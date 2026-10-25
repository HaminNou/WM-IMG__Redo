/**
 * 5×5 grid frame renderer.
 *
 * Builds a self-contained <div><svg/></div> sized to physical mm via the
 * `--mm` CSS custom property set by the screen calibration. The SVG
 * viewBox is in millimetres so every primitive (dot, star, dummy, pattern
 * overlay) can place itself with `cellCentreMm()` directly.
 *
 * Structure (outer ring + small inner dot + rotating cell layer):
 *
 *   <div.grid-frame style="width: calc(var(--mm) * grid_mm)">
 *     <svg viewBox="-pad -pad gridMm+2pad gridMm+2pad" overflow=visible>
 *       <g.grid-bullseye>            ← fixation: outer ring + centre dot
 *         <circle.grid-bullseye-ring/>
 *         <circle.grid-bullseye-dot/>
 *       </g>
 *       <g.grid-rotor transform="rotate(angle ...)">
 *         <g.grid-pattern/>          ← Pattern overlay (toggle visible)
 *         <g.grid-cells/>            ← Structural cell rects kept in the DOM
 *                                       for placement fidelity, but hidden
 *                                       during the task
 *       </g>
 *       <g.grid-stimuli/>            ← Dots, stars, dummies — OUTSIDE the
 *                                       rotor so the stimulus glyphs stay
 *                                       upright when the grid rotates.
 *                                       Primitives use rotatedCellCentreMm()
 *                                       to land on the rotated cell.
 *       <text.grid-fixation/>        ← '?' overlay — outside the rotor so it
 *                                       stays upright when the grid rotates
 *     </svg>
 *   </div>
 *
 * The bull's-eye ring stays visible throughout, the question mark uses the
 * same dim fixation colour as the centre mark, and the grid scaffold stays
 * structurally present but visually hidden unless the pattern overlay itself
 * is being shown.
 *
 * The bull's-eye sits OUTSIDE the rotor so it stays anchored to the screen
 * The fixation text overlay also sits outside the rotor so the '?' stays
 * upright when the grid is rotated.
 *
 * `setFixation(frame, text, { color } = {})` updates the text overlay.
 * Default fixation colour matches the centre dot / question-mark
 * contrast rather than the outer ring stroke.
 *
 * Fixation target: the bull's-eye (outer ring + centre dot) is visible in every
 * phase of every condition. The '?' cue is a path-drawn glyph (see
 * `fixation-mark.js`) whose period is the centre dot itself, so `setFixation(
 * frame, '?')` never hides the dot — it recolours the dot together with the
 * '?' (feedback green/red) and restores both on `setFixation(frame, '')`.
 * Any other overlay text (none in live trials) still swaps with the dot.
 */
import { svgEl } from './svg.js';
import { questionMarkPath, QMARK_STROKE_MM } from './fixation-mark.js';
import { config } from '../config.js';
import { gridSizeMm, cellTopLeftMm } from '../grid.js';
import {
  BULLSEYE_COLOUR_DARK,
  FIXATION_MARK_COLOUR_DARK,
  STIMULUS_BLACK,
  PATTERN_FILLS_BY_BG,
  isValidBackgroundShade,
} from './colour-palette.js';

/* Default (dark-theme) frame colours, used by frames created without a
 * `background_shade` (developer demos and method figures).
 * Trial frames pass a shade (white|gray) and the frame switches to the
 * inked palette in `colour-palette.js`. */
export const BULLSEYE_COLOUR = 'rgba(255, 255, 255, 0.229)';
export const FIXATION_MARK_COLOUR = 'rgba(255, 255, 255, 0.35)';
const STIMULUS_WHITE = '#fff';
/* Dark-theme pattern (gray on black at 33% alpha). Trial-state pattern is
 * fully opaque and uses the complement of the trial's background shade —
 * see `colour-palette.js`'s `PATTERN_FILLS_BY_BG`. */
const DARK_PATTERN_COLOUR = '#fff';
const DARK_PATTERN_OPACITY = 0.33;
const TRIAL_PATTERN_OPACITY = 1.0;
const GRID_BORDER_COLOUR = 'rgba(0, 0, 0, 0)';
const CELL_BORDER_COLOUR = 'rgba(0, 0, 0, 0)';
/* Cells are transparent (fill: none) rather than filled-with-background
 * because they sit *between* the bull's-eye layer and the stimuli layer
 * in z-order; if we filled them with #000 they would occlude the bull's-eye
 * centre dot underneath, even though they would visually look identical to
 * the page background. The grid is intentionally invisible to participants
 * (the whole grid is invisible) and using `none` enforces
 * that without the occlusion side-effect. */
