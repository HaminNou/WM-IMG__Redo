/**
 * Tests for src/grid.js — pattern-membership invariants and cell coordinate
 * math. These are the load-bearing equalities that the entire counterbalance
 * scheme rests on (12 on + 12 off = 24 non-centre, no overlap).
 */
import { describe, it, expect } from 'vitest';
import {
  totalCells,
  nonCentreCells,
  onPatternCells,
  offPatternCells,
  isOnPattern,
  isOffPattern,
  isCentre,
  patternLabel,
  cellRowCol,
  rowColToCell,
  cellCentreMm,
  cellTopLeftMm,
  gridSizeMm,
  rotatedCellCentreMm,
  assertPatternIntegrity,
} from '../src/grid.js';
import { config } from '../src/config.js';

describe('grid: pattern-membership invariants', () => {
  it('has 25 cells in a 5×5 grid', () => {
    expect(totalCells()).toBe(25);
  });

  it('has 24 non-centre cells', () => {
    expect(nonCentreCells()).toHaveLength(24);
    expect(nonCentreCells()).not.toContain(12);
  });

  it('has exactly 12 on-pattern cells (after dropping centre)', () => {
    expect(onPatternCells()).toHaveLength(12);
    expect(onPatternCells()).not.toContain(12);
  });

  it('has exactly 12 off-pattern cells', () => {
    expect(offPatternCells()).toHaveLength(12);
    expect(offPatternCells()).not.toContain(12);
  });

  it('on ∩ off = ∅', () => {
    const offSet = new Set(offPatternCells());
    for (const c of onPatternCells()) {
      expect(offSet.has(c)).toBe(false);
    }
  });

  it('on ∪ off = all 24 non-centre cells', () => {
    const union = new Set([...onPatternCells(), ...offPatternCells()]);
    expect(union.size).toBe(24);
    for (const c of nonCentreCells()) expect(union.has(c)).toBe(true);
  });

  it('membership predicates agree with the arrays', () => {
    for (const c of onPatternCells()) {
      expect(isOnPattern(c)).toBe(true);
      expect(isOffPattern(c)).toBe(false);
      expect(isCentre(c)).toBe(false);
      expect(patternLabel(c)).toBe('on');
    }
    for (const c of offPatternCells()) {
      expect(isOffPattern(c)).toBe(true);
      expect(isOnPattern(c)).toBe(false);
      expect(isCentre(c)).toBe(false);
      expect(patternLabel(c)).toBe('off');
    }
    expect(isCentre(12)).toBe(true);
    expect(patternLabel(12)).toBe('centre');
  });

  it('matches the design-doc gray-pattern verbatim (after centre removal)', () => {
    /* If this fails, someone has changed the locked pattern definition. */
    expect(onPatternCells()).toEqual([1, 2, 3, 7, 10, 11, 13, 14, 17, 21, 22, 23]);
  });

  it('assertPatternIntegrity throws nothing on a valid config', () => {
    expect(() => assertPatternIntegrity()).not.toThrow();
  });

  it('exported arrays are frozen', () => {
    expect(Object.isFrozen(onPatternCells())).toBe(true);
    expect(Object.isFrozen(offPatternCells())).toBe(true);
    expect(Object.isFrozen(nonCentreCells())).toBe(true);
  });
});

