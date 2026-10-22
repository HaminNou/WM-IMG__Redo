/**
 * Probe-type counterbalance.
 *
 * Every memory-task trial (D-only, T-only, I+D, I+T) carries 3 probes drawn
 * from the same four canonical labels:
 *
 *   T_on  — target,  on-pattern (presented this trial)
 *   T_off — target,  off-pattern
 *   F_on  — foil,    on-pattern (NOT presented this trial)
 *   F_off — foil,    off-pattern
 *
 * Probe-type balance lives at the BLOCK level, not the TRIAL level. Within
 * each of the 3 probe serial positions, the four labels are distributed as
 * evenly as possible across the block (exactly 6 each at blockSize = 24,
 * since 24 / 4 = 6), so across the block each (probe_type × probe_position)
 * cell hits exactly 6 times (4 types × 3 positions = 12 cells; 24 trials ×
 * 3 probes / 12 cells = 6 per cell). An individual trial is free to contain
 * repeated probe types so long as the trial remains feasible (1 ≤ targets ≤
 * 2 — neither all-foils nor all-targets — and no more than two probes of
 * any single type, which keeps the trial compatible with the block-level
 * memory-item label schedule used downstream).
 *
 * Encoding-position-to-probe-position counterbalance.
 *
 * For dual-task trials (I+D, I+T) we additionally require: across 24 trials,
 * each (encoding_position × probe_position) cell appears exactly 8 times
 * (24 × 3 / 9 = 8, where 9 = 3 encoding positions × 3 probe positions).
 * This is satisfied by drawing all 6 permutations of [0,1,2] (3! = 6),
 * replicating the pool 4× to reach 24 entries, and shuffling — so each of
 * the 6 mappings is used exactly 4 times across the block. Pairing this
 * pool with the type-by-position pool counterbalances both dimensions
 * exactly; the joint (encoding_position × probe_type) distribution is
 * approximately uniform since the two pools are paired uniformly at random.
 */
import { getSessionPRNG } from '../prng.js';
import { generatePositionBalancedTrials } from './position-balance.js';

export const PROBE_TYPES = Object.freeze(['T_on', 'T_off', 'F_on', 'F_off']);
export const ENCODING_POSITIONS = Object.freeze([0, 1, 2]);
export const PROBES_PER_TRIAL = 3;
const MAIN_BLOCK_SIZE = 24;

let CACHED_ENC_PERMS = null;

function allEncodingPositionPermutations() {
  if (CACHED_ENC_PERMS !== null) return CACHED_ENC_PERMS;
  const out = [];
  permute(ENCODING_POSITIONS.slice(), 0, out);
  CACHED_ENC_PERMS = Object.freeze(out.map(Object.freeze));
  return CACHED_ENC_PERMS;
}

function permute(arr, start, out) {
  if (start === arr.length - 1) {
    out.push(arr.slice());
    return;
  }
  for (let i = start; i < arr.length; i++) {
    [arr[start], arr[i]] = [arr[i], arr[start]];
    permute(arr, start + 1, out);
    [arr[start], arr[i]] = [arr[i], arr[start]];
  }
}

/* Per-trial feasibility check. With 3 probes per trial we require:
 *   - 1 ≤ targetCount ≤ 2  (not all-foils so the trial has at least one
 *     "yes"-correct probe; not all-targets so the trial has at least one
 *     "no"-correct probe — both are necessary to keep guessing strategies
 *     unprofitable);
 *   - per-type cap ≤ 2 (no triple of any single label).
 * These rules keep the per-trial composition compatible with the
 * block-level memory-item label schedule (which must accommodate the
 * trial's T_on / T_off targets at specific encoding positions). */
function isFeasibleProbeTrial(order) {
  const tOnCount = order.filter((type) => type === 'T_on').length;
  const tOffCount = order.filter((type) => type === 'T_off').length;
  const fOnCount = order.filter((type) => type === 'F_on').length;
  const fOffCount = order.filter((type) => type === 'F_off').length;
  const targetCount = tOnCount + tOffCount;
  return (
    targetCount >= 1 &&
    targetCount <= PROBES_PER_TRIAL - 1 &&
    tOnCount <= 2 &&
    tOffCount <= 2 &&
    fOnCount <= 2 &&
    fOffCount <= 2
  );
}

