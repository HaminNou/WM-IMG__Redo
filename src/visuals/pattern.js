/**
 * Gray-pattern overlay (the 13-cell `grayPattern` from `cond_ii1.html`).
 *
 * Rendered into the frame's `.grid-pattern` group with the frame's palette
 * (`frame.pattern_colour`, `frame.pattern_opacity`: 33 % white on the dark
 * theme, fully opaque in the trial-shade palettes). The overlay is built once per frame and toggled visible
 * during pattern-reminder phases (windowed and condition-balanced; see
 * scheduler/pattern-reminders.js).
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
 * centre cell disappears just like the other 12 pattern cells.
 *
 * Fixation while the pattern is shown. The frame's bull's-eye dot sits under
 * the rotor in z-order, so the centre pattern square would dim it. While the
 * pattern is visible, a copy of that dot (same position, size and colour as
 * the frame's own, never a different ink) is drawn above the overlay and the
 * original is hidden, so the participant sees the same bull's-eye as in every
 * other phase. `hidePattern` swaps them back.
 */
import { svgEl } from './svg.js';
import { config } from '../config.js';
import { cellTopLeftMm } from '../grid.js';

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
  /* A demo replay's `clearStimuli` detaches the copy but leaves it cached:
   * re-create it whenever it is no longer a child of the stimuli layer. */
  if (!frame._patternRefDot || frame._patternRefDot.parentNode !== frame.stimuliLayer) {
    const src = frame.centerDot;
    frame._patternRefDot = svgEl('circle', {
      cx: src.getAttribute('cx'),
      cy: src.getAttribute('cy'),
      r: src.getAttribute('r'),
      fill: src.getAttribute('fill'),
      'shape-rendering': 'geometricPrecision',
      class: REFERENCE_DOT_CLASS,
    });
    frame.stimuliLayer.appendChild(frame._patternRefDot);
  }
  frame._patternRefDot.setAttribute('visibility', 'visible');
  frame.centerDot.setAttribute('visibility', 'hidden');
}

export function hidePattern(frame) {
  frame.patternLayer.setAttribute('visibility', 'hidden');
  if (frame._patternRefDot) {
    frame._patternRefDot.setAttribute('visibility', 'hidden');
  }
  frame.centerDot.setAttribute('visibility', 'visible');
}
