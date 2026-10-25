/**
 * Practice block with accuracy-gated re-loop.
 *
 * The practice block runs 2 trials per type × 5 types = 10 trials. After all
 * trials, an accuracy-summary screen reports performance, and a jsPsych
 * `loop_function` decides whether the participant repeats:
 *
 *   - if iteration accuracy ≥ `config.practice.accuracy_criterion` (= 0.7) → stop;
 *   - else if iteration count ≤ `config.practice.max_loops` (= 1) → loop once more;
 *   - else → stop; the downstream `practiceFailureExit` conditional node
 *     (in `instructions/index.js`) detects the failure and ends the session.
 *
 * Two practice attempts is the maximum (the initial run plus one re-loop).
 * Failure on both triggers an early-exit screen that redirects the
 * participant back to Prolific — participants who cannot demonstrate the
 * minimum criterion after two full instruction+practice cycles are unlikely
 * to produce usable experimental data.
 *
 * Accuracy is computed across *all probe and star events in the iteration*:
 *
 *   - probe events tag `probe_correct` (boolean) on their data row;
 *   - star events tag `star_correct` (boolean) on their data row;
 *   - non-responses are scored as `*_correct: false` by the per-condition
 *     judges, so they count as incorrect.
 *
 * Iteration scoping: a marker node at the start of each iteration records the
 * current jsPsych data row count into a closure variable; the feedback node
 * slices `jsPsych.data.get().values()` from that index, so accuracy reflects
 * only the iteration just completed. The `loop_function` separately receives
 * an iteration-scoped DataCollection from jsPsych v8 and re-derives the same
 * accuracy via the shared `computePracticeAccuracy` helper.
 *
 * On re-loop the same trial parameters run again — `assembleBlock` is called
 * once at construction and the same node array is replayed by jsPsych. This
 * is intentional: re-loop is for the participant to consolidate the rules,
 * not to face new items, and re-using the same trials keeps the practice
 * pool finite.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';

import { config } from '../config.js';
import { getSessionPRNG } from '../prng.js';
import { assembleBlock } from './block.js';
import { setPracticeIteration } from './trial-meta.js';
import { consumeDeveloperSkip } from '../hidden-nav.js';
import { continueHintHtml } from '../visuals/continue-hint.js';

const TRIAL_TYPES = Object.freeze(['d_only', 't_only', 'i_only', 'i_d', 'i_t']);

/**
 * Sum probe + star correctness across an array of jsPsych trial-data rows.
 * Pure helper exported for tests.
 *
 * Counted: any row carrying a boolean `probe_correct` or `star_correct`.
 * Each such row contributes one event (probe and star fields are mutually
 * exclusive in the current condition set, so the union is just an OR).
 *
 * @param {object[]} trialDataArray  rows from `jsPsych.data.get().values()`
 * @returns {{correct: number, total: number, accuracy: number}}
 */
export function computePracticeAccuracy(trialDataArray) {
  let correct = 0;
  let total = 0;
  for (const t of trialDataArray) {
    if (typeof t.probe_correct === 'boolean') {
      total += 1;
      if (t.probe_correct) correct += 1;
    }
    if (typeof t.star_correct === 'boolean') {
      total += 1;
      if (t.star_correct) correct += 1;
    }
  }
  return {
    correct,
    total,
    accuracy: total > 0 ? correct / total : 0,
  };
}