/**
 * Build the per-trial probe orders for one block.
 *
 * @param {number} blockSize  number of trials in the block
 * @param {{shuffle: (arr) => Array, pick: (arr) => any}} prng  session PRNG
 * @returns {string[][]}  blockSize arrays of length PROBES_PER_TRIAL (= 3).
 *                        Across the block, every (probe type × probe position)
 *                        cell is as balanced as possible (exactly 6 each at
 *                        n=24, across 12 cells), while individual trials are
 *                        allowed to repeat types within the feasibility caps.
 */
export function generateProbeOrders(blockSize, prng = getSessionPRNG()) {
  return generatePositionBalancedTrials({
    labels: PROBE_TYPES,
    positions: PROBES_PER_TRIAL,
    blockSize,
    prng,
    trialValidator: isFeasibleProbeTrial,
    /* The trial-level [1, 2] target-count range is tighter than the prior
     * [1, 3] range used at set-size 4, so the per-block pass rate of the
     * column-balanced rejection sampler drops accordingly. Bump max attempts
     * generously for the 24-trial main block; smaller practice blocks stay
     * comfortable at 5000. */
    maxAttempts: blockSize === MAIN_BLOCK_SIZE ? 100000 : 5000,
  });
}

/**
 * Build the per-trial encoding-position → probe-position mappings for one
 * block. Each mapping is an array of length PROBES_PER_TRIAL (= 3) where
 * `mapping[probe_position]` = encoding_position, i.e. the encoding-position
 * whose item the probe at `probe_position` is logically associated with
 * (target probes literally use that encoded item's cell; foil probes are
 * tied logically only).
 *
 * @param {number} blockSize  number of trials in the block
 * @param {{shuffle: (arr) => Array, pick: (arr) => any}} prng  session PRNG
 * @returns {number[][]}  blockSize arrays of length 3, each a permutation
 *                        of [0,1,2]. For blockSize === 24, the 6 distinct
 *                        permutations are replicated 4× then shuffled, so
 *                        each mapping appears exactly 4 times.
 */
