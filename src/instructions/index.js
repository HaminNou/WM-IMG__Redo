/**
 * Instructions + practice composer — runs after calibration and before the
 * main task. The five trial types are taught **interleaved** with their
 * own per-type practice trials, so the participant reads about Task N,
 * practises Task N, then moves on to Task N+1. This matches the natural
 * teaching cadence (concept → enact → check) and avoids the cognitive
 * load of holding all five rule-sets in mind before any practice begins.
 *
 * Order:
 *   overview
 *   ── loop ──────────────────────────────────────────────────────────
 *     iteration marker
 *     Task 1 instructions (D-only)  → Task 1 practice trials
 *     Task 2 instructions (T-only)  → Task 2 practice trials
 *     AC1
 *     Task 3 instructions (I-only)  → Task 3 practice trials
 *     AC2
 *     Task 4 instructions (I+D)     → Task 4 practice trials
 *     Task 5 instructions (I+T)     → Task 5 practice trials
 *     AC3
 *     practice feedback
 *   ───────────────────────────────────────────────────────────────────
 *   attention-check summary
 *
 * The three typed-instruction attention checks (design §11.4) sit at the
 * boundary of each teaching "arc" — memory (D+T), imagery (I-only), dual
 * (I+D + I+T) — preserving the §11.4 "scattered through the instructions"
 * intent.
 *
 * The whole instructions+practice section is wrapped in a jsPsych
 * `loop_function` gated on cumulative practice accuracy (probe + star
 * events) versus `config.practice.accuracy_criterion` (= 0.7). On a
 * re-loop the participant re-reads each instruction screen and re-does
 * the per-type practice.
 *
 * If the participant fails to reach the accuracy criterion after both
 * attempts, a conditional exit node (`practiceFailureExit`) fires: it
 * shows a polite end-of-session screen, redirects to the Prolific
 * completion URL, and calls `jsPsych.abortExperiment()` so no
 * subsequent timeline nodes execute.
 *
 * The attention-check summary fires once after the exit gate passes
 * (i.e. only for participants who met the practice criterion), so its
 * denominator counts every administered AC row (both iterations on a
 * re-loop).
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';
import { config } from '../config.js';
import { continueHintHtml } from '../visuals/continue-hint.js';
import { screenOutExit } from '../screen-out.js';
import { dOnlyInstructionNode, tOnlyInstructionNode } from './memory.js';
import { iOnlyInstructionNode } from './imagery.js';
import { iDInstructionNode, iTInstructionNode } from './dual.js';
import {
  dOnlyDemoNode,
  tOnlyDemoNode,
  iOnlyDemoNode,
  iDDemoNode,
  iTDemoNode,
  enumerateDemoNarrationStrings,
} from './demos.js';
import {
  ATTENTION_CHECK_ITEMS,
  typedAttentionCheckNode,
  attentionCheckSummaryNode,
} from './attention-checks.js';
import {
  singleTypePractice,
  computePracticeAccuracy,
  formatPracticeFeedbackHtml,
} from '../scheduler/practice.js';
import { setPracticeIteration } from '../scheduler/trial-meta.js';
import { getSessionPRNG } from '../prng.js';
import {
  consumeDeveloperSkip,
  registerHiddenNavStep,
  registerInstructionFactory,
  trackHiddenNavNode,
  trackInstructionNode,
} from '../hidden-nav.js';

/**
 * The text of every instruction deck as shown to participants (the markup of
 * each page, in order), keyed by deck. Used to identify the wording a session
 * saw.
 *
 * @returns {Record<string, string>}
 */
export function instructionDeckTexts() {
  const pages = (node) => node.pages.join('\n');
  return {
    overview: instructionsOverview().stimulus,
    practice_readiness: practiceReadinessNode().stimulus,
    d_only: pages(dOnlyInstructionNode()),
    t_only: pages(tOnlyInstructionNode()),
    i_only: pages(iOnlyInstructionNode()),
    i_d: pages(iDInstructionNode()),
    i_t: pages(iTInstructionNode()),
    demo_narration: enumerateDemoNarrationStrings().join('\n'),
  };
}

