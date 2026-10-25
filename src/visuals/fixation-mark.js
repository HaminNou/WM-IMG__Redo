/**
 * The centre '?' cue, drawn so the bull's-eye centre dot stays visible.
 *
 * Every in-trial frame (encoding, retention, probe/test, response window,
 * feedback, ITI; every condition) shows the same fixation target: the outer
 * bull's-eye ring plus the centre dot. The '?' that tells the participant
 * "the tests begin, you may drop the picture" used to be a 12 mm text glyph
 * that REPLACED the centre dot. It is now a path-drawn question mark whose
 * hook and stem sit just above the centre and whose period IS the bull's-eye
 * centre dot — so the target is never missing and the dot cannot blur into a
 * second period. Geometry is in mm, relative to the frame centre; the glyph's
 * farthest point is 6.4 mm from the centre, which clears the nearest possible
 * stimulus edge (cell centres are >= 10 mm out, dot radius 2.5 mm => 7.5 mm).
 *
 * Dependency-free on purpose: `frame.js` (live trials) and `slide-layout.js`
 * (instruction cards, which must not import the runtime frame builder) both
 * draw the cue from this one definition.
 */
export const QMARK_STROKE_MM = 1.0;
const HOOK_RADIUS_MM = 1.7;
const HOOK_CENTRE_Y_MM = -4.2;
const STEM_END_Y_MM = -2.2;

/** SVG path `d` for the '?' hook + stem centred on (cx, cy). Stroke only. */
export function questionMarkPath(cx, cy) {
  const r = HOOK_RADIUS_MM;
  const hy = cy + HOOK_CENTRE_Y_MM;
  return (
    `M ${cx - r} ${hy} ` +
    `A ${r} ${r} 0 0 1 ${cx + r} ${hy} ` +
    `C ${cx + r} ${hy + 0.9} ${cx} ${hy + 1.0} ${cx} ${cy + STEM_END_Y_MM}`
  );
}
