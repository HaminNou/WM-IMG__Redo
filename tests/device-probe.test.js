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

  it.each([
    ['frame_median_ms', 'low_refresh_rate'],
    ['frame_p95_ms', 'frame_jitter'],
    ['frame_dropped_frac', 'dropped_frames'],
    ['clock_resolution_ms', 'coarse_clock'],
    ['timeout_overshoot_p95_ms', 'timer_lag'],
  ])(
    'fails %s when it is null, NaN, undefined or infinite (an unmeasured probe is not a pass)',
    (key, reason) => {
      for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
        const r = scoreTiming({ ...good, [key]: bad });
        expect(r.timing_ok, `${key}=${String(bad)}`).toBe(false);
        expect(r.timing_fail_reasons).toContain(reason);
        expect(r.timing_fail_reasons).toContain('not_measured');
      }
    }
  );

  it('fails a probe in which no frames arrived (all metrics null), as a hidden or frozen tab produces', () => {
    const r = scoreTiming({
      frame_median_ms: null,
      frame_p95_ms: null,
      frame_dropped_frac: null,
      clock_resolution_ms: null,
      timeout_overshoot_p95_ms: 3,
    });
    expect(r.timing_ok).toBe(false);
    expect(r.timing_fail_reasons).toEqual(
      expect.arrayContaining([
        'low_refresh_rate',
        'frame_jitter',
        'dropped_frames',
        'coarse_clock',
        'not_measured',
      ])
    );
  });

  it('fails when the page was hidden at any time during the probe, even with good metrics', () => {
    const r = scoreTiming({ ...good, page_hidden_during_probe: true });
    expect(r.timing_ok).toBe(false);
    expect(r.timing_fail_reasons).toEqual(['tab_hidden_during_probe']);
    expect(scoreTiming({ ...good, page_hidden_during_probe: false }).timing_ok).toBe(true);
  });

  it('keeps the boundary: exactly at each limit passes, just over fails', () => {
    const th = TIMING_THRESHOLDS;
    expect(
      scoreTiming({
        frame_median_ms: th.max_median_frame_ms,
        frame_p95_ms: th.max_p95_frame_ms,
        frame_dropped_frac: th.max_dropped_frac,
        clock_resolution_ms: th.max_clock_resolution_ms,
        timeout_overshoot_p95_ms: th.max_timeout_overshoot_p95_ms,
      }).timing_ok
    ).toBe(true);
    expect(scoreTiming({ ...good, frame_median_ms: th.max_median_frame_ms + 0.01 }).timing_ok).toBe(
      false
    );
    expect(scoreTiming({ ...good, frame_p95_ms: th.max_p95_frame_ms + 0.01 }).timing_ok).toBe(
      false
    );
    expect(
      scoreTiming({ ...good, frame_dropped_frac: th.max_dropped_frac + 0.001 }).timing_ok
    ).toBe(false);
    expect(
      scoreTiming({ ...good, clock_resolution_ms: th.max_clock_resolution_ms + 0.01 }).timing_ok
    ).toBe(false);
    expect(
      scoreTiming({ ...good, timeout_overshoot_p95_ms: th.max_timeout_overshoot_p95_ms + 0.01 })
        .timing_ok
    ).toBe(false);
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

describe('timingProbeNode with a frozen or hidden tab', () => {
  afterEach(() => {
    delete window.jsPsych;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  it('a tab in which requestAnimationFrame never fires is recorded as a failed, unmeasured probe', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('requestAnimationFrame', () => 0); /* frozen: the callback never runs */
    const finishTrial = vi.fn();
    window.jsPsych = { finishTrial };
    const node = timingProbeNode({ maxAttempts: 2 });
    const probe = node.timeline[0].timeline[0];
    const run = probe.on_load();
    await vi.advanceTimersByTimeAsync(30000);
    await run;
    const r = finishTrial.mock.calls[0][0];
    expect(r.timing_ok).toBe(false);
    expect(r.timing_fail_reasons).toContain('not_measured');
    expect(r.frame_median_ms).toBeNull();
  });

  it('a tab that was hidden during the probe fails even when frames kept arriving at 60 Hz', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let t = 1000;
    vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb((t += 16.7)), 16));
    const finishTrial = vi.fn();
    window.jsPsych = { finishTrial };
    const node = timingProbeNode({ maxAttempts: 2 });
    const probe = node.timeline[0].timeline[0];
    const run = probe.on_load();
    await vi.advanceTimersByTimeAsync(1000);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(200);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(30000);
    await run;
    const r = finishTrial.mock.calls[0][0];
    expect(r.page_hidden_during_probe).toBe(true);
    expect(r.timing_ok).toBe(false);
    expect(r.timing_fail_reasons).toContain('tab_hidden_during_probe');
  });

  it('a visible tab with steady 60 Hz frames still passes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let t = 1000;
    vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb((t += 16.7)), 16));
    const finishTrial = vi.fn();
    window.jsPsych = { finishTrial };
    const node = timingProbeNode({ maxAttempts: 2 });
    const probe = node.timeline[0].timeline[0];
    const run = probe.on_load();
    await vi.advanceTimersByTimeAsync(30000);
    await run;
    const r = finishTrial.mock.calls[0][0];
    expect(r.page_hidden_during_probe).toBe(false);
    expect(r.timing_fail_reasons.filter((x) => x !== 'timer_lag' && x !== 'coarse_clock')).toEqual(
      []
    );
  });
});
