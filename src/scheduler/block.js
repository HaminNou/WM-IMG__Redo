/**
 * Block assembler — composes a full block from the per-condition trial
 * generators (or pre-built trial-param queues), the cross-condition
 * trial-type schedule, and the periodic pattern-phase node.
 *
 * Pipeline:
 *   1. For each trial type in `countsByType`, get a queue of frozen trial-
 *      parameter objects:
 *        - if `trialParamsByType` is provided, use the supplied queue
 *          (callers like `splitForMainBlocks` use this to pre-generate 24
 *          trials per type at the session level and split exactly 12 + 12
 *          across Main A / Main B, preserving the per-condition counterbalance);
 *        - otherwise call the matching per-condition generator
 *          (`generateMemoryBlock`, `generateImageryBlock`,
 *          `generateDualBlock`) with the requested count.
 *   2. Call `generateTrialTypeSchedule` to interleave the types subject to
 *      the across-trial run-length cap.
 *   3. Walk the schedule slot-by-slot, popping the next trial of the chosen
 *      type from its queue and translating it into a sequence of jsPsych
 *      nodes via the matching per-condition trial composer.
 *   4. Inject `patternPhaseNode` at trial indices 0, F, 2F, … where
 *      F = `config.pattern.pattern_phase_frequency_trials` (= 8) — but
 *      ONLY if the trial at that boundary is imagery-bearing
 *      (i_only / i_d / i_t). When the boundary lands on a memory-only
 *      trial (d_only / t_only) the injection is dropped, because the
 *      pattern phase exists to refresh the imagery-pattern image and
 *      memory-only trials don't need it.
 *      Single-type practice for d_only or t_only therefore receives no
 *      pattern phase at all.
 *
 *      Gate-first ordering: when injected, the
 *      pattern-phase node is spliced into the trial composer's node list
 *      right AFTER the trial-start gate (composer index 0), not before
 *      it. This way the participant always sees the empty-circle gate
 *      first and arms the trial; the pattern reminder, the rotation
 *      arrow cue, and the encoding sequence all play out as the body
 *      of that started trial. This invariant relies on every per-condition
 *      composer's first node being the trial-start gate — verified in
 *      `block.test.js`.
 *
 * Returns:
 *   {
 *     schedule:     [<type>, …]                  // the type sequence (for tests / data)
 *     trialParams:  [<paramObj>, …]              // 1:1 with `schedule`
 *     nodes:        [<jsPsychNode>, …]           // flat array ready to splice into the timeline
 *   }
 *
 * The caller (the runner) splices `nodes` into the global timeline.
 */
import { getSessionPRNG } from '../prng.js';
import { config } from '../config.js';

import { generateMemoryBlock } from './memory-block.js';
import { generateImageryBlock } from './imagery-block.js';
import { generateDualBlock } from './dual-block.js';
import { planBlockTrials } from './block-plan.js';

import { dOnlyTrial } from '../conditions/d_only.js';
import { tOnlyTrial } from '../conditions/t_only.js';
import { iOnlyTrial } from '../conditions/i_only.js';
import { iDTrial } from '../conditions/i_d.js';
import { iTTrial } from '../conditions/i_t.js';
import { patternPhaseNode } from '../conditions/pattern-phase.js';

const TRIAL_TYPES = Object.freeze(['d_only', 't_only', 'i_only', 'i_d', 'i_t']);

/* Imagery-bearing trial types — the only types that ever require a fresh
 * mental image of the gray pattern. The pattern-phase node is the
 * 4 s pre-trial reminder of that pattern; rendering it before a D-only or
 * T-only trial would be meaningless to the participant (those trials never
 * involve a star judgement and so have no need for the pattern).
 *
 * Rule: the pattern-phase cadence still uses
 * `pattern_phase_frequency_trials` (default 8), but a scheduled injection
 * is suppressed whenever the trial at that boundary slot is memory-only.
 * Practical consequences:
 *   - In single-type practice for D-only / T-only, NO pattern phase ever
 *     appears (no imagery trial in the block to anchor the injection).
 *   - In single-type practice for I-only / I+D / I+T, the pattern phase
 *     still anchors slot 0 (and every Nth slot if the block is long
 *     enough).
 *   - In mixed blocks (main_a / main_b / practiceBlock), pattern phases
 *     still arrive on the 0/F/2F cadence, but only if the trial at the
 *     boundary slot is imagery-bearing. When the boundary lands on a
 *     memory-only trial, the injection is dropped — participants don't
 *     see a pattern they don't need, and the cadence resumes at the next
 *     boundary that does land on an imagery trial.
 */
