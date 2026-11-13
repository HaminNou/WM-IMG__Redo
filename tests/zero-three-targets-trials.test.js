// @vitest-environment jsdom
/**
 * Trials with 0 targets (three foils) and 3 targets (no foil), built by the real generators and run
 * through the real jsPsych timeline on a fake clock, in all four memory tasks (D-only, T-only, I+D,
 * I+T): what the probe windows show, the scoring, the feedback colours, the recorded rows, the
 * practice accuracy, the debug trace and the practice response buttons.
 *
 * Nothing is hand-crafted: the trials are found by scanning the generated main plan (and the
 * generated practice blocks) for a trial with the wanted number of targets.
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
import { runTrial, REAL_FAKE_TIMERS } from './helpers/real-rows.js';
import { _setTraceEnabled, _openGroupDepth, _resetTraceState } from '../src/debug/trace.js';
import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';
import { singleTypePractice, computePracticeAccuracy } from '../src/scheduler/practice.js';
import { playToneByCell } from '../src/audio/tones.js';
import {
  KEY_YES,
  KEY_NO,
  FEEDBACK_COLOR_CORRECT,
  FEEDBACK_COLOR_WRONG,
} from '../src/conditions/shared.js';

const TASKS = ['d_only', 't_only', 'i_d', 'i_t'];
const TONE = new Set(['t_only', 'i_t']);
const METHODS = ['log', 'info', 'warn', 'error', 'group', 'groupCollapsed', 'groupEnd', 'table'];
const nTargets = (p) => p.probes.filter((x) => x.is_target).length;

afterEach(() => {
  _setTraceEnabled(false);
  _resetTraceState();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** First trial of each task with 0 and with 3 targets in the generated main plan. */
function mainTrials() {
  setSessionPRNG('zero-three-targets');
  resetSequencePools();
  const plan = generateMainPlan({});
  const out = {};
  for (const block of [plan.mainA, plan.mainB]) {
    block.trialParams.forEach((p, i) => {
      const cond = block.schedule[i];
      if (!TASKS.includes(cond)) return;
      const n = nTargets(p);
      if (n === 0 || n === 3) out[`${cond}:${n}`] ??= p;
    });
  }
  return out;
}
const MAIN = mainTrials();

/** The second practice trial of a task with `n` targets, found by scanning seeds. */
function practiceTrial(cond, n) {
  for (let s = 0; s < 400; s++) {
    setSessionPRNG(`zero-three-practice-${cond}-${s}`);
    resetSequencePools();
    const p = singleTypePractice({ trialType: cond, trialsPerType: 2 }).trialParams[1];
    if (nTargets(p) === n) return p;
  }
  return null;
}

const correctKey = (probe) => (probe.is_target ? 'ArrowRight' : 'ArrowLeft');
const wrongKey = (probe) => (probe.is_target ? 'ArrowLeft' : 'ArrowRight');
const lower = (s) => String(s ?? '').toLowerCase();

/**
 * Run a trial. `answers[i]` is 'correct' | 'wrong' | 'none' for probe i. While a probe window is
 * open the DOM is sampled: the probe dot (dot tasks), the colour of the fixation mark (tone tasks),
 * the response buttons (practice).
 */
async function run(cond, params, answers, { debug = false } = {}) {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: REAL_FAKE_TIMERS });
  const calls = [];
  for (const m of METHODS)
    vi.spyOn(console, m).mockImplementation((...args) => calls.push({ m, args }));
  _resetTraceState();
  _setTraceEnabled(debug);
  playToneByCell.mockClear();
  const seen = [];
  const keyFor = (i) => {
    const a = answers[i];
    if (a === 'none') return null;
    return a === 'correct' ? correctKey(params.probes[i]) : wrongKey(params.probes[i]);
  };
  const { rows } = await runTrial(cond, params, {
    probeRtMs: 600,
    starRtMs: 700,
    probeKeyFor: keyFor,
    onStep: ({ phase, order }) => {
      if (!phase.endsWith('_probe') || order === null) return;
      const o = (seen[order] ??= { dotCells: new Set(), dotFill: null, fixFill: null, buttons: 0 });
      const dots = [...document.querySelectorAll('circle.dot')];
      dots.forEach((d) => o.dotCells.add(Number(d.dataset.cellIndex)));
      if (dots.length) o.dotFill = lower(dots[dots.length - 1].getAttribute('fill'));
      /* the feedback colour stays on the fixation mark until the window closes, then it resets */
      const fix = lower(document.querySelector('.grid-fixation')?.getAttribute('fill'));
      if (fix === lower(FEEDBACK_COLOR_CORRECT) || fix === lower(FEEDBACK_COLOR_WRONG)) {
        o.fixFill = fix;
      } else o.fixFill ??= fix;
      if (document.querySelector('.trial-response-buttons')) o.buttons += 1;
    },
  });
  _setTraceEnabled(false);
  const toneCalls = playToneByCell.mock.calls.filter((c) => c[1] === undefined).map((c) => c[0]);
  vi.useRealTimers();
  return { rows, seen, calls, toneCalls };
}

