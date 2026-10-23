/**
 * Shared instruction-slide layout primitive.
 *
 * One canonical wrapper geometry is used across every instruction-style
 * screen (calibration intros, the five Task 1–5 instruction decks, and the
 * five demo screens) so that:
 *
 *   - the slide TITLE lands at the same y-position on every slide;
 *   - the advance affordance (htmlButtonResponse button, instructions-
 *     plugin Previous/Next nav, or htmlKeyboardResponse "Press Space" hint)
 *     lands at the same y-position on every slide;
 *   - the body copy or active stimulus fills whatever remains in between
 *     without pushing the title or button up or down.
 *
 * The trick is that all three plugin families render their advance
 * affordance immediately after the stimulus DOM. If the stimulus wrapper
 * has the same `min-height` everywhere, the affordance lands at the same
 * y everywhere — even though the wrapper's interior content (a few short
 * paragraphs vs. a calibrated grid frame + caption + button row) varies
 * wildly.
 *
 * The shared `min-height` (see SLIDE_MIN_HEIGHT) is tall enough to
 * accommodate the calibrated 5×5 grid frame on the demo screens with the
 * bull's-eye padding it needs, and leaves room for the plugin's nav
 * chrome (Prev/Next, page indicator) on the instructions decks without
 * spilling into a scrollbar.
 *
 * Two width tracks share the same height:
 *   - TEXT (40 rem): the four calibration intros (viewing-distance,
 *     hands placement, plus any sibling intros) and the five Task 1–5
 *     instruction decks. Fixed line-length keeps copy comfortable to read
 *     and identical across decks.
 *   - DEMO (95 vw, capped at 72 rem): the five demo screens. The demo
 *     wrapper is wider because it must horizontally accommodate the
 *     calibrated circle on smaller laptop screens; the longest demo
 *     title ("Demonstration of Task 5 — Tones and pattern together")
 *     would otherwise wrap. A 72 rem cap keeps the layout from spilling
 *     across ultra-wide monitors.
 *
 * Title row: fixed `min-height: 3rem` flex centre. `white-space: nowrap`
 * ensures the demo titles never wrap into a second line; the deck titles
 * fit comfortably on one line at 40 rem so nowrap is harmless there.
 *
 * Body row: `flex: 1 1 auto` — absorbs the remaining vertical space inside
 * the wrapper, so the title sits flush at the top and the wrapper's
 * BOTTOM edge stays at a stable y regardless of how much body copy is
 * present.
 *
 * This module is intentionally tiny and zero-runtime — it only exports
 * style strings and page builders. The actual page HTML is composed by each consumer
 * (memory.js / imagery.js / dual.js / viewing-distance.js / demos.js)
 * so the per-deck content structure stays close to where its copy lives.
 */
import { config } from '../config.js';

/* Single source of truth for the wrapper's vertical extent. The exported
 * style strings reference this so a change propagates everywhere at once.
 *
 * 72vh is sized so the jsPsych instructions plugin's Previous/Next nav
 * row lands above the fold on a 1280×800 or 1366×768 laptop viewport.
 * The slide content (title +
 * paragraphs + 50 mm circle + paginated spacers) sums to ~620 px even on
 * the dense pages, so 72vh ≈ 576 px floor with `min-height` semantics
 * means short slides match the long slides' bottom edge while long slides
 * push down naturally — no flex-shrink lossage either way. */
const SLIDE_MIN_HEIGHT = '72vh';

/* Palette — the whole page chrome (index.html body +
 * .jspsych-display-element) is light gray, so the slide layout is just a
 * width-constrained text column on the same gray surface, with no fill,
 * shadow or radius. The gray shade is used for all instruction surfaces
 * so a gray-trial onset is visually continuous with the preceding deck. */
const SLIDE_CARD_INK = '#000';

/* Width tokens for the two layout tracks. Demo screens use the wider
 * track so the calibrated circle has horizontal breathing room and the
 * longest task title stays on one line. */