const IMAGERY_BEARING_TYPES = Object.freeze(new Set(['i_only', 'i_d', 'i_t']));

const COMPOSERS = Object.freeze({
  d_only: dOnlyTrial,
  t_only: tOnlyTrial,
  i_only: iOnlyTrial,
  i_d: iDTrial,
  i_t: iTTrial,
});

/**
 * Assemble one block.
 *
 * @param {object} opts
 * @param {string} opts.blockLabel                    e.g. 'practice', 'main_a', 'main_b'
 * @param {Record<string,number>} [opts.countsByType] per-type trial counts; missing keys default to 0.
 *                                                    If omitted, derived from `trialParamsByType` lengths.
 * @param {Record<string,object[]>} [opts.trialParamsByType]
 *                                                    pre-built per-type trial-param queues. When
 *                                                    provided, the per-condition generators are NOT
 *                                                    called — the queues are consumed in array order.
 *                                                    Used by `splitForMainBlocks` to keep the
 *                                                    counterbalance exact across Main A + Main B.
 * @param {number} [opts.runLengthCap]                across-trial cap; defaults to config
 * @param {string} [opts.sequencePoolLabelPrefix]     prefix for per-condition sequence-pool labels
 *                                                    (so practice and main don't collide). Ignored
 *                                                    when `trialParamsByType` is provided.
 * @param {number} [opts.patternPhaseFrequency]       trial-count gap between pattern phases; defaults to config
 * @param {number} [opts.presentationOffset]          number of main-task trials already presented, so
 *                                                    `presentation_index` runs 1..120 over both blocks
 *                                                    (omit for practice)
 * @param {{type: string, length: number}} [opts.previousTail]
 *                                                    trailing run of the preceding block (run-length cap
 *                                                    across the block boundary)
 * @param {{schedule: string[], trialParams: object[]}} [opts.plan]
 *                                                    block already planned by `planBlockTrials`
 * @param {object} [opts.prng]                        session PRNG; defaults to getSessionPRNG()
 * @returns {{schedule: string[], trialParams: object[], nodes: object[]}}
 */
