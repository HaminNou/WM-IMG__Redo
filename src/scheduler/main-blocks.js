/**
 * Main A / Main B block-pair builder.
 *
 * The main task is 24 trials per type × 5 types = 120 trials, split into two
 * 60-trial blocks (Main A and Main B) with a 30-second rest between them.
 * The per-condition counterbalances — (probe_type × probe_position), exactly
 * 6 of each across 12 cells, and (encoding_position × probe_position), exactly
 * 8 of each across 9 cells — hold across the 24 trials of each type. The
 * naive approach of generating 12 trials per type per main block would
 * silently lose this guarantee: at blockSize = 12, the per-condition
 * generators fall back to non-exact sampling.
 *
 * This module preserves that invariant by generating 24 trials per type
 * at session level (via the per-condition generators), shuffling each per-
 * type array, and partitioning into two 12-trial halves. The union of Main A
 * and Main B for a given type is exactly the counterbalanced 24-trial
 * pool — confirmed by the per-condition test suites, which run at blockSize
 * = 24 — and the random partition just decides which half each trial lands
 * in.
 *
 * Each half is then handed to `assembleBlock` (with the pre-built queues, so
 * the assembler skips its own per-condition generation) to produce the
 * cross-condition trial-type schedule and inject pattern-phase nodes.
 *
 * The two halves use distinct trial-type schedules (independent calls to
 * `generateTrialTypeSchedule`) so a participant doesn't see the same type
 * order twice.
 *
 * Background-shade stratification: each per-type 24-trial pool
 * is generated with an exact 12-white / 12-gray split (see
 * `background-shade.js` and the per-condition generators). The split into
 * halfA / halfB is therefore stratified by shade — 6 white + 6 gray per
 * half per type — rather than a plain shuffle-and-slice. This guarantees
 * every block of every type carries an exact 50/50 page-background mix.
 */
import { getSessionPRNG } from '../prng.js';
import { generateMainPlan } from './main-plan.js';
import { assembleBlock } from './block.js';
import { injectIntraBlockRests } from '../conditions/rest.js';

const TRIAL_TYPES = Object.freeze(['d_only', 't_only', 'i_only', 'i_d', 'i_t']);
const TRIALS_PER_TYPE_TOTAL = 24;
const MAIN_TRIALS_TOTAL = TRIAL_TYPES.length * TRIALS_PER_TYPE_TOTAL; /* 120 */
/* Intra-block rest schedule. With 60 trials per block, a rest after
 * within-block trials 20 and 40 splits each block into three 20-trial
 * runs — short enough to keep fatigue effects bounded but long enough
 * that the rests don't dominate the session timeline. The inter-block
 * rest at trial 60→61 is added separately by the runner. */
const REST_AFTER_WITHIN_BLOCK_TRIALS = Object.freeze([20, 40]);

/**
 * Generate the Main A + Main B block pair.
 *
 * @param {object} [opts]
 * @param {string} [opts.sequencePoolLabelPrefix]   prefix for per-condition sequence-pool labels
 *                                                  (default 'main')
 * @param {object} [opts.prng]                      session PRNG; defaults to getSessionPRNG()
 * @returns {{
 *   mainA: {schedule: string[], trialParams: object[], nodes: object[]},
 *   mainB: {schedule: string[], trialParams: object[], nodes: object[]},
 *   trialParamsByType: Record<string, {all: object[], halfA: object[], halfB: object[]}>
 * }}
 */
export function generateMainBlockPair({ sequencePoolLabelPrefix, prng } = {}) {
  const rng = prng ?? getSessionPRNG();

  /* Step 1 — the 24-trial pool of every condition (exact counterbalance),
   * stratified-split by background_shade into 12 + 12, then the ordered trial
   * lists of both blocks. All of it is pure data (`main-plan.js`), so the
   * pilot simulator follows the same code path for the same seed. */
  const plan = generateMainPlan({
    sequencePoolLabelPrefix: sequencePoolLabelPrefix ?? 'main',
    prng: rng,
  });
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
    restAfterWithinBlockTrials: REST_AFTER_WITHIN_BLOCK_TRIALS,
    blockLabel: 'intra_main_a',
  });
  mainB.nodes = injectIntraBlockRests(mainB.nodes, {
    blockStartOverall: mainA.schedule.length + 1,
    restAfterWithinBlockTrials: REST_AFTER_WITHIN_BLOCK_TRIALS,
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