/**
 * Build the trial nodes for a single-type practice mini-block — used by the
 * interleaved instructions+practice flow (`assembleInstructionsAndPractice`),
 * where each trial type has its own teaching screen and practice trials
 * before the next type's teaching screen.
 *
 * Unlike `practiceBlock`, this does NOT wrap a marker / feedback / loop. The
 * caller composes one big loop around all five sub-blocks. Pattern-phase
 * injection follows the default config (one pattern phase at slot 0 of each
 * sub-block, which doubles as a per-task imagery primer).
 *
 * @param {object} opts
 * @param {string} opts.trialType                   one of 'd_only', 't_only', 'i_only', 'i_d', 'i_t'
 * @param {number} [opts.trialsPerType]             defaults to config.blocks.practice_trials_per_type
 * @param {string} [opts.sequencePoolLabelPrefix]   defaults to 'practice'
 * @param {object} [opts.prng]                      session PRNG; defaults to getSessionPRNG()
 * @returns {{schedule: string[], trialParams: object[], nodes: object[]}}
 */
export function singleTypePractice({
  trialType,
  trialsPerType,
  sequencePoolLabelPrefix,
  prng,
} = {}) {
  if (!TRIAL_TYPES.includes(trialType)) {
    throw new Error(
      `singleTypePractice: unknown trialType '${trialType}'; expected one of ${TRIAL_TYPES.join(', ')}`
    );
  }
  const perType = trialsPerType ?? config.blocks.practice_trials_per_type;
  const rng = prng ?? getSessionPRNG();
  /* The across-trial run-length cap (config.sequencing.between_trial_run_length_cap
   * = 2) protects MAIN blocks from long same-type runs. In a single-type
   * practice mini-block every slot is the same type by construction, so the
   * cap would deadlock the schedule generator. Pass `runLengthCap: perType`
   * (the loosest possible value short of Infinity) so the generator emits
   * the all-same-type schedule cleanly. */
  const block = assembleBlock({
    blockLabel: 'practice',
    countsByType: { [trialType]: perType },
    sequencePoolLabelPrefix: sequencePoolLabelPrefix ?? 'practice',
    runLengthCap: Math.max(1, perType),
    prng: rng,
  });
  return {
    schedule: block.schedule,
    trialParams: block.trialParams,
    nodes: block.nodes,
  };
}

/**
 * Render the practice-feedback HTML. Exported so the interleaved
 * instructions+practice composer can re-use the exact same look + copy
 * conventions as the practice block.
 *
 * @param {object} opts
 * @param {{correct:number,total:number,accuracy:number}} opts.acc
 * @param {boolean} opts.passed
 * @param {boolean} opts.willRetry
 * @param {number}  opts.criterion
 * @returns {string}
 */
export function formatPracticeFeedbackHtml({ acc, passed, willRetry, criterion }) {
  return formatFeedbackHtml({ acc, passed, willRetry, criterion });
}

/**
 * Build the practice timeline node — a jsPsych v8 timeline with `loop_function`.
 *
 * @param {object} [opts]
 * @param {number} [opts.trialsPerType]            override trials-per-type (default config.blocks.practice_trials_per_type)
 * @param {number} [opts.accuracyCriterion]        override pass criterion (default config.practice.accuracy_criterion)
 * @param {number} [opts.maxLoops]                 override max re-loops (default config.practice.max_loops)
 * @param {string} [opts.sequencePoolLabelPrefix]  prefix for per-condition sequence-pool labels (default 'practice')
 * @param {object} [opts.prng]                     session PRNG; defaults to getSessionPRNG()
 * @returns {{
 *   timelineNode: object,                           // single jsPsych node ready to splice
 *   schedule: string[],                             // the trial-type sequence (length = 15 with defaults)
 *   trialParams: object[],                          // 1:1 with schedule
 * }}
 */
