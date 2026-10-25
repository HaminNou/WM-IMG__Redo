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
import { orderViolations } from './rotation-balance.js';

export const TRIAL_TYPES = Object.freeze(['d_only', 't_only', 'i_only', 'i_d', 'i_t']);
export const TRIALS_PER_TYPE_TOTAL = 24;

/* A sampler that exhausts its attempt budget throws; retrying draws from the
 * same seeded stream, so the result is still reproducible from the seed. */
const MAX_GENERATION_TRIES = 25;
const MAX_BOUNDARY_TRIES = 25;
/* Whole-plan redraws when the reminder totals of the session are not within one. */
const MAX_PLAN_TRIES = 25;
const IMAGERY_TYPES = Object.freeze(['i_only', 'i_d', 'i_t']);

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
  const planMainA = () =>
    planBlockTrials({
      blockLabel: 'main_a',
      queues: pools.halfA,
      countsByType: countsOf(pools.halfA),
      presentationOffset: 0,
      prng: rng,
    });
  const planMainB = (mainA) =>
    planBlockTrials({
      blockLabel: 'main_b',
      queues: pools.halfB,
      countsByType: countsOf(pools.halfB),
      presentationOffset: mainA.schedule.length,
      previousTail: trailingRun(mainA.schedule),
      previousTrials: mainA.trialParams,
      reminderCounts: mainA.reminderCounts,
      prng: rng,
    });

  /* Two kinds of rule, handled differently.
   *
   * HARD: the shade / rotation run limits must hold across the block boundary.
   * Main A's tail is fixed, so Main B alone cannot always keep them (about 0.2 %
   * of draws): Main B is re-planned from the same seeded stream until it does. If
   * none of MAX_BOUNDARY_TRIES plans does, the whole plan is drawn again (Main A
   * included). A plan that still breaks them is never returned: the function throws.
   *
   * SOFT: the per-condition pattern-reminder totals of the whole session differ by
   * at most one. Main A is planned without knowing Main B, so about 1 session in
   * 4000 ended 4 / 6 / 5. Such a plan is drawn again too; if no plan within
   * MAX_PLAN_TRIES reaches a spread of one, the best one found (smallest spread) is
   * returned, because the reminder schedule is not a hard requirement.
   *
   * Every retry draws from the same seeded stream, so the result is still
   * reproducible from the seed, and a seed that satisfied everything at the first
   * try gives exactly the plan it always did. */
  let best = null;
  for (let plan = 0; plan < MAX_PLAN_TRIES; plan++) {
    const mainA = planMainA();
    let mainB = null;
    for (let attempt = 0; attempt < MAX_BOUNDARY_TRIES; attempt++) {
      const candidate = planMainB(mainA);
      if (orderViolations([...mainA.trialParams, ...candidate.trialParams]) === 0) {
        mainB = candidate;
        break;
      }
    }
    if (mainB === null) continue; /* a hard rule failed in every try: draw the plan again */
    const spread = reminderSpread(mainB.reminderCounts);
    if (spread <= 1) return { ...pools, mainA, mainB };
    if (best === null || spread < best.spread) best = { mainA, mainB, spread };
  }
  if (best === null) {
    throw new Error(
      `generateMainPlan: no plan satisfied the order rules across the block boundary in ${MAX_PLAN_TRIES} × ${MAX_BOUNDARY_TRIES} tries`
    );
  }
  return { ...pools, mainA: best.mainA, mainB: best.mainB };
}

/** Largest minus smallest per-condition reminder count (imagery conditions only). */
function reminderSpread(counts) {
  const values = IMAGERY_TYPES.map((t) => counts?.[t] ?? 0);
  return Math.max(...values) - Math.min(...values);
}