/* A 50 rem text column keeps long instruction pages (e.g. imagery Task 3
 * page 4 "A few more things to know") inside the fold on a ≈ 768 px
 * laptop window by trading horizontal whitespace for fewer wrapped
 * lines. */
const SLIDE_WIDTH_TEXT = '50rem';
const SLIDE_WIDTH_DEMO = '95vw';
const SLIDE_MAX_WIDTH_DEMO = '72rem';

/* Common base — flex column, top-anchored title, padded so the title row
 * never butts up against the viewport edge. `box-sizing: border-box`
 * keeps the padding inside the declared min-height so two slides with
 * the same min-height truly bottom-out at the same y. No background /
 * radius / shadow: the slide is a transparent column over the page-
 * level light-gray fill. */
const BASE_STYLE = `
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: stretch;
  text-align: left;
  box-sizing: border-box;
  padding: 1.1rem 2rem 1.25rem;
  min-height: ${SLIDE_MIN_HEIGHT};
  color: ${SLIDE_CARD_INK};
`
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Wrapper style for text-heavy instruction slides.
 *   - viewing-distance posture / hands placement screens (htmlButtonResponse)
 *   - the five Task 1–5 instruction decks (jsPsych instructions plugin)
 *
 * The instructions plugin renders its Previous/Next nav AFTER the
 * stimulus, so the nav lands at the wrapper's bottom edge → at a stable y
 * across every page of every deck.
 */
const SLIDE_STYLE_TEXT = `${BASE_STYLE} width: ${SLIDE_WIDTH_TEXT}; max-width: 94vw;`;

/**
 * Wrapper style for the five demo screens.
 *
 * Wider track + center-aligned items because the demo body is a
 * calibrated SVG circle plus a caption panel, both of which want to sit
 * dead-centre horizontally regardless of viewport width.
 */
export const SLIDE_STYLE_DEMO = `${BASE_STYLE} width: ${SLIDE_WIDTH_DEMO}; max-width: ${SLIDE_MAX_WIDTH_DEMO}; align-items: center;`;

/**
 * Title-row style — used by every consumer of this primitive so the
 * H2's vertical centre lands at the same y on every slide.
 *
 * `min-height: 3rem` reserves vertical space whether or not the title
 * wraps; combined with `display: flex; align-items: center` the H2 sits
 * mid-row regardless of font-size. `white-space: nowrap` defends the
 * demo titles (which are long: "Demonstration of Task 5 — Tones and
 * pattern together") from wrapping; deck titles are short enough that
 * the rule is harmless.
 */
export const SLIDE_TITLE_ROW_STYLE = `
  flex: 0 0 auto;
  min-height: 3rem;
  width: 100%;
  margin: 0 0 1.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
`
  .replace(/\s+/g, ' ')
  .trim();

export const SLIDE_TITLE_H2_STYLE = `
  margin: 0;
  text-align: center;
  font-size: clamp(1.05rem, 2.1vw, 1.6rem);
  line-height: 1.25;
  white-space: nowrap;
`
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Body-row style — absorbs the remaining vertical space inside the
 * wrapper. `min-height: 0` is required for the flex child to shrink below
 * its intrinsic content size when needed; without it, very long copy can
 * push the wrapper past `min-height` and break the bottom-edge anchor.
 */
