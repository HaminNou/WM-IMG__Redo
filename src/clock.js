/**
 * Clock readings stamped on rows.
 *
 * Event times in the data are `performance.now()` values (ms since the page
 * loaded). `clockAnchor()` pairs that clock with the wall clock so they can be
 * placed in calendar time; `rowClock()` is the per-row wall time.
 */

const jsPsychRef = () => (typeof window !== 'undefined' ? window.jsPsych : undefined);

/** One reading of every clock at the same moment. */
export function clockAnchor() {
  const dateNow = Date.now();
  const start = jsPsychRef()?.getStartTime?.();
  return {
    perf_now_ms: Math.round(performance.now() * 1000) / 1000,
    time_origin_ms: performance.timeOrigin ?? null,
    date_now_ms: dateNow,
    iso: new Date(dateNow).toISOString(),
    jspsych_start_ms: start instanceof Date ? start.getTime() : null,
  };
}

/** Wall time of a row and the experiment-relative time jsPsych would stamp. */
export function rowClock() {
  const elapsed = jsPsychRef()?.getTotalTime?.();
  return {
    wall_ms: Date.now(),
    time_elapsed: Number.isFinite(elapsed) ? elapsed : null,
  };
}
