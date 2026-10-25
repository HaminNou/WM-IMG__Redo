/**
 * Pre-audibility speaker-volume instruction.
 *
 * Browsers cannot read or set the operating-system output level, so we
 * stage the participant's hardware to a known anchor (~50 % of the
 * system master volume) BEFORE the in-page tone-audibility / comfort
 * step in `tone-familiarisation.js`. That sequencing matters: the
 * audibility step exposes an in-page slider that scales the experiment's
 * digital playback level relative to the system level, so if the
 * participant arrives with their system muted or at 100 %, the in-page
 * slider has very little useful headroom in either direction.
 *
 * The audibility/comfort step drives playback adjustment with the actual
 * 24-tone bank under a live in-page gain control. This page is a pure
 * instruction screen with no audio.
 */
import htmlButtonResponse from '@jspsych/plugin-html-button-response';
import { registerHiddenNavStep, trackHiddenNavNode } from '../hidden-nav.js';

export function speakerVolumeInstructionTrial() {
  const stepId = 'speaker_volume_instruction';
  const node = {
    type: htmlButtonResponse,
    stimulus: `
      <h2>Set your system volume to about 50%</h2>
      <div data-voiceover-target>
        <p style="max-width: 38rem; margin: 0 auto 1rem;">
          Open your computer's volume control (in the system toolbar or
          settings) and set the master volume to roughly the
          <strong>middle of its range</strong>.
        </p>
        <p style="max-width: 38rem; margin: 0 auto 1rem;">
          On the next page, you will hear a sequence of tones. You will use
          an on-screen slider to fine-tune the loudness to a comfortable
          level – so leaving your system volume near the middle gives that
          slider room to move in either direction.
        </p>
        <p style="max-width: 38rem; margin: 0 auto;">
          When your system volume is set, click Continue.
        </p>
      </div>
    `,
    choices: ['Continue'],
    data: { phase: 'speaker_volume_instruction' },
  };
  registerHiddenNavStep(stepId, speakerVolumeInstructionTrial);
  return trackHiddenNavNode(node, stepId);
}
