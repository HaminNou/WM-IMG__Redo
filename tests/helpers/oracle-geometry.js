/**
 * Pure helpers for the independent condition oracle (tests/oracle-conditions
 * .test.js). Nothing here imports program code: expected values must come from
 * the page and from hand-written constants, never from the modules under test
 * (src/grid.js, src/audio/tones.js, ...), or a bug in those modules would be
 * "expected" by the test too.
 */

/* The 13-cell imagery pattern's on-pattern cells, written out by hand
 * (cells 0..24, row-major from the top left; the centre cell, 12, is never a
 * stimulus cell). */
export const ON_CELLS = new Set([1, 2, 3, 7, 10, 11, 13, 14, 17, 21, 22, 23]);
export const OFF_CELLS = Array.from({ length: 25 }, (_, i) => i).filter(
  (i) => i !== 12 && !ON_CELLS.has(i)
);
export const BANK_ON_CELLS = [...ON_CELLS].sort((a, b) => a - b);

/* Grid geometry in mm: 5 x 5 cells of 10 mm, grid centre at (25, 25). */
export const MID = 25;
export const CELL = 10;
export const STAR_R = 2.5;

/* The 24-tone bank, 200..3900 Hz in equal log steps. */
export const FREQS = Array.from({ length: 24 }, (_, i) => 200 * Math.pow(3900 / 200, i / 23));

/* The two response colours, written out by hand: correct is green, wrong red. */
export const GREEN = '#0BC926';
export const RED = '#FF1818';

/** Small deterministic generator for the simulated participant. */
export function lcg(seed) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Rotation (deg) of the grid rotor, read from the page. */
export function rotorAngle(svg) {
  const m = /rotate\(\s*(-?[\d.eE+-]+)/.exec(
    svg.querySelector('.grid-rotor').getAttribute('transform')
  );
  return Number(m[1]);
}

/** The cell a screen position (mm) belongs to once the rotor angle is undone. */
export function cellFromScreen(x, y, angle) {
  const t = (-angle * Math.PI) / 180;
  const dx = x - MID;
  const dy = y - MID;
  const ux = dx * Math.cos(t) - dy * Math.sin(t) + MID;
  const uy = dx * Math.sin(t) + dy * Math.cos(t) + MID;
  const col = Math.floor(ux / CELL);
  const row = Math.floor(uy / CELL);
  const cx = col * CELL + CELL / 2;
  const cy = row * CELL + CELL / 2;
  if (Math.hypot(ux - cx, uy - cy) > 1e-6 || col < 0 || col > 4 || row < 0 || row > 4) return null;
  return row * 5 + col;
}

/** Screen position, rotor angle, cell and fill of one drawn stimulus element. */
export function stimInfo(el) {
  const svg = el.closest('svg');
  const angle = rotorAngle(svg);
  let x;
  let y;
  const tag = el.tagName.toLowerCase();
  if (tag === 'circle') {
    x = Number(el.getAttribute('cx'));
    y = Number(el.getAttribute('cy'));
  } else if (tag === 'polygon') {
    const [vx, vy] = el.getAttribute('points').split(' ')[0].split(',').map(Number);
    x = vx;
    y = vy + STAR_R;
  } else {
    x = Number(el.getAttribute('x')) + Number(el.getAttribute('width')) / 2;
    y = Number(el.getAttribute('y')) + Number(el.getAttribute('height')) / 2;
  }
  return { tag, x, y, angle, cell: cellFromScreen(x, y, angle), fill: el.getAttribute('fill') };
}

/**
 * The one grid angle a trial uses from encoding to the end of the probes: the
 * imagery angle (`rotation_deg`) of an imagery-bearing trial, the display
 * angle (`display_rotation_deg`) of a memory-only trial, 0 where a condition
 * has no rotation (tone-only). Reading whichever field the scheduler set keeps
 * the oracle independent of how a condition names its angle.
 */
export function trialAngle(cond, params) {
  if (cond === 't_only') return 0;
  const a = params.rotation_deg ?? params.display_rotation_deg;
  return typeof a === 'number' ? a : 0;
}

/** Index of the 30-degree band an angle falls in (coverage statistic only). */
export function band(a) {
  return Math.min(5, Math.max(0, Math.floor((a + 90 - (a < 0 ? 0 : 1)) / 30)));
}
