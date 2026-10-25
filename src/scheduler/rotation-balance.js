/**
 * Rotation-angle design for the imagery-bearing conditions and the display
 * angle of D-only trials.
 *
 * The angle of each trial is a whole number of degrees in the closed range
 * [config.grid.rotation_min_deg, config.grid.rotation_max_deg] = [-90, +90],
 * 0 and both end points included. The range is cut into six strata that are
 * as equal as whole degrees allow: three counter-clockwise strata of 30
 * degrees ([-90, -61], [-60, -31], [-30, -1]) and three non-negative strata
 * ([0, 30], [31, 60], [61, 90]; the first holds 31 angles because it contains
 * 0). A 24-trial condition holds exactly 4 angles per stratum, drawn at
 * random without replacement inside the stratum, so no angle is repeated
 * within a condition, every part of the range is covered in every session,
 * and 12 trials turn counter-clockwise (negative) and 12 do not (0 or
 * positive). 0 degrees (no rotation) is drawn like any other angle: 4 of the
 * 31 angles of its stratum are chosen per condition, so a given condition
 * contains a 0 degree trial in 4/31 (about 13%) of sessions. The sign class
 * of 0 is "non-negative" (see `rotationSignClass`).
 *
 * Given the angles, the on/off labels of the stars are re-paired with trials
 * so that, at the 24-trial block size, every S-slot (1-6) and every angle
 * stratum holds 6 on-pattern and 6 off-pattern stars. Swaps keep each star
 * serial position at exactly 12 on / 12 off, so the pre-registered balance is
 * untouched.
 */
import { config } from '../config.js';

/* Cut the integer range [lo, hi] into `parts` bands of near-equal size; the
 * first `size % parts` bands take the extra angle. */
function bandsOf(lo, hi, parts) {
  const size = hi - lo + 1;
  const base = Math.floor(size / parts);
  const extra = size % parts;
  const out = [];
  let start = lo;
  for (let i = 0; i < parts; i++) {
    const n = base + (i < extra ? 1 : 0);
    out.push(Object.freeze([start, start + n - 1]));
    start += n;
  }
  return out;
}

const ROTATION_MIN_DEG = config.grid.rotation_min_deg;
const ROTATION_MAX_DEG = config.grid.rotation_max_deg;

export const ROTATION_STRATA = Object.freeze([
  ...bandsOf(ROTATION_MIN_DEG, -1, 3),
  ...bandsOf(0, ROTATION_MAX_DEG, 3),
]);

/** -1 for a counter-clockwise (negative) angle; +1 for 0 and clockwise angles. */
export function rotationSignClass(angle) {
  return angle < 0 ? -1 : 1;
}

export function rotationStratumIndex(angle) {
  for (let i = 0; i < ROTATION_STRATA.length; i++) {
    const [lo, hi] = ROTATION_STRATA[i];
    if (angle >= lo && angle <= hi) return i;
  }
  return -1;
}

/**
 * Stratified rotation angles for one block, in random trial order.
 * Each stratum is used floor(blockSize / 6) times; the remainder strata are
 * chosen at random. Angles are drawn without replacement inside a stratum.
 */
export function stratifiedRotationAngles(blockSize, prng) {
  const perStratum = Math.floor(blockSize / ROTATION_STRATA.length);
  const extra = blockSize % ROTATION_STRATA.length;
  const extraStrata = new Set(prng.shuffle(ROTATION_STRATA.map((_, i) => i)).slice(0, extra));
  const out = [];
  ROTATION_STRATA.forEach(([lo, hi], i) => {
    const values = [];
    for (let a = lo; a <= hi; a++) values.push(a);
    const n = perStratum + (extraStrata.has(i) ? 1 : 0);
    out.push(...prng.shuffle(values).slice(0, n));
  });
  return prng.shuffle(out);
}

function slotsOfS(sequence) {
  const out = [];
  sequence.forEach((c, i) => c === 'S' && out.push(i));
  return out;
}

/* Sum of absolute deviations of the on-pattern star count from half, over
 * S-slots and angle strata. */
function starLabelImbalance(sequences, labels, angles) {
  const slotOn = Array(6).fill(0);
  const slotN = Array(6).fill(0);
  const strOn = Array(ROTATION_STRATA.length).fill(0);
  const strN = Array(ROTATION_STRATA.length).fill(0);
  for (let t = 0; t < sequences.length; t++) {
    const sl = slotsOfS(sequences[t]);
    const g = rotationStratumIndex(angles[t]);
    for (let k = 0; k < sl.length; k++) {
      const on = labels[t][k] === 'on' ? 1 : 0;
      slotOn[sl[k]] += on;
      slotN[sl[k]] += 1;
      strOn[g] += on;
      strN[g] += 1;
    }
  }
  let total = 0;
  for (let i = 0; i < 6; i++) total += Math.abs(slotOn[i] - slotN[i] / 2);
  for (let g = 0; g < strOn.length; g++) total += Math.abs(strOn[g] - strN[g] / 2);
  return total;
}

