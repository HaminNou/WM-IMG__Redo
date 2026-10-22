// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/screen-out.js', () => ({
  screenOutExit: vi.fn((opts) => ({ timeline: [], conditional_function: opts.condition, opts })),
}));

import {
  TIMING_THRESHOLDS,
  readDisplaySnapshot,
  scoreTiming,
  timingProbeNode,
} from '../src/calibration/device-probe.js';

const good = {
  frame_median_ms: 16.7,
  frame_p95_ms: 17.5,
  frame_dropped_frac: 0,
  clock_resolution_ms: 0.1,
  timeout_overshoot_p95_ms: 2,
};

describe('scoreTiming', () => {
  it('passes a 60 Hz machine with a fine clock', () => {
    expect(scoreTiming(good)).toEqual({ timing_ok: true, timing_fail_reasons: [] });
  });

  it('flags each failing measure with its own reason', () => {
    expect(scoreTiming({ ...good, frame_median_ms: 33 }).timing_fail_reasons).toContain(
      'low_refresh_rate'
    );
    expect(scoreTiming({ ...good, frame_p95_ms: 60 }).timing_fail_reasons).toContain(
      'frame_jitter'
    );
    expect(scoreTiming({ ...good, frame_dropped_frac: 0.2 }).timing_fail_reasons).toContain(
      'dropped_frames'
    );
    expect(scoreTiming({ ...good, clock_resolution_ms: 100 }).timing_fail_reasons).toContain(
      'coarse_clock'
    );
    expect(scoreTiming({ ...good, timeout_overshoot_p95_ms: 80 }).timing_fail_reasons).toContain(
      'timer_lag'
    );
  });

  it('fails when a measure is missing', () => {
    const { frame_median_ms: _omit, ...rest } = good;
    expect(scoreTiming(rest).timing_ok).toBe(false);
  });

  it('uses the registered thresholds by default', () => {
    expect(TIMING_THRESHOLDS.max_median_frame_ms).toBe(20.5);
    expect(Object.isFrozen(TIMING_THRESHOLDS)).toBe(true);
  });
});

describe('readDisplaySnapshot', () => {
  it('records the values needed to interpret the card calibration', () => {
    const snap = readDisplaySnapshot();
    for (const key of [
      'dpr',
      'screen_w',
      'screen_h',
      'inner_w',
      'inner_h',
      'outer_w',
      'zoom_proxy_outer_inner',
      'is_fullscreen',
      'user_agent',
      'forced_colors',
    ]) {
      expect(snap).toHaveProperty(key);
    }
    expect(snap.user_agent).toBe(navigator.userAgent);
  });
});

describe('timingProbeNode', () => {
  it('ends the session through the screen-out path only after the last failed attempt', () => {
    const node = timingProbeNode({ maxAttempts: 2 });
    const exit = node.timeline[1];
    expect(exit.opts.phase).toBe('timing_probe_fail');
    expect(exit.opts.exitReason).toBe('timing_check_failed');
    expect(exit.opts.flush).toBe(true);
    /* Before any probe has run there is no verdict, so no exit. */
    expect(exit.conditional_function()).toBe(false);
  });
});

describe('timingProbeNode when the probe cannot run', () => {
  afterEach(() => {
    delete window.jsPsych;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('records an erroring probe as a failed attempt, finishes the trial and then screens out', async () => {
    vi.stubGlobal('requestAnimationFrame', () => {
      throw new Error('no animation frames');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const finishTrial = vi.fn();
    window.jsPsych = { finishTrial };

    const node = timingProbeNode({ maxAttempts: 2 });
    const probe = node.timeline[0].timeline[0];
    const exit = node.timeline[1];

    await probe.on_load();
    expect(finishTrial).toHaveBeenCalledTimes(1);
    const first = finishTrial.mock.calls[0][0];
    expect(first.timing_ok).toBe(false);
    expect(first.timing_fail_reasons).toEqual(['probe_error']);
    expect(first.probe_error).toContain('no animation frames');
    expect(first.probe_attempt).toBe(1);
    expect(exit.conditional_function()).toBe(false);

    await probe.on_load();
    expect(finishTrial).toHaveBeenCalledTimes(2);
    expect(exit.conditional_function()).toBe(true);
  });
});
