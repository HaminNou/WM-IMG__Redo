// @vitest-environment jsdom
/**
 * Every star of an imagery encoding node is recorded exactly once, whichever of
 * the six slots it occupies (1st..6th event) and however the participant
 * answers it.
 *
 * The first run of the study lost star rows in some conditions and slots, and
 * the last event of a trial in some cases. last-star-recorded.test.js covers
 * the sixth slot; this file covers all six slots in I-only, I+D and I+T with
 * three kinds of participant on one fake clock:
 *
 *   - first-frame responder: the key is dispatched in the same task in which
 *     the star is inserted (the earliest response the page can see);
 *   - non-responder: no key at all (row must exist, `responded: false`);
 *   - late responder: a key 2950 ms after onset, plus a second key (double press).
 *
 * Checked per star: one row, in storage, written before the node finishes,
 * with onset equal to the slot onset on the encoding row, the planned cell,
 * on/off label, serial position, and the response, RT and correctness that the
 * simulated participant's own key log predicts.
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
import { generateImageryBlock } from '../src/scheduler/imagery-block.js';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { iOnlyTrial } from '../src/conditions/i_only.js';
import { iDTrial } from '../src/conditions/i_d.js';
import { iTTrial } from '../src/conditions/i_t.js';
import {
  _resetStorageForTests,
  initStorage,
  appendTrialRow,
  getAllTrialRows,
} from '../src/storage.js';
import { STAR_DURATION_MS } from '../src/conditions/shared.js';

const CONDITIONS = {
  i_only: { compose: iOnlyTrial, gen: (n) => generateImageryBlock({ blockSize: n }) },
  i_d: { compose: iDTrial, gen: (n) => generateDualBlock({ trialType: 'i_d', blockSize: n }) },
  i_t: { compose: iTTrial, gen: (n) => generateDualBlock({ trialType: 'i_t', blockSize: n }) },
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

/** Trials of a 24-trial block that together put a star in each of the slots 0..5. */
function trialsCoveringEverySlot(cond) {
  setSessionPRNG(`every-slot-${cond}`);
  resetSequencePools();
  const block = CONDITIONS[cond].gen(24);
  const covered = new Set();
  const chosen = [];
  for (const p of block) {
    if (p.stars.some((s) => !covered.has(s.slot_index_in_seq))) {
      chosen.push(p);
      p.stars.forEach((s) => covered.add(s.slot_index_in_seq));
    }
  }
  expect([...covered].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  return chosen;
}

/**
 * Run only the encoding node of a trial. `plan(order)` gives the participant's
 * behaviour for the order-th star of the trial: null (no key) or
 * { dt, key: 'ok'|'bad', extra?: [{dt, key}] }.
 */
async function runEncoding(cond, params, plan) {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  document.body.innerHTML = '';
  const jsPsych = initJsPsych({ on_data_update: (d) => appendTrialRow(d).catch(() => {}) });
  window.jsPsych = jsPsych;
  const node = CONDITIONS[cond]
    .compose(params)
    .find((n) => (n.data?.phase ?? '').endsWith('_encoding'));
  node.data = { ...node.data, block_label: 'main_a' };
  const starsInOrder = [...params.stars].sort((a, b) => a.slot_index_in_seq - b.slot_index_in_seq);
  const keyLog = []; /* { order, key, t } */
  const seen = new Map();
  let done = false;
  const run = jsPsych.run([node]).then(() => {
    done = true;
  });
  const tap = (key) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const send = (order, a, star) => {
    const right = a.key === 'ok' ? star.is_on_pattern : !star.is_on_pattern;
    const key = right ? 'ArrowRight' : 'ArrowLeft';
    keyLog.push({ order, key: key.toLowerCase(), t: performance.now() });
    tap(key);
  };
  /* Observe the DOM so that a dt = 0 key is sent in the star's own first frame. */
  const mo = new MutationObserver(() => {
    const el = document.querySelector('polygon.star');
    if (!el || seen.has(el)) return;
    const order = seen.size;
    seen.set(el, order);
    const a = plan(order);
    if (!a) return;
    const star = starsInOrder[order];
    for (const x of [a, ...(a.extra ?? [])]) {
      if (x.dt === 0) send(order, x, star);
      else setTimeout(() => send(order, x, star), x.dt);
    }
  });
  mo.observe(document.body, { subtree: true, childList: true });
  for (let t = 0; t < 40000 && !done; t += STEP_MS) await vi.advanceTimersByTimeAsync(STEP_MS);
  mo.disconnect();
  await run;
  /* No flush: the rows must already be in storage when the node has finished. */
  const rows = await getAllTrialRows();
  return { rows, keyLog, starsInOrder, jsPsychRows: jsPsych.data.get().values() };
}

beforeEach(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: FAKE });
});
afterEach(() => {
  vi.useRealTimers();
});

