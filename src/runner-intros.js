/**
 * Main-task intro / outro instruction screens.
 *
 * Kept separate from `runner.js` so the voiceover harvester
 * (`scripts/harvest-voiceover.js`) can import and inspect each factory's
 * stimulus HTML for `[data-voiceover-target]` regions without loading the
 * runner, a side-effect-heavy bootstrap entry that imports the storage /
 * Prolific layer at module load.
 *
 * Four nodes (all narrated except the tag reminder, see its comment):
 *   - `mainAIntroNode()`     — "Main task — Block 1 of 2"
 *   - `mainATagReminderNode()` — "Before every trial: check the tag" (the last screen
 *                              before Block 1's first trial gate)
 *   - `mainBIntroNode()`     — "Main task — Block 2 of 2"
 *   - `endOfTaskIntroNode()` — "You've finished the task"
 *
 * Each node carries a `[data-voiceover-target]` body and registers a
 * hidden-nav checkpoint so the experimenter's `U` / `R` keys advance
 * through them. `endOfTaskIntroNode` also unmounts the `X/120` counter
 * counter on entry so it doesn't leak into the questionnaire chain.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';

import { config } from './config.js';
import { registerHiddenNavStep, trackHiddenNavNode } from './hidden-nav.js';
import { unmountTrialCounter } from './conditions/trial-counter.js';
import { narrateNowIfPresent, unmountToggle } from './visuals/voiceover-slide.js';
import { getVoiceover } from './visuals/voiceover.js';
import { continueHintHtml } from './visuals/continue-hint.js';
import { TRIAL_TYPE_LABELS, trialTypeTagHtml } from './conditions/shared.js';

/**
 * Leaving a narrated screen: stop any utterance still running and remove the "Voice on/off"
 * pill. The pill is mounted when a narrated screen is handed to the engine and is otherwise only
 * removed by the trial-start gate, so without this it stayed on the end-of-task questionnaires,
 * the upload screen and the redirect screen, where nothing is narrated.
 */
function leaveNarratedScreen() {
  unmountToggle();
  try {
    getVoiceover().cancel();
  } catch {
    /* engine init touches localStorage/document; never let this block the session */
  }
}

