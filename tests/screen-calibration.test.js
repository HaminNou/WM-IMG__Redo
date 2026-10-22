/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { registerHiddenNavStep, trackHiddenNavNode, startDisplayGuard } = vi.hoisted(() => ({
  registerHiddenNavStep: vi.fn(),
  trackHiddenNavNode: vi.fn((node) => node),
  startDisplayGuard: vi.fn(),
}));

vi.mock('../src/hidden-nav.js', () => ({
  registerHiddenNavStep,
  trackHiddenNavNode,
}));

vi.mock('../src/calibration/display-guard.js', () => ({
  startDisplayGuard,
}));

import {
  _testHelpers,
  evaluateAttempt,
  getCalibration,
  screenCalibrationWithRetry,
} from '../src/calibration/screen.js';

const T = _testHelpers;
const CARD = T.CARD_MM_WIDTH;
const pass = (px, extra = {}) => ({
  px,
  moved: true,
  in_bounds: px / CARD >= T.PX_PER_MM_MIN && px / CARD <= T.PX_PER_MM_MAX,
  ...extra,
});

describe('slider bounds', () => {
  it('lets the slider reach values the validity gate rejects', () => {
    expect(T.SLIDER_MIN_PX / CARD).toBeLessThan(T.PX_PER_MM_MIN);
    expect(T.SLIDER_MAX_PX / CARD).toBeGreaterThan(T.PX_PER_MM_MAX);
  });
});

describe('evaluateAttempt', () => {
  it('averages two agreeing passes', () => {
    const ev = evaluateAttempt([pass(400), pass(410)], 1440);
    expect(ev.usable).toBe(true);
    expect(ev.consistent).toBe(true);
    expect(ev.mean_px).toBe(405);
    expect(ev.px_per_mm).toBeCloseTo(405 / CARD, 10);
  });

  it('is usable but not consistent when the passes differ by more than the tolerance', () => {
    const ev = evaluateAttempt([pass(300), pass(420)], 1440);
    expect(ev.usable).toBe(true);
    expect(ev.consistent).toBe(false);
    expect(ev.rel_diff).toBeGreaterThan(T.CONSISTENCY_TOL);
  });

  it('rejects a pass where the slider did not move', () => {
    const ev = evaluateAttempt([pass(400, { moved: false }), pass(402)], 1440);
    expect(ev.usable).toBe(false);
    expect(ev.reasons).toContain('slider_not_moved');
  });

  it('rejects px/mm outside the allowed range', () => {
    const ev = evaluateAttempt([pass(840), pass(845)], 1440);
    expect(ev.usable).toBe(false);
    expect(ev.reasons).toContain('px_per_mm_out_of_range');
  });

  it('rejects a physical screen width that is implausible', () => {
    /* 408 px / 85.6 mm = 4.77 px/mm; an 800 px wide screen would be 168 mm. */
    const ev = evaluateAttempt([pass(405), pass(411)], 800);
    expect(ev.usable).toBe(false);
    expect(ev.reasons).toContain('implied_screen_width_implausible');
  });

  it('needs both passes', () => {
    expect(evaluateAttempt([pass(400)], 1440).usable).toBe(false);
  });
});

/* ---------- Timeline behaviour ---------- */

let nowMs;

function findNodes(timeline) {
  const [start, loop, fail] = timeline.timeline;
  const [hint, pass1, pass2, evaluate] = loop.timeline;
  return { start, loop, fail, hint, pass1, pass2, evaluate };
}

/**
 * Run one pass the way jsPsych does: render the stimulus, call on_load, let
 * the participant drag the slider, click the button, empty the display
 * element, and only then call on_finish.
 */