export function practiceBlock({
  trialsPerType,
  accuracyCriterion,
  maxLoops,
  sequencePoolLabelPrefix,
  prng,
} = {}) {
  const perType = trialsPerType ?? config.blocks.practice_trials_per_type;
  const criterion = accuracyCriterion ?? config.practice.accuracy_criterion;
  const cap = maxLoops ?? config.practice.max_loops;
  const rng = prng ?? getSessionPRNG();

  const counts = {};
  for (const type of TRIAL_TYPES) counts[type] = perType;

  const block = assembleBlock({
    blockLabel: 'practice',
    countsByType: counts,
    sequencePoolLabelPrefix: sequencePoolLabelPrefix ?? 'practice',
    prng: rng,
  });

  /* Closure state — reset each session import. There's only ever one
   * practice block per session, so module-level safety is fine. */
  let attemptCount = 0;
  let iterationStartRow = 0;
  let lastIterationResult = null; /* {accuracy, passed, willRetry, attemptCount} */

  const markerNode = {
    type: htmlKeyboardResponse,
    stimulus: '',
    choices: 'NO_KEYS',
    trial_duration: 0,
    on_start: () => {
      attemptCount += 1;
      setPracticeIteration(attemptCount);
      iterationStartRow = window.jsPsych?.data?.get().count() ?? 0;
    },
    data: () => ({
      phase: 'practice_iteration_start',
      practice_iteration: attemptCount,
    }),
  };

  const feedbackNode = {
    type: htmlKeyboardResponse,
    stimulus: () => {
      const all = window.jsPsych?.data?.get().values() ?? [];
      const iterationData = all.slice(iterationStartRow);
      const acc = computePracticeAccuracy(iterationData);
      const passed = acc.accuracy >= criterion;
      const willRetry = !passed && attemptCount <= cap;
      lastIterationResult = {
        accuracy: acc.accuracy,
        correct: acc.correct,
        total: acc.total,
        passed,
        willRetry,
        attemptCount,
      };
      return formatFeedbackHtml({ acc, passed, willRetry, criterion });
    },
    choices: [' '],
    data: () => ({
      phase: 'practice_feedback',
      practice_iteration: attemptCount,
      iteration_accuracy: lastIterationResult?.accuracy ?? null,
      iteration_correct: lastIterationResult?.correct ?? null,
      iteration_total: lastIterationResult?.total ?? null,
      iteration_passed: lastIterationResult?.passed ?? null,
    }),
  };

  const timelineNode = {
    timeline: [markerNode, ...block.nodes, feedbackNode],
    loop_function: function () {
      if (consumeDeveloperSkip()) return false;
      const all = window.jsPsych?.data?.get().values() ?? [];
      const iterationData = all.slice(iterationStartRow);
      const acc = computePracticeAccuracy(iterationData);
      if (acc.accuracy >= criterion) return false;
      if (attemptCount > cap) return false;
      return true;
    },
  };

  return {
    timelineNode,
    schedule: block.schedule,
    trialParams: block.trialParams,
  };
}

function formatFeedbackHtml({ acc, passed, willRetry, criterion }) {
  const pct = Math.round(acc.accuracy * 100);
  const critPct = Math.round(criterion * 100);
  const head = passed
    ? `<h2 style="color:#0a7c4d;">Practice complete</h2>`
    : willRetry
      ? `<h2 style="color:#b3261e;">Practice – let's try again</h2>`
      : `<h2 style="color:#b3261e;">Practice – below criterion</h2>`;
  const body = passed
    ? `<p>You got <strong>${acc.correct} / ${acc.total}</strong> correct
       (${pct}%), at or above the ${critPct}% criterion.</p>
       ${continueHintHtml('Press <kbd>Space</kbd> to start the main task.')}`
    : willRetry
      ? `<p>You got <strong>${acc.correct} / ${acc.total}</strong> correct
         (${pct}%), below the ${critPct}% criterion. Let's try the practice
         once more.</p>
         ${continueHintHtml('Press <kbd>Space</kbd> to begin.')}`
      : `<p>You got <strong>${acc.correct} / ${acc.total}</strong> correct
         (${pct}%), below the ${critPct}% criterion.</p>
         ${continueHintHtml('Press <kbd>Space</kbd> to continue.')}`;
  return `
    <div style="display: grid; place-items: center; gap: 1rem; max-width: 36rem; margin: 0 auto;">
      ${head}
      ${body}
    </div>
  `;
}