export function mainAIntroNode() {
  const stepId = 'main_a_intro';
  const node = {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="max-width: 36rem; margin: 0 auto;">
        <h2>Practice is over – the main trials start now</h2>
        <div data-voiceover-target>
          <p>Practice is over. The main trials start now. There are two
          blocks of 60 trials. Block 1 includes a
          ${config.blocks.rest_duration_s}-second rest after trials 20 and 40,
          Block 2 includes ${config.blocks.rest_duration_s}-second rests after
          trials 15, 30 and 45, and there is another
          ${config.blocks.rest_duration_s}-second rest between the two
          blocks.</p>
          <p>Same controls as the practice: <strong>Yes</strong> or
          <strong>On-pattern</strong> on the
          <kbd>&rarr;</kbd> RIGHT arrow key,
          <strong>No</strong> or <strong>Not on-pattern</strong> on the
          <kbd>&larr;</kbd> LEFT arrow key.</p>
          <p><strong>Important:</strong> To start each trial, press the
          Left and Right arrow keys <strong>at the same time</strong>.
          Before you do, look at the label shown above the circle. It
          tells you what type of trial is coming next, so you know what
          to expect.</p>
          ${continueHintHtml('Press <kbd>Space</kbd> to begin Block 1.')}
        </div>
      </div>
    `,
    choices: [' '],
    data: { phase: 'main_a_intro' },
    on_finish: leaveNarratedScreen,
    /* Voiceover scope (see runner.js): the global slide-narration observer
     * is intentionally NOT installed, so instruction decks / calibration /
     * questionnaires stay silent. This single screen, the practice→main
     * boundary announcement, is one of two manually-narrated exceptions
     * (the other is the end-of-task "thank you" screen). Calling
     * `narrateNowIfPresent` from `on_load` triggers narration for the
     * [data-voiceover-target] in this stimulus only. */
    on_load: () => {
      narrateNowIfPresent();
    },
  };
  registerHiddenNavStep(stepId, mainAIntroNode);
  return trackHiddenNavNode(node, stepId);
}

/* What comes next for each trial tag, in the wording of the instruction slides
 * (Tasks 1-5): remember the dots / the tones, picture the pattern and judge the stars,
 * or both together. Keyed by the same trial-type ids as TRIAL_TYPE_LABELS. */
const TAG_MEANING = Object.freeze({
  d_only: 'remember the dots, then answer Yes or No for each dot test.',
  t_only: 'remember the tones, then answer Yes or No for each tone test.',
  i_only: 'picture the pattern and judge each star: On-pattern or Not on-pattern.',
  i_d: 'judge each star against the pattern and remember the dots.',
  i_t: 'judge each star against the pattern and remember the tones.',
});

/* A small stand-in for the circle under the example tag: the bull's-eye ring and dot. */
const MINI_CIRCLE_HTML = `<span class="tag-reminder-circle" aria-hidden="true" style="display: inline-block; position: relative; width: 4.2rem; height: 4.2rem; border: 2px solid rgba(255, 255, 255, 0.55); border-radius: 50%; box-sizing: border-box;"><span style="position: absolute; top: 50%; left: 50%; width: 0.45rem; height: 0.45rem; margin: -0.225rem 0 0 -0.225rem; border-radius: 50%; background: rgba(255, 255, 255, 0.8);"></span></span>`;

/**
 * One-time slide shown as the last screen before the first trial gate of Block 1: before
 * every trial starts, look at the tag above the circle, because it says which kind of task
 * the trial is. The five tags are the live ones (`trialTypeTagHtml`).
 */
export function mainATagReminderNode() {
  const stepId = 'main_a_tag_reminder';
  const rows = Object.keys(TRIAL_TYPE_LABELS)
    .map(
      (type) =>
        `<li class="tag-reminder-row" style="display: flex; align-items: center; gap: 0.8rem; margin: 0.55rem 0;"><span style="flex: 0 0 10.5rem; text-align: left;">${trialTypeTagHtml(type)}</span><span class="tag-reminder-meaning" style="white-space: nowrap;">– ${TAG_MEANING[type]}</span></li>`
    )
    .join('');
  const node = {
    type: htmlKeyboardResponse,
    stimulus: `
      <div class="slide-text tag-reminder" style="max-width: 56rem; margin: 0 auto;">
        <h2>Before every trial: check the tag</h2>
        <div class="tag-reminder-example" style="text-align: center; margin: 0.6rem 0 0.8rem;">
          ${trialTypeTagHtml('d_only')}
          <div style="margin-top: 0.5rem;">${MINI_CIRCLE_HTML}</div>
        </div>
        <div>
          <p>Before every trial starts, look at the small tag at the top of
          the circle. It tells you which kind of task the upcoming trial is,
          so you know what to expect. The five kinds of trial are mixed in a
          random order, so you cannot know in advance which one comes next:
          check the tag before you start each trial.</p>
          <div style="text-align: center;"><ul style="display: inline-block; text-align: left; list-style: none; padding: 0; margin: 0.8rem 0 0;">${rows}</ul></div>
          ${continueHintHtml('Press <kbd>Space</kbd> to start the first trial.')}
        </div>
      </div>
    `,
    choices: [' '],
    data: { phase: 'main_a_tag_reminder' },
    /* Not narrated yet: the Edge TTS endpoint refused the render (HTTP 403) when this
     * slide was written. To narrate it, put 'data-voiceover-target' on the body div,
     * add 'on_load: () => narrateNowIfPresent()' and 'on_finish: leaveNarratedScreen'
     * as on the screens around it, then run 'npm run harvest-voiceover' and
     * 'npm run render-voiceover-edge' (the harvester already visits this node). */
  };
  registerHiddenNavStep(stepId, mainATagReminderNode);
  return trackHiddenNavNode(node, stepId);
}

export function mainBIntroNode() {
  const stepId = 'main_b_intro';
  const node = {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="max-width: 36rem; margin: 0 auto;">
        <h2>Main task – Block 2 of 2</h2>
        <div data-voiceover-target>
          <p>Last block. 60 more trials, same controls, with
          ${config.blocks.rest_duration_s}-second rests after trials 15,
          30 and 45.</p>
          ${continueHintHtml('Press <kbd>Space</kbd> to begin Block 2.')}
        </div>
      </div>
    `,
    choices: [' '],
    data: { phase: 'main_b_intro' },
  };
  registerHiddenNavStep(stepId, mainBIntroNode);
  return trackHiddenNavNode(node, stepId);
}

export function endOfTaskIntroNode() {
  const stepId = 'end_of_task_intro';
  const node = {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="max-width: 36rem; margin: 0 auto;">
        <h2>Thank you – you've finished the task</h2>
        <div data-voiceover-target>
          <p>Thank you for completing the trials. Your work is enormously
          helpful to our research, and we are grateful for your time and
          attention.</p>
          <p>A couple of short questionnaires are next. Once you finish
          them, your data will be saved and you will be returned to
          Prolific.</p>
          ${continueHintHtml('Press <kbd>Space</kbd> to continue.')}
        </div>
      </div>
    `,
    choices: [' '],
    data: { phase: 'end_of_task_intro' },
    on_finish: leaveNarratedScreen,
    on_load: () => {
      /* Main task is over — remove the small gray "X/120" counter so it
       * doesn't bleed into the questionnaire chain. */
      unmountTrialCounter();
      /* Voiceover scope (see runner.js): selective per-screen narration.
       * This is the "thank you" message the participant sees at the end
       * of the main experiment — the other manually-narrated exception
       * alongside `mainAIntroNode`. */
      narrateNowIfPresent();
    },
  };
  registerHiddenNavStep(stepId, endOfTaskIntroNode);
  return trackHiddenNavNode(node, stepId);
}
