// @vitest-environment jsdom
/**
 * The last star of an imagery trial (I-only, I+D, I+T) must be recorded,
 * stored, uploaded in the right file and exported.
 *
 * Background: in the first run of this experiment the third star of an I+T
 * trial was shown but not recorded when it fell in the last (sixth) slot, so
 * half of the I+T trials lacked a star row. This test runs real trials whose
 * final slot holds a star on a fake clock, with a simulated participant who
 * answers (or does not answer) the last star in different ways, and follows
 * the rows through everything between the screen and the analyst:
 *
 *   jsPsych rows  ->  storage (as the runner mirrors them)  ->  upload buckets
 *   ->  JSON round trip  ->  tidy tables and wide CSV rows.
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
  flushPendingWrites,
  getAllTrialRows,
} from '../src/storage.js';
import { partitionRowsIntoBuckets } from '../src/uploader.js';
import { composeTidyTables } from '../scripts/tidy-tables.js';
import {
  groupTrialRows,
  buildWideRowIOnly,
  buildWideRowID,
  buildWideRowIT,
} from '../scripts/csv-export.js';
import { STAR_DURATION_MS } from '../src/conditions/shared.js';

const CONDITIONS = {
  i_only: {
    compose: iOnlyTrial,
    gen: (n) => generateImageryBlock({ blockSize: n }),
    bucket: '04_i_only_star_only',
    wide: buildWideRowIOnly,
  },
  i_d: {
    compose: iDTrial,
    gen: (n) => generateDualBlock({ trialType: 'i_d', blockSize: n }),
    bucket: '07_i_d_dual_dot_star',
    wide: buildWideRowID,
  },
  i_t: {
    compose: iTTrial,
    gen: (n) => generateDualBlock({ trialType: 'i_t', blockSize: n }),
    bucket: '06_i_t_dual_tone_star',
    wide: buildWideRowIT,
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
const STEP_MS = 10;
const LAST_SLOT = 5; /* six slots, numbered 0..5 */

/** A trial whose sequence ends in a star slot (the case that was lost before). */
function trialEndingInStar(cond) {
  setSessionPRNG(`last-star-${cond}`);
  resetSequencePools();
  const block = CONDITIONS[cond].gen(24);
  const t = block.find((p) => p.sequence[p.sequence.length - 1] === 'S');
  if (!t) throw new Error(`no ${cond} trial ending in a star`);
  expect(t.stars.some((s) => s.slot_index_in_seq === LAST_SLOT)).toBe(true);
  return t;
}

/**
 * Run one trial. `lastStar` says what the participant does with the last
 * star: { rtMs, correct } to answer it `rtMs` after its onset (correct or
 * not), or null for no answer. The other stars are answered correctly at
 * 700 ms. Rows are mirrored to storage the way src/runner.js does it.
 */
async function runTrial(cond, params, lastStar) {
  document.body.innerHTML = '';
  const jsPsych = initJsPsych({
    on_data_update: (datum) => {
      appendTrialRow(datum).catch(() => {});
    },
  });
  window.jsPsych = jsPsych;
  const timeline = CONDITIONS[cond].compose(params);
  timeline.forEach((n) => {
    n.data = { ...(n.data ?? {}), block_label: 'main_a' };
  });
  const starsInOrder = [...params.stars].sort((a, b) => a.slot_index_in_seq - b.slot_index_in_seq);

  let done = false;
  const runP = jsPsych.run(timeline).then(() => {
    done = true;
  });
  const press = (key) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const release = (key) =>
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));

  const seen = new Map(); /* star element -> { index, t, done } */
  const probeSeen = new Map();
  for (let t = 0; t < 120000 && !done; t += STEP_MS) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    const now = performance.now();
    if (document.querySelector('.trial-start-hint')) {
      press('ArrowLeft');
      press('ArrowRight');
      release('ArrowLeft');
      release('ArrowRight');
    }
    const el = document.querySelector('polygon.star');
    if (el) {
      if (!seen.has(el)) seen.set(el, { index: seen.size, t: now, done: false });
      const s = seen.get(el);
      const star = starsInOrder[s.index];
      const isLast = s.index === starsInOrder.length - 1;
      const correctKey = star.is_on_pattern ? 'ArrowRight' : 'ArrowLeft';
      const wrongKey = star.is_on_pattern ? 'ArrowLeft' : 'ArrowRight';
      let plan = { rtMs: 700, key: correctKey };
      if (isLast) {
        plan = lastStar
          ? { rtMs: lastStar.rtMs, key: lastStar.correct ? correctKey : wrongKey }
          : null;
      }
      if (plan && !s.done && now - s.t >= plan.rtMs) {
        s.done = true;
        press(plan.key);
      }
    }
    const trial = jsPsych.getCurrentTrial?.();
    const phase = trial?.data?.phase ?? '';
    if (phase.endsWith('_probe')) {
      if (!probeSeen.has(trial)) probeSeen.set(trial, { t: now, done: false });
      const p = probeSeen.get(trial);
      if (!p.done && now - p.t >= 600) {
        p.done = true;
        press('ArrowRight');
      }
    }
  }
  await runP;
  await flushPendingWrites();
  const jsPsychRows = jsPsych.data.get().values();
  const stored = await getAllTrialRows();
  return { jsPsychRows, stored, starsInOrder };
}