describe('grid: cell coordinates', () => {
  it('cellRowCol and rowColToCell are inverses for every cell', () => {
    for (let i = 0; i < 25; i++) {
      const { row, col } = cellRowCol(i);
      expect(rowColToCell(row, col)).toBe(i);
    }
  });

  it('places cell 0 at top-left, cell 24 at bottom-right', () => {
    expect(cellRowCol(0)).toEqual({ row: 0, col: 0 });
    expect(cellRowCol(24)).toEqual({ row: 4, col: 4 });
    expect(cellRowCol(12)).toEqual({ row: 2, col: 2 });
  });

  it('cellCentreMm computes correct centre for known cells', () => {
    const cell = config.grid.cell_size_mm;
    const half = cell / 2;
    expect(cellCentreMm(0)).toEqual({ x_mm: half, y_mm: half });
    /* Cell 12 = (col 2, row 2) → centre at (2.5 × cell, 2.5 × cell). */
    expect(cellCentreMm(12)).toEqual({ x_mm: 2.5 * cell, y_mm: 2.5 * cell });
    /* Cell 24 = (col 4, row 4) → centre at (4.5 × cell, 4.5 × cell). */
    expect(cellCentreMm(24)).toEqual({ x_mm: 4.5 * cell, y_mm: 4.5 * cell });
  });

  it('cellTopLeftMm + half size = cellCentreMm', () => {
    const half = config.grid.cell_size_mm / 2;
    for (let i = 0; i < 25; i++) {
      const tl = cellTopLeftMm(i);
      const c = cellCentreMm(i);
      expect(c.x_mm).toBe(tl.x_mm + half);
      expect(c.y_mm).toBe(tl.y_mm + half);
    }
  });

  it('gridSizeMm = 5 × cell_size_mm', () => {
    expect(gridSizeMm()).toBe(5 * config.grid.cell_size_mm);
  });

  it('out-of-range cells throw', () => {
    expect(() => cellRowCol(-1)).toThrow();
    expect(() => cellRowCol(25)).toThrow();
    expect(() => rowColToCell(5, 0)).toThrow();
    expect(() => rowColToCell(0, -1)).toThrow();
    expect(() => patternLabel(99)).toThrow();
  });
});

/**
 * The rotation contract: `rotatedCellCentreMm` rotates a cell's screen
 * position around the grid centre, while `isOnPattern(cellIndex)` continues
 * to read the upright on-pattern set. This split is what makes the same
 * physical pixel on screen "on-pattern" in some trials and "off-pattern"
 * in others — the cell whose centre lands on that pixel changes as the
 * grid rotates, even though each cell's pattern membership is fixed.
 *
 * These tests pin down the contract so a future refactor that mistakenly
 * couples rotation to pattern membership (or vice versa) fails loudly.
 */
