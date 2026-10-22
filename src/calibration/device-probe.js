/**
 * Display / device snapshot and timing probe.
 *
 * `readDisplaySnapshot()` is a plain read of the values needed to interpret
 * the credit-card calibration (devicePixelRatio, screen and window sizes,
 * browser zoom proxies, platform). It is stamped onto the calibration rows
 * and onto the guard baseline.
 *
 * `runTimingProbe()` samples requestAnimationFrame for a few seconds,
 * measures performance.now() granularity and setTimeout overshoot, and
 * returns a verdict against fixed thresholds. The thresholds are set here
 * so they can be reported in the preregistration.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';
import htmlButtonResponse from '@jspsych/plugin-html-button-response';
import { screenOutExit } from '../screen-out.js';
import { withTimeout } from '../async-util.js';

export const TIMING_THRESHOLDS = Object.freeze({
  probe_ms: 3000,
  skip_first_frames: 5,
  max_median_frame_ms: 20.5 /* >= ~49 Hz */,
  max_p95_frame_ms: 34 /* two 60 Hz frames */,
  max_dropped_frac: 0.05 /* frames longer than 1.5 x median */,
  max_clock_resolution_ms: 1.0,
  max_timeout_overshoot_p95_ms: 25,
});

/** Longest the whole probe may take beyond its sampling time. */
export const PROBE_SLACK_MS = 8000;

export function readDisplaySnapshot() {
  const w = window;
  const vv = w.visualViewport;
  const mm = (q) => {
    try {
      return w.matchMedia(q).matches;
    } catch {
      return null;
    }
  };
  return {
    snap_iso: new Date().toISOString(),
    dpr: w.devicePixelRatio,
    screen_w: w.screen?.width ?? null,
    screen_h: w.screen?.height ?? null,
    avail_w: w.screen?.availWidth ?? null,
    avail_h: w.screen?.availHeight ?? null,
    color_depth: w.screen?.colorDepth ?? null,
    inner_w: w.innerWidth,
    inner_h: w.innerHeight,
    outer_w: w.outerWidth,
    outer_h: w.outerHeight,
    /* Proxies only: outer/inner width is ~ the page zoom in desktop Chrome,
     * Edge and Firefox; it is not reliable in Safari or in fullscreen. */
    zoom_proxy_outer_inner: w.innerWidth > 0 ? w.outerWidth / w.innerWidth : null,
    visual_viewport_scale: vv ? vv.scale : null,
    is_fullscreen: !!document.fullscreenElement,
    orientation: w.screen?.orientation?.type ?? null,
    platform: navigator.userAgentData?.platform ?? navigator.platform ?? null,
    ua_mobile: navigator.userAgentData?.mobile ?? null,
    user_agent: navigator.userAgent,
    hardware_concurrency: navigator.hardwareConcurrency ?? null,
    device_memory_gb: navigator.deviceMemory ?? null,
    forced_colors: mm('(forced-colors: active)'),
    prefers_dark: mm('(prefers-color-scheme: dark)'),
    prefers_reduced_motion: mm('(prefers-reduced-motion: reduce)'),
    display_gamut_p3: mm('(color-gamut: p3)'),
  };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

function sampleFrames(durationMs) {
  return new Promise((resolve) => {
    const stamps = [];
    const t0 = performance.now();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(stamps);
    };
    const step = (ts) => {
      stamps.push(ts);
      if (ts - t0 >= durationMs) finish();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    /* rAF does not fire in a hidden tab; do not wait forever. */
    setTimeout(finish, durationMs + 2000);
  });
}

function clockResolutionMs() {
  const diffs = [];
  let last = performance.now();
  const end = last + 50;
  while (last < end) {
    const now = performance.now();
    if (now !== last) {
      diffs.push(now - last);
      last = now;
    }
  }
  return diffs.length ? Math.min(...diffs) : null;
}

async function timeoutOvershoot(n = 20, delayMs = 50) {
  const over = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await new Promise((r) => setTimeout(r, delayMs));
    over.push(performance.now() - t - delayMs);
  }
  over.sort((a, b) => a - b);
  return { median: quantile(over, 0.5), p95: quantile(over, 0.95), max: over[over.length - 1] };
}

async function batteryInfo() {
  try {
    if (!navigator.getBattery) return { battery_api: false };
    const b = await navigator.getBattery();
    return { battery_api: true, battery_charging: b.charging, battery_level: b.level };
  } catch {
    return { battery_api: false };
  }
}

