/**
 * Imagery-only trial-type instruction screen (I-only).
 *
 * Audience: general-public Prolific participants. Copy is plain English —
 * no jargon like "set size", "probe", "encoding", "stimulus", "imagery
 * maintenance", or "rotated mental representation". The participant is
 * asked, in normal language, to (a) keep the pattern in mind that they
 * just learned in the demo, (b) turn it the way the arrow shows, and
 * (c) decide whether each star is on-pattern or not on-pattern relative
 * to that turned pattern.
 *
 * Visual frame language (matches the memory screens): the participant
 * only ever sees the bull's-eye circle. The 5×5 cell grid is invisible.
 * Copy therefore says "inside the circle" / "location" instead of "on
 * the grid" / "square", and never tells the participant which square
 * the star is on — only whether it lands on the rotated pattern.
 *
 * The non-trivial design constraint to communicate is **rotation**: the
 * star's on/off-pattern membership is judged against the *rotated*
 * mental pattern, not the upright one. The rotation-cue arrow is shown
 * here (and in I+D / I+T) precisely because imagery is involved —
 * without an imagery component there is nothing to rotate, so D-only and
 * T-only screens never mention the cue. The specific rotation angle is
 * NOT written into the copy: the arrow alone tells the participant
 * which way to turn the pattern, mirroring the reference experiment.
 *
 * Pagination: the long instruction text is delivered as a sequence of
 * short pages through the jsPsych instructions plugin so the participant
 * sees one piece at a time. Space (or Next) advances; Left arrow
 * (or Previous) goes back. The last page advances out of the trial and
 * into the per-type demo.
 */
import jsPsychInstructions from '@jspsych/plugin-instructions';
import { config } from '../config.js';
import { registerInstructionFactory, trackInstructionNode } from '../hidden-nav.js';
import { slideStimulusPage } from '../visuals/slide-layout.js';
import { FEEDBACK_GREEN, FEEDBACK_RED } from './feedback-words.js';
import { ARROW_MEANING_HTML, ARROW_MEANING_TEXT, PATTERN_REMINDER_SECONDS } from './shared-copy.js';

/* See `slide-layout.js` for the unification rationale — the H2 title
 * and the plugin's Previous/Next nav land at the same y across every
 * page of every deck (and across the calibration intros and the five
 * demo screens) because every wrapper shares the same `min-height`. */
/* Match the exact feedback green/red the participant sees on a live trial
 * and in the demo animation — same #0BC926 / #FF1818 hex at full opacity. */
const CALLOUT_OPEN = `<p style="border-left: 3px solid #772139; padding: 0.5rem 0.75rem; margin: 1rem 0; background: rgba(119, 33, 57, 0.08);">`;

const NAV_OPTS = Object.freeze({
  key_forward: ' ',
  key_backward: 'ArrowLeft',
  allow_backward: true,
  allow_keys: true,
  show_clickable_nav: true,
  show_page_number: true,
  page_label: 'Page',
  button_label_previous: 'Previous',
  button_label_next: 'Next',
});

export function iOnlyInstructionNode() {
  const starsPerTrial = config.imagery.stars_per_trial;
  const title = 'Task 3 – Picture the pattern';
  const pages = [
    slideStimulusPage({
      title,
      body: `
        <p>In Task 3 you will <strong>picture this pattern in your
        mind</strong> and keep that picture clear while you respond.</p>
        ${CALLOUT_OPEN}
        <strong style="color: #772139;">Important:</strong> the
        demonstration will show this pattern once more so you can commit
        it to memory. During the task, right after you start a trial and
        before the arrow, the upright pattern will sometimes appear again on
        its own screen for ${PATTERN_REMINDER_SECONDS} seconds, as a
        reminder. It is never shown during the rest of the trial.</p>
      `,
      narration: `In Task 3 you will picture this pattern in your mind and keep that picture clear while you respond. Important: the demonstration will show this pattern once more so you can commit it to memory. During the task, right after you start a trial and before the arrow, the upright pattern will sometimes appear again on its own screen for ${PATTERN_REMINDER_SECONDS} seconds, as a reminder. It is never shown during the rest of the trial.`,
      exemplar: ['pattern'],
    }),
    slideStimulusPage({
      title,
      body: `
        <p>Each trial begins with an <strong>arrow</strong>. The arrow
        tells you to <strong>turn the pattern in your mind</strong>, like
        rotating a piece of paper. ${ARROW_MEANING_HTML} Hold this turned
        pattern in mind.</p>
        <p>After the arrow goes away you'll have about
        <strong>5 seconds</strong> to imagine and turn the pattern, then the
        trial continues automatically.</p>
      `,
      narration: `Each trial begins with an arrow. The arrow tells you to turn the pattern in your mind, like rotating a piece of paper. ${ARROW_MEANING_TEXT} Hold this turned pattern in mind. After the arrow goes away you'll have about 5 seconds to imagine and turn the pattern, then the trial continues automatically.`,
      exemplar: ['arrow'],
    }),
    slideStimulusPage({
      title,
      body: `
        <p>Then <strong>${starsPerTrial} bright stars</strong> will flash
        inside the circle, one at a time. For each star, decide whether
        it lands on the <strong>rotated pattern you are picturing</strong>.</p>
        <p style="margin: 1.25rem 0;">
          Press <strong>On-pattern</strong> (<kbd>&rarr;</kbd> RIGHT arrow)
          if the star falls on your pictured pattern.<br />
          Press <strong>Not on-pattern</strong> (<kbd>&larr;</kbd> LEFT arrow)
          if it does not.
        </p>
      `,
      narration: `Then ${starsPerTrial} bright stars will flash inside the circle, one at a time. For each star, decide whether it lands on the rotated pattern you are picturing. Press On-pattern, the right arrow, if the star falls on your pictured pattern. Press Not on-pattern, the left arrow, if it does not.`,
      exemplar: ['star'],
    }),
    slideStimulusPage({
      title,
      body: `
        <p>You have <strong>3 seconds</strong> for each star. Aim for
        accuracy first, but don't dwell.</p>
        <p>If you answer in time, the star turns
        ${FEEDBACK_GREEN} for correct or
        ${FEEDBACK_RED} for incorrect while it is still on screen.</p>
        <p>Be honest about your mental picture – if it's fuzzy, just do
        your best.</p>
        <p>Keep your eyes on the small bull's-eye in the center of the circle throughout the trial.</p>
      `,
      narration: `You have 3 seconds for each star. Aim for accuracy first, but don't dwell. If you answer in time, the star turns green for correct or red for incorrect while it is still on screen. Be honest about your mental picture – if it's fuzzy, just do your best. Keep your eyes on the small bull's-eye in the center of the circle throughout the trial.`,
      exemplar: ['star'],
    }),
  ];
  const node = {
    type: jsPsychInstructions,
    pages,
    ...NAV_OPTS,
    data: { phase: 'instructions_imagery_i_only' },
  };
  registerInstructionFactory(node.data.phase, iOnlyInstructionNode);
  return trackInstructionNode(node);
}
