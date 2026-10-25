// @vitest-environment jsdom
/**
 * Browser support.
 *
 * 1. The production bundle must not contain ES2022 class static blocks (they
 *    sit inside the jsPsych plugins). Safari before 16.4 cannot parse them, and
 *    the participant would see a blank page with no way to learn why. The
 *    build target in vite.config.js makes esbuild lower them; the test builds
 *    for real and looks.
 * 2. index.html carries a plain ES5 gate that checks the features the study
 *    uses and, if one is missing, shows a message instead of a blank page and
 *    sets `window.__studyUnsupported`, which src/runner.js checks before it
 *    starts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf-8');

describe('build target', () => {
  it('names the oldest supported browsers explicitly, with no es2022', () => {
    const cfg = readFileSync(join(ROOT, 'vite.config.js'), 'utf-8');
    const target = cfg.match(/target:\s*(\[[^\]]*\]|'[^']*')/)?.[1] ?? '';
    /* The oldest versions that have Object.hasOwn, which jsPsych calls on every trial
     * (MDN browser-compat-data: Chrome/Edge 93, Firefox 92, Safari 15.4). */
    expect(target).toContain('safari15.4');
    expect(target).toContain('chrome93');
    expect(target).toContain('edge93');
    expect(target).toContain('firefox92');
    expect(target).toContain('es2020');
    expect(target).not.toMatch(/es2022|esnext/i);
  });

  it('produces a bundle without class static blocks', () => {
    const out = mkdtempSync(join(tmpdir(), 'bundle-'));
    try {
      const run = spawnSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], {
        cwd: ROOT,
        encoding: 'utf-8',
      });
      expect(run.status, run.stderr || run.stdout).toBe(0);
      const assets = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'));
      expect(assets.length).toBeGreaterThan(0);
      for (const f of assets) {
        const code = readFileSync(join(out, 'assets', f), 'utf-8');
        expect(code, `${f} contains a class static block`).not.toMatch(/static\s*\{/);
      }
      /* The gate and its flag ship in the page itself. */
      expect(readFileSync(join(out, 'index.html'), 'utf-8')).toContain('__studyUnsupported');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});

/* The inline ES5 gate: the one <script> without type="module". */
function gateSource() {
  const scripts = [
    ...indexHtml.matchAll(/<script(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g),
  ];
  const gate = scripts.map((m) => m[1]).find((s) => s.includes('__studyUnsupported'));
  if (!gate) throw new Error('browser gate script not found in index.html');
  return gate;
}

const saved = {};
const KEYS = [
  'fetch',
  'AbortController',
  'AudioContext',
  'webkitAudioContext',
  'requestAnimationFrame',
  'matchMedia',
  'Blob',
];

function provideEverything() {
  window.fetch = () => {};
  window.AbortController = window.AbortController ?? function () {};
  window.AudioContext = function () {};
  window.requestAnimationFrame = () => 0;
  window.matchMedia = () => ({ matches: false });
  window.Blob = window.Blob ?? function () {};
  if (!('noModule' in HTMLScriptElement.prototype)) {
    Object.defineProperty(HTMLScriptElement.prototype, 'noModule', {
      value: false,
      configurable: true,
    });
  }
  if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:x';
}

function runGate() {
  /* The gate is classic code that reads globals; run it as one would in a page. */
  new Function(gateSource())();
}

beforeEach(() => {
  for (const k of KEYS) saved[k] = window[k];
  delete window.__studyUnsupported;
  document.body.innerHTML = '<p id="app">study</p>';
  provideEverything();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete window[k];
    else window[k] = saved[k];
  }
  delete window.__studyUnsupported;
});