const isStar = (r) => (r.phase ?? '').endsWith('_star');

beforeEach(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: FAKE });
});
afterEach(() => {
  vi.useRealTimers();
});

const VARIANTS = [
  {
    name: 'answered correctly at 700 ms',
    lastStar: { rtMs: 700, correct: true },
    check: (row, star) => {
      expect(row.responded).toBe(true);
      expect(row.star_correct).toBe(true);
      expect(row.response_rt_ms).toBeGreaterThanOrEqual(690);
      expect(row.response_rt_ms).toBeLessThanOrEqual(720);
      expect(row.response_key).toBe(star.is_on_pattern ? 'arrowright' : 'arrowleft');
    },
  },
  {
    name: 'answered as late as the window allows (2950 ms)',
    lastStar: { rtMs: 2950, correct: true },
    check: (row) => {
      expect(row.responded).toBe(true);
      expect(row.star_correct).toBe(true);
      expect(row.response_rt_ms).toBeGreaterThanOrEqual(2940);
      expect(row.response_rt_ms).toBeLessThan(STAR_DURATION_MS);
      expect(row.late_keypresses).toBe(0);
    },
  },
  {
    name: 'answered wrongly',
    lastStar: { rtMs: 900, correct: false },
    check: (row, star) => {
      expect(row.responded).toBe(true);
      expect(row.star_correct).toBe(false);
      expect(row.said_on).toBe(!star.is_on_pattern);
      expect(row.response_rt_ms).toBeGreaterThan(0);
    },
  },
  {
    name: 'not answered',
    lastStar: null,
    check: (row) => {
      /* The row must still exist: a miss is data, a missing row is a loss. */
      expect(row.responded).toBe(false);
      expect(row.response_rt_ms).toBeNull();
      expect(row.star_correct).toBe(false);
      expect(row.displayed).toBe(true);
      expect(row.truncated).toBe(false);
    },
  },
];