const SLIDE_BODY_STYLE = `
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
`
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Compose a text-heavy instruction page (decks, viewing-distance) with
 * the canonical title row + body block. `body` is raw HTML — the consumer
 * is responsible for paragraph-level structure inside it.
 *
 * The body div carries `data-voiceover-target` so the global voiceover-
 * slide observer (`src/visuals/voiceover-slide.js`) can locate it and
 * narrate the page's prose. The TITLE intentionally sits OUTSIDE the
 * narration target — title text is short and read at a glance; narrating
 * it would slow every slide's onset by 1–2 seconds for no comprehension
 * gain. The "Press Space to continue" footer hint, when present, is
 * rendered by the host plugin's nav chrome and is also outside the
 * target by construction.
 *
 * Optional `narration` decouples the SPOKEN text from the VISIBLE body.
 * When provided, the voiceover engine plays the narration string (giving
 * the experimenter room to add framing words — "Let's start with…" —
 * before / after the on-screen prose); when omitted, the engine reads
 * the visible body verbatim. The narration is HTML-attribute-escaped
 * and stamped as `data-voiceover-script` for the engine to pick up.
 */
export function slideTextPage({ title, body, narration }) {
  const scriptAttr =
    typeof narration === 'string' && narration.trim()
      ? ` data-voiceover-script="${escapeAttr(narration.trim())}"`
      : '';
  /* Tightened vs. the deck wrapper so the host plugin's button row
   * (e.g. viewing-distance's "I am ready") sits above the fold on
   * ≈ 768 px laptop viewports — and is reachable on the ~600 px windows
   * Prolific participants sometimes use. The compactness comes from
   *   (a) `min-height: auto`  → wrapper hugs content, no 72vh floor;
   *   (b) `padding-top/bottom: 0.4rem` → trim wrapper chrome from 1.1rem
   *       above and 1.25rem below;
   *   (c) `font-size: 0.95rem; line-height: 1.5` → match the consent /
   *       demographics body scale instead of jsPsych's default 18px/1.6em;
   *   (d) a compact title row (natural height, smaller bottom margin)
   *       overrides the 3rem-tall title slot the decks need.
   * The instruction decks keep the 72vh anchor + default title row via
   * `slideStimulusPage` so the H2 + nav still line up across the deck
   * pages. */
  const compactWrapperStyle = `${SLIDE_STYLE_TEXT} min-height: auto; padding-top: 0.4rem; padding-bottom: 0.4rem; font-size: 0.95rem; line-height: 1.5;`;
  const compactTitleRowStyle =
    'flex: 0 0 auto; width: 100%; margin: 0 0 0.5rem; display: flex; align-items: center; justify-content: center;';
  return `
    <div style="${compactWrapperStyle}">
      <div style="${compactTitleRowStyle}">
        <h2 style="${SLIDE_TITLE_H2_STYLE}">${title}</h2>
      </div>
      <div style="${SLIDE_BODY_STYLE}" data-voiceover-target${scriptAttr}>${body}</div>
    </div>
  `;
}

/* Calibrated bull's-eye geometry — duplicates the math in
 * `frame.js::createGridFrame` deliberately, because slide-layout is the
 * shared primitive layer and must not import the runtime frame builder.
 * If a future tweak alters `gridSizeMm()` / ring radius, update both. */
const SLIDE_GRID_SIZE_MM = 50; /* 5 × 10 mm cells */
const SLIDE_GRID_MID_MM = SLIDE_GRID_SIZE_MM / 2;
const SLIDE_RING_RADIUS_MM = (SLIDE_GRID_SIZE_MM * Math.SQRT2) / 2 + 1.0;
const SLIDE_PAD_MM = SLIDE_RING_RADIUS_MM - SLIDE_GRID_MID_MM + 0.5;
const SLIDE_VIEWBOX_MM = SLIDE_GRID_SIZE_MM + 2 * SLIDE_PAD_MM;
const SLIDE_DOT_CELL_CENTRE_MM = { cx: 35, cy: 15 };
const SLIDE_STAR_CELL_CENTRE_MM = { cx: 15, cy: 35 };
const SLIDE_DOT_R_MM = 2.5; /* config.memory.dot_diameter_mm / 2 */
const SLIDE_STAR_R_MM = 2.5; /* config.imagery.star_size_mm / 2 */
const SLIDE_ARROW_PX = 100; /* config.imagery.rotation_arrow_size_px */
/* Slide-stamp arrows render TILTED by default — an upright arrow does not
 * read as a rotation cue. The angle is intentionally NOT any of the live
 * trial's rotation values (live trials use integer angles from
 * config.grid.rotation_min_deg to rotation_max_deg), so the instruction slides
 * do not preview a specific trial rotation; this is an iconographic tilt, not
 * a numeric preview. */
