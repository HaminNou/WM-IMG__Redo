/**
 * Post-experiment questionnaire composer.
 *
 * Order: strategy questionnaire (19 items across five condition-specific
 * pages: dot-memory, tone-memory, pattern-imagery, image+dot dual,
 * image+tone dual; see `./strategy.js`) then the music-experience
 * questionnaire (Gold-MSI Musical Training subscale plus an absolute-pitch
 * self-report), which serves as a covariate for the non-musical tone bank:
 * it lets the analyst flag absolute-pitch and substantial-musical-training
 * cases.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';
import { strategyTimeline } from './strategy.js';
import { musicExperienceTimeline } from './music-experience.js';
import { registerHiddenNavStep, trackHiddenNavNode } from '../hidden-nav.js';
import { continueHintHtml } from '../visuals/continue-hint.js';

function questionnaireIntro() {
  const stepId = 'questionnaire_intro';
  const node = {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="max-width: 38rem; margin: 0 auto; text-align: left;">
        <h2 style="text-align: center;">One last set of questions</h2>
        <p>You have finished the main task – thank you. Before we save your
        data, we have two short questionnaires:</p>
        <ol>
          <li>A <strong>strategy</strong> questionnaire – five short pages
          (one per trial type) asking how you approached the dots, the
          tones, the pattern, and the two dual-task conditions
          (about 3–4 minutes).</li>
          <li>A <strong>music background</strong> questionnaire – eight quick
          questions about your music training and listening (about 1 minute).</li>
        </ol>
        <p>There are no right or wrong answers; people use very different
        strategies on these tasks, and that is exactly what we want to
        measure.</p>
        ${continueHintHtml('Press <kbd>Space</kbd> to begin.')}
      </div>
    `,
    choices: [' '],
    data: { phase: 'questionnaire_intro' },
  };
  registerHiddenNavStep(stepId, questionnaireIntro);
  return trackHiddenNavNode(node, stepId);
}

export function assembleQuestionnaireChain() {
  return [questionnaireIntro(), ...strategyTimeline(), ...musicExperienceTimeline()];
}