describe.each(Object.keys(CONDITIONS))('%s: the last star is recorded and exported', (cond) => {
  describe.each(VARIANTS)('last star $name', (variant) => {
    it('has a row in jsPsych and in storage, in the right bucket, and in the exported tables', async () => {
      const params = trialEndingInStar(cond);
      const { jsPsychRows, stored, starsInOrder } = await runTrial(cond, params, variant.lastStar);
      const lastPlanned = starsInOrder[starsInOrder.length - 1];
      expect(lastPlanned.slot_index_in_seq).toBe(LAST_SLOT);

      /* 1. jsPsych: one row per planned star, the last one included. */
      const stars = jsPsychRows.filter(isStar);
      expect(stars).toHaveLength(params.stars.length);
      expect(stars.map((r) => r.slot_index_in_seq).sort()).toEqual(
        params.stars.map((s) => s.slot_index_in_seq).sort()
      );
      const last = stars.find((r) => r.slot_index_in_seq === LAST_SLOT);
      expect(last).toBeDefined();
      expect(last.probed_cell).toBe(lastPlanned.cell);
      expect(last.pattern_label).toBe(lastPlanned.pattern_label);
      expect(last.is_on_pattern).toBe(lastPlanned.is_on_pattern);
      expect(last.probe_position).toBe(params.stars.length - 1);
      expect(last.star_onset_ts_ms).toBeGreaterThan(0);
      expect(last.window_closed_ts_ms).toBeGreaterThan(last.star_onset_ts_ms);
      /* The window of the last star is as long as the others'. */
      for (const r of stars) {
        expect(r.window_closed_ts_ms - r.star_onset_ts_ms).toBeGreaterThanOrEqual(
          STAR_DURATION_MS - 20
        );
        expect(r.window_closed_ts_ms - r.star_onset_ts_ms).toBeLessThanOrEqual(
          STAR_DURATION_MS + 100
        );
      }
      variant.check(last, lastPlanned);

      /* The encoding row counts the star rows it wrote, so an analyst can see a loss. */
      const enc = stored.find((r) => (r.phase ?? '').endsWith('_encoding'));
      expect(enc.n_star_rows).toBe(params.stars.length);
      expect(enc.n_star_rows_expected).toBe(params.stars.length);

      /* 2. Storage holds exactly the same star rows, once each. */
      const storedStars = stored.filter(isStar);
      expect(storedStars).toHaveLength(params.stars.length);
      const storedLast = storedStars.find((r) => r.slot_index_in_seq === LAST_SLOT);
      expect(storedLast).toBeDefined();
      expect(storedLast.responded).toBe(last.responded);
      expect(storedLast.response_rt_ms).toBe(last.response_rt_ms);
      expect(storedLast.star_correct).toBe(last.star_correct);
      expect(storedLast.star_onset_ts_ms).toBe(last.star_onset_ts_ms);
      expect(new Set(stored.map((r) => r.seq)).size).toBe(stored.length);

      /* 3. Upload: the star rows travel in this condition's own file. */
      const parts = partitionRowsIntoBuckets(stored);
      const mine = parts.find((p) => p.bucket.label === CONDITIONS[cond].bucket);
      expect(mine.rows.filter(isStar)).toHaveLength(params.stars.length);
      expect(mine.rows.some((r) => isStar(r) && r.slot_index_in_seq === LAST_SLOT)).toBe(true);
      for (const p of parts) {
        if (p !== mine) expect(p.rows.filter(isStar)).toHaveLength(0);
      }
      const uploaded = JSON.parse(JSON.stringify(mine.rows));

      /* 4. Export: tidy tables. */
      const tidy = composeTidyTables([{ participant_id: 'P1', session: {}, rows: uploaded }]);
      expect(tidy.trials).toHaveLength(1);
      expect(tidy.trials[0].n_star_rows).toBe(params.stars.length);
      expect(tidy.trials[0].n_stars_missing_row).toBe(0);
      expect(tidy.stars).toHaveLength(params.stars.length);
      /* The tidy tables number slots and serial positions from 1. */
      const tidyLast = tidy.stars.find((s) => s.slot === LAST_SLOT + 1);
      expect(tidyLast).toBeDefined();
      expect(tidyLast.star_serial_position).toBe(params.stars.length);
      expect(tidyLast.row_recorded).toBe(true);
      expect(tidyLast.responded).toBe(variant.lastStar !== null);
      expect(tidyLast.cell).toBe(lastPlanned.cell);
      expect(tidyLast.displayed).toBe(true);

      /* 5. Export: wide CSV row (the Ast_3 block is the last star). */
      const groups = [...groupTrialRows(new Map([['P1', uploaded]])).values()];
      expect(groups).toHaveLength(1);
      expect(groups[0].stars).toHaveLength(params.stars.length);
      for (const criterion of [1, 2]) {
        const wide = CONDITIONS[cond].wide(groups[0], criterion);
        const n = params.stars.length;
        expect(wide[`Ast_${n}_Cell`]).not.toBe('NA');
        expect(wide[`Ast_${n}_OnsetMs`]).not.toBe('NA');
        if (variant.lastStar) expect(wide[`Ast_${n}_Key`]).not.toBe('NA');
      }
    }, 60000);
  });
});
