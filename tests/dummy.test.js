/**
 * @vitest-environment jsdom
 *
 * Tests for `addOpenSquare` in `src/visuals/dummy.js`.
 *
 * The open-square placeholder exists to keep single-task trials (D-only,
 * T-only, I-only) the same length as the dual-task trial each one stands
 * in for. In D-only and T-only the dummy substitutes for the star of the
 * matched dual-task condition (I+D, I+T) and therefore runs on the
 * S-slot envelope (3000 ms onset + 500 ms offset). In I-only the dummy
 * substitutes for the matched dual-task condition's *memory item* (dot
 * in I+D, tone in I+T) and therefore runs on the M-slot envelope
 * (1000 ms onset + 500 ms offset). In live participant-facing trials and
 * in the teaching demos the rect is rendered INVISIBLY (`visible: false`)
 * so it does not compete visually with the encoded dots / tones / stars;
 * only the timing-equating purpose remains. Manuscript figures and the
 * developer primitives demo keep `visible: true` (the default) so the
 * placeholder remains explicable on paper / for QC.
 *
 * This file pins:
 *   - logic preserved: the rect element and its data-cell-index attribute
 *     are mounted regardless of `visible`,
 *   - visible mode (default): stroke = bullseye gray, non-zero stroke-width,
 *     `data-visible="true"`,
 *   - invisible mode: stroke = none, stroke-width = 0,
 *     `data-visible="false"` — i.e. participant cannot perceive it.
 */
import { describe, it, expect } from 'vitest';
import { addOpenSquare } from '../src/visuals/dummy.js';
import { config } from '../src/config.js';
import { BULLSEYE_COLOUR } from '../src/visuals/frame.js';

function makeStubFrame() {
  /* The dummy module only reads `frame.rotation_deg` and writes to
   * `frame.stimuliLayer`. We don't need a real SVG hierarchy for the
   * attribute-level assertions in this file. */
  const stimuliLayer = {
    children: [],
    appendChild(el) {
      this.children.push(el);
    },
  };
  return { rotation_deg: 0, stimuliLayer };
}

describe('addOpenSquare: visible mode (default – manuscript figures, dev demo)', () => {
  it('mounts a rect into the frame stimuli layer', () => {
    const frame = makeStubFrame();
    const el = addOpenSquare(frame, 7);
    expect(el).toBeTruthy();
    expect(frame.stimuliLayer.children).toHaveLength(1);
    expect(frame.stimuliLayer.children[0]).toBe(el);
  });

  it('renders with the bullseye stroke colour and the configured stroke width', () => {
    const frame = makeStubFrame();
    const el = addOpenSquare(frame, 7);
    expect(el.getAttribute('stroke')).toBe(BULLSEYE_COLOUR);
    expect(Number(el.getAttribute('stroke-width'))).toBe(config.dummies.open_square_stroke_mm);
    expect(el.getAttribute('data-visible')).toBe('true');
  });
});

describe('addOpenSquare: invisible mode (live trials + instruction demos)', () => {
  it('still mounts the rect element and preserves data-cell-index', () => {
    /* Logic preserved: the rect must exist so the schedule's
     * `addOpenSquare` → `removeElement` round-trip and the timing envelope
     * are byte-identical to the dual-task slot structure. */
    const frame = makeStubFrame();
    const el = addOpenSquare(frame, 12, { visible: false });
    expect(el).toBeTruthy();
    expect(frame.stimuliLayer.children).toHaveLength(1);
    expect(el.getAttribute('data-cell-index')).toBe('12');
  });

  it('renders with no stroke and zero stroke-width so the participant cannot see it', () => {
    const frame = makeStubFrame();
    const el = addOpenSquare(frame, 12, { visible: false });
    expect(el.getAttribute('stroke')).toBe('none');
    expect(Number(el.getAttribute('stroke-width'))).toBe(0);
    expect(el.getAttribute('fill')).toBe('none');
    expect(el.getAttribute('data-visible')).toBe('false');
  });

  it('still occupies the same bounding box as a visible square (size unchanged)', () => {
    /* Width/height come from `config.dummies.open_square_size_mm` and must
     * be identical across modes — only the stroke is suppressed. This keeps
     * any geometry-aware QC tooling that probes the live DOM consistent
     * across visible and invisible callers. */
    const frame = makeStubFrame();
    const visibleEl = addOpenSquare(makeStubFrame(), 7);
    const invisibleEl = addOpenSquare(frame, 7, { visible: false });
    expect(invisibleEl.getAttribute('width')).toBe(visibleEl.getAttribute('width'));
    expect(invisibleEl.getAttribute('height')).toBe(visibleEl.getAttribute('height'));
  });
});