export function instructionsOverview() {
  const perType = config.blocks.practice_trials_per_type;
  const totalPractice = perType * 5;
  const critPct = Math.round(config.practice.accuracy_criterion * 100);
  const node = {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="max-width: 38rem; margin: 0 auto; text-align: left;">
        <h2 style="text-align: center;">Instructions</h2>
        <div data-voiceover-target>
          <p>You are about to learn <strong>five short tasks</strong>.
          We'll teach them one at a time: <strong>for each task</strong>
          you will first read a short page of instructions and then do a
          few practice trials of that task before moving on to the next.</p>
          <p>Practice has ${totalPractice} trials in total (${perType} per
          task). A few quick reading checks are mixed in along the way –
          please read each page carefully.</p>
          <p>If your practice score across all five tasks is below
          ${critPct}%, the whole instructions-and-practice sequence will
          run once more so you can get the hang of it. If your score
          remains below ${critPct}% after the second attempt, the session
          will end.</p>
        </div>
        ${continueHintHtml('Press <kbd>Space</kbd> to begin.')}
      </div>
    `,
    choices: [' '],
    data: { phase: 'instructions_overview' },
  };
  registerInstructionFactory(node.data.phase, instructionsOverview);
  return trackInstructionNode(node);
}

export function practiceReadinessNode() {
  const critPct = Math.round(config.practice.accuracy_criterion * 100);
  const node = {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="max-width: 34rem; margin: 0 auto; text-align: center;">
        <h2>Before you begin</h2>
        <div data-voiceover-target>
          <p style="font-size: 1.05rem; line-height: 1.6;">
            Please try to be <strong>as accurate as you can</strong> during
            the practice trials.</p>
          <p style="font-size: 1.05rem; line-height: 1.6;">
            If your overall practice score falls below
            <strong>${critPct}%</strong>, you will be returned to the
            beginning of the instructions to read them again and repeat
            the practice. If your score remains below
            <strong>${critPct}%</strong> after the second attempt, the
            session will end and you will be redirected back to
            Prolific.</p>
        </div>
        ${continueHintHtml('Press <kbd>Space</kbd> to continue.')}
      </div>
    `,
    choices: [' '],
    data: { phase: 'practice_readiness' },
  };
  registerInstructionFactory(node.data.phase, practiceReadinessNode);
  return trackInstructionNode(node);
}

/**
 * Build the full instructions + per-type practice timeline, wrapped in a
 * single jsPsych `loop_function` and book-ended by the overview screen and
 * the attention-check summary.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.trialsPerType]      override config.blocks.practice_trials_per_type
 * @param {number}  [opts.accuracyCriterion]  override config.practice.accuracy_criterion
 * @param {number}  [opts.maxLoops]           override config.practice.max_loops
 * @param {object}  [opts.prng]               session PRNG; defaults to getSessionPRNG()
 * @returns {object[]}                        flat array of jsPsych timeline nodes
 */
