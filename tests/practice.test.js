/**
 * Tests for src/scheduler/practice.js — the practice block + accuracy-gated
 * re-loop. Two layers of testing:
 *
 *   1. `computePracticeAccuracy` is a pure helper, tested directly with
 *      hand-built trial-data arrays. Covers: empty input, mixed phases,
 *      false-vs-undefined distinction, simultaneous probe + star fields.
 *
 *   2. `practiceBlock()` returns a jsPsych timeline node whose
 *      `loop_function` we exercise by:
 *        a. calling the marker node's `on_start` to advance the iteration
 *           counter (the same way jsPsych v8 would call it at runtime);
 *        b. invoking `loop_function` with a fake DataCollection that has the
 *           same `.values()` shape jsPsych supplies.
 *      This avoids spinning up a full jsPsych runtime while still exercising
 *      the closure-based iteration tracking and the loop decision logic.
 *
 * @vitest-environment jsdom
 *
 * jsdom is required because practice.js transitively imports the per-condition
 * trial composers (jsPsych v8 plugin side-effects touch `window`). The marker
 * node's `on_start` also reads `window.jsPsych?.data?.get().count()`; in this
 * test environment `window.jsPsych` is undefined, which the optional-chain
 * fallback (`?? 0`) handles correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  practiceBlock,
  singleTypePractice,
  computePracticeAccuracy,
  formatPracticeFeedbackHtml,
} from '../src/scheduler/practice.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { setSessionPRNG } from '../src/prng.js';
import { config } from '../src/config.js';

const ALL_TYPES = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];
const DEFAULT_PER_TYPE = config.blocks.practice_trials_per_type;

beforeEach(() => {
  setSessionPRNG('practice-test-seed');
  resetSequencePools();
  /* jsPsych v8 installs a throwing migration getter on `window.jsPsych` at
   * import time. We never run jsPsych in tests, but the marker node's
   * `on_start` reads `window.jsPsych?.data?.get().count()` — accessing the
   * getter would throw. Override the property with a minimal stub so the
   * read returns 0 without throwing. */
  Object.defineProperty(window, 'jsPsych', {
    value: { data: { get: () => ({ count: () => 0, values: () => [] }) } },
    configurable: true,
    writable: true,
  });
});

describe('computePracticeAccuracy', () => {
  it('returns zero accuracy for empty input', () => {
    expect(computePracticeAccuracy([])).toEqual({ correct: 0, total: 0, accuracy: 0 });
  });

  it('ignores rows without probe_correct or star_correct', () => {
    const data = [{ phase: 'iti' }, { phase: 'pattern_phase' }, { phase: 'd_only_encoding' }];
    expect(computePracticeAccuracy(data)).toEqual({ correct: 0, total: 0, accuracy: 0 });
  });

  it('counts only boolean probe_correct fields, ignoring undefined', () => {
    const data = [
      { phase: 'foo' },
      { probe_correct: true },
      { probe_correct: false },
      { phase: 'bar', probe_correct: undefined },
    ];
    expect(computePracticeAccuracy(data)).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
  });

  it('counts star_correct fields the same way', () => {
    const data = [{ star_correct: true }, { star_correct: true }, { star_correct: false }];
    expect(computePracticeAccuracy(data)).toEqual({
      correct: 2,
      total: 3,
      accuracy: 2 / 3,
    });
  });

  it('treats false as a counted incorrect, not as missing', () => {
    /* Per-condition judges return {responded: false, correct: false} for
     * non-responses, so a non-response is `*_correct: false` — it must count
     * as one wrong trial, not be silently dropped. */
    const data = [{ probe_correct: false }, { star_correct: false }];
    expect(computePracticeAccuracy(data)).toEqual({ correct: 0, total: 2, accuracy: 0 });
  });

  it('combines probe and star events from the same iteration', () => {
    const data = [
      { probe_correct: true },
      { probe_correct: true },
      { star_correct: true },
      { star_correct: false },
    ];
    expect(computePracticeAccuracy(data)).toEqual({
      correct: 3,
      total: 4,
      accuracy: 0.75,
    });
  });

  it('counts both fields when (hypothetically) on the same row', () => {
    /* Edge case: condition composers don't currently emit rows with both
     * fields, but if they ever did, both should count. */
    const data = [{ probe_correct: true, star_correct: false }];
    expect(computePracticeAccuracy(data)).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
  });
});

