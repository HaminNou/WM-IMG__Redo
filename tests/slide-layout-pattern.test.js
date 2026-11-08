// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { slideStimulusPage } from '../src/visuals/slide-layout.js';
import { onPatternCells } from '../src/grid.js';
import { createGridFrame } from '../src/visuals/frame.js';
import { buildPatternOverlay, showPattern } from '../src/visuals/pattern.js';

describe('slide-layout pattern overlay', () => {
  const page = slideStimulusPage({
    title: 't',
    body: '<p>b</p>',
    exemplar: ['pattern'],
  });

  function patternRects() {
    const host = document.createElement('div');
    host.innerHTML = page;
    return Array.from(host.querySelectorAll('rect.slide-pattern-fill')).map((r) => ({
      x: Number(r.getAttribute('x')),
      y: Number(r.getAttribute('y')),
    }));
  }

  it('has no list of its own: the cells it draws come from config.pattern.gray_pattern_cells', () => {
    const rects = patternRects();
    expect(rects).toHaveLength(config.pattern.gray_pattern_cells.length);
    const n = config.grid.cells_per_side;
    const size = config.grid.cell_size_mm;
    const drawn = rects.map((r) => {
      /* The slide viewBox adds the same padding on both axes. */
      return { col: r.x, row: r.y };
    });
    const cells = config.pattern.gray_pattern_cells.map((c) => ({
      col: (c % n) * size,
      row: Math.floor(c / n) * size,
    }));
    const offset = drawn[0].col - cells[0].col;
    expect(drawn.map((d) => ({ col: d.col - offset, row: d.row - offset }))).toEqual(cells);
  });

  it('draws the same 13 cells that the runtime treats as on-pattern, plus the centre', () => {
    expect(config.pattern.gray_pattern_cells).toHaveLength(13);
    const onSet = new Set([...onPatternCells(), config.grid.centre_cell_index]);
    expect([...onSet].sort((a, b) => a - b)).toEqual(
      [...config.pattern.gray_pattern_cells].sort((a, b) => a - b)
    );
  });
});

describe('the centre dot on the instruction cards is the live dot', () => {
  const card = (exemplar) => {
    const host = document.createElement('div');
    host.innerHTML = slideStimulusPage({ title: 't', body: '<p>b</p>', exemplar });
    return host;
  };
  const dotOf = (host) =>
    [...host.querySelectorAll('svg circle')].find((c) => c.getAttribute('r') === '0.65');

  it('the pattern card draws the dot on top of the pattern, at the centre, in the live colour', () => {
    const host = card(['pattern']);
    const dot = dotOf(host);
    expect(dot).toBeDefined();
    expect([dot.getAttribute('cx'), dot.getAttribute('cy')]).toEqual(['25', '25']);
    /* The live frame's own bull's-eye dot and its pattern copy. */
    const frame = createGridFrame({ rotation_deg: 0, fixation: '', background_shade: 'gray' });
    buildPatternOverlay(frame);
    showPattern(frame);
    expect(dot.getAttribute('fill')).toBe(frame.centerDot.getAttribute('fill'));
    expect(dot.getAttribute('fill')).toBe(frame._patternRefDot.getAttribute('fill'));
    expect(dot.getAttribute('r')).toBe(frame._patternRefDot.getAttribute('r'));
    /* Later in the SVG = painted above: the dot follows every pattern rect. */
    const nodes = [...host.querySelectorAll('svg > *')];
    const lastRect = Math.max(...nodes.map((n, i) => (n.tagName === 'rect' ? i : -1)));
    expect(nodes.indexOf(dot)).toBeGreaterThan(lastRect);
  });

  it.each([['arrow'], ['star'], ['dot'], ['qmark'], []])(
    'the %s card shows the same dot colour as the live frame',
    (...exemplar) => {
      const dot = dotOf(card(exemplar));
      const frame = createGridFrame({ rotation_deg: 0, fixation: '', background_shade: 'gray' });
      expect(dot.getAttribute('fill')).toBe(frame.centerDot.getAttribute('fill'));
    }
  );
});
