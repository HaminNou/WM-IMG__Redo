/**
 * Single-task event-rate dummies.
 *
 *   - Open muted-gray square (D-only, T-only, I-only): same bounding side as a
 *     star's bounding diameter, 0.4 mm stroke, no fill. Slot-matched to
 *     where a dual-task star would appear and onset/offset-matched to the
 *     star's 3000 ms visible window so the square and star share an
 *     identical temporal envelope across the whole experiment. The square
 *     is rendered INVISIBLY in participant-facing live trials and
 *     instruction demos (`visible: false`) — its sole purpose there is the
 *     temporal envelope, and visible squares would compete
 *     visually with the encoded dots/tones/stars. Method figures and
 *     developer demos keep `visible: true` so the placeholder
 *     event remains explicable on paper / for QC.
 */
import { svgEl } from './svg.js';
import { config } from '../config.js';
import { rotatedCellCentreMm } from '../grid.js';
import { BULLSEYE_COLOUR } from './frame.js';

export function addOpenSquare(
  frame,
  cellIndex,
  { className = 'dummy-open-square', visible = true } = {}
) {
  const { x_mm, y_mm } = rotatedCellCentreMm(cellIndex, frame.rotation_deg ?? 0);
  const side = config.dummies.open_square_size_mm;
  const half = side / 2;
  /* Invisible mode: the rect element is still mounted (so the encoding
   * schedule's `addOpenSquare` → `removeElement` round-trip and the timing
   * envelope remain identical to dual-task trials), but it is rendered
   * with no stroke and no fill so the participant cannot see it. The
   * `data-cell-index` attribute is preserved either way for tests / QC
   * tooling that probe the live DOM.
   *
   * Stroke colour follows the frame's bull's-eye colour (dim ink on trial
   * frames, dim white on default frames) so the open
   * square reads as a faint placeholder against either background. */
  const stroke = visible ? (frame.bullseye_colour ?? BULLSEYE_COLOUR) : 'none';
  const strokeWidth = visible ? config.dummies.open_square_stroke_mm : 0;
  const el = svgEl('rect', {
    x: x_mm - half,
    y: y_mm - half,
    width: side,
    height: side,
    fill: 'none',
    stroke,
    'stroke-width': strokeWidth,
    'data-cell-index': cellIndex,
    'data-visible': visible ? 'true' : 'false',
    class: className,
  });
  frame.stimuliLayer.appendChild(el);
  return el;
}
