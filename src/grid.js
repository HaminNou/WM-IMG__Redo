/**
 * Grid math — pure, DOM-free.
 *
 * The 5×5 grid is row-major, cell index 0..24, centre cell 12 reserved for
 * fixation / question mark and never used as a stimulus location. Two derived
 * subsets drive the experiment's design:
 *
 *   onPatternCells  = grayPattern \ {12}              → 12 cells
 *   offPatternCells = (all 24 non-centre) \ onPattern → 12 cells
 *
 * Every consumer (audio bank, visuals, schedulers) imports from here so the
 * pattern definition exists in exactly one place. Mutating the exported
 * arrays is impossible — they're frozen at module load.
 */
import { config } from './config.js';

const { cells_per_side, centre_cell_index } = config.grid;
const TOTAL_CELLS = cells_per_side * cells_per_side;

const GRAY_PATTERN = config.pattern.gray_pattern_cells;

/* Built once at module load — assumed never to change at runtime. */
const NON_CENTRE_CELLS = Object.freeze(
  Array.from({ length: TOTAL_CELLS }, (_, i) => i).filter((i) => i !== centre_cell_index)
);

const ON_PATTERN_CELLS = Object.freeze(
  GRAY_PATTERN.filter((i) => i !== centre_cell_index)
    .slice()
    .sort((a, b) => a - b)
);

const OFF_PATTERN_CELLS = Object.freeze(
  NON_CENTRE_CELLS.filter((i) => !ON_PATTERN_CELLS.includes(i))
);

const ON_SET = new Set(ON_PATTERN_CELLS);
const OFF_SET = new Set(OFF_PATTERN_CELLS);

/* Run the pattern integrity check at module load. If we ever introduce a
 * config typo that breaks the 12/12 invariant, the experiment will refuse to
 * start with a loud, specific error rather than silently scheduling a broken
 * counterbalance. */
assertPatternIntegrity();

export function totalCells() {
  return TOTAL_CELLS;
}

export function nonCentreCells() {
  return NON_CENTRE_CELLS;
}

export function onPatternCells() {
  return ON_PATTERN_CELLS;
}

export function offPatternCells() {
  return OFF_PATTERN_CELLS;
}

export function isOnPattern(cellIndex) {
  return ON_SET.has(cellIndex);
}

export function isOffPattern(cellIndex) {
  return OFF_SET.has(cellIndex);
}

export function isCentre(cellIndex) {
  return cellIndex === centre_cell_index;
}

export function patternLabel(cellIndex) {
  if (isOnPattern(cellIndex)) return 'on';
  if (isOffPattern(cellIndex)) return 'off';
  if (isCentre(cellIndex)) return 'centre';
  throw new Error(`patternLabel: cell ${cellIndex} is out of range 0..${TOTAL_CELLS - 1}`);
}

export function cellRowCol(cellIndex) {
  if (cellIndex < 0 || cellIndex >= TOTAL_CELLS) {
    throw new Error(`cellRowCol: cell ${cellIndex} out of range`);
  }
  return {
    row: Math.floor(cellIndex / cells_per_side),
    col: cellIndex % cells_per_side,
  };
}

export function rowColToCell(row, col) {
  if (row < 0 || row >= cells_per_side || col < 0 || col >= cells_per_side) {
    throw new Error(`rowColToCell: (${row}, ${col}) out of range`);
  }
  return row * cells_per_side + col;
}

/**
 * Centre coordinates of a cell, in *millimetres* relative to the top-left of
 * the grid. The visual layer multiplies these by CSS `--mm` to land the SVG
 * element at the correct physical size on the participant's calibrated
 * screen.
 */
export function cellCentreMm(cellIndex) {
  const { row, col } = cellRowCol(cellIndex);
  const half = config.grid.cell_size_mm / 2;
  return {
    x_mm: col * config.grid.cell_size_mm + half,
    y_mm: row * config.grid.cell_size_mm + half,
  };
}