export function assembleBlock({
  blockLabel,
  countsByType,
  trialParamsByType,
  runLengthCap,
  sequencePoolLabelPrefix,
  patternPhaseFrequency,
  presentationOffset,
  previousTail,
  plan: precomputedPlan,
  prng,
} = {}) {
  if (!blockLabel || typeof blockLabel !== 'string') {
    throw new Error('assembleBlock: blockLabel must be a non-empty string');
  }
  /* Derive countsByType from trialParamsByType if only the latter is given,
   * so callers don't have to pass redundant information. */
  const effectiveCounts =
    countsByType ?? (trialParamsByType ? deriveCountsFromQueues(trialParamsByType) : null);
  if (!effectiveCounts || typeof effectiveCounts !== 'object') {
    throw new Error('assembleBlock: countsByType (or trialParamsByType) must be provided');
  }
  for (const type of Object.keys(effectiveCounts)) {
    if (!TRIAL_TYPES.includes(type)) {
      throw new Error(
        `assembleBlock: unknown trial type '${type}'; expected one of ${TRIAL_TYPES.join(', ')}`
      );
    }
  }
  if (trialParamsByType) {
    /* Validate the supplied queues match the counts and contain the right
     * trial_type label. Catches caller bugs where a queue was built for the
     * wrong type or got truncated. */
    for (const [type, n] of Object.entries(effectiveCounts)) {
      if (n === 0) continue;
      const queue = trialParamsByType[type];
      if (!Array.isArray(queue) || queue.length !== n) {
        throw new Error(
          `assembleBlock: trialParamsByType['${type}'] has length ${queue?.length} but count is ${n}`
        );
      }
      for (const trial of queue) {
        if (trial.trial_type !== type) {
          throw new Error(
            `assembleBlock: trialParamsByType['${type}'] contains a trial with trial_type='${trial.trial_type}'`
          );
        }
      }
    }
  }
  const rng = prng ?? getSessionPRNG();
  const freq = patternPhaseFrequency ?? config.pattern.pattern_phase_frequency_trials;
  if (!Number.isInteger(freq) || freq < 1) {
    throw new Error(`assembleBlock: patternPhaseFrequency must be ≥ 1, got ${freq}`);
  }
  const poolPrefix = sequencePoolLabelPrefix ?? blockLabel;

  /* Steps 1-2 — per-condition trial-parameter queues, the cross-condition
   * schedule, the trial order and the identity fields. A caller that has
   * already planned the block (the main task) passes `plan`. */
  let plan = precomputedPlan;
  if (!plan) {
    const queues = {};
    for (const type of TRIAL_TYPES) {
      const n = effectiveCounts[type] ?? 0;
      if (n === 0) continue;
      queues[type] =
        trialParamsByType && trialParamsByType[type]
          ? trialParamsByType[type].slice()
          : generateConditionBlock(type, n, `${poolPrefix}__${type}`, rng);
    }
    plan = planBlockTrials({
      blockLabel,
      queues,
      countsByType: effectiveCounts,
      runLengthCap,
      previousTail,
      presentationOffset,
      prng: rng,
    });
  }
  const { schedule } = plan;

  /* Step 3 + 4 — compose the nodes of each trial in order, injecting a
   * pattern-phase at cadence boundaries that land on an imagery-bearing
   * trial. See the IMAGERY_BEARING_TYPES comment above for the why, and the
   * file header for the gate-first splice rule (pattern-phase mounts AFTER
   * the trial-start gate, not before it). */
  const trialParams = [];
  const nodes = [];
  for (let i = 0; i < schedule.length; i++) {
    const type = schedule[i];
    const params = plan.trialParams[i];
    const trialMeta = params.trial_meta;
    trialParams.push(params);
    const composedNodes = COMPOSERS[type](params);
    if (i % freq === 0 && IMAGERY_BEARING_TYPES.has(type)) {
      /* Splice the pattern-phase node IN at index 1 — i.e. between the
       * trial-start gate (composer's index 0) and the rest of the trial
       * body. The participant therefore: arms the trial via the gate →
       * sees the pattern reminder → sees the rotation arrow → starts
       * encoding. This makes pattern presentation literally part of the
       * trial timeline rather than a pre-trial event. */
      composedNodes.splice(
        1,
        0,
        patternPhaseNode({
          block_label: blockLabel,
          trial_index_in_block: i,
          background_shade: params.background_shade,
        })
      );
    }
    for (const node of composedNodes) {
      node.data = { ...(node.data ?? {}), ...trialMeta };
    }
    nodes.push(...composedNodes);
  }

  /* Stamp block_label onto every emitted node's `data` so downstream filters
   * (pilot summary's probe-matrix, analysis scripts) can distinguish practice
   * rows from main rows without reverse-engineering trial counts. The
   * pattern-phase node already sets block_label internally — this overwrites
   * with the same value, which is harmless. */
  for (const node of nodes) {
    node.data = { ...(node.data ?? {}), block_label: blockLabel };
  }

  return { schedule, trialParams, nodes };
}

function generateConditionBlock(type, blockSize, sequencePoolLabel, prng) {
  if (type === 'd_only' || type === 't_only') {
    return generateMemoryBlock({ trialType: type, blockSize, sequencePoolLabel, prng });
  }
  if (type === 'i_only') {
    return generateImageryBlock({ blockSize, sequencePoolLabel, prng });
  }
  if (type === 'i_d' || type === 'i_t') {
    return generateDualBlock({ trialType: type, blockSize, sequencePoolLabel, prng });
  }
  throw new Error(`generateConditionBlock: unknown type '${type}'`);
}

function deriveCountsFromQueues(trialParamsByType) {
  const counts = {};
  for (const [type, queue] of Object.entries(trialParamsByType)) {
    counts[type] = Array.isArray(queue) ? queue.length : 0;
  }
  return counts;
}
