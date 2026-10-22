#!/usr/bin/env node
/**
 * Verify every imperative narration call site has a matching string
 * in `public/voiceover/strings.json`.
 *
 * The bug class this catches: `enumerateDemoNarrationStrings()` (and
 * any other enumerator the harvester relies on) must stay byte-identical
 * to the strings actually passed to `speak()` / `narrate()` at runtime.
 * A one-word divergence → different SHA-256 → manifest miss → noisy
 * Web Speech fallback at runtime. We've hit this twice; this script
 * makes recurrence loud and early.
 *
 * Scope: single-quoted string-literal arguments to `.speak(...)`,
 * `.narrate(...)`, and `setCaption('...')` across `src/`. Template
 * literals (backtick-delimited) are NOT statically checked here — they
 * expand to many strings at runtime and the harvester's enumerator is
 * the authoritative listing of those variants. Mismatches in the
 * enumerated variants must be caught by code review (or by an end-to-
 * end pass that records `window.__voiceoverHarvest`).
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const SRC_DIR = join(ROOT, 'src');
const STRINGS_FILE = join(ROOT, 'public', 'voiceover', 'strings.json');

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/* Mirror voiceover.js::htmlToNarrationText (browser path). The runtime
 * engine assigns the HTML to a temporary div's `innerHTML` and reads
 * `textContent`, so the only correct emulation is a real DOM. Using
 * jsdom (already a devDep) — a naive `replace(/<[^>]+>/, ' ')` inserts
 * spurious whitespace at tag boundaries that breaks the hash. */
const dom = new JSDOM('<!doctype html><body></body>');
const scratch = dom.window.document.createElement('div');
function htmlToNarrationText(html) {
  scratch.innerHTML = String(html);
  return (scratch.textContent ?? '').replace(/\s+/g, ' ').trim();
}

async function walkJs(dir, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJs(full, out);
    } else if (entry.isFile() && /\.js$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/* Match single- or double-quoted string-literal arguments to .speak(),
 * .narrate(), or setCaption('...'). The body of the literal must not
 * contain its own un-escaped delimiter — standard regex caveat, fine
 * for our copy. Template literals (`...`) are intentionally skipped. */
const CALL_RE = /\b(?:speak|narrate|setCaption)\(\s*(['"])((?:\\\1|(?!\1).)*)\1\s*[,)]/g;

async function main() {
  const strings = JSON.parse(await readFile(STRINGS_FILE, 'utf8'));
  const knownHashes = new Set(strings.map((s) => sha256Hex(s.text)));

  const files = await walkJs(SRC_DIR, []);
  const misses = [];
  let checked = 0;

  for (const file of files) {
    const src = await readFile(file, 'utf8');
    /* Reset regex state between files. */
    CALL_RE.lastIndex = 0;
    let m;
    while ((m = CALL_RE.exec(src)) !== null) {
      const raw = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
      const text = htmlToNarrationText(raw);
      if (!text) continue;
      checked += 1;
      if (!knownHashes.has(sha256Hex(text))) {
        const line = src.slice(0, m.index).split('\n').length;
        misses.push({ file: file.slice(ROOT.length + 1), line, text });
      }
    }
  }

  console.log(
    `[verify-voiceover] checked ${checked} string-literal narration call(s) across ${files.length} file(s).`
  );

  if (misses.length === 0) {
    console.log('[verify-voiceover] OK — every literal is in strings.json.');
    process.exit(0);
  }

  console.error(
    `[verify-voiceover] FAIL — ${misses.length} narration literal(s) NOT in strings.json:`
  );
  for (const { file, line, text } of misses) {
    const preview = text.length > 90 ? text.slice(0, 87) + '...' : text;
    console.error(`  ${file}:${line}  "${preview}"`);
  }
  console.error(
    '[verify-voiceover] Fix: align the enumerator (or the runtime call), then re-run `npm run harvest-voiceover && npm run render-voiceover-edge`.'
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('[verify-voiceover] crashed:', err);
  process.exit(2);
});
