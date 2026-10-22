/**
 * SVG construction helpers shared by every visual primitive.
 *
 * Why SVG and not absolutely-positioned divs:
 *   - Whole-grid rotation (−90°, −45°, 0°, +45°, +90°) is one
 *     transform on a `<g>` instead of per-element CSS transforms that fight
 *     each other.
 *   - Stars are 10-point polygons; SVG renders them at any size without
 *     pixel-grid artefacts.
 *   - Vector primitives scale exactly with our `--mm` calibration via the
 *     viewBox, so a 20 mm dot is 20 mm on every screen that completed screen calibration.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    el.setAttribute(k, String(v));
  }
  return el;
}
