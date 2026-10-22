/**
 * Memory-only trial-type instruction screens (D-only, T-only).
 *
 * Audience: general-public Prolific participants — not psychology students.
 * Copy is deliberately plain English: "remember where each dot was", "do you
 * recognise this tone", etc., avoiding jargon like "set size", "encoding
 * stream", "probe", "retention", "imagery", etc.
 *
 * Importantly, NEITHER screen mentions a rotation cue: rotation is an
 * imagery-only construct. The grid layout that would be rotated still
 * exists in the abstract design, but on D-only and T-only trials the
 * participant is not asked to imagine anything, so no arrow appears on
 * the screen and no rotation step occurs in the trial sequence.
 *
 * Visual frame language: the participant only ever sees the bull's-eye
 * circle — the underlying 5×5
 * cell grid is invisible to participants throughout the task. Copy
 * therefore says "inside the circle" / "location" instead of "on the
 * grid" / "square", to match what the participant actually sees.
 *
 * Pagination: each instruction screen is split into several short pages
 * delivered through the jsPsych instructions plugin so the participant
 * sees one piece of the rules at a time and can step back if they missed
 * something. Space (or the on-screen Next button) advances; Left arrow
 * (or Previous) goes back. The last page advances out of the trial and
 * into the per-type demo.
 */
import jsPsychInstructions from '@jspsych/plugin-instructions';
import { config } from '../config.js';
import { registerInstructionFactory, trackInstructionNode } from '../hidden-nav.js';
import { slideStimulusPage } from '../visuals/slide-layout.js';
import { FEEDBACK_COLOR_CORRECT_TEXT, FEEDBACK_COLOR_WRONG_TEXT } from '../conditions/shared.js';

/* Each page uses the shared text-slide wrapper from `slide-layout.js`,
 * which pins the H2 title at the top and lets body copy fill whatever
 * remains, so the plugin's Previous/Next nav lands at the same y across
 * every page of every deck — and across the calibration intros, the
 * imagery / dual decks, and the five demo screens. See `slide-layout.js`
 * for the unification rationale. The H2 inside the title row is rendered
 * by the primitive itself; pages here only supply the title text and the
 * body HTML. */
/* Match the exact feedback green/red the participant sees on a live trial
 * and in the demo animation — same #0BC926 / #FF1818 hex at full opacity. */
const FEEDBACK_GREEN = `<span style="color: ${FEEDBACK_COLOR_CORRECT_TEXT};"><strong>green</strong></span>`;
const FEEDBACK_RED = `<span style="color: ${FEEDBACK_COLOR_WRONG_TEXT};"><strong>red</strong></span>`;

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

export function dOnlyInstructionNode() {
  const setSize = config.memory.set_size;
  const title = 'Task 1 — Remember the dots';
  const pages = [
    slideStimulusPage({
      title,
      body: `
        <p>You will see <strong>${setSize} dots</strong> appear one at a
        time at different locations inside the circle. Each dot is brief
        — remember <strong>which locations</strong> the dots appear in.</p>
      `,
      narration: `You will see ${setSize} dots appear one at a time at different locations inside the circle. Each dot is brief — remember which locations the dots appear in.`,
      exemplar: ['dot'],
    }),
    slideStimulusPage({
      title,
      body: `
        <p>After the dots, we test your memory <strong>${setSize}
        times</strong>. Each time, a black dot appears for 3 seconds in
        some location:</p>
        <p style="margin: 1.25rem 0;">
          Press <strong>Yes</strong> (<kbd>&rarr;</kbd> RIGHT arrow) if
          a dot was shown in that location.<br />
          Press <strong>No</strong> (<kbd>&larr;</kbd> LEFT arrow) if it
          was not.
        </p>
        <p>Keep your eyes on the centre of the circle throughout.</p>
      `,
      narration: `After the dots, we test your memory ${setSize} times. Each time, a black dot appears for 3 seconds in some location. Press Yes, the right arrow, if a dot was shown in that location. Press No, the left arrow, if it was not. Keep your eyes on the centre of the circle throughout.`,
      exemplar: ['qmark'],
    }),
    slideStimulusPage({
      title,
      body: `
        <p>You have <strong>3 seconds</strong> for each test. Aim for
        accuracy first, but don't dwell.</p>
        <p>If you answer in time, the dot turns
        ${FEEDBACK_GREEN} for correct or
        ${FEEDBACK_RED} for incorrect while it is still on screen.</p>
      `,
      narration: `You have 3 seconds for each test. Aim for accuracy first, but don't dwell. If you answer in time, the dot turns green for correct or red for incorrect while it is still on screen.`,
      exemplar: ['qmark'],
    }),
  ];
  const node = {
    type: jsPsychInstructions,
    pages,
    ...NAV_OPTS,
    data: { phase: 'instructions_memory_d_only' },
  };
  registerInstructionFactory(node.data.phase, dOnlyInstructionNode);
  return trackInstructionNode(node);
}

export function tOnlyInstructionNode() {
  const setSize = config.memory.set_size;
  const title = 'Task 2 — Remember the tones';
  const pages = [
    slideStimulusPage({
      title,
      body: `
        <p>Task 2 is like Task 1, but with sounds instead of dots. You
        will hear <strong>${setSize} short tones</strong>, one at a time.
        Remember <strong>each tone you hear</strong>.</p>
      `,
      narration: `Task 2 is like Task 1, but with sounds instead of dots. You will hear ${setSize} short tones, one at a time. Remember each tone you hear.`,
      exemplar: ['tone'],
    }),
    slideStimulusPage({
      title,
      body: `
        <p>Then we play <strong>${setSize} more tones</strong>, one at a
        time. For each one:</p>
        <p style="margin: 1.25rem 0;">
          Press <strong>Yes</strong> (<kbd>&rarr;</kbd> RIGHT arrow) if
          you heard this tone before.<br />
          Press <strong>No</strong> (<kbd>&larr;</kbd> LEFT arrow) if
          you did not.
        </p>
        <p>Keep your eyes on the centre of the circle and listen.</p>
      `,
      narration: `Then we play ${setSize} more tones, one at a time. For each one: Press Yes, the right arrow, if you heard this tone before. Press No, the left arrow, if you did not. Keep your eyes on the centre of the circle and listen.`,
      exemplar: ['qmark'],
    }),
    slideStimulusPage({
      title,
      body: `
        <p>You have <strong>3 seconds</strong> for each test. If you
        answer in time, the central question mark turns
        ${FEEDBACK_GREEN} for correct or
        ${FEEDBACK_RED} for incorrect.</p>
        <p>Please make sure your audio volume is still at the level you
        set earlier.</p>
      `,
      narration: `You have 3 seconds for each test. If you answer in time, the central question mark turns green for correct or red for incorrect. Please make sure your audio volume is still at the level you set earlier.`,
      exemplar: ['tone'],
    }),
  ];
  const node = {
    type: jsPsychInstructions,
    pages,
    ...NAV_OPTS,
    data: { phase: 'instructions_memory_t_only' },
  };
  registerInstructionFactory(node.data.phase, tOnlyInstructionNode);
  return trackInstructionNode(node);
}