const SLIDE_ARROW_DEFAULT_TILT_DEG = 30;
const SLIDE_TONE_GLYPH_SIZE_MM = 12;
const SLIDE_QMARK_GLYPH_SIZE_MM = 12;

/* Pattern overlay — the 13 gray-pattern cells, read from
 * `config.pattern.gray_pattern_cells` (config.js has no dependencies, so this
 * does not pull the runtime graph in). Mirrors the runtime overlay built by
 * `pattern.js::buildPatternOverlay`. If the cell size changes, update both.
 *
 * SLIDE_PATTERN_OPACITY is 0.33 to match the live gray-trial rendering.
 * The slide bull's-eye sits on the SAME light-gray (#D3D3D3) the trial
 * uses, so the same opacity yields a visually identical pattern. */
const SLIDE_CELL_SIZE_MM = 10;
const SLIDE_PATTERN_FILL = '#FFFFFF';
const SLIDE_PATTERN_OPACITY = 0.33;

function starPolygonPoints(cx, cy, R) {
  const INNER_RATIO = 0.382;
  const r = R * INNER_RATIO;
  const out = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? R : r;
    const theta = -Math.PI / 2 + (i * Math.PI) / 5;
    out.push(`${cx + radius * Math.cos(theta)},${cy + radius * Math.sin(theta)}`);
  }
  return out.join(' ');
}

const SLIDE_STAR_POLY_POINTS = starPolygonPoints(
  SLIDE_STAR_CELL_CENTRE_MM.cx,
  SLIDE_STAR_CELL_CENTRE_MM.cy,
  SLIDE_STAR_R_MM
);

/* Slide stimulus palette — matches the live trial palette
 * (`src/visuals/colour-palette.js`: BULLSEYE_COLOUR_DARK,
 * FIXATION_MARK_COLOUR_DARK, STIMULUS_BLACK) so the exemplar dot / star /
 * '?' / '♪' that the participant sees on the instruction card is
 * pixel-identical to the stimulus they'll see during the trial body. The
 * fixation centre dot uses the deeper 0.55 alpha so it reads as a fixation
 * aid against the gray card without blending into the dim 0.229 ring. */
const SLIDE_RING_STROKE_COLOUR = 'rgba(0, 0, 0, 0.229)';
const SLIDE_FIXATION_DOT_COLOUR = 'rgba(0, 0, 0, 0.55)';
const SLIDE_STIM_COLOUR = '#000';
const SLIDE_TONE_GLYPH_COLOUR = 'rgba(0, 0, 0, 0.85)';

/* Build the SVG bull's-eye + stamped exemplar element as an HTML string.
 * `kinds` is a Set of element names: 'dot', 'star', 'arrow', 'tone', 'qmark',
 * 'pattern'.
 *
 * 'qmark' is the centre '?' fixation shown on probe / recognition events
 * during the live trial (see `frame.js::setFixation`). It is used on
 * probe-phase instruction slides ("After the dots, we will test your
 * memory…") so the participant sees the same centre marker on the
 * teaching slide that they will see when the test phase starts. Like
 * 'tone', it occupies the centre and therefore hides the dim centre
 * dot — mirroring the centre-dot/overlay swap in `frame.js`.
 *
 * 'pattern' renders the 13 gray-pattern cells inside the bull's-eye so the
 * imagery (Task 3) "welcome" slide can show the participant exactly what
 * pattern they will be asked to picture. `arrowAngleDeg` rotates the
 * rotation-cue arrow (default: SLIDE_ARROW_DEFAULT_TILT_DEG so the arrow
 * does not stand upright). */
