/**
 * Cross-condition trial-type scheduler.
 *
 * Given a count of trials per type (e.g. {d_only: 12, t_only: 12, i_only: 12,
 * i_d: 12, i_t: 12} for one half of the main task, or {d_only: 3, t_only: 3,
 * i_only: 3, i_d: 3, i_t: 3} for practice), this module produces a flat
 * length-N schedule of trial-type labels that:
 *
 *   1. honours the requested count exactly (no type appears more or fewer
 *      times than asked), and
 *   2. obeys the across-trial run-length cap from
 *      `config.sequencing.between_trial_run_length_cap` (primary value: 2 —
 *      "no more than 2 trials of the same type in a row").
 *
 * Algorithm — "weighted draw with rejection":
 *   At each schedule slot, sample a candidate type proportional to its
 *   *remaining* count, but reject draws that would extend the current run
 *   beyond `runLengthCap`. If every type with remaining count > 0 would
 *   violate the cap (a tail-deadlock — e.g. only one type left with N > cap),
 *   restart the schedule from scratch with a fresh draw history. This is
 *   bounded by `MAX_RESTARTS` (set generously; deadlocks are rare and the
 *   test suite verifies tractability for typical inputs).
 *
 * The classic alternative — pre-shuffling and rejecting whole shuffles —
 * burns far more PRNG draws on long inputs. Per-slot weighted draw is
 * simpler, equally unbiased, and the only path that makes deadlock detection
 * cheap (we know we are wedged the moment all candidates with > 0 remaining
 * are run-cap-blocked).
 *
 * Returned schedule is a frozen array of strings (the trial-type labels).
 */
import { getSessionPRNG } from '../prng.js';
import { config } from '../config.js';

const MAX_RESTARTS = 200;

/**
 * Generate a schedule of trial-type labels.
 *
 * @param {object} opts
 * @param {Record<string,number>} opts.countsByType   e.g. {d_only: 12, …}
 * @param {number} [opts.runLengthCap]                across-trial cap; defaults to config
 * @param {object} [opts.prng]                        session PRNG; defaults to getSessionPRNG()
 * @param {{type: string, length: number}} [opts.previousTail]  trailing run of the preceding block, so the
 *                                                    run-length cap also holds across a block boundary
 * @returns {string[]}                                frozen array of type labels, length = sum of counts
 */
export function generateTrialTypeSchedule({ countsByType, runLengthCap, prng, previousTail } = {}) {
  if (!countsByType || typeof countsByType !== 'object') {
    throw new Error('generateTrialTypeSchedule: countsByType must be an object');
  }
  for (const [type, n] of Object.entries(countsByType)) {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(
        `generateTrialTypeSchedule: count for '${type}' must be a non-negative integer, got ${n}`
      );
    }
  }
  const cap = runLengthCap ?? config.sequencing.between_trial_run_length_cap;
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`generateTrialTypeSchedule: runLengthCap must be ≥ 1, got ${cap}`);
  }
  const rng = prng ?? getSessionPRNG();

  const total = Object.values(countsByType).reduce((a, b) => a + b, 0);
  if (total === 0) return Object.freeze([]);

  for (let attempt = 0; attempt < MAX_RESTARTS; attempt++) {
    const schedule = tryBuildSchedule(countsByType, cap, rng, previousTail);
    if (schedule !== null) return Object.freeze(schedule);
  }
  throw new Error(
    `generateTrialTypeSchedule: failed to build a schedule after ${MAX_RESTARTS} restarts ` +
      `(cap=${cap}, counts=${JSON.stringify(countsByType)}). The cap may be too tight ` +
      `for the requested counts.`
  );
}

function tryBuildSchedule(countsByType, cap, rng, previousTail) {
  const remaining = { ...countsByType };
  const schedule = [];
  let lastType = previousTail?.type ?? null;
  let runLen = previousTail?.length ?? 0;

  const total = Object.values(countsByType).reduce((a, b) => a + b, 0);
  for (let slot = 0; slot < total; slot++) {
    /* Build the eligible pool: types with remaining > 0 AND, if at run-cap,
     * not equal to lastType. Weight by remaining count so the schedule stays
     * balanced — a type with 12 remaining is 12× more likely to be picked
     * than a type with 1 remaining. */
    const eligible = [];
    let weightSum = 0;
    for (const [type, n] of Object.entries(remaining)) {
      if (n <= 0) continue;
      if (type === lastType && runLen >= cap) continue;
      eligible.push({ type, weight: n });
      weightSum += n;
    }
    if (eligible.length === 0) {
      /* Tail-deadlock: every remaining type would extend a same-type run past
       * the cap. Restart from scratch. */
      return null;
    }

    const pick = weightedPick(eligible, weightSum, rng);
    schedule.push(pick);
    remaining[pick] -= 1;
    if (pick === lastType) runLen += 1;
    else {
      lastType = pick;
      runLen = 1;
    }
  }
  return schedule;
}

function weightedPick(eligible, weightSum, rng) {
  const r = rng.next() * weightSum;
  let acc = 0;
  for (const { type, weight } of eligible) {
    acc += weight;
    if (r < acc) return type;
  }
  /* Fallback for floating-point rounding at the upper edge. */
  return eligible[eligible.length - 1].type;
}
