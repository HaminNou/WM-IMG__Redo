/**
 * Practice-only response aids.
 *
 * (1) The two response buttons under the circle while a response window is open
 *     (memory probes and star judgements of the PRACTICE trials only). The window
 *     nodes take the label pair from `practiceProbeButtons(params)` /
 *     `practiceStarButtons(params)`, which return `null` for main trials, so a main
 *     trial never builds, mounts or styles a button.
 * (2) A self-paced notice after the first practice trial of D-only, T-only and
 *     I-only that zooms the buttons in and says they will not be shown in the main
 *     trials (`practiceButtonsNoticeNode`).
 *
 * The sides come from the task's key constants, not from a second mapping here:
 * Right = KEY_YES / KEY_ON, Left = KEY_NO / KEY_OFF, each mapped to a button side
 * through `ARROW_KEY_SIDE`.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';

import { continueHintHtml } from '../visuals/continue-hint.js';
import {
  ARROW_KEY_SIDE,
  PROBE_BUTTON_TEXT,
  STAR_BUTTON_TEXT,
  ensureResponseButtonStyles,
  trialButtonPairHtml,
  zoomIn,
} from '../visuals/response-buttons.js';
import {
  KEY_YES,
  KEY_NO,
  KEY_ON,
  KEY_OFF,
  isPracticeTrial,
  isFirstPracticeTrial,
} from './shared.js';

export const PRACTICE_BUTTONS_NOTICE_PHASE = 'practice_buttons_notice';
export const PRACTICE_BUTTONS_NOTICE_TEXT =
  'In the main experimental trials, you will not see these buttons anymore. Keep using the Left and Right arrow keys.';
export const PRACTICE_BUTTONS_NOTICE_HINT = 'Press <kbd>Space</kbd> to continue.';

/** Label pair `{left, right}` for the recognition probes (Right = Yes, Left = No). */
export const PROBE_BUTTON_LABELS = Object.freeze({
  [ARROW_KEY_SIDE[KEY_NO]]: PROBE_BUTTON_TEXT.no,
  [ARROW_KEY_SIDE[KEY_YES]]: PROBE_BUTTON_TEXT.yes,
});
/** Label pair for the star judgements (Right = On-pattern, Left = Not on-pattern). */
export const STAR_BUTTON_LABELS = Object.freeze({
  [ARROW_KEY_SIDE[KEY_OFF]]: STAR_BUTTON_TEXT.off,
  [ARROW_KEY_SIDE[KEY_ON]]: STAR_BUTTON_TEXT.on,
});

/** Probe-window buttons for this trial: the label pair in practice, else `null`. */
export function practiceProbeButtons(params) {
  return isPracticeTrial(params) ? PROBE_BUTTON_LABELS : null;
}
/** Star-window buttons for this trial: the label pair in practice, else `null`. */
export function practiceStarButtons(params) {
  return isPracticeTrial(params) ? STAR_BUTTON_LABELS : null;
}

/**
 * The notice node for the first practice trial of a single task, or `null` for any
 * other trial. Insert it after the trial's last response window, before its ITI.
 * Space is the only key; it is not a hidden-nav checkpoint, so the experimenter's
 * skip neutralises it like every other trial node.
 *
 * @param {object} params   trial params (reads `trial_meta`, `trial_index_in_block`)
 * @param {'d_only'|'t_only'|'i_only'} task
 * @param {{left: string, right: string}} labels   the task's button labels
 */
export function practiceButtonsNoticeNode(params, task, labels) {
  if (!isFirstPracticeTrial(params)) return null;
  return {
    type: htmlKeyboardResponse,
    stimulus: `
      <div class="practice-buttons-notice" style="max-width: 40rem; margin: 0 auto; text-align: center; background: #FFFFFF; color: #000000; border: 3px solid #772139; border-radius: 0.9rem; padding: 2rem 2.2rem 1.4rem; box-shadow: 0 12px 40px rgba(0,0,0,0.35);">
        <div class="practice-buttons-notice-zoom" style="display: flex; justify-content: center; margin: 0.5rem 0 1.6rem;">
          ${trialButtonPairHtml(labels, { large: true, inflow: true })}
        </div>
        <p style="font-size: 1.25rem; font-weight: 600; line-height: 1.45; margin: 0;">${PRACTICE_BUTTONS_NOTICE_TEXT}</p>
        ${continueHintHtml(PRACTICE_BUTTONS_NOTICE_HINT)}
      </div>
    `,
    choices: [' '],
    on_load: () => {
      ensureResponseButtonStyles();
      const zoom = document.querySelector('.practice-buttons-notice-zoom');
      if (zoom) zoomIn(zoom);
    },
    data: {
      phase: 'practice_buttons_notice',
      trial_index_in_block: params.trial_index_in_block,
      background_shade: params.background_shade ?? null,
      notice_task: task,
    },
  };
}
