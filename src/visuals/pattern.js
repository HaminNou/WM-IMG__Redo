/**
 * Gray-pattern overlay (the 13-cell `grayPattern` from `cond_ii1.html`).
 *
 * Rendered into the frame's `.grid-pattern` group at 33 % opacity
 *. The overlay is built once per frame and toggled visible
 * during pattern-presentation phases (block start + every 8 trials,
 * config.pattern.pattern_phase_frequency_trials).
 *
 * The overlay rotates with the rest of the rotor `<g>`, so the pattern stays
 * locked to the rotated grid while the participant judges star positions.
 *
 * Centre cell (index 12) — the centre cell
 * must look graphically identical to the other gray cells while the pattern
 * is shown, even though it is logically excluded from on-pattern stimulus
 * placement (see `grid.js` accessor functions, which strip cell 12 from the
 * on-/off-pattern pools). Rendering the centre cell here means it joins the
 * pattern's visual gestalt; when the pattern is hidden between trials, the
 * whole `patternLayer` group toggles off via `visibility="hidden"`, so the
 * centre cell disappears just like the other 12 pattern cells. The bull's-
 * eye dot sits underneath the rotor in z-order and becomes visible again the
 * moment the pattern goes away.
 */
import { svgEl } from './svg.js';
import { config } from '../config.js';
import { cellTopLeftMm, gridSizeMm } from '../grid.js';

const REFERENCE_DOT_DIAMETER_MM = 1.3;
const REFERENCE_DOT_CLASS = 'pattern-reference-dot';

export function buildPatternOverlay(frame) {
  /* Idempotent — rebuilds rather than appending duplicates. */
  while (frame.patternLayer.firstChild) {
    frame.patternLayer.removeChild(frame.patternLayer.firstChild);
  }
  const fill = frame.pattern_colour;
  const opacity = frame.pattern_opacity;
  for (const cellIndex of config.pattern.gray_pattern_cells) {
    const { x_mm, y_mm } = cellTopLeftMm(cellIndex);
    frame.patternLayer.appendChild(
      svgEl('rect', {
        x: x_mm,
        y: y_mm,
        width: config.grid.cell_size_mm,
        height: config.grid.cell_size_mm,
        fill,
        opacity,
        'data-cell-index': cellIndex,
      })
    );
  }
}

export function showPattern(frame) {
  frame.patternLayer.setAttribute('visibility', 'visible');
  if (!frame._patternRefDot) {
    const mid = gridSizeMm() / 2;
    frame._patternRefDot = svgEl('circle', {
      cx: mid,
      cy: mid,
      r: REFERENCE_DOT_DIAMETER_MM / 2,
      fill: '#000',
      'shape-rendering': 'geometricPrecision',
      class: REFERENCE_DOT_CLASS,
    });
    frame.stimuliLayer.appendChild(frame._patternRefDot);
  }
  frame._patternRefDot.setAttribute('visibility', 'visible');
}

export function hidePattern(frame) {
  frame.patternLayer.setAttribute('visibility', 'hidden');
  if (frame._patternRefDot) {
    frame._patternRefDot.setAttribute('visibility', 'hidden');
  }
}
