/**
 * Typed-instruction attention checks — design §11.4.
 *
 * Three short typed-response items scattered through the instruction screens.
 * The participant types a single word; the response is normalised (lowercased,
 * trimmed) and compared against the expected answer. Each check tags its data
 * row with `attention_check_id` and `attention_check_passed: boolean`.
 *
 * Scoring:
 *   - "Pass" iff `normalize(response) === normalize(expectedAnswer)`. Normalize
 *     drops surrounding whitespace and folds to lowercase. Punctuation is
 *     intentionally NOT stripped because the prompts ask for single short
 *     words; participants who type "blue." or "blue!" reveal sloppy reading
 *     and should fail (the design intent is to catch low-effort responding,
 *     not to be charitable about typing).
 *   - "Failure" count is the number of failed checks across the full set.
 *   - Threshold is `config.attention_checks.instruction_max_failures` (= 1).
 *     Cumulative failures > threshold → flag the participant for analysis-
 *     level exclusion. **Do not** end the session early; the
 *     participant still finishes and receives full pay (the flag is recorded
 *     in the data so the analysis script can apply the pre-registered
 *     exclusion).
 *
 * Three items below. The wording is low-stakes English with an unambiguous
 * one-word expected answer.
 */
import surveyHtmlForm from '@jspsych/plugin-survey-html-form';
import { config } from '../config.js';
import { registerHiddenNavStep, trackHiddenNavNode } from '../hidden-nav.js';

/* The three items. Order is meaningful — they're interleaved through the
 * memory / imagery / dual instruction blocks in `instructions/index.js`. */
export const ATTENTION_CHECK_ITEMS = Object.freeze([
  Object.freeze({
    id: 'ac1_direct_instruction',
    prompt:
      'To show you are reading carefully, please type the word <strong>paper</strong> into the box below (lowercase, no punctuation).',
    expected_answer: 'paper',
  }),
  Object.freeze({
    id: 'ac2_third_word',
    prompt:
      'In the sentence “Click the third word in this sentence”, what is the third word? Type just that word into the box below.',
    expected_answer: 'third',
  }),
  Object.freeze({
    id: 'ac3_arrow_mapping',
    prompt:
      'In this study, the right-arrow key means “Yes” and “On-pattern”. To show you understood, type the word <strong>right</strong> into the box below.',
    expected_answer: 'right',
  }),
]);

/**
 * Normalise a typed response for comparison: trim surrounding whitespace and
 * fold to lowercase. Used by both the on_finish judge and the
 * `evaluateAttentionChecks` test helper, so a response that passes one path
 * is guaranteed to pass the other.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function normaliseAttentionAnswer(s) {
  if (typeof s !== 'string') return '';
  return s.trim().toLowerCase();
}

/**
 * Build a jsPsych `survey-html-form` node for one typed-attention-check item.
 *
 * @param {object} item   one entry from `ATTENTION_CHECK_ITEMS`
 * @returns {object}      jsPsych timeline node
 */
export function typedAttentionCheckNode(item) {
  if (!item?.id || !item?.prompt || !item?.expected_answer) {
    throw new Error(
      `typedAttentionCheckNode: item must have {id, prompt, expected_answer}, got ${JSON.stringify(item)}`
    );
  }
  const stepId = `attention_check_${item.id}`;
  const node = {
    type: surveyHtmlForm,
    preamble: `<h2>Quick check</h2>`,
    html: `
      <div style="text-align:left; max-width: 36rem; margin: 0 auto;">
        <p style="margin: 0.75rem 0;">${item.prompt}</p>
        <p style="margin: 0.75rem 0;">
          <label>Your answer:
            <input
              name="response"
              type="text"
              required
              autocomplete="off"
              spellcheck="false"
              style="margin-left: 0.5rem; width: 12rem;"
            />
          </label>
        </p>
      </div>
    `,
    button_label: 'Continue',
    on_finish: (data) => {
      const raw = data.response?.response ?? '';
      const normalised = normaliseAttentionAnswer(raw);
      data.attention_check_id = item.id;
      data.attention_check_raw = raw;
      data.attention_check_passed = normalised === normaliseAttentionAnswer(item.expected_answer);
    },
    data: { phase: 'attention_check' },
  };
  registerHiddenNavStep(stepId, () => typedAttentionCheckNode(item));
  return trackHiddenNavNode(node, stepId);
}

/**
 * Pure helper — tally results across the data rows of all attention checks.
 * Used by tests, by the runner's `on_finish` reporting, and by the post-pilot
 * analysis script.
 *
 * @param {object[]} rows         array of jsPsych data rows (any phase)
 * @param {number}   [maxFailures] override config default
 * @returns {{
 *   total: number,
 *   passed: number,
 *   failed: number,
 *   exceededThreshold: boolean,
 *   threshold: number,
 *   ids: string[]
 * }}
 */
export function evaluateAttentionChecks(
  rows,
  maxFailures = config.attention_checks.instruction_max_failures
) {
  const checks = (rows ?? []).filter((r) => r?.phase === 'attention_check');
  const passed = checks.filter((r) => r.attention_check_passed === true).length;
  const failed = checks.filter((r) => r.attention_check_passed === false).length;
  return {
    total: checks.length,
    passed,
    failed,
    exceededThreshold: failed > maxFailures,
    threshold: maxFailures,
    ids: checks.map((r) => r.attention_check_id),
  };
}

/**
 * Conditional jsPsych node that, AFTER all three checks have been
 * administered, stamps a session-level summary row tagged
 * `phase: 'attention_check_summary'`. The row carries `attention_excluded`
 * which downstream analysis scripts use to apply the §11.4 exclusion rule.
 *
 * Crucially this node does NOT end the session — per design §11.4 the
 * participant finishes the experiment and is paid; only the analysis
 * exclusion flag is set.
 */
export function attentionCheckSummaryNode() {
  const stepId = 'attention_check_summary';
  const node = {
    type: surveyHtmlForm,
    preamble: `<h2>Thanks – moving on.</h2>`,
    html: `
      <div style="max-width: 36rem; margin: 0 auto;">
        <p>Press <strong>Continue</strong> to proceed to the main task.</p>
      </div>
    `,
    button_label: 'Continue',
    on_finish: (data) => {
      const allRows = window.jsPsych?.data?.get().values() ?? [];
      const summary = evaluateAttentionChecks(allRows);
      data.phase = 'attention_check_summary';
      data.attention_total = summary.total;
      data.attention_passed = summary.passed;
      data.attention_failed = summary.failed;
      data.attention_excluded = summary.exceededThreshold;
      data.attention_threshold = summary.threshold;
    },
  };
  registerHiddenNavStep(stepId, attentionCheckSummaryNode);
  return trackHiddenNavNode(node, stepId);
}
