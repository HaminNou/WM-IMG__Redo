/**
 * The rotation-cue arrow is a 100 px image laid over the centre of the frame,
 * and its centre pixel is opaque, so on its own it would hide the bull's-eye
 * dot for the whole cue. This style cuts a small transparent hole at the
 * arrow's centre: the dot (and its ring) stay visible through it, the arrow's
 * size, orientation and meaning are unchanged, and the hole is symmetric so
 * the arrow's rotation does not move it. The hole's RADIUS equals the dot's
 * DIAMETER, 1.3 mm (`--mm` is the calibrated millimetre in CSS px), so the hole is
 * 2.6 mm across, twice as wide as the dot, and leaves a margin of 0.65 mm of
 * page background around the dot.
 */
import { FIXATION_DOT_DIAMETER_MM } from './frame.js';

const HOLE_RADIUS = `calc(var(--mm) * ${FIXATION_DOT_DIAMETER_MM})`;
const MASK = `radial-gradient(circle at 50% 50%, transparent ${HOLE_RADIUS}, #000 calc(${HOLE_RADIUS} + 0.5px))`;

/** Inline CSS declarations (with trailing semicolon) to append to an arrow's style. */
export const ARROW_CENTRE_HOLE_STYLE = `-webkit-mask-image: ${MASK}; mask-image: ${MASK};`;
