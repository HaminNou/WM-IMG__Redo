/**
 * Dual-task trial-type instruction screens (I+D and I+T).
 *
 * Audience: general-public Prolific participants. Copy is plain English —
 * "remember the dots", "picture the pattern", "turn it the way the arrow
 * shows". Avoids jargon like "encoding stream", "interleaved", "subtask",
 * "mental image", "concurrent maintenance", "cognitive load", etc.
 *
 * Visual frame language (matches the memory and imagery screens): the
 * participant only ever sees the bull's-eye circle. The 5×5 cell grid is
 * invisible. Copy therefore says "inside the circle" / "location"
 * instead of "on the grid" / "square".
 *
 * Each screen teaches one dual-task type and emphasises three things:
 * (a) the rotation cue arrow tells the participant which way to turn
 * the pictured pattern in mind — exactly as in I-only; (b) dots/tones
 * and stars come mixed in together within one trial; and (c) keeping
 * the pictured pattern in mind for the WHOLE trial is critical, with a
 * single permitted "drop the image" moment when the central question
 * mark appears for the recognition tests at the end of the trial.
 *
 * The rotation cue is mentioned ONLY here and in `imagery.js` (I-only).
 * D-only and T-only screens deliberately do not mention it: in those
 * trials no rotation arrow is shown to the participant, because there
 * is nothing to picture or turn. The grid layout that would be rotated
 * still exists in the abstract experimental design across all five
 * trial types, but the participant only ever sees the arrow on
 * imagery-bearing trials. The specific rotation angle is NOT written
 * into the copy — the arrow alone does the job, mirroring the
 * reference experiment.
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
import { FEEDBACK_COLOR_CORRECT_TEXT, FEEDBACK_COLOR_WRONG_TEXT } from '../conditions/shared.js';

/* See `slide-layout.js` for the unification rationale — the H2 title
 * and the plugin's Previous/Next nav land at the same y across every
 * page of every deck (and across the calibration intros and the five
 * demo screens) because every wrapper shares the same `min-height`. */
/* Match the exact feedback green/red the participant sees on a live trial
 * and in the demo animation — same #0BC926 / #FF1818 hex at full opacity. */
const FEEDBACK_GREEN = `<span style="color: ${FEEDBACK_COLOR_CORRECT_TEXT};"><strong>green</strong></span>`;
const FEEDBACK_RED = `<span style="color: ${FEEDBACK_COLOR_WRONG_TEXT};"><strong>red</strong></span>`;
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

export function iDInstructionNode() {
  const setSize = config.memory.set_size;
  const starsPerTrial = config.imagery.stars_per_trial;
  const totalEvents = setSize + starsPerTrial;
  const title = 'Task 4 – Dots and pattern together';
  const pages = [
    slideStimulusPage({
      title,
      body: `
        <p>Task 4 combines Task 3 (the pattern) with Task 1 (the dots).
        Each trial begins with the <strong>arrow</strong>: turn the
        pattern in your mind and hold the turned pattern for the whole
        trial. You'll have <strong>5 seconds</strong> to imagine and
        turn it.</p>
      `,
      narration: `Task 4 combines Task 3, the pattern, with Task 1, the dots. Each trial begins with the arrow: turn the pattern in your mind and hold the turned pattern for the whole trial. You'll have 5 seconds to imagine and turn it.`,
      exemplar: ['arrow'],
    }),
    slideStimulusPage({
      title,
      body: `
        <p>Then <strong>${totalEvents} things</strong> appear inside the
        circle one at a time, <strong>mixed together</strong>:</p>
        <ul style="margin: 0.75rem 1.25rem;">
          <li><strong>${starsPerTrial} stars</strong> – for each star,
          press <strong>On-pattern</strong>
          (<kbd>&rarr;</kbd> RIGHT arrow) if it lands on your rotated
          pattern, or <strong>Not on-pattern</strong>
          (<kbd>&larr;</kbd> LEFT arrow) if it does not.</li>
          <li><strong>${setSize} dots</strong> – remember
          <strong>which locations</strong> they appear in, for the dot
          tests at the end of the trial.</li>
        </ul>
      `,
      narration: `Then ${totalEvents} things appear inside the circle one at a time, mixed together. ${starsPerTrial} stars – for each star, press On-pattern, the right arrow, if it lands on your rotated pattern, or Not on-pattern, the left arrow, if it does not. And ${setSize} dots – remember which locations they appear in, for the dot tests at the end of the trial.`,
      exemplar: ['star', 'dot'],
    }),
    slideStimulusPage({
      title,
      body: `
        <p>After the ${totalEvents} things, we test your dot memory
        <strong>${setSize} times</strong>. Each time a black dot appears
        for 3 seconds in some location:</p>
        <p style="margin: 1.25rem 0;">
          Press <strong>Yes</strong> (<kbd>&rarr;</kbd> RIGHT arrow) if
          a dot was shown here.<br />
          Press <strong>No</strong> (<kbd>&larr;</kbd> LEFT arrow) if
          it was not.
        </p>
        <p>You have <strong>3 seconds</strong> for each star and each
        dot test. If you answer in time, the star or dot turns
        ${FEEDBACK_GREEN} for correct or ${FEEDBACK_RED} for incorrect.</p>
      `,
      narration: `After the ${totalEvents} things, we test your dot memory ${setSize} times. Each time a black dot appears for 3 seconds in some location. Press Yes, the right arrow, if a dot was shown here. Press No, the left arrow, if it was not. You have 3 seconds for each star and each dot test. If you answer in time, the star or dot turns green for correct or red for incorrect.`,
      exemplar: ['qmark'],
    }),
    slideStimulusPage({
      title,
      body: `
        ${CALLOUT_OPEN}
        <strong style="color: #772139;">VERY important:</strong> keep the
        picture of the rotated pattern in mind during the
        <strong>entire</strong> trial. You may drop it only when the
        central <strong>question mark (?)</strong> appears – that is
        when the dot tests begin.</p>
        <p>Keep your eyes on the small bull's-eye in the center of the circle throughout the trial.</p>
      `,
      narration: `Very important: keep the picture of the rotated pattern in mind during the entire trial. You may drop it only when the central question mark appears – that is when the dot tests begin. Keep your eyes on the small bull's-eye in the center of the circle throughout the trial.`,
      exemplar: ['pattern'],
    }),
  ];
  const node = {
    type: jsPsychInstructions,
    pages,
    ...NAV_OPTS,
    data: { phase: 'instructions_dual_i_d' },
  };
  registerInstructionFactory(node.data.phase, iDInstructionNode);
  return trackInstructionNode(node);
}

