// @vitest-environment jsdom
/**
 * Every recognition probe of every condition (D-only, T-only, I+D, I+T) is
 * recorded, in each of the three probe positions, and the LAST probe (the last
 * event of the trial before the ITI and the next trial) is as complete as the
 * first.
 *
 * Whole trials run through the real jsPsych timeline on a fake clock. The
 * simulated participant answers probe 0 after 100 ms, leaves probe 1
 * unanswered and answers probe 2 at 2950 ms and presses a second key 10 ms later.
 * Expected response, RT, correctness and extra-key counts are computed from the
 * participant's own key log, not from the code under test. Rows are read from
 * storage the moment `jsPsych.run` resolves (no extra flush): the last probe and
 * the final ITI row must already be there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initJsPsych } from 'jspsych';

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

import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { generateMemoryBlock } from '../src/scheduler/memory-block.js';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { dOnlyTrial } from '../src/conditions/d_only.js';
import { tOnlyTrial } from '../src/conditions/t_only.js';
import { iDTrial } from '../src/conditions/i_d.js';
import { iTTrial } from '../src/conditions/i_t.js';
import {
  _resetStorageForTests,
  initStorage,
  appendTrialRow,
  getAllTrialRows,
} from '../src/storage.js';
import { PROBE_RESPONSE_MS } from '../src/conditions/shared.js';
import { stampFinishedTrial } from '../src/trial-finish.js';

const CONDITIONS = {
  d_only: {
    compose: dOnlyTrial,
    gen: () => generateMemoryBlock({ trialType: 'd_only', blockSize: 24 }),
  },
  t_only: {
    compose: tOnlyTrial,
    gen: () => generateMemoryBlock({ trialType: 't_only', blockSize: 24 }),
  },
  i_d: {
    compose: iDTrial,
    gen: () => generateDualBlock({ trialType: 'i_d', blockSize: 24 }),
  },
  i_t: {
    compose: iTTrial,
    gen: () => generateDualBlock({ trialType: 'i_t', blockSize: 24 }),
  },
};
const FAKE = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'Date',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];
const STEP_MS = 5;

/* What the participant does with probe k: [{ dt (ms after the probe is first seen), agree }]. */
const BEHAVIOUR = [
  [{ dt: 100, agree: true }],
  [],
  [
    { dt: 2950, agree: false },
    { dt: 2960, agree: true },
  ],
];

async function runTrial(cond, params) {
  document.body.innerHTML = '';
  const jsPsych = initJsPsych({
    on_trial_finish: stampFinishedTrial /* as src/runner.js does */,
    on_data_update: (d) => appendTrialRow(d).catch(() => {}),
  });
  window.jsPsych = jsPsych;
  const timeline = CONDITIONS[cond].compose(params);
  timeline.forEach((n) => {
    n.data = { ...(n.data ?? {}), block_label: 'main_a' };
  });
  const stars = [...(params.stars ?? [])].sort((a, b) => a.slot_index_in_seq - b.slot_index_in_seq);
  let done = false;
  const run = jsPsych.run(timeline).then(() => {
    done = true;
  });
  const keyLog = [];
  const tap = (key) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const release = (key) =>
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  const seenStars = new Set();
  const probeSeen = new Map(); /* trial -> { order, t, sent } */
  for (let t = 0; t < 150000 && !done; t += STEP_MS) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    const now = performance.now();
    if (document.querySelector('.trial-start-hint')) {
      tap('ArrowLeft');
      tap('ArrowRight');
      release('ArrowLeft');
      release('ArrowRight');
    }
    const el = document.querySelector('polygon.star');
    if (el && !seenStars.has(el)) {
      seenStars.add(el);
      const star = stars[seenStars.size - 1];
      setTimeout(() => tap(star.is_on_pattern ? 'ArrowRight' : 'ArrowLeft'), 700);
    }
    const trial = jsPsych.getCurrentTrial?.();
    if ((trial?.data?.phase ?? '').endsWith('_probe')) {
      if (!probeSeen.has(trial)) probeSeen.set(trial, { order: probeSeen.size, t: now, sent: 0 });
      const p = probeSeen.get(trial);
      const plan = BEHAVIOUR[p.order] ?? [];
      while (p.sent < plan.length && now - p.t >= plan[p.sent].dt) {
        const probe = params.probes[p.order];
        const right = plan[p.sent].agree ? probe.is_target : !probe.is_target;
        keyLog.push({
          order: p.order,
          key: right ? 'arrowright' : 'arrowleft',
          t: performance.now(),
        });
        tap(right ? 'ArrowRight' : 'ArrowLeft');
        p.sent += 1;
      }
    }
  }
  await run;
  /* No flush here on purpose. */
  return { rows: await getAllTrialRows(), keyLog };
}

beforeEach(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: FAKE });
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each(Object.keys(CONDITIONS))('%s: every probe row is complete', (cond) => {
  it('stores three probe rows, the last as complete as the first, and the final ITI row', async () => {
    setSessionPRNG(`probe-rows-${cond}`);
    resetSequencePools();
    const params = CONDITIONS[cond].gen()[0];
    const { rows, keyLog } = await runTrial(cond, params);
    const probes = rows.filter((r) => r.phase === `${cond}_probe`).sort((a, b) => a.seq - b.seq);
    expect(probes).toHaveLength(3);
    expect(probes.map((r) => r.probe_position)).toEqual([0, 1, 2]);

    probes.forEach((r, k) => {
      const planned = params.probes[k];
      expect(r.probed_cell).toBe(planned.cell);
      expect(r.is_target).toBe(planned.is_target);
      expect(r.probe_type).toBe(planned.type);
      expect(r.encoding_position).toBe(planned.encoding_position);
      expect(Number.isFinite(r.probe_onset_ts_ms)).toBe(true);
      expect(typeof r.responded).toBe('boolean');
      expect(typeof r.probe_correct).toBe('boolean');
      expect(r.wall_ms).toBeGreaterThan(0);
      expect('user_gain' in r).toBe(true);
      const inWindow = keyLog
        .filter(
          (x) =>
            x.order === k &&
            x.t >= r.probe_onset_ts_ms &&
            x.t < r.probe_onset_ts_ms + PROBE_RESPONSE_MS
        )
        .sort((a, b) => a.t - b.t);
      if (inWindow.length === 0) {
        expect(r.responded).toBe(false);
        expect(r.rt).toBeNull();
        expect(r.response).toBeNull();
        expect(r.said_yes).toBeNull();
        expect(r.probe_correct).toBe(false);
      } else {
        const first = inWindow[0];
        expect(r.responded).toBe(true);
        expect(r.response).toBe(first.key);
        expect(r.said_yes).toBe(first.key === 'arrowright');
        expect(r.probe_correct).toBe((first.key === 'arrowright') === planned.is_target);
        expect(Math.abs(r.rt - (first.t - r.probe_onset_ts_ms))).toBeLessThanOrEqual(2);
        expect(r.extra_keypresses).toBe(inWindow.length - 1);
      }
    });
    /* The three behaviours were all exercised. */
    expect(probes[0].responded).toBe(true);
    expect(probes[1].responded).toBe(false);
    expect(probes[2].responded).toBe(true);
    expect(probes[2].extra_keypresses).toBe(1);

    /* Nothing is held back: the last probe precedes the final ITI row, which is stored. */
    const iti = rows.filter((r) => r.phase === `${cond}_iti`);
    expect(iti).toHaveLength(1);
    expect(probes[2].seq).toBeLessThan(iti[0].seq);
    expect(rows[rows.length - 1].phase).toBe(`${cond}_iti`);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length);
  }, 120000);
});