const CELL_FILL_COLOUR = 'none';
const CENTER_CELL_FILL = 'none';
const FIXATION_DOT_DIAMETER_MM = 1.3; /* 5 px @ 96 DPI */
const BULLSEYE_RING_STROKE_MM = 0.5;
const GRID_BORDER_STROKE_MM = 0.28;
const CELL_BORDER_STROKE_MM = 0.16;
/* The rotated grid sweeps a circle of diameter side × √2; +4 px
 * padding ≈ +1 mm in our calibrated units. */
const BULLSEYE_RING_DIAMETER_FACTOR = Math.SQRT2;
const BULLSEYE_RING_PAD_MM = 1.0;
const FIXATION_TEXT_SIZE_MM = 12;

export function createGridFrame({ rotation_deg = 0, fixation = '', background_shade = null } = {}) {
  const sizeMm = gridSizeMm();
  const mid = sizeMm / 2;
  const shade = isValidBackgroundShade(background_shade) ? background_shade : null;
  /* Per-trial palette (shade given) vs default dark-theme palette. The frame
   * carries these as own-properties so primitives (dot, star, dummy, pattern)
   * can read them via `frame.stimulus_colour` / `frame.pattern_colour`
   * without a side-channel. */
  const bullseyeColour = shade ? BULLSEYE_COLOUR_DARK : BULLSEYE_COLOUR;
  const fixationColour = shade ? FIXATION_MARK_COLOUR_DARK : FIXATION_MARK_COLOUR;
  const stimulusColour = shade ? STIMULUS_BLACK : STIMULUS_WHITE;
  const patternColour = shade ? PATTERN_FILLS_BY_BG[shade] : DARK_PATTERN_COLOUR;
  const patternOpacity = shade ? TRIAL_PATTERN_OPACITY : DARK_PATTERN_OPACITY;

  /* The bull's-eye ring extends past the grid edge (it circumscribes the
   * rotated grid). We pad the SVG viewBox so the ring is not clipped. */
  const ringRadiusMm = (sizeMm * BULLSEYE_RING_DIAMETER_FACTOR) / 2 + BULLSEYE_RING_PAD_MM;
  const padMm = Math.max(0, ringRadiusMm - mid) + BULLSEYE_RING_STROKE_MM;
  const viewBoxMm = sizeMm + 2 * padMm;

  const wrapper = document.createElement('div');
  wrapper.className = 'grid-frame';
  wrapper.style.width = `calc(var(--mm) * ${viewBoxMm})`;
  wrapper.style.height = `calc(var(--mm) * ${viewBoxMm})`;
  wrapper.style.position = 'relative';
  wrapper.style.margin = '0 auto';

  const svg = svgEl('svg', {
    viewBox: `${-padMm} ${-padMm} ${viewBoxMm} ${viewBoxMm}`,
    width: '100%',
    height: '100%',
  });
  svg.style.display = 'block';
  svg.style.overflow = 'visible';

  /* Bull's-eye: outer ring + centre dot. Rendered first so cell borders /
   * stimuli stack on top in the visual layer order. The bull's-eye is NOT
   * inside the rotor — it stays anchored to the screen. */
  const bullseyeLayer = svgEl('g', { class: 'grid-bullseye' });
  bullseyeLayer.appendChild(
    svgEl('circle', {
      cx: mid,
      cy: mid,
      r: ringRadiusMm,
      fill: 'none',
      stroke: bullseyeColour,
      'stroke-width': BULLSEYE_RING_STROKE_MM,
      class: 'grid-bullseye-ring',
    })
  );
  const centerDot = svgEl('circle', {
    cx: mid,
    cy: mid,
    r: FIXATION_DOT_DIAMETER_MM / 2,
    fill: fixationColour,
    'shape-rendering': 'geometricPrecision',
    class: 'grid-bullseye-dot',
  });
  bullseyeLayer.appendChild(centerDot);

  const rotor = svgEl('g', {
    class: 'grid-rotor',
    transform: `rotate(${rotation_deg} ${mid} ${mid})`,
  });

  const patternLayer = svgEl('g', { class: 'grid-pattern', visibility: 'hidden' });
  const stimuliLayer = svgEl('g', { class: 'grid-stimuli' });
  const cellsLayer = svgEl('g', { class: 'grid-cells' });

  cellsLayer.appendChild(
    svgEl('rect', {
      x: 0,
      y: 0,
      width: sizeMm,
      height: sizeMm,
      fill: 'none',
      stroke: GRID_BORDER_COLOUR,
      'stroke-width': GRID_BORDER_STROKE_MM,
      class: 'grid-outline',
    })
  );

  const cellSize = config.grid.cell_size_mm;
  for (let i = 0; i < config.grid.cells_per_side * config.grid.cells_per_side; i++) {
    const { x_mm, y_mm } = cellTopLeftMm(i);
    cellsLayer.appendChild(
      svgEl('rect', {
        x: x_mm,
        y: y_mm,
        width: cellSize,
        height: cellSize,
        fill: i === config.grid.centre_cell_index ? CENTER_CELL_FILL : CELL_FILL_COLOUR,
        stroke: CELL_BORDER_COLOUR,
        'stroke-width': CELL_BORDER_STROKE_MM,
        'data-cell-index': i,
      })
    );
  }

  /* '?' / '♪' / etc. text overlay — sits OUTSIDE the rotor so it stays
   * upright when the rotor is rotated (pulled out of the rotation group).
   * Empty by default. Colour matches the bull's-eye. While the overlay
   * carries non-empty text, `setFixation` hides the centre dot so the two
   * glyphs never coexist at the same screen position (see the centre-dot
   * ↔ fixation-overlay swap note in the file header). */
  const fixationEl = svgEl('text', {
    x: mid,
    y: mid,
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
    fill: fixationColour,
    'font-size': FIXATION_TEXT_SIZE_MM,
    'font-family': 'Arial, sans-serif',
    'font-weight': 'bold',
    'shape-rendering': 'geometricPrecision',
    class: 'grid-fixation',
  });
  fixationEl.textContent = fixation;

  /* '?' cue: hook + stem only; the period is the bull's-eye centre dot. Same
   * upright layer as the text overlay (outside the rotor). Hidden until
   * `setFixation(frame, '?')`. */
  const questionMarkEl = svgEl('path', {
    d: questionMarkPath(mid, mid),
    fill: 'none',
    stroke: fixationColour,
    'stroke-width': QMARK_STROKE_MM,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'shape-rendering': 'geometricPrecision',
    visibility: 'hidden',
    class: 'grid-fixation-qmark',
  });

  rotor.appendChild(cellsLayer);
  rotor.appendChild(patternLayer);
  svg.appendChild(bullseyeLayer);
  svg.appendChild(rotor);
  /* stimuliLayer is a sibling of the rotor, painted on top, so the dot /
   * star / dummy glyphs render at the rotated cell-centre coordinates
   * (computed by `rotatedCellCentreMm`) while the glyph itself stays upright. */
  svg.appendChild(stimuliLayer);
  svg.appendChild(fixationEl);
  svg.appendChild(questionMarkEl);
  wrapper.appendChild(svg);

  const frame = {
    wrapper,
    svg,
    rotor,
    rotation_deg: rotation_deg,
    background_shade: shade,
    bullseye_colour: bullseyeColour,
    fixation_colour: fixationColour,
    stimulus_colour: stimulusColour,
    pattern_colour: patternColour,
    pattern_opacity: patternOpacity,
    bullseyeLayer,
    centerDot,
    patternLayer,
    stimuliLayer,
    cellsLayer,
    fixationEl,
    questionMarkEl,
  };

  /* Apply the initial fixation state from the very first paint. */
  applyFixation(frame, fixation);

  return frame;
}

