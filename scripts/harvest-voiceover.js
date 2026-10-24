#!/usr/bin/env node
/**
 * Harvest narration strings into `public/voiceover/strings.json` so the
 * render script knows what to synthesise.
 *
 * Two complementary harvest paths, both write to the same `strings.json`
 * (deduplicated by SHA-256 hash of the text — re-running is safe and
 * idempotent):
 *
 *   1. **Static harvest (default).** Spins up Vite's SSR runtime, loads
 *      every instruction module + slide-page consumer, calls each
 *      `*Node()` factory or reads each module-level slide constant,
 *      walks the produced HTML for `[data-voiceover-target]` regions,
 *      and extracts the narration text using the same algorithm the
 *      browser engine uses. This catches the bulk of the experiment's
 *      prose with zero operator interaction.
 *
 *   2. **Runtime harvest (`--from-runtime <dump.json>`).** Reads a JSON
 *      dump of `window.__voiceoverHarvest` produced by the engine while
 *      the operator clicked through the experiment in dev mode. This
 *      catches dynamic strings that static harvest can't see — demo
 *      captions assembled at runtime, rest-message variations, debug
 *      overrides, etc. Operator workflow:
 *        a. `npm run dev` → click through every screen end-to-end
 *        b. In DevTools: `copy(JSON.stringify(window.__voiceoverHarvest))`
 *        c. Paste into a file `tmp/runtime-harvest.json`
 *        d. `node scripts/harvest-voiceover.js --from-runtime tmp/runtime-harvest.json`
 *
 * The two paths are additive: run static first (catches ~95% of the
 * narration), spot-check with runtime if you want to be exhaustive.
 *
 * Output schema for `public/voiceover/strings.json` — array of records:
 *   `[ { text, source }, ... ]`
 * where `source` is a free-form tag (`memory.dOnly#0`, `runtime`, etc.)
 * for diff-readability. The render script ignores `source` and keys by
 * SHA-256 of `text`.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const VOICEOVER_DIR = join(ROOT, 'public', 'voiceover');
const STRINGS_FILE = join(VOICEOVER_DIR, 'strings.json');

/* Audio is keyed on the text with en dashes written as em dashes, so the
 * dash style shown on screen does not change which recording is played. */
function sha256Hex(text) {
  text = text.replace(/\u2013/g, '\u2014');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Normalise the narration text from a `[data-voiceover-target]` host
 * element using exactly the same algorithm as the browser engine's
 * `wrapWordsInPlace`. Words are run together with single ASCII spaces;
 * visible whitespace within a single text node is collapsed out of the
 * narration stream (same as the engine).
 *
 * Implemented manually with a regex over `textContent` because the
 * engine's algorithm is functionally equivalent for the no-element-
 * boundary-crossing case, and the renderer hashes the same text either
 * way. We could import the engine's `wrapWordsInPlace` here, but it
 * mutates the host element — keeping the harvester read-only is
 * cleaner.
 */
function extractNarrationText(host) {
  /* Walk the DOM, emitting words separated by single spaces. This
   * mirrors `wrapWordsInPlace`: visible whitespace within a text node
   * is collapsed (regex `\s+` matched as a single space token), and a
   * separator space is inserted between words from different text nodes
   * (which is what the per-text-node regex naturally produces because
   * each text node contributes its own non-empty token sequence). */
  const words = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        const text = child.nodeValue;
        if (!text) continue;
        const matches = text.match(/\S+/g);
        if (matches) words.push(...matches);
      } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
        walk(child);
      }
    }
  };
  walk(host);
  return words.join(' ');
}

/**
 * Read the existing `strings.json` and return as `Map<hash, record>`.
 * Fresh empty Map if the file doesn't exist yet.
 */
async function readExistingStrings() {
  const map = new Map();
  if (!existsSync(STRINGS_FILE)) return map;
  const raw = await readFile(STRINGS_FILE, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }
  if (!Array.isArray(parsed)) return map;
  for (const entry of parsed) {
    const text = typeof entry === 'string' ? entry : entry?.text;
    if (typeof text !== 'string' || !text.trim()) continue;
    const hash = sha256Hex(text);
    if (!map.has(hash)) map.set(hash, { text, source: entry?.source ?? null });
  }
  return map;
}