export function assembleInstructionsAndPractice({
  trialsPerType,
  accuracyCriterion,
  maxLoops,
  prng,
} = {}) {
  if (ATTENTION_CHECK_ITEMS.length !== 3) {
    throw new Error(
      `assembleInstructionsAndPractice: expected exactly 3 attention-check items, got ${ATTENTION_CHECK_ITEMS.length}`
    );
  }
  const [ac1, ac2, ac3] = ATTENTION_CHECK_ITEMS;

  const perType = trialsPerType ?? config.blocks.practice_trials_per_type;
  const criterion = accuracyCriterion ?? config.practice.accuracy_criterion;
  const cap = maxLoops ?? config.practice.max_loops;
  const rng = prng ?? getSessionPRNG();

  /* Five per-type practice mini-blocks. Same PRNG instance threaded through
   * all of them so the across-type pool state remains deterministic. */
  const dPractice = singleTypePractice({ trialType: 'd_only', trialsPerType: perType, prng: rng });
  const tPractice = singleTypePractice({ trialType: 't_only', trialsPerType: perType, prng: rng });
  const iPractice = singleTypePractice({ trialType: 'i_only', trialsPerType: perType, prng: rng });
  const idPractice = singleTypePractice({ trialType: 'i_d', trialsPerType: perType, prng: rng });
  const itPractice = singleTypePractice({ trialType: 'i_t', trialsPerType: perType, prng: rng });

  /* Closure state — fresh per call; one instructions-and-practice block per
   * session. attemptCount and iterationStartRow are mutated by the marker's
   * `on_start` so the feedback node can slice this iteration's data and so
   * the loop_function can know whether the cap is exhausted. */
  let attemptCount = 0;
  let iterationStartRow = 0;
  let lastIterationResult = null;

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

  function practiceFeedbackNode() {
    const stepId = 'practice_feedback';
    const node = {
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
        return formatPracticeFeedbackHtml({ acc, passed, willRetry, criterion });
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
    registerHiddenNavStep(stepId, practiceFeedbackNode);
    return trackHiddenNavNode(node, stepId);
  }

  const feedbackNode = practiceFeedbackNode();

  const innerTimeline = [
    markerNode,
    practiceReadinessNode(),
    /* Memory arc — D-only and T-only, then AC1. Each instruction screen
     * is followed by a slowed-down auto-playing demo of the trial type
     * (mirrors Amir's reference experiment) before practice begins. */
    dOnlyInstructionNode(),
    dOnlyDemoNode(),
    ...dPractice.nodes,
    tOnlyInstructionNode(),
    tOnlyDemoNode(),
    ...tPractice.nodes,
    typedAttentionCheckNode(ac1),
    /* Imagery arc — I-only, then AC2. */
    iOnlyInstructionNode(),
    iOnlyDemoNode(),
    ...iPractice.nodes,
    typedAttentionCheckNode(ac2),
    /* Dual arc — I+D and I+T, then AC3. */
    iDInstructionNode(),
    iDDemoNode(),
    ...idPractice.nodes,
    iTInstructionNode(),
    iTDemoNode(),
    ...itPractice.nodes,
    typedAttentionCheckNode(ac3),
    feedbackNode,
  ];

  const loopNode = {
    timeline: innerTimeline,
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

  return [instructionsOverview(), loopNode, practiceFailureExit(), attentionCheckSummaryNode()];
}

/**
 * Conditional exit node — fires only when the participant failed to reach
 * the practice accuracy criterion after the maximum allowed attempts.
 *
 * A `conditional_function` checks the most recent `practice_feedback` data row;
 * if `iteration_passed === false`, the participant is shown a polite end-of-
 * session screen and, through the shared screen-out path, is sent to the
 * Prolific screen-out completion URL. The experiment is then aborted.
 *
 * @returns {object} jsPsych conditional timeline node
 */
function practiceFailureExit() {
  const critPct = Math.round(config.practice.accuracy_criterion * 100);
  const lastFeedback = () =>
    window.jsPsych?.data?.get().filter({ phase: 'practice_feedback' }).last(1).values()[0];

  return screenOutExit({
    phase: 'practice_disqualification',
    exitReason: 'practice_criterion_not_met',
    flush: true,
    reasonHtml: () => {
      const last = lastFeedback();
      const pct =
        last?.iteration_accuracy !== undefined && last?.iteration_accuracy !== null
          ? Math.round(last.iteration_accuracy * 100)
          : '–';
      const attempts = last?.practice_iteration ?? '–';
      return (
        '<h2>Thank you for your effort</h2>' +
        '<p style="font-size: 1.05rem;">' +
        'Your practice accuracy was ' +
        pct +
        '% after ' +
        attempts +
        ' attempt' +
        (attempts === 1 ? '' : 's') +
        ', which is below the required ' +
        critPct +
        '% threshold. ' +
        'Our pre-registered protocol requires participants to demonstrate ' +
        'at least ' +
        critPct +
        '% accuracy on the practice trials before ' +
        'proceeding to the main task.</p>' +
        '<p>This is not a reflection of your ability. The task is ' +
        'genuinely challenging and requires familiarity with several ' +
        'concurrent response rules. We sincerely appreciate your ' +
        'willingness to participate.</p>'
      );
    },
    onFinish: (data) => {
      const last = lastFeedback();
      data.final_practice_accuracy = last?.iteration_accuracy ?? null;
      data.final_practice_correct = last?.iteration_correct ?? null;
      data.final_practice_total = last?.iteration_total ?? null;
      data.practice_attempts = last?.practice_iteration ?? null;
    },
    condition: () => lastFeedback()?.iteration_passed === false,
  });
}