const probeRows = (rows) =>
  rows
    .filter((r) => /_probe$/.test(r.phase ?? ''))
    .sort((a, b) => a.probe_position - b.probe_position);

describe('the generator really yields 0- and 3-target trials for every task', () => {
  it.each(TASKS)('%s', (cond) => {
    expect(MAIN[`${cond}:0`], 'no 0-target trial').toBeTruthy();
    expect(MAIN[`${cond}:3`], 'no 3-target trial').toBeTruthy();
    expect(MAIN[`${cond}:0`].probes.every((p) => !p.is_target && /^F_/.test(p.type))).toBe(true);
    expect(MAIN[`${cond}:3`].probes.every((p) => p.is_target && /^T_/.test(p.type))).toBe(true);
  });
});

describe.each(TASKS)('%s, real timeline', (cond) => {
  it.each([
    [0, ['correct', 'wrong', 'correct']],
    [3, ['wrong', 'correct', 'none']],
  ])(
    '%i targets: windows, scoring, colours and rows',
    async (n, answers) => {
      const params = MAIN[`${cond}:${n}`];
      const { rows, seen, toneCalls } = await run(cond, params, answers);
      const encoded = new Set(params.memory_items.map((m) => m.cell));
      const prow = probeRows(rows);
      expect(prow).toHaveLength(3);

      prow.forEach((r, i) => {
        const pl = params.probes[i];
        const a = answers[i];
        expect(r.probe_position).toBe(i);
        expect(r.is_target).toBe(n === 3);
        expect(r.probe_type).toBe(pl.type);
        expect(r.probe_type.startsWith(n === 3 ? 'T_' : 'F_')).toBe(true);
        expect(r.probed_cell).toBe(pl.cell);
        /* target probes sit on an encoded cell, foils never do */
        expect(encoded.has(r.probed_cell)).toBe(n === 3);
        if (a === 'none') {
          expect(r.responded).toBe(false);
          expect(r.said_yes).toBe(null);
          expect(r.probe_correct).toBe(false);
          expect(r.response).toBe(null);
        } else {
          const key = a === 'correct' ? correctKey(pl) : wrongKey(pl);
          expect(lower(r.response)).toBe(lower(key));
          expect(r.responded).toBe(true);
          expect(r.said_yes).toBe(lower(key) === KEY_YES);
          expect(r.probe_correct).toBe(a === 'correct');
          expect(r.rt).toBeGreaterThanOrEqual(570);
          expect(r.rt).toBeLessThanOrEqual(650);
        }
        /* the window: 3 s of response time, one key accepted */
        expect(r.late_keypresses).toBe(0);
        expect(r.extra_keypresses).toBe(0);

        /* what the window showed */
        const o = seen[i];
        expect(o, `probe ${i} observed`).toBeTruthy();
        if (TONE.has(cond)) {
          expect(o.dotCells.size).toBe(0);
          expect(toneCalls[i]).toBe(pl.cell);
        } else {
          expect([...o.dotCells]).toEqual([pl.cell]);
          expect(encoded.has([...o.dotCells][0])).toBe(n === 3);
        }
        /* feedback colour = recorded correctness; no colour without an answer */
        const colour = TONE.has(cond) ? o.fixFill : o.dotFill;
        if (a === 'none') {
          expect(colour).not.toBe(lower(FEEDBACK_COLOR_CORRECT));
          expect(colour).not.toBe(lower(FEEDBACK_COLOR_WRONG));
        } else {
          expect(colour).toBe(
            lower(r.probe_correct ? FEEDBACK_COLOR_CORRECT : FEEDBACK_COLOR_WRONG)
          );
        }
        /* no response buttons in a main trial */
        expect(o.buttons).toBe(0);
      });
      if (TONE.has(cond)) expect(toneCalls).toEqual(params.probes.map((p) => p.cell));

      /* the accuracy helper counts exactly the three probes (and stars, if any) */
      const acc = computePracticeAccuracy(rows);
      const stars = rows.filter((r) => /_star$/.test(r.phase ?? ''));
      const expectCorrect =
        answers.filter((a) => a === 'correct').length + stars.filter((r) => r.star_correct).length;
      expect(acc.total).toBe(3 + stars.length);
      expect(acc.correct).toBe(expectCorrect);

      /* the encoding row carries the planned probes with is_target as generated */
      const enc = rows.find((r) => /_encoding$/.test(r.phase));
      const spec = enc.trial_spec ?? enc;
      if (spec.probes) expect(spec.probes.map((p) => p.is_target)).toEqual(Array(3).fill(n === 3));
    },
    120000
  );

  it.each([0, 3])(
    'debug trace, %i targets: TEST lines, answers, recall table, summary',
    async (n) => {
      const params = MAIN[`${cond}:${n}`];
      const answers = n === 0 ? ['wrong', 'correct', 'correct'] : ['correct', 'correct', 'wrong'];
      const { rows, calls } = await run(cond, params, answers, { debug: true });
      const text = (c) => (typeof c.args[0] === 'string' ? c.args[0].replace(/%c/g, '') : '');
      const L = calls.map((c) => ({ m: c.m, t: text(c), c }));
      const prow = probeRows(rows);
      expect(L.filter((l) => l.m === 'group').length).toBe(
        L.filter((l) => l.m === 'groupEnd').length
      );
      expect(_openGroupDepth()).toBe(0);
      expect(L.filter((l) => l.m === 'error' || l.m === 'warn')).toEqual([]);
      const tests = L.filter((l) => /TEST \d\/3/.test(l.t));
      expect(tests).toHaveLength(3);
      tests.forEach((l) => expect(l.t).toContain(n === 3 ? 'TARGET' : 'FOIL'));
      tests.forEach((l, i) => expect(l.t).toContain(prow[i].probe_type));
      const answered = L.filter((l) => /correct answer (YES|NO)/.test(l.t));
      expect(answered).toHaveLength(3);
      answered.forEach((l, i) => {
        expect(l.t).toContain(`correct answer ${n === 3 ? 'YES' : 'NO'}`);
        expect(l.t).toContain(prow[i].probe_correct ? 'GREEN' : 'RED');
      });
      const tables = L.filter((l) => l.m === 'table').map((l) => l.c.args[0]);
      expect(tables[1].map((r) => r.role)).toEqual(Array(3).fill(n === 3 ? 'T' : 'F'));
      /* the encoding plan: the items are tested at test #k only when they are targets */
      const tested = tables[0].filter((r) => /^test #\d$/.test(r.tested));
      expect(tested).toHaveLength(n === 3 ? 3 : 0);
      const mc = prow.filter((r) => r.probe_correct).length;
      expect(L.find((l) => l.t.startsWith('SUMMARY')).t).toContain(`memory ${mc}/3`);
    },
    120000
  );
});

describe.each(TASKS)('%s, practice trial with 0 / 3 targets', (cond) => {
  it.each([
    [0, ['correct', 'wrong', 'correct']],
    [3, ['correct', 'correct', 'wrong']],
  ])(
    '%i targets: buttons, feedback, accuracy',
    async (n, answers) => {
      const params = practiceTrial(cond, n);
      expect(params, `no ${n}-target practice trial found`).toBeTruthy();
      const { rows, seen } = await run(cond, params, answers);
      const prow = probeRows(rows);
      expect(prow.map((r) => r.is_target)).toEqual(Array(3).fill(n === 3));
      expect(prow.map((r) => r.probe_correct)).toEqual(answers.map((a) => a === 'correct'));
      /* the practice response buttons are up in every probe window */
      seen.forEach((o) => expect(o.buttons).toBeGreaterThan(0));
      const acc = computePracticeAccuracy(rows);
      const stars = rows.filter((r) => /_star$/.test(r.phase ?? ''));
      expect(acc.total).toBe(3 + stars.length);
      expect(acc.correct).toBe(
        answers.filter((a) => a === 'correct').length + stars.filter((r) => r.star_correct).length
      );
      expect(KEY_NO).toBe('arrowleft');
    },
    120000
  );
});