describe('practiceBlock structure', () => {
  it('returns timelineNode, schedule, trialParams', () => {
    const p = practiceBlock();
    expect(p).toHaveProperty('timelineNode');
    expect(p).toHaveProperty('schedule');
    expect(p).toHaveProperty('trialParams');
  });

  it('produces (per_type × 5) trials with default config', () => {
    const p = practiceBlock();
    expect(p.schedule).toHaveLength(DEFAULT_PER_TYPE * 5);
    expect(p.trialParams).toHaveLength(DEFAULT_PER_TYPE * 5);
  });

  it('produces exactly per_type of each trial type', () => {
    const p = practiceBlock();
    const counts = {};
    for (const t of p.schedule) counts[t] = (counts[t] ?? 0) + 1;
    for (const type of ALL_TYPES) expect(counts[type]).toBe(DEFAULT_PER_TYPE);
  });

  it('respects a trialsPerType override', () => {
    const p = practiceBlock({ trialsPerType: 1 });
    expect(p.schedule).toHaveLength(5);
    const counts = {};
    for (const t of p.schedule) counts[t] = (counts[t] ?? 0) + 1;
    for (const type of ALL_TYPES) expect(counts[type]).toBe(1);
  });

  it('schedule slots match trialParams trial_type 1:1', () => {
    const p = practiceBlock();
    for (let i = 0; i < p.schedule.length; i++) {
      expect(p.trialParams[i].trial_type).toBe(p.schedule[i]);
    }
  });

  it('timelineNode has the jsPsych v8 timeline + loop_function shape', () => {
    const p = practiceBlock();
    expect(Array.isArray(p.timelineNode.timeline)).toBe(true);
    expect(typeof p.timelineNode.loop_function).toBe('function');
    /* timeline[0] is the iteration-start marker; timeline[last] is feedback. */
    expect(p.timelineNode.timeline.length).toBeGreaterThan(2);
  });

  it('first timeline entry is the iteration marker (phase: practice_iteration_start)', () => {
    const p = practiceBlock();
    const marker = p.timelineNode.timeline[0];
    /* Marker uses a function-form data field, so call it. */
    const data = typeof marker.data === 'function' ? marker.data() : marker.data;
    expect(data.phase).toBe('practice_iteration_start');
  });

  it('last timeline entry is the practice feedback node', () => {
    const p = practiceBlock();
    const last = p.timelineNode.timeline[p.timelineNode.timeline.length - 1];
    const data = typeof last.data === 'function' ? last.data() : last.data;
    expect(data.phase).toBe('practice_feedback');
  });
});

describe('singleTypePractice', () => {
  it('returns nodes for exactly one trial type with the requested count', () => {
    for (const type of ALL_TYPES) {
      const p = singleTypePractice({ trialType: type, trialsPerType: 4 });
      expect(p.schedule).toEqual(Array(4).fill(type));
      expect(p.trialParams).toHaveLength(4);
      for (const params of p.trialParams) {
        expect(params.trial_type).toBe(type);
      }
      expect(Array.isArray(p.nodes)).toBe(true);
      expect(p.nodes.length).toBeGreaterThan(0);
    }
  });

  it('honours config.blocks.practice_trials_per_type as the default', () => {
    const p = singleTypePractice({ trialType: 'd_only' });
    expect(p.schedule).toHaveLength(DEFAULT_PER_TYPE);
  });

  it('throws on an unknown trial type', () => {
    expect(() => singleTypePractice({ trialType: 'bogus' })).toThrow(/unknown trialType/);
  });

  it('every emitted node carries block_label="practice" on its data', () => {
    const p = singleTypePractice({ trialType: 'i_only', trialsPerType: 2 });
    for (const node of p.nodes) {
      expect(node.data?.block_label).toBe('practice');
    }
  });
});