export function generateEncodingPositionMappings(blockSize, prng = getSessionPRNG()) {
  const perms = allEncodingPositionPermutations();
  if (blockSize === MAIN_BLOCK_SIZE) {
    if (MAIN_BLOCK_SIZE % perms.length !== 0) {
      throw new Error(
        `generateEncodingPositionMappings: main block size (${MAIN_BLOCK_SIZE}) is not ` +
          `a multiple of permutation pool size (${perms.length}); replication is ill-defined.`
      );
    }
    const replications = MAIN_BLOCK_SIZE / perms.length;
    const pool = [];
    for (let r = 0; r < replications; r++) {
      for (const p of perms) pool.push(p.slice());
    }
    return prng.shuffle(pool);
  }
  const out = [];
  for (let i = 0; i < blockSize; i++) {
    out.push(prng.shuffle(ENCODING_POSITIONS.slice()));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Encoding-position plan shared by the four memory-bearing conditions *
 * ------------------------------------------------------------------ */

const TARGET_CLASSES = Object.freeze(['T_on', 'T_off']);

/**
 * Count target probes by (target class, encoding position, probe position).
 * Foils carry an encoding-position label but point at no encoded item, so
 * they are not counted.
 */
function countTargetCells(probeOrders, encPosMappings) {
  const counts = TARGET_CLASSES.map(() =>
    Array.from({ length: PROBES_PER_TRIAL }, () => Array(PROBES_PER_TRIAL).fill(0))
  );
  for (let t = 0; t < probeOrders.length; t++) {
    for (let j = 0; j < probeOrders[t].length; j++) {
      const cls = TARGET_CLASSES.indexOf(probeOrders[t][j]);
      if (cls >= 0) counts[cls][encPosMappings[t][j]][j] += 1;
    }
  }
  return counts;
}

/* Sum of absolute deviations from perfect balance. For each target class
 * and probe position the targets are spread over the 3 encoding positions;
 * the ideal count per cell is (targets of that class at that position) / 3. */
function targetImbalance(counts) {
  let total = 0;
  for (const byEnc of counts) {
    for (let j = 0; j < PROBES_PER_TRIAL; j++) {
      let colSum = 0;
      for (let e = 0; e < PROBES_PER_TRIAL; e++) colSum += byEnc[e][j];
      const ideal = colSum / PROBES_PER_TRIAL;
      for (let e = 0; e < PROBES_PER_TRIAL; e++) total += Math.abs(byEnc[e][j] - ideal);
    }
  }
  return total;
}

/**
 * Re-pair the encoding-position permutations with the trials so that the
 * target probes are balanced over (target class x encoding position x
 * probe position). Swapping whole permutations between trials keeps the
 * exact 8-per-cell balance of all probes (targets and foils together). At
 * blockSize = 24 the result has 2 targets in each of the 18 cells
 * (T_on / T_off x 3 x 3).
 */
function balanceTargetEncodingPositions(probeOrders, encPosMappings, prng, maxSwaps = 20000) {
  const maps = encPosMappings.map((m) => m.slice());
  let best = targetImbalance(countTargetCells(probeOrders, maps));
  for (let step = 0; step < maxSwaps && best > 0; step++) {
    const a = prng.int(maps.length);
    const b = prng.int(maps.length);
    if (a === b) continue;
    [maps[a], maps[b]] = [maps[b], maps[a]];
    const score = targetImbalance(countTargetCells(probeOrders, maps));
    if (score <= best) best = score;
    else [maps[a], maps[b]] = [maps[b], maps[a]];
  }
  return maps;
}

/**
 * Block-level memory-label cap per encoding position: with 24 trials each
 * position carries 24 labels, so at most 12 target probes of one label
 * (on / off) can be pinned to one encoding position.
 */
function fixedTargetCountsAreFeasible(probeOrders, encPosMappings) {
  const fixedOn = Array(PROBES_PER_TRIAL).fill(0);
  const fixedOff = Array(PROBES_PER_TRIAL).fill(0);
  for (let t = 0; t < probeOrders.length; t++) {
    for (let j = 0; j < probeOrders[t].length; j++) {
      const e = encPosMappings[t][j];
      if (probeOrders[t][j] === 'T_on') fixedOn[e]++;
      if (probeOrders[t][j] === 'T_off') fixedOff[e]++;
    }
  }
  const cap = Math.ceil(probeOrders.length / 2);
  return fixedOn.every((c) => c <= cap) && fixedOff.every((c) => c <= cap);
}

export function generateFeasibleEncodingPositionMappings(
  blockSize,
  probeOrders,
  prng,
  maxAttempts = 2000
) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let maps = generateEncodingPositionMappings(blockSize, prng);
    if (blockSize === MAIN_BLOCK_SIZE) {
      maps = balanceTargetEncodingPositions(probeOrders, maps, prng);
    }
    if (fixedTargetCountsAreFeasible(probeOrders, maps)) return maps;
  }
  throw new Error(
    `generateFeasibleEncodingPositionMappings: no feasible encoding-position mapping after ${maxAttempts} attempts.`
  );
}

/**
 * Per-trial memory labels pinned by the probe plan: the item probed by a
 * T_on (T_off) probe must be an on-pattern (off-pattern) item.
 */
export function buildFixedMemoryLabelsByTrial(probeOrders, encPosMappings) {
  return probeOrders.map((probeOrder, t) => {
    const fixed = Array(PROBES_PER_TRIAL).fill(null);
    for (let j = 0; j < probeOrder.length; j++) {
      if (probeOrder[j] === 'T_on') fixed[encPosMappings[t][j]] = 'on';
      if (probeOrder[j] === 'T_off') fixed[encPosMappings[t][j]] = 'off';
    }
    return fixed;
  });
}
