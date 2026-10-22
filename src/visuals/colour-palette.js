/**
 * Trial-state colour palette.
 *
 * Each trial uses a per-trial light or gray background with stimuli drawn
 * in black, across all 5 trial types.
 *
 *   - Per-trial background: WHITE (#FFFFFF) or LIGHT-GRAY (#D3D3D3),
 *     counterbalanced 50/50 within every block of every trial type.
 *   - Pattern overlay: complementary shade (gray on white, white on
 *     gray) so the pattern reads as a figure on every trial.
 *   - Stimuli (dots, stars, question-mark glyph, rotation arrow):
 *     solid BLACK on every trial regardless of background shade.
 *   - Bull's-eye ring + fixation centre dot: dim DARK, low alpha so
 *     they read as fixation aids rather than competing stimuli on the
 *     light backdrop.
 *
 * The non-trial UI surfaces (calibration, instructions, demos, rest,
 * questionnaire, upload, completion, welcome) use a dark theme; only the
 * per-trial visual area flips to white/gray. The flip happens at the
 * trial-start gate and is reverted by the next gate or the trial's ITI
 * (arrow cue, imagination, pattern phase, encoding, retention, probes,
 * ITI). See `page-background.js` for the flip mechanism.
 */

export const BACKGROUND_SHADES = Object.freeze(['white', 'gray']);

export const BACKGROUND_FILLS = Object.freeze({
  white: '#FFFFFF',
  gray: '#D3D3D3',
});

/* Pattern fill complements the background. On a WHITE-bg trial the
 * pattern is gray on white; on a GRAY-bg trial it is white on gray.
 * This keeps the pattern readable as figure-on-ground regardless of the
 * trial's background shade. */
export const PATTERN_FILLS_BY_BG = Object.freeze({
  white: '#D3D3D3',
  gray: '#FFFFFF',
});

/* Stimulus colour for dots, stars, and the central '?' / probe glyph
 * during trial state. Solid black (no alpha) because the stimuli sit on
 * opaque backgrounds and alpha would only smear the edge. */
export const STIMULUS_BLACK = '#000000';

/* Bull's-eye ring + fixation centre-dot colours during trial state.
 * Same alpha scheme as the default (dark-theme) frame colours (0.229 / 0.35) but on
 * black ink so they read on a light backdrop. The dim alpha keeps the
 * ring as a fixation aid rather than a competing stimulus. */
export const BULLSEYE_COLOUR_DARK = 'rgba(0, 0, 0, 0.229)';
export const FIXATION_MARK_COLOUR_DARK = 'rgba(0, 0, 0, 0.85)';

export function isValidBackgroundShade(shade) {
  return shade === 'white' || shade === 'gray';
}
