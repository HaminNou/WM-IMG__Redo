/**
 * Imagery-probe star.
 *
 * 5-pointed star, `config.imagery.star_size_mm` (5 mm) bounding diameter, in the
 * frame's stimulus colour. The participant judges
 * whether the star sits on or off the (rotated) gray pattern.
 *
 * Math: 10 vertices alternating outer (R = star_size_mm/2) and inner radius
 * (r = R × 0.382 ≈ golden-ratio inset). Vertex 0 points up.
 *
 * The star is placed at the *rotated* cell-centre so it visually lands on
 * the rotated grid cell, but the star's own orientation is upright (vertex 0
 * always points to screen-up) — the stimuli layer is outside the rotor, so
 * the star polygon does not inherit the rotor transform.
 */
import { svgEl } from './svg.js';
import { config } from '../config.js';
import { rotatedCellCentreMm } from '../grid.js';

const INNER_RATIO = 0.382;

function starPathPoints(cx, cy, R, points = 5) {
  const r = R * INNER_RATIO;
  const out = [];
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? R : r;
    const theta = -Math.PI / 2 + (i * Math.PI) / points;
    out.push(`${cx + radius * Math.cos(theta)},${cy + radius * Math.sin(theta)}`);
  }
  return out.join(' ');
}

export function addStar(frame, cellIndex, { color, className = 'star' } = {}) {
  const { x_mm, y_mm } = rotatedCellCentreMm(cellIndex, frame.rotation_deg ?? 0);
  const R = config.imagery.star_size_mm / 2;
  /* Default to the frame's stimulus colour (black on trial frames,
   * white on default frames). Explicit `color` (e.g. feedback
   * green/red) still wins. */
  const fill = color ?? frame.stimulus_colour ?? '#fff';
  const el = svgEl('polygon', {
    points: starPathPoints(x_mm, y_mm, R),
    fill,
    'data-cell-index': cellIndex,
    class: className,
  });
  frame.stimuliLayer.appendChild(el);
  return el;
}

export function recolourStar(starEl, color) {
  if (starEl) starEl.setAttribute('fill', color);
}