/**
 * Re-pair star on/off labels with trials (same serial position only) to
 * balance on/off over S-slots and over angle strata. Returns a new array of
 * label rows; per-position totals are unchanged. Best effort: the search
 * stops at the first perfectly balanced arrangement or after `maxSwaps`.
 */
export function balanceStarLabels({ sequences, starLabels, angles, prng, maxSwaps = 20000 }) {
  const labels = starLabels.map((row) => row.slice());
  let best = starLabelImbalance(sequences, labels, angles);
  const positions = labels[0]?.length ?? 0;
  for (let step = 0; step < maxSwaps && best > 0 && positions > 0; step++) {
    const a = prng.int(labels.length);
    const b = prng.int(labels.length);
    const k = prng.int(positions);
    if (a === b || labels[a][k] === labels[b][k]) continue;
    [labels[a][k], labels[b][k]] = [labels[b][k], labels[a][k]];
    const score = starLabelImbalance(sequences, labels, angles);
    if (score <= best) best = score;
    else [labels[a][k], labels[b][k]] = [labels[b][k], labels[a][k]];
  }
  return labels;
}

/* ---------------- presentation-order rules ---------------- */

const MAX_SAME_SIGN_RUN = 6;
const MIN_ANGLE_STEP_DEG = 3;
const MAX_SAME_SHADE_RUN = 6;
/* Trials of the previous block that can still take part in a run: the longest
 * run limit (6) plus the trial that breaks it. */
const BOUNDARY_WINDOW = Math.max(MAX_SAME_SIGN_RUN, MAX_SAME_SHADE_RUN) + 1;

/** Rotation angle of a trial: the imagery angle, or the display angle of a D-only trial. */
export function trialAngleDeg(t) {
  if (typeof t.rotation_deg === 'number') return t.rotation_deg;
  if (typeof t.display_rotation_deg === 'number') return t.display_rotation_deg;
  return null;
}

/**
 * Count rule violations in a presentation-ordered list of trials:
 *   - over rotated trials (imagery-bearing trials and D-only trials), a run of more than MAX_SAME_SIGN_RUN
 *     rotations in the same direction (0 counts as non-negative), or two consecutive angles closer than
 *     MIN_ANGLE_STEP_DEG;
 *   - over all trials, a run of more than MAX_SAME_SHADE_RUN trials with the
 *     same page background.
 */
export function orderViolations(trials) {
  let v = 0;
  const angles = trials.map(trialAngleDeg).filter((a) => a !== null);
  let run = 1;
  for (let i = 1; i < angles.length; i++) {
    const a = angles[i - 1];
    const b = angles[i];
    if (Math.abs(b - a) < MIN_ANGLE_STEP_DEG) v += 1;
    run = rotationSignClass(a) === rotationSignClass(b) ? run + 1 : 1;
    if (run > MAX_SAME_SIGN_RUN) v += 1;
  }
  let shadeRun = 1;
  for (let i = 1; i < trials.length; i++) {
    shadeRun = trials[i].background_shade === trials[i - 1].background_shade ? shadeRun + 1 : 1;
    if (shadeRun > MAX_SAME_SHADE_RUN) v += 1;
  }
  return v;
}

/**
 * Reorder trials of the same condition (the condition sequence is fixed) to
 * satisfy `orderViolations`. Trial content moves as a whole, so every
 * counterbalance of the pool is untouched. Returns a new array.
 *
 * `previous` is the trials that were presented immediately before this block
 * (Main B receives Main A's), so the run limits hold across the boundary
 * between blocks as well as inside them: the last `BOUNDARY_WINDOW` of them
 * are prepended when the rules are counted. Violations that already exist
 * inside `previous` are not this block's to fix and are ignored.
 */
export function arrangeTrialOrder(trials, prng, maxSwaps = 5000, previous = []) {
  const prefix = previous.slice(-BOUNDARY_WINDOW);
  const baseline = orderViolations(prefix);
  const score = (list) => orderViolations(prefix.concat(list)) - baseline;
  const out = trials.slice();
  let best = score(out);
  for (let step = 0; step < maxSwaps && best > 0; step++) {
    const a = prng.int(out.length);
    const b = prng.int(out.length);
    if (a === b || out[a].trial_type !== out[b].trial_type) continue;
    [out[a], out[b]] = [out[b], out[a]];
    const s = score(out);
    if (s <= best) best = s;
    else [out[a], out[b]] = [out[b], out[a]];
  }
  return out;
}