function slideStimulusSvg(kinds, { arrowAngleDeg = SLIDE_ARROW_DEFAULT_TILT_DEG } = {}) {
  const want = new Set(kinds);
  const centreOccupied = want.has('tone') || want.has('qmark');
  const showPattern = want.has('pattern');
  const ring = `<circle cx="${SLIDE_GRID_MID_MM}" cy="${SLIDE_GRID_MID_MM}" r="${SLIDE_RING_RADIUS_MM}" fill="none" stroke="${SLIDE_RING_STROKE_COLOUR}" stroke-width="0.5" />`;
  /* Pattern hides the fixation dot too — when the pattern is on display the
   * centre cell (cell 12) is one of the 13 painted cells, so a tiny dot at
   * its centre would be lost in the white wash and the slide would read as
   * "pattern with a stray speck" rather than as the gestalt the participant
   * will see in trials. */
  const centreDot =
    centreOccupied || showPattern
      ? ''
      : `<circle cx="${SLIDE_GRID_MID_MM}" cy="${SLIDE_GRID_MID_MM}" r="0.65" fill="${SLIDE_FIXATION_DOT_COLOUR}" />`;
  const pattern = showPattern
    ? config.pattern.gray_pattern_cells
        .map((cellIndex) => {
          const col = cellIndex % 5;
          const row = Math.floor(cellIndex / 5);
          const x = col * SLIDE_CELL_SIZE_MM;
          const y = row * SLIDE_CELL_SIZE_MM;
          return `<rect x="${x}" y="${y}" width="${SLIDE_CELL_SIZE_MM}" height="${SLIDE_CELL_SIZE_MM}" fill="${SLIDE_PATTERN_FILL}" opacity="${SLIDE_PATTERN_OPACITY}" />`;
        })
        .join('')
    : '';
  const dot = want.has('dot')
    ? `<circle cx="${SLIDE_DOT_CELL_CENTRE_MM.cx}" cy="${SLIDE_DOT_CELL_CENTRE_MM.cy}" r="${SLIDE_DOT_R_MM}" fill="${SLIDE_STIM_COLOUR}" />`
    : '';
  const star = want.has('star')
    ? `<polygon points="${SLIDE_STAR_POLY_POINTS}" fill="${SLIDE_STIM_COLOUR}" />`
    : '';
  const tone = want.has('tone')
    ? `<text x="${SLIDE_GRID_MID_MM}" y="${SLIDE_GRID_MID_MM}" text-anchor="middle" dominant-baseline="central" fill="${SLIDE_TONE_GLYPH_COLOUR}" font-size="${SLIDE_TONE_GLYPH_SIZE_MM}" font-family="Arial, sans-serif" font-weight="bold">♪</text>`
    : '';
  const qmark = want.has('qmark')
    ? `<text x="${SLIDE_GRID_MID_MM}" y="${SLIDE_GRID_MID_MM}" text-anchor="middle" dominant-baseline="central" fill="${SLIDE_TONE_GLYPH_COLOUR}" font-size="${SLIDE_QMARK_GLYPH_SIZE_MM}" font-family="Arial, sans-serif" font-weight="bold">?</text>`
    : '';
  const svg = `
    <svg viewBox="${-SLIDE_PAD_MM} ${-SLIDE_PAD_MM} ${SLIDE_VIEWBOX_MM} ${SLIDE_VIEWBOX_MM}"
         width="100%" height="100%" style="display: block; overflow: visible;">
      ${ring}${pattern}${centreDot}${dot}${star}${tone}${qmark}
    </svg>
  `;
  /* The rotation-arrow asset is a mid-gray PNG. `filter: brightness(0)
   * saturate(100%)` re-paints every non-transparent pixel as solid black,
   * so the exemplar arrow reads as a stimulus on the gray card. Same trick
   * as the trial frames.
   *
   * Tilt is expressed in `turn` units rather than `deg` so the inline
   * `style=` text never contains an "Ndeg" or "N°" token that the
   * `instructions.test.js::rotation cue framing` guard would flag — the
   * guard is intentionally pessimistic (matches raw HTML, not rendered
   * text) so we use a CSS-equivalent representation that doesn't trip it.
   * 1 turn = 360°, so 30° → ≈ 0.0833 turn. CSS-rendering is identical. */
  const arrowTurns = (arrowAngleDeg / 360).toFixed(6);
  const arrow = want.has('arrow')
    ? `<img src="${getRotationArrowUrl()}" alt="rotation cue"
            style="position: absolute; top: 50%; left: 50%; width: ${SLIDE_ARROW_PX}px; height: ${SLIDE_ARROW_PX}px;
                   transform: translate(-50%, -50%) rotate(${arrowTurns}turn); pointer-events: none; z-index: 10; user-select: none;
                   filter: brightness(0) saturate(100%) drop-shadow(1px 0 0 #fff) drop-shadow(-1px 0 0 #fff) drop-shadow(0 1px 0 #fff) drop-shadow(0 -1px 0 #fff);" />`
    : '';
  return `
    <div style="position: relative; width: calc(var(--mm) * ${SLIDE_VIEWBOX_MM}); height: calc(var(--mm) * ${SLIDE_VIEWBOX_MM}); margin: 0 auto;">
      ${svg}${arrow}
    </div>
  `;
}