describe('grid: rotation contract (rotatedCellCentreMm)', () => {
  const cell = config.grid.cell_size_mm;
  const mid = (5 * cell) / 2;

  it('rotation 0 is identity for every cell', () => {
    for (let i = 0; i < 25; i++) {
      const upright = cellCentreMm(i);
      const rotated = rotatedCellCentreMm(i, 0);
      expect(rotated.x_mm).toBeCloseTo(upright.x_mm, 10);
      expect(rotated.y_mm).toBeCloseTo(upright.y_mm, 10);
    }
  });

  it('the centre cell never moves under rotation', () => {
    for (const angle of [0, 30, 90, 180, 270, 360, -45]) {
      const r = rotatedCellCentreMm(12, angle);
      expect(r.x_mm).toBeCloseTo(mid, 10);
      expect(r.y_mm).toBeCloseTo(mid, 10);
    }
  });

  it('rotating by 360° returns each cell to its upright position', () => {
    for (let i = 0; i < 25; i++) {
      const upright = cellCentreMm(i);
      const r = rotatedCellCentreMm(i, 360);
      expect(r.x_mm).toBeCloseTo(upright.x_mm, 8);
      expect(r.y_mm).toBeCloseTo(upright.y_mm, 8);
    }
  });

  it('a 90° rotation maps the corners to the next corner clockwise (SVG y-down)', () => {
    /* Cell 0 is top-left (col 0, row 0) and cell 4 is top-right (col 4, row 0).
     * In SVG's y-down coordinate system, a positive `rotate(90)` is clockwise,
     * so top-left rotates to top-right (cell 4's upright centre). */
    const tl = cellCentreMm(0);
    const tr = cellCentreMm(4);
    const r = rotatedCellCentreMm(0, 90);
    expect(r.x_mm).toBeCloseTo(tr.x_mm, 8);
    expect(r.y_mm).toBeCloseTo(tr.y_mm, 8);
    /* And cell 0 rotated by -90° (counter-clockwise) lands at the bottom-left
     * cell 20's upright centre. */
    const bl = cellCentreMm(20);
    const r2 = rotatedCellCentreMm(0, -90);
    expect(r2.x_mm).toBeCloseTo(bl.x_mm, 8);
    expect(r2.y_mm).toBeCloseTo(bl.y_mm, 8);
  });

  it('the screen position of a cell changes with rotation, but its pattern membership does not', () => {
    /* Pick an on-pattern cell and an off-pattern cell. Their pattern
     * membership is rotation-invariant by the upright-set contract; their
     * screen positions, however, must differ across rotations. */
    const onCell = onPatternCells()[0];
    const offCell = offPatternCells()[0];
    for (const angle of [30, 90, 180, 270]) {
      expect(isOnPattern(onCell)).toBe(true);
      expect(isOnPattern(offCell)).toBe(false);
      const upright = cellCentreMm(onCell);
      const rotated = rotatedCellCentreMm(onCell, angle);
      const dx = rotated.x_mm - upright.x_mm;
      const dy = rotated.y_mm - upright.y_mm;
      /* Sanity: a non-centre cell really does move when rotated by a non-zero
       * angle (this is the bit the participant perceives as "the pattern
       * rotated"). */
      expect(Math.hypot(dx, dy)).toBeGreaterThan(0.5);
    }
  });

  it('a fixed screen position can be on-pattern at one rotation and off-pattern at another', () => {
    /* The user-facing semantics in cond_ii1.html: "a point inside the circle
     * might be on-pattern in a trial but off-pattern in another trial, only
     * because of the rotation of the pattern from the first trial to the
     * next one." Translation into our coordinates: pick a fixed screen point
     * P; under rotation θ₁ the cell whose centre lands at P is cell A
     * (on-pattern); under rotation θ₂ the cell whose centre lands at P is
     * cell B (off-pattern). The fixed pixel therefore "flips" pattern
     * membership trial-to-trial, even though A and B individually are
     * stable. We verify this by checking that the cell at the upright centre
     * of cell A under rotation -θ falls on a different pattern subset.
     *
     * Concretely: cell 1 is on-pattern (top row, col 1). Under a 90° clockwise
     * rotation, the cell whose centre lands at cell 1's upright pixel is
     * cell 7 (right column from cell 1's perspective rotated to top).
     * Both 1 and 7 are on-pattern — wrong example. So instead pick cell 1
     * (on-pattern) and probe whether cell-19 (off-pattern, bottom row) lands
     * on cell-1's upright pixel under a 270° rotation. The mathematical test:
     * under rotation θ, the cell at upright pixel P is the cell whose centre
     * is at rotatedCellCentreMm(_, -θ) = P. We check the contract by
     * round-tripping: rotating cell A by θ gives some new screen point;
     * find a different cell B whose UPRIGHT centre is closest to that point
     * — which means under rotation -θ from B, the point lands at A's
     * upright position, demonstrating the swap.
     *
     * Easier: assert that cell 1's screen position at 90° equals cell 11's
     * upright screen position (top-row col 1 rotates to middle-left at 90°
     * clockwise in SVG — cell 11 is row 2 col 1 — let math decide). We
     * compute and check pattern-membership disagreement programmatically.
     */
    const angle = 90;
    /* Find cell pairs (A, B) such that rotated centre of A at θ equals
     * upright centre of B (within tolerance), and assert at least one such
     * pair has different pattern labels. */
    let foundFlip = false;
    for (let a = 0; a < 25; a++) {
      const r = rotatedCellCentreMm(a, angle);
      for (let b = 0; b < 25; b++) {
        if (a === b) continue;
        const u = cellCentreMm(b);
        if (Math.hypot(r.x_mm - u.x_mm, r.y_mm - u.y_mm) > 0.001) continue;
        /* Cells a (rotated to position of b) and b (occupying that position
         * upright) — if their pattern labels disagree, the fixed screen
         * point flipped membership when the rotation changed. */
        const aLabel = isCentre(a) ? 'centre' : isOnPattern(a) ? 'on' : 'off';
        const bLabel = isCentre(b) ? 'centre' : isOnPattern(b) ? 'on' : 'off';
        if (aLabel !== bLabel) {
          foundFlip = true;
        }
      }
    }
    expect(foundFlip).toBe(true);
  });
});
