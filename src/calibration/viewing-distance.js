/**
 * Viewing-distance & posture setup screen.
 *
 * Online psychophysics has no chinrest, so the standard mitigation is a
 * brief instructional screen at the start of the session telling the
 * participant how to position themselves: eyes aligned with screen
 * centre, ~ 60 cm (an arm's length) from the monitor, and a request to
 * stay in that posture for the rest of the session. This is the same
 * recipe used by Anwyl-Irvine et al. 2020 (online psychophysics
 * guidance), and
 * Li et al. 2020's web-based virtual-chinrest paper (which keeps a
 * posture-instruction step alongside its blind-spot estimation).
 *
 * We do NOT estimate viewing distance directly (no blind-spot routine
 * here): for our 5×5 cell-grid task, accurate physical SIZE matters far
 * more than viewing distance, and the screen-calibration step that
 * follows already pins physical size via the credit-card method. The
 * 60 cm target is therefore an instruction, not a measurement — its job
 * is to put the participant in a comfortable, repeatable posture before
 * the calibration and stimulus geometry are committed.
 *
 * Placement: between demographics and screen calibration. Putting it
 * here means the participant is already in the right posture when they
 * hold the credit card up against the screen for screen-cal, which
 * keeps the parallax of the card-vs-screen geometry roughly consistent
 * across participants.
 */
import htmlButtonResponse from '@jspsych/plugin-html-button-response';
import { trackHiddenNavNode } from '../hidden-nav.js';
import { slideTextPage } from '../visuals/slide-layout.js';

/* Both slides use the canonical text-slide wrapper from `slide-layout.js`,
 * which pins the H2 title at the top of the wrapper and lets the body
 * absorb whatever remains, so jsPsych renders the "I am ready" button at
 * the same y-position across these two slides AND across the Task 1–5
 * instruction decks AND the five demo screens. See `slide-layout.js`
 * for the unification rationale. */

const POSTURE_HTML = slideTextPage({
  title: 'Sit comfortably for the study',
  body: `
    <p>Before we begin the tasks, let's get you set up.</p>
    <p>This study works best when you are seated comfortably and stay in
    roughly the same position for the rest of the session. Please take a
    moment to set yourself up:</p>
    <ul style="margin: 0.5rem 0 0.75rem 1.25rem; line-height: 1.45;">
      <li>Sit so that your eyes are <strong>about an arm's length
      (≈ 60 cm)</strong> away from the monitor.</li>
      <li>Centre yourself in front of the screen: your eyes should be
      <strong>directly in front of the middle of the monitor</strong>,
      not off to one side.</li>
      <li>Make sure the screen is roughly at <strong>eye level</strong> —
      adjust your chair or the monitor if needed.</li>
      <li>Try to <strong>stay in this position</strong> for the rest of
      the study — moving your head closer or farther between trials can
      change how the task looks and how well you can do it.</li>
    </ul>
    <p>When you are settled in this position, click the button below to
    continue.</p>
  `,
  narration: `Before we begin the tasks, let's get you set up. This study works best when you are seated comfortably and stay in roughly the same position for the rest of the session. Please take a moment to set yourself up. Sit so that your eyes are about an arm's length, roughly 60 centimetres, away from the monitor. Centre yourself in front of the screen: your eyes should be directly in front of the middle of the monitor, not off to one side. Make sure the screen is roughly at eye level — adjust your chair or the monitor if needed. And try to stay in this position for the rest of the study — moving your head closer or farther between trials can change how the task looks, and how well you can do it. When you are settled in this position, click the button below to continue.`,
});

const HANDS_HTML = slideTextPage({
  title: 'How to place your hands',
  body: `
    <p>Next, let's set up your hands.</p>
    <p>Throughout the study you will respond with the
    <strong>two horizontal arrow keys</strong>
    (<kbd>&larr;</kbd>&nbsp;<kbd>&rarr;</kbd>) on your keyboard. The
    demonstrations will label them <strong>&ldquo;No&rdquo;</strong> /
    <strong>&ldquo;Yes&rdquo;</strong> and
    <strong>&ldquo;Not on-pattern&rdquo;</strong> /
    <strong>&ldquo;On-pattern&rdquo;</strong>. How you place your hands
    matters:</p>
    <ul style="margin: 0.5rem 0 0.75rem 1.25rem; line-height: 1.45;">
      <li>Use <strong>both hands</strong>, and <strong>only your index
      fingers</strong>.</li>
      <li>Place <strong>one index finger on each of the two horizontal
      arrow keys</strong>, one finger per hand.</li>
      <li>Keep them resting on those two keys throughout the study.</li>
      <li><strong>Do not use two fingers of the same hand</strong> — one
      index finger per hand, on its own response key.</li>
    </ul>
    <p>When both index fingers are resting on the two response keys,
    click the button below to continue.</p>
  `,
  narration: `Next, let's set up your hands. Throughout the study you will respond with the two horizontal arrow keys on your keyboard, the left arrow and the right arrow. The demonstrations will label them No or Yes, and Not on-pattern or On-pattern. How you place your hands matters. Use both hands, and only your index fingers. Place one index finger on each of the two horizontal arrow keys, one finger per hand. Keep them resting on those two keys throughout the study. Do not use two fingers of the same hand — one index finger per hand, on its own response key. When both index fingers are resting on the two response keys, click the button below to continue.`,
});

export function viewingDistanceTrial() {
  const postureNode = trackHiddenNavNode(
    {
      type: htmlButtonResponse,
      stimulus: POSTURE_HTML,
      choices: ['I am ready'],
      button_html: (choice) =>
        `<button class="jspsych-btn" style="margin-top: 1rem;">${choice}</button>`,
      data: { phase: 'viewing_distance' },
    },
    'viewing_distance'
  );
  const handsNode = trackHiddenNavNode(
    {
      type: htmlButtonResponse,
      stimulus: HANDS_HTML,
      choices: ['I am ready'],
      button_html: (choice) =>
        `<button class="jspsych-btn" style="margin-top: 1rem;">${choice}</button>`,
      data: { phase: 'hand_placement' },
    },
    'hand_placement'
  );
  return { timeline: [postureNode, handsNode] };
}
