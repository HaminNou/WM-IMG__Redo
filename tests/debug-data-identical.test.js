// @vitest-environment jsdom
/**
 * Debug tools must not change a single recorded value: the same seeded trial is run through the
 * real nodes with the debug tools off and with them on (reveal installed and toggled by a
 * participant-like stream of G presses, trace enabled), and the data rows are compared.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/audio/context.js', () => ({
  getAudioContext: () => ({ currentTime: performance.now() / 1000, state: 'running' }),
  audioContextInfo: () => ({
    sample_rate_hz: 48000,
    state: 'running',
    base_latency_ms: 10,
    output_latency_ms: 20,
  }),
  ensureRunning: async () => {},
  unlockAudio: async () => {},
}));
vi.mock('../src/audio/tones.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, playToneByCell: vi.fn(() => Promise.resolve()) };
});

import { _resetStorageForTests, initStorage } from '../src/storage.js';
import { runTrial, plannedTrials, REAL_FAKE_TIMERS } from './helpers/real-rows.js';
import { installReveal, uninstallReveal } from '../src/debug/reveal.js';
import { _setTraceEnabled } from '../src/debug/trace.js';

afterEach(() => {
  uninstallReveal();
  _setTraceEnabled(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function run(cond, debug) {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: REAL_FAKE_TIMERS });
  const params = plannedTrials('debug-identical')[cond][0];
  const revealRows = [];
  let timer = null;
  if (debug) {
    for (const m of ['log', 'info', 'warn', 'group', 'groupEnd', 'table']) {
      vi.spyOn(console, m).mockImplementation(() => {});
    }
    _setTraceEnabled(true);
    installReveal({ enabled: true, emitRow: (r) => revealRows.push(r) });
    /* G pressed every 120 ms: a double press (a toggle) about every 240 ms. */
    timer = setInterval(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true })
      );
    }, 120);
  }
  const { rows } = await runTrial(cond, params, { starRtMs: 700, probeRtMs: 600 });
  if (timer) clearInterval(timer);
  uninstallReveal();
  _setTraceEnabled(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
  /* Random DOM ids and the real-time start of the fake Date are not trial data. */
  const norm = rows.map(({ wall_ms: _w, ...r }) => ({
    ...r,
    stimulus:
      typeof r.stimulus === 'string'
        ? r.stimulus.replace(/-mount-[a-z0-9]+/g, '-mount')
        : r.stimulus,
  }));
  return { rows: norm, revealRows };
}

describe('debug on vs off', () => {
  for (const cond of ['d_only', 'i_d']) {
    it(`${cond}: every recorded row is identical`, async () => {
      const off = await run(cond, false);
      const on = await run(cond, true);
      expect(on.rows.length).toBeGreaterThan(5);
      expect(on.rows).toEqual(off.rows);
      expect(on.revealRows.length).toBeGreaterThan(0);
      expect(on.revealRows.every((r) => r.phase === 'debug_reveal')).toBe(true);
    }, 120000);
  }
});