/** Pure scoring function, exported so it can be unit-tested. */
export function scoreTiming(m, th = TIMING_THRESHOLDS) {
  const reasons = [];
  if (!(m.frame_median_ms <= th.max_median_frame_ms)) reasons.push('low_refresh_rate');
  if (!(m.frame_p95_ms <= th.max_p95_frame_ms)) reasons.push('frame_jitter');
  if (!(m.frame_dropped_frac <= th.max_dropped_frac)) reasons.push('dropped_frames');
  if (!(m.clock_resolution_ms <= th.max_clock_resolution_ms)) reasons.push('coarse_clock');
  if (!(m.timeout_overshoot_p95_ms <= th.max_timeout_overshoot_p95_ms)) reasons.push('timer_lag');
  return { timing_ok: reasons.length === 0, timing_fail_reasons: reasons };
}

export async function runTimingProbe(th = TIMING_THRESHOLDS) {
  const stamps = await sampleFrames(th.probe_ms);
  const deltas = [];
  for (let i = th.skip_first_frames + 1; i < stamps.length; i++)
    deltas.push(stamps[i] - stamps[i - 1]);
  const sorted = deltas.slice().sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  const sd = deltas.length
    ? Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length)
    : null;
  const dropped = median ? deltas.filter((d) => d > 1.5 * median).length : null;
  const res = clockResolutionMs();
  const to = await timeoutOvershoot();
  const m = {
    frame_n: deltas.length,
    frame_median_ms: median,
    frame_mean_ms: mean,
    frame_sd_ms: sd,
    frame_p95_ms: quantile(sorted, 0.95),
    frame_max_ms: sorted.length ? sorted[sorted.length - 1] : null,
    frame_dropped_frac: deltas.length ? dropped / deltas.length : null,
    refresh_hz_est: median ? 1000 / median : null,
    clock_resolution_ms: res,
    timeout_overshoot_median_ms: to.median,
    timeout_overshoot_p95_ms: to.p95,
    timeout_overshoot_max_ms: to.max,
    page_hidden_during_probe: document.hidden,
    cross_origin_isolated: !!self.crossOriginIsolated,
    ...(await batteryInfo()),
  };
  return { ...m, ...scoreTiming(m, th), thresholds: th };
}

/* ---------- jsPsych nodes ---------- */
/**
 * Timing probe node. Runs the probe; on a fail (including a probe that errors
 * or does not finish in time) it shows a hint and runs it once more (loop),
 * then records both results. The exit node ends the session if the final
 * result still fails.
 */
export function timingProbeNode({ maxAttempts = 2 } = {}) {
  let attempts = 0;
  let last = null;
  const probe = {
    type: htmlKeyboardResponse,
    stimulus:
      '<h2>Checking your display</h2><p>Please wait a few seconds and do not switch tabs.</p>',
    choices: 'NO_KEYS',
    on_load: async () => {
      attempts += 1;
      /* A probe that throws or hangs is recorded as a failed attempt, so the
       * participant moves on to the retry or the exit screen. */
      try {
        last = await withTimeout(
          runTimingProbe(),
          TIMING_THRESHOLDS.probe_ms + PROBE_SLACK_MS,
          'timing probe'
        );
      } catch (err) {
        console.error('[timing-probe] probe failed', err);
        last = {
          timing_ok: false,
          timing_fail_reasons: ['probe_error'],
          probe_error: String(err?.message ?? err),
          thresholds: TIMING_THRESHOLDS,
        };
      }
      window.jsPsych.finishTrial({ ...last, probe_attempt: attempts, ...readDisplaySnapshot() });
    },
    data: { phase: 'timing_probe' },
  };
  const hint = {
    timeline: [
      {
        type: htmlButtonResponse,
        stimulus: `<h2>Your browser is running slowly</h2>
          <p style="max-width:38rem;margin:0 auto 1rem">Please close other tabs and
          programs, plug in your laptop if it is on battery, and turn off any
          battery-saver mode. Then press Continue to run the check again.</p>`,
        choices: ['Continue'],
        data: { phase: 'timing_probe_hint' },
      },
    ],
    conditional_function: () => last && !last.timing_ok && attempts < maxAttempts,
  };
  const exit = screenOutExit({
    phase: 'timing_probe_fail',
    exitReason: 'timing_check_failed',
    reasonHtml: `<h2>Sorry, this computer cannot run the task</h2>
      <p>The task needs precise timing and your browser did not pass the timing check.</p>`,
    condition: () => !!last && !last.timing_ok && attempts >= maxAttempts,
    flush: true,
  });
  return {
    timeline: [
      { timeline: [probe, hint], loop_function: () => !last.timing_ok && attempts < maxAttempts },
      exit,
    ],
  };
}
