/**
 * Main-task intro / outro instruction screens.
 *
 * Kept separate from `runner.js` so the voiceover harvester
 * (`scripts/harvest-voiceover.js`) can import and inspect each factory's
 * stimulus HTML for `[data-voiceover-target]` regions without loading the
 * runner, a side-effect-heavy bootstrap entry that imports the storage /
 * Prolific layer at module load.
 *
 * Three nodes, all narrated:
 *   - `mainAIntroNode()`     — "Main task — Block 1 of 2"
 *   - `mainBIntroNode()`     — "Main task — Block 2 of 2"
 *   - `endOfTaskIntroNode()` — "You've finished the task"
 *
 * Each node carries a `[data-voiceover-target]` body and registers a
 * hidden-nav checkpoint so the experimenter's `U` / `R` keys advance
 * through them. `endOfTaskIntroNode` also unmounts the `Trial X / 120`
 * counter on entry so it doesn't leak into the questionnaire chain.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';

import { config } from './config.js';
import { registerHiddenNavStep, trackHiddenNavNode } from './hidden-nav.js';
import { unmountTrialCounter } from './conditions/trial-counter.js';
import { narrateNowIfPresent } from './visuals/voiceover-slide.js';
import { continueHintHtml } from './visuals/continue-hint.js';

export function mainAIntroNode() {
  const stepId = 'main_a_intro';
  const node = {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="max-width: 36rem; margin: 0 auto;">
        <h2>Practice is over — the main trials start now</h2>
        <div data-voiceover-target>
          <p>Practice is over. The main trials start now. There are two
          blocks of 60 trials. Each block includes a
          ${config.blocks.rest_duration_s}-second rest after trials 20 and 40,
          and there is another ${config.blocks.rest_duration_s}-second rest
          between the two blocks.</p>
          <p>Same controls as the practice: <strong>Yes</strong> /
          <strong>On-pattern</strong> on the
          <kbd>&rarr;</kbd> RIGHT arrow key,
          <strong>No</strong> / <strong>Not on-pattern</strong> on the
          <kbd>&larr;</kbd> LEFT arrow key.</p>
          <p><strong>Important:</strong> Before you press both arrow keys
          to start each trial, look at the label shown above the circle.
          It tells you what type of trial is coming next, so you know
          what to expect.</p>
          ${continueHintHtml('Press <kbd>Space</kbd> to begin Block 1.')}
        </div>
      </div>
    `,
    choices: [' '],
    data: { phase: 'main_a_intro' },
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

export function mainBIntroNode() {
  const stepId = 'main_b_intro';
  const node = {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="max-width: 36rem; margin: 0 auto;">
        <h2>Main task — Block 2 of 2</h2>
        <div data-voiceover-target>
          <p>Last block. 60 more trials, same controls, with
          ${config.blocks.rest_duration_s}-second rests after trials 20
          and 40.</p>
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
        <h2>Thank you — you've finished the task</h2>
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
    on_load: () => {
      /* Main task is over — remove the dim "Trial X / 120" overlay so it
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
