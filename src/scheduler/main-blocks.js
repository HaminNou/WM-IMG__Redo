/**
 * Main A / Main B block-pair builder.
 *
 * The main task is 24 trials per type × 5 types = 120 trials, split into two
 * 60-trial blocks (Main A and Main B) with a rest of up to 10 minutes between them.
 *
 * Each type's 24-trial pool is generated as TWO exact 12-trial halves, one per
 * block (`balanced-pool.js`), never as a 24-pool that is partitioned afterwards.
 * Per block and per type (identically for all five types) the M/S slot occupancy,
 * the on/off labels of memory items and of stars per serial position, probe type ×
 * test position, encoding position × test position, the rotation strata and the
 * background shade are exact; across the two blocks the 24-trial pool keeps its
 * pre-registered balances (probe type × position 6 per cell, encoding position ×
 * position 8 per cell, ...) and in addition probed-target on/off labels per slot
 * and every encoded dot / tone and star cell are exact. The full list is in
 * `balanced-pool.js`; `balance-invariants.js` verifies it, and `generateMainPlan`
 * throws rather than return a plan that fails it.
 *
 * Each half is then handed to `assembleBlock` (with the pre-built queues, so
 * the assembler skips its own per-condition generation) to produce the
 * cross-condition trial-type schedule and inject pattern-phase nodes. That
 * step reorders whole trials of one type inside the block only: no label ever
 * moves between slots or blocks after generation.
 *
 * The two halves use distinct trial-type schedules (independent calls to
 * `generateTrialTypeSchedule`) so a participant doesn't see the same type
 * order twice.
 *
 * Background shade is generated 6 white + 6 gray inside every half (no split step).
 */
import { getSessionPRNG } from '../prng.js';
import { generateMainPlan } from './main-plan.js';
import { assembleBlock } from './block.js';
import { injectIntraBlockRests } from '../conditions/rest.js';

const TRIAL_TYPES = Object.freeze(['d_only', 't_only', 'i_only', 'i_d', 'i_t']);
const TRIALS_PER_TYPE_TOTAL = 24;
const MAIN_TRIALS_TOTAL = TRIAL_TYPES.length * TRIALS_PER_TYPE_TOTAL; /* 120 */
/* Intra-block rest schedule. With 60 trials per block, Main A gets a rest
 * after within-block trials 20 and 40 (three 20-trial runs). Main B, the
 * later block and the one run under more fatigue, gets one more rest: after
 * trials 15, 30 and 45 (four 15-trial runs). Every intra-block rest is the same length
 * (`config.blocks.rest_duration_s`, 30 s, no skip). The inter-block rest at trial 60→61 is
 * added separately by the runner (`config.blocks.inter_block_rest_max_s`, ended early by both arrow keys). */
export const REST_AFTER_WITHIN_BLOCK_TRIALS_A = Object.freeze([20, 40]);
export const REST_AFTER_WITHIN_BLOCK_TRIALS_B = Object.freeze([15, 30, 45]);

/**
 * Generate the Main A + Main B block pair.
 *
 * @param {object} [opts]
 * @param {object} [opts.prng]                      session PRNG; defaults to getSessionPRNG()
 * @returns {{
 *   mainA: {schedule: string[], trialParams: object[], nodes: object[]},
 *   mainB: {schedule: string[], trialParams: object[], nodes: object[]},
 *   trialParamsByType: Record<string, {all: object[], halfA: object[], halfB: object[]}>
 * }}
 */
export function generateMainBlockPair({ prng } = {}) {
  const rng = prng ?? getSessionPRNG();

  /* Step 1 — the pool of every condition as its two exact 12-trial halves, then
   * the ordered trial lists of both blocks. All of it is pure data (`main-plan.js`), so the
   * pilot simulator follows the same code path for the same seed. */
  const plan = generateMainPlan({ prng: rng });
  const { trialParamsByType } = plan;

  /* Step 2 — build the nodes of each block from its plan. */
  const mainA = assembleBlock({
    blockLabel: 'main_a',
    trialParamsByType: plan.halfA,
    plan: plan.mainA,
    prng: rng,
  });
  const mainB = assembleBlock({
    blockLabel: 'main_b',
    trialParamsByType: plan.halfB,
    plan: plan.mainB,
    prng: rng,
  });

  /* Stamp `main_trial_number_overall` (1..120) onto every per-trial gate
   * node. The gate is the FIRST node of each trial composition and is
   * identifiable by its `phase` ending in `_trial_start`. The dim top-left
   * counter overlay (`trial-counter.js`) reads these fields in its on_load
   * and updates accordingly. */
  stampMainTrialNumbers(mainA.nodes, 0);
  stampMainTrialNumbers(mainB.nodes, mainA.schedule.length);

  /* Splice in the intra-block forced rests. Numbering is preserved because
   * rest + resume-gate nodes carry no `_trial_start` phase, so the gate
   * the overlay reads from is unchanged. Done after stamping so the
   * within-block trial number can be derived from the already-stamped
   * `main_trial_number_overall`. */
  mainA.nodes = injectIntraBlockRests(mainA.nodes, {
    blockStartOverall: 1,
    restAfterWithinBlockTrials: REST_AFTER_WITHIN_BLOCK_TRIALS_A,
    blockLabel: 'intra_main_a',
  });
  mainB.nodes = injectIntraBlockRests(mainB.nodes, {
    blockStartOverall: mainA.schedule.length + 1,
    restAfterWithinBlockTrials: REST_AFTER_WITHIN_BLOCK_TRIALS_B,
    blockLabel: 'intra_main_b',
  });

  return {
    mainA,
    mainB,
    trialParamsByType: Object.freeze(trialParamsByType),
  };
}

function stampMainTrialNumbers(nodes, startOffset) {
  let n = startOffset;
  for (const node of nodes) {
    if (node?.data?.phase && /_trial_start$/.test(node.data.phase)) {
      n += 1;
      /* Derive trial type from the gate's phase prefix
       * (e.g. 'd_only_trial_start' → 'd_only'). The trial-counter
       * overlay reads this to colour its tag. */
      const trialType = node.data.phase.replace(/_trial_start$/, '');
      node.data = {
        ...node.data,
        main_trial_number_overall: n,
        main_trial_total: MAIN_TRIALS_TOTAL,
        main_trial_type: trialType,
      };
    }
  }
}
