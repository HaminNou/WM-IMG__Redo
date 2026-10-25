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

export const PATTERN_REMINDER_SECONDS = config.pattern.pattern_phase_duration_ms / 1000;