describe('browser gate in index.html', () => {
  it('is plain ES5 (it must run in a browser that cannot run the study)', () => {
    const src = gateSource();
    expect(src).not.toMatch(/=>|\bconst\b|\blet\b|\bclass\b|`|\?\.|\?\?|\basync\b|\bawait\b/);
  });

  it('does nothing when every feature is present', () => {
    runGate();
    expect(window.__studyUnsupported).toBeUndefined();
    expect(document.getElementById('app')).not.toBeNull();
  });

  it.each([
    ['AudioContext', 'Web Audio'],
    ['fetch', 'fetch'],
    ['matchMedia', 'matchMedia'],
    ['requestAnimationFrame', 'requestAnimationFrame'],
  ])('shows a message and sets the flag when %s is missing', (feature, label) => {
    delete window[feature];
    if (feature === 'AudioContext') delete window.webkitAudioContext;
    runGate();
    expect(window.__studyUnsupported).toContain(label);
    expect(document.getElementById('app')).toBeNull();
    const box = document.querySelector('[role="alert"]');
    expect(box.textContent).toContain('This browser cannot run the study');
    expect(box.textContent).toMatch(/Chrome, Edge, Firefox or Safari/);
    expect(box.textContent).toContain(label);
  });

  it('reports a browser without Object.hasOwn, which jsPsych calls on every trial', () => {
    /* Chrome/Edge 87-92, Firefox < 92 and Safari 14-15.3 pass every other check, then
     * stop at the first trial with a stack trace nobody can act on. */
    const saved = Object.hasOwn;
    try {
      delete Object.hasOwn;
      runGate();
      expect(window.__studyUnsupported).toContain('Object.hasOwn');
      const box = document.querySelector('[role="alert"]');
      expect(box.textContent).toContain('Object.hasOwn');
    } finally {
      Object.hasOwn = saved;
    }
  });

  it('says which versions are the oldest that work', () => {
    delete window.fetch;
    runGate();
    const text = document.querySelector('[role="alert"]').textContent;
    expect(text).toContain('Safari 15.4');
    expect(text).toContain('Firefox 92');
    expect(text).toMatch(/Chrome or Edge 93/);
  });

  it('the bundle calls Object.hasOwn, so the gate must check it (guard against drift)', () => {
    /* If the bundle stops using it the check may go; until then it must stay. */
    const out = mkdtempSync(join(tmpdir(), 'hasown-'));
    try {
      const run = spawnSync('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], {
        cwd: ROOT,
        encoding: 'utf-8',
      });
      expect(run.status, run.stderr || run.stdout).toBe(0);
      const code = readdirSync(join(out, 'assets'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => readFileSync(join(out, 'assets', f), 'utf-8'))
        .join('\n');
      if (code.includes('Object.hasOwn(')) expect(gateSource()).toContain('Object.hasOwn');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);

  it('accepts the prefixed audio API alone (older Safari)', () => {
    delete window.AudioContext;
    window.webkitAudioContext = function () {};
    runGate();
    expect(window.__studyUnsupported).toBeUndefined();
  });

  it('reports a browser without JavaScript modules', () => {
    Object.defineProperty(HTMLScriptElement.prototype, 'noModule', {
      value: undefined,
      configurable: true,
    });
    delete HTMLScriptElement.prototype.noModule;
    runGate();
    expect(window.__studyUnsupported).toContain('JavaScript modules');
  });

  it('the runner refuses to start when the gate has flagged the browser', () => {
    const runner = readFileSync(join(ROOT, 'src/runner.js'), 'utf-8');
    const guard = runner.indexOf('window.__studyUnsupported');
    const session = runner.indexOf('const session = initSession()');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(session);
    /* The guard must really stop the module: a live condition followed by a throw. */
    expect(runner).toMatch(
      /if \(typeof window !== 'undefined' && window\.__studyUnsupported\) \{\s*throw new Error/
    );
  });

  it('the Prolific listing names the same oldest versions as the gate', () => {
    const md = readFileSync(join(ROOT, 'prolific-study-description.md'), 'utf-8');
    for (const text of [md, indexHtml]) {
      expect(text).toContain('Safari 15.4');
      expect(text).toContain('Firefox 92');
      expect(text).toMatch(/Chrome or Edge 93/);
    }
    /* The plain-text listing lives outside the repository: check it when it is there. */
    const txtPath = join(ROOT, '..', 'Prolific study description.txt');
    if (existsSync(txtPath)) {
      const txt = readFileSync(txtPath, 'utf-8');
      expect(txt).toContain('Safari 15.4');
      expect(txt).toContain('Firefox 92');
      expect(txt).toMatch(/Chrome or Edge 93/);
    }
  });

  it('keeps a message for browsers with JavaScript turned off', () => {
    expect(indexHtml).toMatch(/<noscript>[\s\S]*JavaScript[\s\S]*<\/noscript>/);
  });
});
