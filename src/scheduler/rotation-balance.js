/**
 * Rotation-angle design for the imagery-bearing conditions and the display
 * angle of D-only trials.
 *
 * The angle of each trial is drawn from six equal strata of 30 integer
 * degrees, [-90, -61], [-60, -31], [-30, -1], [1, 30], [31, 60], [61, 90],
 * so a 24-trial condition holds exactly 4 angles per stratum (12 clockwise,
 * 12 counter-clockwise), no angle is repeated within a condition, and the
 * whole range is covered in every session. A 0 degree trial would involve no
 * rotation and is not drawn.
 *
 * Given the angles, the on/off labels of the stars are re-paired with trials
 * so that, at the 24-trial block size, every S-slot (1-6) and every angle
 * stratum holds 6 on-pattern and 6 off-pattern stars. Swaps keep each star
 * serial position at exactly 12 on / 12 off, so the pre-registered balance is
 * untouched.
 */

export const ROTATION_STRATA = Object.freeze([
  Object.freeze([-90, -61]),
  Object.freeze([-60, -31]),
  Object.freeze([-30, -1]),
  Object.freeze([1, 30]),
  Object.freeze([31, 60]),
  Object.freeze([61, 90]),
]);

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

/** Rotation angle of a trial: the imagery angle, or the display angle of a D-only trial. */
export function trialAngleDeg(t) {
  if (typeof t.rotation_deg === 'number') return t.rotation_deg;
  if (typeof t.display_rotation_deg === 'number') return t.display_rotation_deg;
  return null;
}

/**
 * Count rule violations in a presentation-ordered list of trials:
 *   - over rotated trials (imagery-bearing trials and D-only trials), a run of more than MAX_SAME_SIGN_RUN
 *     rotations in the same direction, or two consecutive angles closer than
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
    run = Math.sign(a) === Math.sign(b) ? run + 1 : 1;
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
 */
export function arrangeTrialOrder(trials, prng, maxSwaps = 5000) {
  const out = trials.slice();
  let best = orderViolations(out);
  for (let step = 0; step < maxSwaps && best > 0; step++) {
    const a = prng.int(out.length);
    const b = prng.int(out.length);
    if (a === b || out[a].trial_type !== out[b].trial_type) continue;
    [out[a], out[b]] = [out[b], out[a]];
    const score = orderViolations(out);
    if (score <= best) best = score;
    else [out[a], out[b]] = [out[b], out[a]];
  }
  return out;
}
