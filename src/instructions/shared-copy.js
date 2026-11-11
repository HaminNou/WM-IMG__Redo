/**
 * Wording shared by the three imagery decks (I-only, I+D, I+T), defined once
 * so the decks cannot drift apart.
 *
 * ARROW_MEANING_*: what the rotation cue shows. Verified against the program:
 * the cue arrow is drawn pointing straight up and tilted by the trial's
 * rotation angle (positive = clockwise, same sign as the grid rotor), and the
 * angle runs from -90 to +90 degrees, 0 included (tests/rotation-*.test.js,
 * tests/oracle-conditions.test.js). So: straight up = no turn, tilt right =
 * clockwise, tilt left = counterclockwise, never more than a quarter turn.
 *
 * NO_HEAD_ROTATION_*: the rule that goes with the arrow page of the three imagery decks: the
 * pattern is turned in the mind, never by turning or tilting the head. One sentence, defined
 * once and shown in bold on the arrow page of Task 3, Task 4 and Task 5 (and nowhere else).
 * It is on the screen only: the decks' `narration` strings are harvested into
 * public/voiceover/strings.json with a recording each, and a changed string would need a new
 * recording (see scripts/harvest-voiceover.js), so the narration of those pages is unchanged.
 *
 * PATTERN_REMINDER_SECONDS: how long the upright-pattern reminder screen stays
 * up (config.pattern.pattern_phase_duration_ms).
 */
import { config } from '../config.js';

const ARROW_MEANING = Object.freeze({
  straight:
    "if it points straight up, don't turn the pattern at all; if it tilts to the right, turn the pattern clockwise by that same amount; if it tilts to the left, turn it counterclockwise by that same amount",
  limit: 'The arrow never tilts further than pointing straight sideways, which is a quarter turn.',
});

/** Plain sentence(s) for narration and tests. */
export const ARROW_MEANING_TEXT = `The arrow shows how far to turn the pattern: ${ARROW_MEANING.straight}. ${ARROW_MEANING.limit}`;

/** Same sentence(s) for the on-screen body, with the key phrases bold. */
export const ARROW_MEANING_HTML = `The arrow shows how far to turn the pattern: <strong>if it points straight up, don't turn the pattern at all</strong>; if it tilts to the right, turn the pattern <strong>clockwise</strong> by that same amount; if it tilts to the left, turn it <strong>counterclockwise</strong> by that same amount. ${ARROW_MEANING.limit}`;

/** The head-rotation rule, plain text (tests). */
export const NO_HEAD_ROTATION_TEXT =
  'Head rotation is NOT allowed: turn the pattern only in your mind. Do not rotate or tilt your head.';

/** The same sentence for the on-screen body: bold, as its own paragraph's content. The page's
 * text is weight 300, so a plain <strong> ("bolder") only reaches 400; 700 is set outright. */
export const NO_HEAD_ROTATION_HTML = `<strong style="font-weight: 700;">${NO_HEAD_ROTATION_TEXT}</strong>`;

export const PATTERN_REMINDER_SECONDS = config.pattern.pattern_phase_duration_ms / 1000;
