/**
 * Pure part of the main-task plan: the 24-trial pool of every condition,
 * the stratified split into Main A and Main B, and the ordered trial lists
 * of the two blocks. Shared by the runtime (`main-blocks.js`) and the pilot
 * simulator so both follow the same code path for the same seed.
 */
import { getSessionPRNG } from '../prng.js';
import { generateMemoryBlock } from './memory-block.js';
import { generateImageryBlock } from './imagery-block.js';
import { generateDualBlock } from './dual-block.js';
import { planBlockTrials, trailingRun } from './block-plan.js';

export const TRIAL_TYPES = Object.freeze(['d_only', 't_only', 'i_only', 'i_d', 'i_t']);
export const TRIALS_PER_TYPE_TOTAL = 24;

/* A sampler that exhausts its attempt budget throws; retrying draws from the
 * same seeded stream, so the result is still reproducible from the seed. */
const MAX_GENERATION_TRIES = 25;

function generatePerTypeOnce(type, blockSize, sequencePoolLabel, prng) {
  if (type === 'd_only' || type === 't_only') {
    return generateMemoryBlock({ trialType: type, blockSize, sequencePoolLabel, prng });
  }
  if (type === 'i_only') {
    return generateImageryBlock({ blockSize, sequencePoolLabel, prng });
  }
  if (type === 'i_d' || type === 'i_t') {
    return generateDualBlock({ trialType: type, blockSize, sequencePoolLabel, prng });
  }
  throw new Error(`generateMainPools: unknown trial type '${type}'`);
}

function generatePerType(type, blockSize, sequencePoolLabel, prng) {
  let lastError;
  for (let attempt = 0; attempt < MAX_GENERATION_TRIES; attempt++) {
    try {
      return generatePerTypeOnce(type, blockSize, sequencePoolLabel, prng);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Stratified split: partition a per-type pool into halfA + halfB so each
 * half carries the same background-shade composition (6 white + 6 gray per
 * half at 24 trials; within one trial for odd counts).
 */
function stratifiedSplitByShade(pool, rng) {
  const byShade = new Map();
  for (const trial of pool) {
    const key = trial.background_shade;
    if (!byShade.has(key)) byShade.set(key, []);
    byShade.get(key).push(trial);
  }
  const halfA = [];
  const halfB = [];
  for (const [, trials] of byShade) {
    const shuffled = rng.shuffle(trials.slice());
    const cut = Math.floor(shuffled.length / 2);
    const leftover = shuffled.length - cut * 2;
    const flipExtra = leftover === 1 && rng.int(2) === 1;
    const aTake = flipExtra ? cut + 1 : cut;
    halfA.push(...shuffled.slice(0, aTake));
    halfB.push(...shuffled.slice(aTake));
  }
  return { halfA: rng.shuffle(halfA), halfB: rng.shuffle(halfB) };
}

/**
 * The 24-trial pool of each condition and its two halves.
 * @returns {{trialParamsByType: object, halfA: object, halfB: object}}
 */
function generateMainPools({ sequencePoolLabelPrefix = 'main', prng } = {}) {
  const rng = prng ?? getSessionPRNG();
  const trialParamsByType = {};
  const halfA = {};
  const halfB = {};
  for (const type of TRIAL_TYPES) {
    const all24 = generatePerType(
      type,
      TRIALS_PER_TYPE_TOTAL,
      `${sequencePoolLabelPrefix}__${type}`,
      rng
    );
    const split = stratifiedSplitByShade(all24, rng);
    halfA[type] = split.halfA;
    halfB[type] = split.halfB;
    trialParamsByType[type] = Object.freeze({
      all: Object.freeze(all24),
      halfA: Object.freeze(split.halfA.slice()),
      halfB: Object.freeze(split.halfB.slice()),
    });
  }
  return { trialParamsByType, halfA, halfB };
}

function countsOf(half) {
  const counts = {};
  for (const type of TRIAL_TYPES) counts[type] = half[type].length;
  return counts;
}

/**
 * Pools plus the ordered trial lists of Main A and Main B (condition
 * sequence, trial order and identity fields), without building any nodes.
 */
export function generateMainPlan({ sequencePoolLabelPrefix, prng } = {}) {
  const rng = prng ?? getSessionPRNG();
  const pools = generateMainPools({ sequencePoolLabelPrefix, prng: rng });
  const mainA = planBlockTrials({
    blockLabel: 'main_a',
    queues: pools.halfA,
    countsByType: countsOf(pools.halfA),
    presentationOffset: 0,
    prng: rng,
  });
  const mainB = planBlockTrials({
    blockLabel: 'main_b',
    queues: pools.halfB,
    countsByType: countsOf(pools.halfB),
    presentationOffset: mainA.schedule.length,
    previousTail: trailingRun(mainA.schedule),
    reminderCounts: mainA.reminderCounts,
    prng: rng,
  });
  return { ...pools, mainA, mainB };
}
