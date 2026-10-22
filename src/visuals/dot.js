/**
 * Memory-encoding dot (white filled circle).
 *
 * Lands at the rotated cell-centre so the dot appears on the rotated grid
 * cell visually, but the dot glyph itself is rotation-symmetric (a circle)
 * and lives in the stimuli layer outside the rotor → stays upright.
 *
 * Returns the appended SVG element so the caller can fade it out / remove it
 * after `dot_duration_ms`.
 */
import { svgEl } from './svg.js';
import { config } from '../config.js';
import { rotatedCellCentreMm } from '../grid.js';

export function addDot(frame, cellIndex, { color, className = 'dot' } = {}) {
  const { x_mm, y_mm } = rotatedCellCentreMm(cellIndex, frame.rotation_deg ?? 0);
  const r = config.memory.dot_diameter_mm / 2;
  /* Default to the frame's stimulus colour (black on trial frames,
   * white on default frames). Explicit `color` (e.g. feedback
   * green/red) still wins. */
  const fill = color ?? frame.stimulus_colour ?? '#fff';
  const el = svgEl('circle', {
    cx: x_mm,
    cy: y_mm,
    r,
    fill,
    'data-cell-index': cellIndex,
    class: className,
  });
  frame.stimuliLayer.appendChild(el);
  return el;
}

export function removeElement(el) {
  if (el && el.parentNode) el.parentNode.removeChild(el);
}