async function writeStrings(map) {
  await mkdir(VOICEOVER_DIR, { recursive: true });
  /* Stable hash-sorted order for diff-readable commits. */
  const entries = Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
  await writeFile(STRINGS_FILE, JSON.stringify(entries, null, 2) + '\n', 'utf8');
}

/* ------------------------------- runtime ------------------------------- */

async function harvestFromRuntime(filePath) {
  if (!existsSync(filePath)) {
    console.error(`[harvest-voiceover] File not found: ${filePath}`);
    process.exit(1);
  }
  const raw = await readFile(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[harvest-voiceover] ${filePath} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    console.error(
      `[harvest-voiceover] ${filePath} must be an array (window.__voiceoverHarvest dump).`
    );
    process.exit(1);
  }
  const out = [];
  for (const entry of parsed) {
    const text = typeof entry === 'string' ? entry : entry?.text;
    if (typeof text !== 'string' || !text.trim()) continue;
    out.push({ text, source: entry?.source ?? 'runtime' });
  }
  return out;
}

/* -------------------------------- static ------------------------------- */

/**
 * Spin up a Vite SSR runtime and load the instruction modules. For each
 * factory or constant that produces slide HTML, harvest narration from
 * any `[data-voiceover-target]` regions inside the produced HTML.
 *
 * The factories require a DOM (some access `document` at module init or
 * factory call time — at minimum `slideTextPage` produces template
 * strings, and the demos.js factory builds DOM nodes). We provide jsdom
 * as a polyfill before calling factories.
 */