function runPass(node, targetPx, { dwellMs = 5000 } = {}) {
  document.body.innerHTML = `<div id="jspsych-content">${node.stimulus()}<div id="jspsych-html-button-response-btngroup">${node.button_html('This matches my card', 0)}</div></div>`;
  node.on_load();
  const slider = document.getElementById('cc-slider');
  const btn = document.querySelector('button.jspsych-btn[data-idx="0"]');
  const startPx = Number(slider.value);
  const initiallyDisabled = btn.disabled;
  if (targetPx !== null) {
    slider.value = String(targetPx);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
  nowMs += dwellMs;
  vi.advanceTimersByTime(dwellMs);
  const enabledAtClick = !btn.disabled;
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  /* jsPsych empties the display element before on_finish runs. */
  document.body.innerHTML = '';
  const data = {};
  node.on_finish(data);
  return { data, startPx, initiallyDisabled, enabledAtClick };
}

describe('screen calibration timeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    Object.defineProperty(window.screen, 'width', { value: 1440, configurable: true });
    document.documentElement.style.removeProperty('--mm');
    startDisplayGuard.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function run(passValues) {
    const tl = screenCalibrationWithRetry();
    const n = findNodes(tl);
    n.start.func();
    const outcomes = [];
    let attemptIdx = 0;
    do {
      const [a, b] = passValues[attemptIdx];
      runPass(n.pass1, a);
      runPass(n.pass2, b);
      outcomes.push(n.evaluate.func());
      attemptIdx += 1;
    } while (n.loop.loop_function() && attemptIdx < passValues.length);
    return { n, outcomes };
  }

  it('records the slider value from input events although the DOM is empty at on_finish', () => {
    const tl = screenCalibrationWithRetry();
    const n = findNodes(tl);
    n.start.func();
    const { data } = runPass(n.pass1, 412);
    expect(data.cc_px_width).toBe(412);
    expect(data.px_per_mm).toBeCloseTo(412 / CARD, 10);
    expect(data.cc_px_width).not.toBe(320);
    expect(data.cal_n_input).toBe(1);
    expect(data.cal_moved).toBe(true);
    expect(data.cal_trace).toEqual([[expect.any(Number), 412]]);
  });

  it('keeps the continue button disabled until the slider has moved and the minimum time has passed', () => {
    const tl = screenCalibrationWithRetry();
    const n = findNodes(tl);
    n.start.func();
    const noMove = runPass(n.pass1, null);
    expect(noMove.initiallyDisabled).toBe(true);
    expect(noMove.enabledAtClick).toBe(false);
    expect(noMove.data.cal_moved).toBe(false);

    const tooQuick = runPass(n.pass1, 420, { dwellMs: 500 });
    expect(tooQuick.enabledAtClick).toBe(false);

    const ok = runPass(n.pass1, 420, { dwellMs: 3500 });
    expect(ok.enabledAtClick).toBe(true);
  });

  it('starts the two passes from a low and a high width, in either order', () => {
    const tl = screenCalibrationWithRetry();
    const n = findNodes(tl);
    n.start.func();
    const a = runPass(n.pass1, null).startPx;
    const b = runPass(n.pass2, null).startPx;
    expect(Math.min(a, b)).toBeLessThan(300);
    expect(Math.max(a, b)).toBeGreaterThan(400);
  });

  it('accepts two agreeing passes, sets --mm to their mean and starts the display guard', () => {
    const { n, outcomes } = run([[412, 405]]);
    expect(outcomes[0].accepted).toBe(true);
    expect(outcomes[0].status).toBe('ok');
    expect(outcomes[0].attempts_used).toBe(1);
    expect(outcomes[0].retried).toBe(false);
    expect(outcomes[0].cc_px_width).toBe(408.5);
    const mm = document.documentElement.style.getPropertyValue('--mm');
    expect(parseFloat(mm)).toBeCloseTo(408.5 / CARD, 10);
    expect(startDisplayGuard).toHaveBeenCalledTimes(1);
    expect(n.loop.loop_function()).toBe(false);
    expect(n.fail.conditional_function()).toBe(false);
    expect(getCalibration().status).toBe('ok');
  });

  it('retries after inconsistent passes and accepts the third attempt with a flag', () => {
    const { n, outcomes } = run([
      [300, 420],
      [300, 420],
      [300, 420],
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['retry', 'retry', 'inconsistent_accepted']);
    expect(outcomes.map((o) => o.attempts_used)).toEqual([1, 2, 3]);
    expect(outcomes[2].retried).toBe(true);
    expect(n.loop.loop_function()).toBe(false);
    expect(n.fail.conditional_function()).toBe(false);
  });

  it('shows the retry hint only after the first attempt', () => {
    const tl = screenCalibrationWithRetry();
    const n = findNodes(tl);
    n.start.func();
    expect(n.hint.conditional_function()).toBe(false);
    runPass(n.pass1, 300);
    runPass(n.pass2, 420);
    n.evaluate.func();
    expect(n.hint.conditional_function()).toBe(true);
  });

  it('ends the session when no attempt is usable', () => {
    const { n, outcomes } = run([
      [840, 845],
      [840, 845],
      [840, 845],
    ]);
    expect(outcomes.every((o) => o.status === 'retry')).toBe(true);
    expect(outcomes.every((o) => o.reasons.includes('px_per_mm_out_of_range'))).toBe(true);
    expect(n.loop.loop_function()).toBe(false);
    expect(n.fail.conditional_function()).toBe(true);
    expect(getCalibration()).toBeNull();
    expect(startDisplayGuard).not.toHaveBeenCalled();
    expect(document.documentElement.style.getPropertyValue('--mm')).toBe('');
  });
});