const PARTICIPANTS = [
  ['first-frame responder', () => ({ dt: 0, key: 'ok' })],
  ['non-responder', () => null],
  [
    'late responder with a double press',
    () => ({ dt: 2950, key: 'bad', extra: [{ dt: 2960, key: 'ok' }] }),
  ],
];

describe.each(Object.keys(CONDITIONS))('%s: a star in any slot is recorded', (cond) => {
  describe.each(PARTICIPANTS)('%s', (_name, makePlan) => {
    it('writes one complete row per star, in every slot, before the node ends', async () => {
      const slotsSeen = new Set();
      for (const params of trialsCoveringEverySlot(cond)) {
        const { rows, keyLog, starsInOrder, jsPsychRows } = await runEncoding(
          cond,
          params,
          makePlan
        );
        const stars = rows.filter((r) => (r.phase ?? '').endsWith('_star'));
        const enc = rows.find((r) => (r.phase ?? '').endsWith('_encoding'));
        expect(stars).toHaveLength(params.stars.length);
        expect(jsPsychRows.filter((r) => (r.phase ?? '').endsWith('_star'))).toHaveLength(
          params.stars.length
        );
        expect(enc.n_star_rows).toBe(params.stars.length);
        expect(enc.slot_onsets_ts_ms.every(Number.isFinite)).toBe(true);
        /* Star rows reach storage before the encoding row, i.e. before the next phase. */
        for (const s of stars) expect(s.seq).toBeLessThan(enc.seq);

        starsInOrder.forEach((planned, order) => {
          const row = stars.filter((r) => r.slot_index_in_seq === planned.slot_index_in_seq);
          expect(row).toHaveLength(1);
          const r = row[0];
          slotsSeen.add(planned.slot_index_in_seq);
          expect(r.probe_position).toBe(order);
          expect(r.probed_cell).toBe(planned.cell);
          expect(r.is_on_pattern).toBe(planned.is_on_pattern);
          expect(r.displayed).toBe(true);
          expect(r.truncated).toBe(false);
          expect(r.star_onset_ts_ms).toBe(enc.slot_onsets_ts_ms[planned.slot_index_in_seq]);
          expect(r.window_closed_ts_ms - r.star_onset_ts_ms).toBeGreaterThanOrEqual(
            STAR_DURATION_MS - 20
          );
          expect(Number.isFinite(r.star_x_mm) && Number.isFinite(r.star_y_mm)).toBe(true);
          /* What the participant's own key log predicts. */
          const inWindow = keyLog
            .filter(
              (k) =>
                k.order === order &&
                k.t >= r.star_onset_ts_ms &&
                k.t < r.star_onset_ts_ms + STAR_DURATION_MS
            )
            .sort((a, b) => a.t - b.t);
          if (inWindow.length === 0) {
            expect(r.responded).toBe(false);
            expect(r.response_rt_ms).toBeNull();
            expect(r.response_key).toBeNull();
            expect(r.star_correct).toBe(false);
          } else {
            const first = inWindow[0];
            expect(r.responded).toBe(true);
            expect(r.response_key).toBe(first.key);
            expect(r.said_on).toBe(first.key === 'arrowright');
            expect(r.star_correct).toBe((first.key === 'arrowright') === planned.is_on_pattern);
            expect(Math.abs(r.response_rt_ms - (first.t - r.star_onset_ts_ms))).toBeLessThanOrEqual(
              2
            );
            expect(r.response_rt_ms).toBeGreaterThanOrEqual(1);
            expect(r.extra_keypresses).toBe(inWindow.length - 1);
          }
        });
      }
      expect([...slotsSeen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    }, 120000);
  });
});