export function setRotation(frame, rotation_deg) {
  const mid = gridSizeMm() / 2;
  frame.rotor.setAttribute('transform', `rotate(${rotation_deg} ${mid} ${mid})`);
  frame.rotation_deg = rotation_deg;
}

/**
 * Set the centre cue: '' (bull's-eye only) or '?' (question-mark cue).
 *
 * The bull's-eye ring and centre dot stay visible in both states; for '?'
 * the dot doubles as the glyph's period. Pass `{ color }` to recolour the
 * cue (green/red probe feedback) — it recolours the '?' strokes AND the
 * dot; calling again without `color` restores the default fill. Any other
 * text is drawn as a legacy text overlay that hides the dot while shown.
 */
export function setFixation(frame, text, { color } = {}) {
  applyFixation(frame, text, color);
}

function applyFixation(frame, text, color) {
  const t = text === null || text === undefined ? '' : String(text);
  const fill = color ?? frame.fixation_colour ?? FIXATION_MARK_COLOUR;
  const isQuestionMark = t === '?';
  frame.fixationEl.textContent = t;
  frame.fixationEl.setAttribute('fill', fill);
  /* The '?' text node stays in the DOM (semantics, tests) but is never
   * painted: the path glyph is what the participant sees. */
  frame.fixationEl.setAttribute('visibility', isQuestionMark ? 'hidden' : 'visible');
  frame.questionMarkEl.setAttribute('stroke', fill);
  frame.questionMarkEl.setAttribute('visibility', isQuestionMark ? 'visible' : 'hidden');
  /* Dot: always visible, except behind legacy overlay text. As the '?'
   * period it takes the cue colour. */
  const legacyOverlay = t.length > 0 && !isQuestionMark;
  frame.centerDot.setAttribute('visibility', legacyOverlay ? 'hidden' : 'visible');
  frame.centerDot.setAttribute(
    'fill',
    isQuestionMark ? fill : (frame.fixation_colour ?? FIXATION_MARK_COLOUR)
  );
}

export function clearStimuli(frame) {
  while (frame.stimuliLayer.firstChild) {
    frame.stimuliLayer.removeChild(frame.stimuliLayer.firstChild);
  }
}