export function cellTopLeftMm(cellIndex) {
  const { row, col } = cellRowCol(cellIndex);
  return {
    x_mm: col * config.grid.cell_size_mm,
    y_mm: row * config.grid.cell_size_mm,
  };
}

export function gridSizeMm() {
  return cells_per_side * config.grid.cell_size_mm;
}

/**
 * Centre coordinates of a cell after the grid has been rotated by
 * `rotationDeg` around its midpoint. Used for stimulus primitives (dots,
 * stars, dummies) that must appear at the rotated cell location while
 * staying upright themselves — they live in a sibling SVG group OUTSIDE
 * the rotor, so they do not inherit the rotor's rotation transform but
 * still need to land on the right pixel.
 *
 * SVG `rotate(angle cx cy)` is clockwise for positive `angle` in the
 * Y-down SVG coordinate system, which the rotation matrix below mirrors.
 */
export function rotatedCellCentreMm(cellIndex, rotationDeg) {
  const { x_mm, y_mm } = cellCentreMm(cellIndex);
  if (!rotationDeg) return { x_mm, y_mm };
  const mid = gridSizeMm() / 2;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = x_mm - mid;
  const dy = y_mm - mid;
  return {
    x_mm: mid + dx * cos - dy * sin,
    y_mm: mid + dx * sin + dy * cos,
  };
}

/**
 * Fixed geometry of one cell, in the grid frame (origin at the grid centre,
 * x to the right, y down, millimetres). `x_mm` / `y_mm` are the centre of the
 * cell in the UPRIGHT grid; use `rotatedCellCentreMm` for the position on the
 * screen once the grid has been rotated. `radius_mm` is the distance of the
 * cell centre from the fixation point and does not change with rotation.
 */
export function cellGeometry(cellIndex) {
  const { row, col } = cellRowCol(cellIndex);
  const { x_mm, y_mm } = cellCentreMm(cellIndex);
  const mid = gridSizeMm() / 2;
  const cx = x_mm - mid;
  const cy = y_mm - mid;
  const radius_mm = Math.hypot(cx, cy);
  return {
    cell: cellIndex,
    row,
    col,
    x_mm: cx,
    y_mm: cy,
    radius_mm,
    radius_cells: radius_mm / config.grid.cell_size_mm,
    pattern_label: patternLabel(cellIndex),
  };
}

/**
 * Screen position of a cell centre in the fixed grid frame (origin at the
 * grid centre, x right, y down, mm) after the grid has been rotated by
 * `rotationDeg` (clockwise positive, same sign convention as the SVG rotor).
 */
export function screenPositionMm(cellIndex, rotationDeg = 0) {
  const mid = gridSizeMm() / 2;
  const p = rotatedCellCentreMm(cellIndex, rotationDeg);
  return { x_mm: p.x_mm - mid, y_mm: p.y_mm - mid };
}

/**
 * Runtime invariant. Throws if any of the expected counts is wrong.
 * Called once at module load and re-callable from tests.
 */
export function assertPatternIntegrity() {
  if (NON_CENTRE_CELLS.length !== 24) {
    throw new Error(
      `Pattern integrity: expected 24 non-centre cells, got ${NON_CENTRE_CELLS.length}`
    );
  }
  if (ON_PATTERN_CELLS.length !== 12) {
    throw new Error(
      `Pattern integrity: expected 12 on-pattern cells, got ${ON_PATTERN_CELLS.length}`
    );
  }
  if (OFF_PATTERN_CELLS.length !== 12) {
    throw new Error(
      `Pattern integrity: expected 12 off-pattern cells, got ${OFF_PATTERN_CELLS.length}`
    );
  }
  if (ON_SET.has(centre_cell_index) || OFF_SET.has(centre_cell_index)) {
    throw new Error(
      `Pattern integrity: centre cell ${centre_cell_index} leaked into a stimulus pool`
    );
  }
  for (const c of ON_PATTERN_CELLS) {
    if (OFF_SET.has(c)) {
      throw new Error(`Pattern integrity: cell ${c} is in BOTH on- and off-pattern pools`);
    }
  }
}
