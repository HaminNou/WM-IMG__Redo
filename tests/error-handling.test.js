// @vitest-environment jsdom
/**
 * The global failure net (src/error-handling.js) and the screens for a session
 * that cannot go on (src/fatal-screens.js, src/fatal-handler.js).
 *
 * What is pinned here:
 *   - an uncaught error or unhandled rejection becomes ONE `runtime_error` row,
 *     with no stack, no URL and no host in it;
 *   - benign browser noise (ResizeObserver, cross-origin "Script error.",
 *     extension errors, aborted fetches) is not logged;
 *   - a flood of errors is capped, and a repeat inside the dedupe window is
 *     skipped;
 *   - the handlers never throw, whatever the writer does;
 *   - the three failure screens say different, true things, and text from an
 *     error is never parsed as HTML.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEDUPE_MS,
  MAX_ROWS,
  MESSAGE_MAX,
  describeError,
  installGlobalErrorHandlers,
  isBenignError,
  sourceLabel,
} from '../src/error-handling.js';
import {
  FATAL_TEXT,
  RECOVERY_LINK_TEXT,
  SAVE_BUTTON_TEXT,
  errorReference,
  renderFatalScreen,
} from '../src/fatal-screens.js';
import { handleFatal, saveSessionData } from '../src/fatal-handler.js';

/* A minimal EventTarget stand-in that lets a test fire `error` / `unhandledrejection`. */
function fakeWindow() {
  const handlers = { error: [], unhandledrejection: [] };
  return {
    addEventListener: (type, fn) => handlers[type]?.push(fn),
    removeEventListener: (type, fn) => {
      handlers[type] = (handlers[type] ?? []).filter((h) => h !== fn);
    },
    fire: (type, event) => handlers[type].forEach((h) => h(event)),
    count: (type) => handlers[type].length,
  };
}

