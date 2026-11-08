import { getSessionPRNG } from '../prng.js';
import {
  generateBalancedPool,
  createAttemptBudget,
  AttemptBudgetExceeded,
} from './balanced-pool.js';
import { assertPoolInvariants, assertPlanInvariants } from './balance-invariants.js';
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
/* Global attempt budget of one generateMainPlan call (units: see createAttemptBudget).
 * Measured over 70000 seeds: a plan needs 22 to 49 units (mean about 24); budget 500 (10x
 * margin). A degenerate stream (constant PRNG) spends the
 * budget in about 1 to 1.5 s and then throws. */
export const MAX_TOTAL_ATTEMPTS = 500;
const IMAGERY_TYPES = Object.freeze(['i_only', 'i_d', 'i_t']);

/* One condition's pool as its two 12-trial halves (Main A, Main B), generated
 * half by half so the counterbalance is exact inside every block, and checked
 * against the independent validator before it is used. */
function generatePerType(type, prng, budget) {
  let lastError;
  for (let attempt = 0; attempt < MAX_GENERATION_TRIES; attempt++) {
    try {
      budget.spend('pool generation');
      const pool = generateBalancedPool(type, prng, { budget });
      assertPoolInvariants(pool.halfA, pool.halfB, type);
      return pool;
    } catch (err) {
      if (err instanceof AttemptBudgetExceeded) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * The 24-trial pool of each condition and its two halves. Each pool is built as
 * two exact 12-trial halves (`balanced-pool.js`); nothing is partitioned afterwards.
 * @returns {{trialParamsByType: object, halfA: object, halfB: object}}
 */
function generateMainPools({ prng, budget } = {}) {
  const rng = prng ?? getSessionPRNG();
  const trialParamsByType = {};
  const halfA = {};
  const halfB = {};
  for (const type of TRIAL_TYPES) {
    const pool = generatePerType(type, rng, budget);
    halfA[type] = pool.halfA.slice();
    halfB[type] = pool.halfB.slice();
    trialParamsByType[type] = Object.freeze({
      all: Object.freeze([...pool.halfA, ...pool.halfB]),
      halfA: Object.freeze(pool.halfA.slice()),
      halfB: Object.freeze(pool.halfB.slice()),
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
export function generateMainPlan({ prng, budget = createAttemptBudget(MAX_TOTAL_ATTEMPTS) } = {}) {
  const rng = prng ?? getSessionPRNG();
  const pools = generateMainPools({ prng: rng, budget });
  const planMainA = () =>
    budget.spend('Main A plan') ||
    planBlockTrials({
      blockLabel: 'main_a',
      queues: pools.halfA,
      countsByType: countsOf(pools.halfA),
      presentationOffset: 0,
      prng: rng,
    });
  const planMainB = (mainA) =>
    budget.spend('Main B plan') ||
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
   * reproducible from the seed. */
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
    if (spread <= 1) return finalise({ ...pools, mainA, mainB });
    if (best === null || spread < best.spread) best = { mainA, mainB, spread };
  }
  if (best === null) {
    throw new Error(
      `generateMainPlan: no plan satisfied the order rules across the block boundary in ${MAX_PLAN_TRIES} × ${MAX_BOUNDARY_TRIES} tries`
    );
  }
  return finalise({ ...pools, mainA: best.mainA, mainB: best.mainB });
}

/* Last line of defence: whatever path produced the plan (re-plans, the soft
 * reminder fallback), a plan that is not block-exact is never returned. */
function finalise(plan) {
  assertPlanInvariants(plan);
  return plan;
}

/** Largest minus smallest per-condition reminder count (imagery conditions only). */
function reminderSpread(counts) {
  const values = IMAGERY_TYPES.map((t) => counts?.[t] ?? 0);
  return Math.max(...values) - Math.min(...values);
}