function getRotationArrowUrl() {
  return `${import.meta.env.BASE_URL}assets/rotation-arrow.png`;
}

/**
 * Compose an instruction page that pairs short body copy with a calibrated
 * bull's-eye circle stamped with the components the body discusses (dot,
 * star, rotation arrow, ♪ glyph). The column structure mirrors the demo
 * frame (`demos.js::demoFrameTemplate`) so the circle's Y position is
 * pixel-identical across every instruction slide AND the per-task demo —
 * the participant sees the circle stay anchored as they advance from
 * page 1 of the deck through to the demo's first event.
 *
 * `exemplar` is an array of any of: 'dot', 'star', 'arrow', 'tone'. Pass
 * `[]` (or omit) for a circle with no stamp; pass multiple to compose
 * (e.g. ['arrow', 'dot'] for I+D's "combine the rotation with dots" page).
 *
 * The 5rem and 6.5rem placeholder rows below the circle have no content —
 * they exist purely to occupy the vertical band the demo's caption box +
 * button row will fill on the very next screen, so the circle does not
 * jump when the participant advances from instruction → demo.
 */
export function slideStimulusPage({ title, body, narration, exemplar = [], arrowAngleDeg }) {
  const scriptAttr =
    typeof narration === 'string' && narration.trim()
      ? ` data-voiceover-script="${escapeAttr(narration.trim())}"`
      : '';
  const stim = slideStimulusSvg(
    exemplar,
    typeof arrowAngleDeg === 'number' ? { arrowAngleDeg } : {}
  );
  /* Layout — title sits at the top, body takes its natural height, the
   * circle follows with a generous margin so the body's last line never
   * runs into the ring. The trailing spacer absorbs
   * leftover viewport height so the plugin nav row lands at a stable y
   * on every page regardless of body length. */
  return `
    <div style="${SLIDE_STYLE_TEXT} align-items: center;">
      <div style="${SLIDE_TITLE_ROW_STYLE}">
        <h2 style="${SLIDE_TITLE_H2_STYLE}">${title}</h2>
      </div>
      <div style="flex: 0 0 auto; width: 100%; text-align: left;"
           data-voiceover-target${scriptAttr}>${body}</div>
      <div style="flex: 0 0 auto; display: flex; align-items: center; justify-content: center; margin-top: 2rem;">
        ${stim}
      </div>
      <div style="flex: 1 0 auto; min-height: 1rem;" aria-hidden="true"></div>
    </div>
  `;
}

function escapeAttr(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