describe('formatPracticeFeedbackHtml', () => {
  it('renders a green "complete" header on pass', () => {
    const html = formatPracticeFeedbackHtml({
      acc: { correct: 8, total: 10, accuracy: 0.8 },
      passed: true,
      willRetry: false,
      criterion: 0.7,
    });
    expect(html).toContain('Practice complete');
    expect(html).toContain('8 / 10');
    expect(html).toContain('80%');
  });

  it('renders a red "try again" header when below criterion with retry available', () => {
    const html = formatPracticeFeedbackHtml({
      acc: { correct: 1, total: 10, accuracy: 0.1 },
      passed: false,
      willRetry: true,
      criterion: 0.7,
    });
    expect(html).toContain("let's try again");
    expect(html).toContain('try the practice');
    expect(html).toContain('once more');
  });

  it('renders a red "below criterion" header when cap is exhausted', () => {
    const html = formatPracticeFeedbackHtml({
      acc: { correct: 2, total: 10, accuracy: 0.2 },
      passed: false,
      willRetry: false,
      criterion: 0.7,
    });
    expect(html).toContain('below criterion');
    expect(html).not.toContain('start the main task');
    expect(html).toContain('continue');
  });
});

describe('practiceBlock loop_function', () => {
  /* The loop_function reads from the global jsPsych data collection (to
   * include aux star rows). We mock window.jsPsych.data.get() so the
   * global-slice path works in the test environment. The marker's on_start
   * sets iterationStartRow = count(), so we seed the mock before on_start
   * and then append the iteration rows before calling loop_function. */
  let globalRows;
  function mockJsPsychData(rows) {
    globalRows = rows;
    window.jsPsych = {
      data: {
        get: () => ({
          values: () => [...globalRows],
          count: () => globalRows.length,
        }),
      },
    };
  }
  function seedIteration(p, rows) {
    mockJsPsychData([]);
    p.timelineNode.timeline[0].on_start();
    mockJsPsychData(rows);
  }

  afterEach(() => {
    delete window.jsPsych;
  });

  it('does NOT loop when accuracy meets the criterion', () => {
    const p = practiceBlock({ accuracyCriterion: 0.7, maxLoops: 1 });
    seedIteration(p, [
      { probe_correct: true },
      { probe_correct: true },
      { probe_correct: true },
      { probe_correct: false },
    ]); /* 0.75 ≥ 0.70 */
    expect(p.timelineNode.loop_function()).toBe(false);
  });

  it('does NOT loop when accuracy exactly equals the criterion', () => {
    const p = practiceBlock({ accuracyCriterion: 0.7, maxLoops: 1 });
    seedIteration(p, [
      { probe_correct: true },
      { probe_correct: true },
      { probe_correct: true },
      { probe_correct: true },
      { probe_correct: true },
      { probe_correct: true },
      { probe_correct: true },
      { probe_correct: false },
      { probe_correct: false },
      { probe_correct: false },
    ]); /* exactly 0.7 */
    expect(p.timelineNode.loop_function()).toBe(false);
  });

  it('LOOPS on iteration 1 when accuracy is below criterion', () => {
    const p = practiceBlock({ accuracyCriterion: 0.7, maxLoops: 1 });
    seedIteration(p, [
      { probe_correct: false },
      { probe_correct: false },
      { probe_correct: true },
    ]); /* 0.33 < 0.70 */
    expect(p.timelineNode.loop_function()).toBe(true);
  });

  it('does NOT loop on iteration 2 even when accuracy stays below criterion', () => {
    const p = practiceBlock({ accuracyCriterion: 0.7, maxLoops: 1 });
    seedIteration(p, [{ probe_correct: false }]);
    expect(p.timelineNode.loop_function()).toBe(true);
    seedIteration(p, [{ probe_correct: false }]);
    expect(p.timelineNode.loop_function()).toBe(false);
  });

  it('does NOT loop at all when maxLoops = 0', () => {
    const p = practiceBlock({ accuracyCriterion: 0.7, maxLoops: 0 });
    seedIteration(p, [{ probe_correct: false }]);
    /* Below criterion but no loops allowed → don't loop. */
    expect(p.timelineNode.loop_function()).toBe(false);
  });

  it('treats an iteration with zero scored events as below criterion (loops)', () => {
    const p = practiceBlock({ accuracyCriterion: 0.7, maxLoops: 1 });
    seedIteration(p, []);
    expect(p.timelineNode.loop_function()).toBe(true);
  });
});