async function harvestFromStatic() {
  /* Imported lazily so the static path doesn't pay vite + jsdom startup
   * cost when the operator is just running --from-runtime. */
  const { createServer } = await import('vite');
  const { JSDOM } = await import('jsdom');

  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="jspsych-target"></div></body></html>',
    {
      url: 'http://localhost/',
      pretendToBeVisual: true,
    }
  );
  /* Mount jsdom globals BEFORE Vite SSR loads modules — many of them
   * read `window` / `document` at module init (CSS class registration,
   * canvas helpers, etc). Some Node globals (`navigator`) have only a
   * getter on globalThis in newer Node versions, so we use defineProperty
   * which can override the getter. */
  const setGlobal = (name, value) => {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
    });
  };
  setGlobal('window', dom.window);
  setGlobal('document', dom.window.document);
  setGlobal('navigator', dom.window.navigator);
  setGlobal('HTMLElement', dom.window.HTMLElement);
  setGlobal('Node', dom.window.Node);
  setGlobal('Element', dom.window.Element);
  setGlobal('DocumentFragment', dom.window.DocumentFragment);
  setGlobal('MutationObserver', dom.window.MutationObserver);
  setGlobal('requestAnimationFrame', (cb) => dom.window.setTimeout(cb, 16));
  setGlobal('cancelAnimationFrame', (id) => dom.window.clearTimeout(id));
  setGlobal('localStorage', dom.window.localStorage);

  const server = await createServer({
    root: ROOT,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
    logLevel: 'warn',
  });

  const harvested = []; /* { text, source } */
  const pushHtml = (html, source) => {
    if (typeof html !== 'string' || !html.trim()) return;
    const wrapper = dom.window.document.createElement('div');
    wrapper.innerHTML = html;
    const targets = wrapper.querySelectorAll('[data-voiceover-target]');
    if (targets.length === 0) return;
    let i = 0;
    for (const t of targets) {
      /* `data-voiceover-script` lets a slide author specify experimenter
       * framing distinct from the visible body — when present, that
       * script (not the on-screen prose) is what the engine speaks, so
       * it's also what we render. Fall back to extracting the visible
       * text only when no script is supplied. */
      const scriptAttr = t.getAttribute('data-voiceover-script');
      const hasScript = typeof scriptAttr === 'string' && scriptAttr.trim();
      const text = hasScript ? scriptAttr.trim() : extractNarrationText(t);
      if (text) {
        harvested.push({
          text,
          source: `${source}#${i++}${hasScript ? ':script' : ''}`,
        });
      }
    }
  };

  /* Recursive node-tree walker. Every jsPsych node carries narration in
   * exactly two shapes:
   *   - `stimulus: '<html…>'` — single page (htmlButtonResponse,
   *     htmlKeyboardResponse, surveyHtmlForm).
   *   - `pages: ['<html…>', '<html…>', …]` — multi-page (jsPsych
   *     instructions plugin).
   * Both shapes flow into `pushHtml`. Composite nodes
   * (`{ timeline: [...] }`) are walked recursively. Conditional /
   * loop nodes that don't include their inner timeline at the top
   * level are out of scope here — none of the narration-bearing nodes
   * use that shape. */
  const walkNode = (node, source) => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walkNode(node[i], `${source}[${i}]`);
      return;
    }
    if (typeof node !== 'object') return;
    if (typeof node.stimulus === 'string') pushHtml(node.stimulus, `${source}.stimulus`);
    if (Array.isArray(node.pages)) {
      for (let i = 0; i < node.pages.length; i++) pushHtml(node.pages[i], `${source}.page${i}`);
    }
    if (Array.isArray(node.timeline)) {
      for (let i = 0; i < node.timeline.length; i++)
        walkNode(node.timeline[i], `${source}.timeline[${i}]`);
    }
  };

  /* Each entry is `[modulePath, harvest(mod)]`. Each harvester resolves
   * the module's exported factories (or constants) and pushes harvested
   * narration via `pushHtml` (for HTML strings) or via direct call to
   * `harvested.push({ text, source })` (for already-plain narration
   * strings, e.g. the demo caption enumerator). The recursive
   * `walkNode(mod.factory(), 'tag')` helper handles every jsPsych shape
   * the codebase actually uses. */
  const MODULES = [
    [
      '/src/instructions/index.js',
      (mod) => {
        /* The "Instructions" overview slide is the first narrated screen
         * after the calibration chain. Its body paragraphs (wrapped in
         * `[data-voiceover-target]`) describe the practice structure. */
        walkNode(mod.instructionsOverview(), 'instructions.instructionsOverview');
        walkNode(mod.practiceReadinessNode(), 'instructions.practiceReadinessNode');
      },
    ],
    [
      '/src/instructions/memory.js',
      (mod) => {
        walkNode(mod.dOnlyInstructionNode(), 'memory.dOnlyInstructionNode');
        walkNode(mod.tOnlyInstructionNode(), 'memory.tOnlyInstructionNode');
      },
    ],
    [
      '/src/instructions/imagery.js',
      (mod) => {
        walkNode(mod.iOnlyInstructionNode(), 'imagery.iOnlyInstructionNode');
      },
    ],
    [
      '/src/instructions/dual.js',
      (mod) => {
        walkNode(mod.iDInstructionNode(), 'dual.iDInstructionNode');
        walkNode(mod.iTInstructionNode(), 'dual.iTInstructionNode');
      },
    ],
    [
      '/src/calibration/viewing-distance.js',
      (mod) => {
        walkNode(mod.viewingDistanceTrial(), 'viewing-distance.viewingDistanceTrial');
      },
    ],
    [
      '/src/calibration/screen.js',
      (mod) => {
        /* `screenCalibrationWithRetry()` wraps a 4-node timeline (retry-
         * hint sub-timeline + cal trial + gate + outcome). Only the retry-
         * hint trial carries `[data-voiceover-target]`; the others are no-
         * ops for narration. The walker visits them all and pushHtml
         * silently skips stimuli without a narration target. */
        walkNode(mod.screenCalibrationWithRetry(), 'screen.screenCalibrationWithRetry');
      },
    ],
    [
      '/src/calibration/volume.js',
      (mod) => {
        walkNode(mod.speakerVolumeInstructionTrial(), 'volume.speakerVolumeInstructionTrial');
      },
    ],
    [
      '/src/calibration/tone-familiarisation.js',
      (mod) => {
        /* The audibility/comfort trial gates its 24-tone sweep behind
         * narration of the body paragraphs (wrapped in
         * `[data-voiceover-target][data-tac-narration]`). The walker
         * picks up the target from the stimulus HTML. */
        walkNode(mod.toneAudibilityAndComfortTrial(), 'tone-fam.toneAudibilityAndComfortTrial');
      },
    ],
    [
      '/src/conditions/rest.js',
      (mod) => {
        walkNode(mod.restNode(), 'rest.restNode');
        walkNode(mod.intraBlockRestNode(), 'rest.intraBlockRestNode');
        walkNode(mod.resumeAfterRestGateNode(), 'rest.resumeAfterRestGateNode');
      },
    ],
    [
      '/src/runner-intros.js',
      (mod) => {
        walkNode(mod.mainAIntroNode(), 'runner-intros.mainAIntroNode');
        walkNode(mod.mainBIntroNode(), 'runner-intros.mainBIntroNode');
        walkNode(mod.endOfTaskIntroNode(), 'runner-intros.endOfTaskIntroNode');
      },
    ],
    [
      '/src/instructions/demos.js',
      (mod) => {
        /* Demos compose narration imperatively via `setCaption()` →
         * `getVoiceover().speak(htmlToNarrationText(text))`. There is no
         * static HTML carrying `[data-voiceover-target]` to walk, so the
         * module exports an enumerator that returns the full caption set
         * (literals + enumerated template-variable forms). Each returned
         * string is the spoken (tag-stripped) form that the runtime hashes
         * against the manifest. */
        if (typeof mod.enumerateDemoNarrationStrings === 'function') {
          const strings = mod.enumerateDemoNarrationStrings();
          for (let i = 0; i < strings.length; i++) {
            const text = strings[i];
            if (typeof text === 'string' && text.trim()) {
              harvested.push({ text: text.trim(), source: `demos.caption${i}` });
            }
          }
        }
      },
    ],
  ];

  let modulesLoaded = 0;
  let modulesFailed = 0;
  for (const [path, harvest] of MODULES) {
    try {
      const mod = await server.ssrLoadModule(path);
      harvest(mod);
      modulesLoaded += 1;
    } catch (err) {
      modulesFailed += 1;
      console.error(`[harvest-voiceover] Failed to load ${path}: ${err.message}`);
    }
  }

  await server.close();
  console.log(
    `[harvest-voiceover] static: loaded ${modulesLoaded} module(s), ${modulesFailed} failed, harvested ${harvested.length} narration regions.`
  );
  return harvested;
}

