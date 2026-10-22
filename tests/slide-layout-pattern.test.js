// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { slideStimulusPage } from '../src/visuals/slide-layout.js';
import { onPatternCells } from '../src/grid.js';

describe('slide-layout pattern overlay', () => {
  const page = slideStimulusPage({
    title: 't',
    body: '<p>b</p>',
    exemplar: ['pattern'],
  });

  function patternRects() {
    const host = document.createElement('div');
    host.innerHTML = page;
    return Array.from(host.querySelectorAll('rect[opacity="0.33"]')).map((r) => ({
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