export function iTInstructionNode() {
  const setSize = config.memory.set_size;
  const starsPerTrial = config.imagery.stars_per_trial;
  const totalEvents = setSize + starsPerTrial;
  const title = 'Task 5 – Tones and pattern together';
  const pages = [
    slideStimulusPage({
      title,
      body: `
        <p>Task 5 combines Task 3 (the pattern) with Task 2 (the tones).
        Each trial begins with the <strong>arrow</strong>: turn the
        pattern in your mind and hold the turned pattern for the whole
        trial. You'll have <strong>5 seconds</strong> to imagine and
        turn it.</p>
      `,
      narration: `Task 5 combines Task 3, the pattern, with Task 2, the tones. Each trial begins with the arrow: turn the pattern in your mind and hold the turned pattern for the whole trial. You'll have 5 seconds to imagine and turn it.`,
      exemplar: ['arrow'],
    }),
    slideStimulusPage({
      title,
      body: `
        <p>Then <strong>${totalEvents} things</strong> happen one at a
        time, <strong>mixed together</strong>:</p>
        <ul style="margin: 0.75rem 1.25rem;">
          <li><strong>${starsPerTrial} stars</strong> inside the circle –
          for each star, press <strong>On-pattern</strong>
          (<kbd>&rarr;</kbd> RIGHT arrow) if it lands on your rotated
          pattern, or <strong>Not on-pattern</strong>
          (<kbd>&larr;</kbd> LEFT arrow) if it does not.</li>
          <li><strong>${setSize} tones</strong> – remember
          <strong>each tone you hear</strong>, for the tone tests at the
          end of the trial.</li>
        </ul>
      `,
      narration: `Then ${totalEvents} things happen one at a time, mixed together. ${starsPerTrial} stars inside the circle – for each star, press On-pattern, the right arrow, if it lands on your rotated pattern, or Not on-pattern, the left arrow, if it does not. And ${setSize} tones – remember each tone you hear, for the tone tests at the end of the trial.`,
      exemplar: ['star', 'tone'],
    }),
    slideStimulusPage({
      title,
      body: `
        <p>After the ${totalEvents} things, we test your tone memory
        <strong>${setSize} times</strong>. Each test plays a tone:</p>
        <p style="margin: 1.25rem 0;">
          Press <strong>Yes</strong> (<kbd>&rarr;</kbd> RIGHT arrow) if
          you heard this tone before.<br />
          Press <strong>No</strong> (<kbd>&larr;</kbd> LEFT arrow) if
          you did not.
        </p>
        <p>You have <strong>3 seconds</strong> for each star and each
        tone test. If you answer in time, the star or central question
        mark turns ${FEEDBACK_GREEN} for correct or ${FEEDBACK_RED} for
        incorrect.</p>
      `,
      narration: `After the ${totalEvents} things, we test your tone memory ${setSize} times. Each test plays a tone. Press Yes, the right arrow, if you heard this tone before. Press No, the left arrow, if you did not. You have 3 seconds for each star and each tone test. If you answer in time, the star or central question mark turns green for correct or red for incorrect.`,
      exemplar: ['qmark'],
    }),
    slideStimulusPage({
      title,
      body: `
        ${CALLOUT_OPEN}
        <strong style="color: #772139;">VERY important:</strong> keep the
        picture of the rotated pattern in mind during the
        <strong>entire</strong> trial. You may drop it only when the
        central <strong>question mark (?)</strong> appears – that is
        when the tone tests begin.</p>
        <p>Keep your eyes on the small bull's-eye in the center of the circle throughout the trial.</p>
        <p>Please make sure your audio volume is still at the level you
        set earlier.</p>
      `,
      narration: `Very important: keep the picture of the rotated pattern in mind during the entire trial. You may drop it only when the central question mark appears – that is when the tone tests begin. Keep your eyes on the small bull's-eye in the center of the circle throughout the trial. Please make sure your audio volume is still at the level you set earlier.`,
      exemplar: ['pattern'],
    }),
  ];
  const node = {
    type: jsPsychInstructions,
    pages,
    ...NAV_OPTS,
    data: { phase: 'instructions_dual_i_t' },
  };
  registerInstructionFactory(node.data.phase, iTInstructionNode);
  return trackInstructionNode(node);
}
