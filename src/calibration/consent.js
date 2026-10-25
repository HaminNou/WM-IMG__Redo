/**
 * Consent + audio-context unlock.
 *
 * The consent button click is also our user-gesture trigger for AudioContext —
 * after this trial the audio system is permitted to play sound. If we tried to
 * unlock later (e.g., on the volume-calibration screen), Safari and some
 * Chrome configs would still block the first tone.
 *
 * The form text is in `consent-text.js`.
 */
import htmlButtonResponse from '@jspsych/plugin-html-button-response';
import { unlockAudio } from '../audio/context.js';
import { registerHiddenNavStep, trackHiddenNavNode } from '../hidden-nav.js';
import { consentBodyHtml } from './consent-text.js';

const CONSENT_VERSION = 'online-2101803-v1';

export function consentTrial() {
  const stepId = 'consent';
  /* Closure-captured at change time so on_finish can read it after jsPsych
   * has torn down the trial DOM. */
  let acknowledged = false;
  const node = {
    type: htmlButtonResponse,
    stimulus: consentBodyHtml(),
    choices: ['I consent – begin', 'I do not consent – exit'],
    button_html: (choice, idx) =>
      `<button class="jspsych-btn" data-idx="${idx}"${idx === 0 ? ' disabled' : ''}>${choice}</button>`,
    on_load: () => {
      acknowledged = false;
      const checkbox = document.getElementById('consent-checkbox');
      const consentBtn = document.querySelector('button.jspsych-btn[data-idx="0"]');
      if (!checkbox || !consentBtn) return;
      checkbox.addEventListener('change', () => {
        acknowledged = checkbox.checked;
        consentBtn.disabled = !checkbox.checked;
      });
    },
    on_finish: async (data) => {
      data.consented = data.response === 0;
      data.consent_acknowledged = acknowledged;
      data.consent_version = CONSENT_VERSION;
      if (data.consented) {
        /* Click was the gesture; the await happens off the trial timeline so
         * jsPsych moves on without waiting for it. By the next trial the
         * context is ready. */
        await unlockAudio();
      }
    },
    data: { phase: 'consent' },
  };
  registerHiddenNavStep(stepId, consentTrial);
  return trackHiddenNavNode(node, stepId);
}

/**
 * Conditional timeline node that ends the experiment if the participant
 * declined. Declining is a withdrawal, not a screen-out: the participant is
 * told how to withdraw on Prolific. Returned as a separate node so callers
 * can place it directly after `consentTrial()`. Nothing is uploaded.
 */
export function consentGate() {
  return {
    timeline: [
      {
        type: htmlButtonResponse,
        stimulus: `
          <h2>Thank you</h2>
          <p>You declined consent, so the study will not continue and no data from this session will be kept.</p>
          <p>To withdraw, please close this window, go back to Prolific, and select &ldquo;Stop without completing&rdquo;, which returns your submission. You will not be penalized for declining.</p>
        `,
        choices: ['Close'],
        data: { phase: 'consent_declined', exit_reason: 'consent_declined' },
        on_finish: () => {
          if (typeof window !== 'undefined' && window.jsPsych?.abortExperiment) {
            window.jsPsych.abortExperiment('Consent declined.');
          }
        },
      },
    ],
    conditional_function: () => {
      const last = window.jsPsych?.data?.get().filter({ phase: 'consent' }).last(1).values()[0];
      return last ? last.consented === false : false;
    },
  };
}