/* -------------------------------- main -------------------------------- */

function parseArgs(argv) {
  const args = { mode: 'static', file: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-runtime') {
      args.mode = 'runtime';
      args.file = argv[++i];
    } else if (a === '--help' || a === '-h') {
      args.mode = 'help';
    } else {
      console.error(`[harvest-voiceover] Unknown arg: ${a}`);
      args.mode = 'help';
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/harvest-voiceover.js
      Static harvest — load instruction modules via Vite SSR and write
      every narration target into public/voiceover/strings.json.

  node scripts/harvest-voiceover.js --from-runtime tmp/dump.json
      Runtime harvest — merge a window.__voiceoverHarvest dump into
      public/voiceover/strings.json. Use after clicking through the
      experiment in dev mode and copying \`window.__voiceoverHarvest\`
      from DevTools.

Both modes are idempotent and additive — entries are deduped by
SHA-256 hash of the narration text, so running both is safe and
expected.`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode === 'help') {
    printHelp();
    return;
  }

  const existing = await readExistingStrings();
  const beforeCount = existing.size;

  let fresh;
  if (args.mode === 'runtime') {
    fresh = await harvestFromRuntime(args.file);
  } else {
    fresh = await harvestFromStatic();
  }

  let added = 0;
  for (const rec of fresh) {
    const hash = sha256Hex(rec.text);
    if (!existing.has(hash)) {
      existing.set(hash, rec);
      added += 1;
    }
  }

  await writeStrings(existing);
  const totalChars = Array.from(existing.values()).reduce((s, r) => s + r.text.length, 0);
  console.log(
    `[harvest-voiceover] ${added} new, ${beforeCount} preserved → ${existing.size} total (${totalChars} chars) in ${STRINGS_FILE}`
  );
}

main().catch((err) => {
  console.error('[harvest-voiceover] Unhandled error:', err);
  process.exit(1);
});