function setup({ getPhase, logRow } = {}) {
  const win = fakeWindow();
  const rows = [];
  let t = 1000;
  const handle = installGlobalErrorHandlers({
    logRow: logRow ?? ((row) => rows.push(row)),
    getPhase,
    target: win,
    now: () => t,
  });
  return {
    win,
    rows,
    handle,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe('describeError / sourceLabel / isBenignError', () => {
  it('describes errors, strings and odd values without throwing', () => {
    expect(describeError(new TypeError('boom'))).toEqual({ name: 'TypeError', message: 'boom' });
    expect(describeError('text')).toEqual({ name: 'string', message: 'text' });
    expect(describeError(undefined).name).toBe('undefined');
    expect(describeError({ name: '', message: 7 }).message).toContain('[object Object]');
  });

  it('keeps only file name and position of a source, never host, path or query', () => {
    expect(sourceLabel('https://study.example.org/assets/main-abc.js?v=1#x', 12, 34)).toBe(
      'main-abc.js:12:34'
    );
    expect(sourceLabel('', 1, 1)).toBeNull();
    expect(sourceLabel('file.js', 0, 0)).toBe('file.js');
  });

  it('treats browser noise as benign, and a real error as not', () => {
    expect(
      isBenignError({ message: 'ResizeObserver loop completed with undelivered notifications.' })
    ).toBe(true);
    expect(isBenignError({ message: 'ResizeObserver loop limit exceeded' })).toBe(true);
    expect(isBenignError({ message: 'Script error.' })).toBe(true);
    expect(isBenignError({ name: 'AbortError', message: 'The operation was aborted.' })).toBe(true);
    expect(isBenignError({ message: 'x', filename: 'chrome-extension://abc/content.js' })).toBe(
      true
    );
    expect(isBenignError({ message: 'x', stack: 'at moz-extension://abc/inject.js:1:1' })).toBe(
      true
    );
    expect(isBenignError({ message: "Cannot read properties of undefined (reading 'cell')" })).toBe(
      false
    );
  });
});

describe('installGlobalErrorHandlers', () => {
  it('writes one runtime_error row for an uncaught error, with a bounded, URL-free shape', () => {
    const { win, rows } = setup({ getPhase: () => 'i_d_probe' });
    const err = new TypeError('x'.repeat(1000));
    err.stack = 'TypeError: x\n    at https://study.example.org/assets/main-abc.js:1:1';
    win.fire('error', {
      error: err,
      message: err.message,
      filename: 'https://study.example.org/assets/main-abc.js?v=2',
      lineno: 10,
      colno: 5,
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      phase: 'runtime_error',
      kind: 'error',
      error_name: 'TypeError',
      source: 'main-abc.js:10:5',
      trial_phase: 'i_d_probe',
    });
    expect(row.message.length).toBeLessThanOrEqual(MESSAGE_MAX);
    const text = JSON.stringify(row);
    expect(text).not.toContain('https://');
    expect(text).not.toContain('study.example.org');
    expect(text).not.toContain('at https');
    expect(row).not.toHaveProperty('stack');
  });

  it('writes a row for an unhandled rejection, including a non-Error reason', () => {
    const { win, rows } = setup();
    win.fire('unhandledrejection', { reason: new RangeError('bad range') });
    win.fire('unhandledrejection', { reason: 'plain string reason' });
    expect(rows.map((r) => [r.kind, r.error_name, r.message])).toEqual([
      ['unhandledrejection', 'RangeError', 'bad range'],
      ['unhandledrejection', 'string', 'plain string reason'],
    ]);
  });

  it('does not log benign errors', () => {
    const { win, rows } = setup();
    win.fire('error', { message: 'ResizeObserver loop limit exceeded', lineno: 0, colno: 0 });
    win.fire('error', { message: 'Script error.', filename: '', lineno: 0, colno: 0 });
    win.fire('error', {
      error: new Error('x'),
      message: 'x',
      filename: 'safari-extension://a/b.js',
      lineno: 1,
      colno: 1,
    });
    win.fire('unhandledrejection', {
      reason: Object.assign(new Error('aborted'), { name: 'AbortError' }),
    });
    expect(rows).toHaveLength(0);
  });

  it('skips the same error inside the dedupe window and logs it again after', () => {
    const { win, rows, advance } = setup();
    const ev = { error: new Error('same'), message: 'same', filename: 'a.js', lineno: 1, colno: 1 };
    win.fire('error', ev);
    win.fire('error', ev);
    advance(DEDUPE_MS - 1);
    win.fire('error', ev);
    expect(rows).toHaveLength(1);
    advance(2);
    win.fire('error', ev);
    expect(rows).toHaveLength(2);
  });

  it('caps the number of rows so an error in an animation frame cannot flood storage', () => {
    const { win, rows, handle } = setup();
    for (let i = 0; i < MAX_ROWS + 40; i++) {
      win.fire('error', {
        error: new Error(`e${i}`),
        message: `e${i}`,
        filename: 'a.js',
        lineno: i + 1,
        colno: 1,
      });
    }
    expect(rows).toHaveLength(MAX_ROWS);
    expect(handle.getLoggedCount()).toBe(MAX_ROWS);
  });

  it('never throws, whatever the writer or the phase lookup does', () => {
    const rejecting = setup({ logRow: () => Promise.reject(new Error('storage dead')) });
    expect(() =>
      rejecting.win.fire('error', {
        error: new Error('a'),
        message: 'a',
        filename: 'a.js',
        lineno: 1,
        colno: 1,
      })
    ).not.toThrow();
    const throwing = setup({
      logRow: () => {
        throw new Error('sync failure');
      },
      getPhase: () => {
        throw new Error('no jsPsych yet');
      },
    });
    expect(() =>
      throwing.win.fire('error', {
        error: new Error('b'),
        message: 'b',
        filename: 'a.js',
        lineno: 1,
        colno: 1,
      })
    ).not.toThrow();
    expect(() => throwing.win.fire('unhandledrejection', {})).not.toThrow();
    expect(() => throwing.win.fire('error', undefined)).not.toThrow();
  });

  it('removes its listeners on uninstall and is inert without a writer', () => {
    const { win, handle } = setup();
    expect(win.count('error')).toBe(1);
    expect(win.count('unhandledrejection')).toBe(1);
    handle.uninstall();
    expect(win.count('error')).toBe(0);
    expect(win.count('unhandledrejection')).toBe(0);
    const inert = installGlobalErrorHandlers({ target: fakeWindow() });
    expect(inert.getLoggedCount()).toBe(0);
  });
});

describe('failure screens', () => {
  beforeEach(() => {
    document.body.innerHTML = '<p id="old">old page</p>';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('says a different, accurate thing for each stage', () => {
    const titles = new Set(Object.values(FATAL_TEXT).map((t) => t.title));
    expect(titles.size).toBe(3);
    /* Only a real storage failure may talk about storing data in the browser. */
    expect(FATAL_TEXT.storage.paragraphs.join(' ')).toMatch(/store data/i);
    expect(FATAL_TEXT.startup.paragraphs.join(' ')).not.toMatch(/storage|store data/i);
    expect(FATAL_TEXT.running.paragraphs.join(' ')).not.toMatch(/storage|blocking/i);
    /* The running screen must not tell the participant to reload as if it were free. */
    expect(FATAL_TEXT.running.paragraphs.join(' ')).toMatch(/from the beginning/);
    expect(FATAL_TEXT.running.paragraphs.join(' ')).toMatch(/saved on this computer/);
  });

  it('replaces the page and shows the right title', () => {
    for (const stage of ['storage', 'startup', 'running']) {
      renderFatalScreen({ stage, error: new Error('e') });
      expect(document.getElementById('old')).toBeNull();
      expect(document.querySelector('#fatal-screen h2').textContent).toBe(FATAL_TEXT[stage].title);
    }
  });

  it('only offers saving and the recovery page when the task was running', () => {
    renderFatalScreen({
      stage: 'storage',
      error: new Error('e'),
      saveData: async () => ({ ok: true, text: 'x' }),
    });
    expect(document.getElementById('fatal-save')).toBeNull();
    renderFatalScreen({ stage: 'startup', error: new Error('e') });
    expect(document.getElementById('fatal-save')).toBeNull();
    renderFatalScreen({
      stage: 'running',
      error: new Error('e'),
      saveData: async () => ({ ok: true, text: 'x' }),
    });
    expect(document.getElementById('fatal-save').textContent).toBe(SAVE_BUTTON_TEXT);
    const link = document.getElementById('fatal-recover');
    expect(link.textContent).toBe(RECOVERY_LINK_TEXT);
    expect(link.getAttribute('href')).toBe('recover.html');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('never parses text from an error as HTML', () => {
    const hostile = new Error(
      '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>'
    );
    for (const stage of ['storage', 'startup', 'running']) {
      renderFatalScreen({
        stage,
        error: hostile,
        saveData: async () => ({ ok: true, text: '<b>x</b>' }),
      });
      expect(document.querySelector('#fatal-screen img')).toBeNull();
      expect(document.querySelector('#fatal-screen script')).toBeNull();
      expect(document.querySelector('#fatal-screen code').textContent).toContain('<img');
    }
    expect(window.__pwned).toBeUndefined();
  });

  it('shows the result of the save button as plain text and re-enables the button', async () => {
    const saveData = vi.fn(async () => ({ ok: true, text: 'Sent <b>ok</b>' }));
    renderFatalScreen({ stage: 'running', error: new Error('e'), saveData });
    const button = document.getElementById('fatal-save');
    button.click();
    expect(button.disabled).toBe(true);
    await vi.waitFor(() =>
      expect(document.getElementById('fatal-status').textContent).toBe('Sent <b>ok</b>')
    );
    expect(document.querySelector('#fatal-status b')).toBeNull();
    expect(button.disabled).toBe(false);
    expect(saveData).toHaveBeenCalledTimes(1);
  });

  it('keeps going when saving throws', async () => {
    renderFatalScreen({
      stage: 'running',
      error: new Error('e'),
      saveData: async () => {
        throw new Error('network');
      },
    });
    document.getElementById('fatal-save').click();
    await vi.waitFor(() =>
      expect(document.getElementById('fatal-status').textContent).toMatch(/message the researcher/i)
    );
  });

  it('describes an error in one short plain line', () => {
    expect(errorReference(new TypeError('bad\n  thing'))).toBe('TypeError: bad thing');
    expect(errorReference(undefined)).toBe('Error: unknown');
    expect(errorReference(new Error('y'.repeat(500))).length).toBeLessThanOrEqual(200);
  });
});

describe('handleFatal and saveSessionData', () => {
  const session = { params: { session_id: 's' } };

  function deps(overrides = {}) {
    return {
      appendTrialRow: vi.fn(() => Promise.resolve(1)),
      renderFatalScreen: vi.fn(() => document.createElement('div')),
      markUploadDone: vi.fn(),
      rowClock: () => ({ clock_ms: 1 }),
      uploadPendingData: vi.fn(async () => ({ status: 'uploaded' })),
      downloadAsJson: vi.fn(() => ({ filename: 'data.json', sizeBytes: 1 })),
      getAllTrialRows: vi.fn(async () => [{ seq: 1 }]),
      ...overrides,
    };
  }

  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('a storage failure writes no row and does not touch the leave-page prompt', () => {
    const d = deps();
    handleFatal({ stage: 'storage', error: new Error('idb'), session, deps: d });
    expect(d.appendTrialRow).not.toHaveBeenCalled();
    expect(d.markUploadDone).not.toHaveBeenCalled();
    expect(d.renderFatalScreen).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'storage', saveData: undefined })
    );
  });

  it('a start-up failure writes a row and keeps the prompt', () => {
    const d = deps();
    handleFatal({ stage: 'startup', error: new Error('boom'), session, deps: d });
    expect(d.appendTrialRow).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'runtime_error_fatal', stage: 'startup', clock_ms: 1 })
    );
    expect(d.markUploadDone).not.toHaveBeenCalled();
  });

  it('a failure while running writes a row, releases the leave-page prompt, and offers saving', async () => {
    const d = deps();
    handleFatal({ stage: 'running', error: new TypeError('in a trial'), session, deps: d });
    expect(d.appendTrialRow).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'runtime_error_fatal',
        stage: 'running',
        message: 'TypeError: in a trial',
      })
    );
    expect(d.markUploadDone).toHaveBeenCalledTimes(1);
    const { saveData } = d.renderFatalScreen.mock.calls[0][0];
    expect(typeof saveData).toBe('function');
    await expect(saveData()).resolves.toMatchObject({ ok: true });
    expect(d.uploadPendingData).toHaveBeenCalledWith({ session, allRuns: true });
  });

  it('survives a writer that throws or rejects, and still shows the screen', () => {
    const d1 = deps({
      appendTrialRow: vi.fn(() => {
        throw new Error('sync');
      }),
    });
    expect(() =>
      handleFatal({ stage: 'running', error: new Error('a'), session, deps: d1 })
    ).not.toThrow();
    expect(d1.renderFatalScreen).toHaveBeenCalled();
    const d2 = deps({ appendTrialRow: vi.fn(() => Promise.reject(new Error('async'))) });
    expect(() =>
      handleFatal({ stage: 'startup', error: new Error('b'), session, deps: d2 })
    ).not.toThrow();
    expect(d2.renderFatalScreen).toHaveBeenCalled();
  });

  it('saveSessionData falls back to a download when the upload fails or throws', async () => {
    const failed = deps({ uploadPendingData: vi.fn(async () => ({ status: 'partial' })) });
    const r1 = await saveSessionData({ session, deps: failed });
    expect(r1.ok).toBe(false);
    expect(r1.text).toContain('data.json');
    expect(r1.text).toMatch(/Prolific messaging/);
    const thrown = deps({
      uploadPendingData: vi.fn(async () => {
        throw new Error('net');
      }),
    });
    const r2 = await saveSessionData({ session, deps: thrown });
    expect(r2.ok).toBe(false);
    expect(thrown.downloadAsJson).toHaveBeenCalled();
  });

  it('saveSessionData still answers when even the download fails', async () => {
    const d = deps({
      uploadPendingData: vi.fn(async () => ({ status: 'partial' })),
      downloadAsJson: vi.fn(() => {
        throw new Error('blocked');
      }),
    });
    const r = await saveSessionData({ session, deps: d });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/message the researcher/i);
  });
});
