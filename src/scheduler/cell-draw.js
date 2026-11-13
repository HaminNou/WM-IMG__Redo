/**
 * Cell draws of the main-task generator: STATELESS and independent.
 *
 * Which grid cell carries an encoded dot / tone, a foil probe, a star or a dummy is drawn
 * independently for every trial, uniformly (or, for tones, from a FIXED weighted distribution)
 * over the cells that are eligible given the item's on/off label and the hard exclusions. No
 * count of "how often was this cell used so far" is carried from one trial to the next, so
 * nothing about the cell history of a session predicts whether a probed cell is a target or a
 * foil (a leak that exact per-pool cell-usage balancing and greedy least-used picking create:
 * a cell probed but never encoded would be a target with p = 1, a cell already encoded twice
 * would be a target with p = 0).
 *
 * Hard exclusions (as in the legacy per-condition generators):
 *   - the three encoded cells of a trial are distinct; a foil is never an encoded cell and the
 *     foils of a trial are distinct;
 *   - stars and dummies avoid every encoded cell and every foil cell of the trial;
 *   - tones (T_only, I+T): the three encoded tones are >= MIN_TONE_GAP_RANKS ranks apart and
 *     every foil tone is >= MIN_TONE_GAP_RANKS ranks from every encoded tone.
 *
 * Dots (D_only, I+D) have no spacing rule: the encoded cells of a label are a uniformly random
 * subset of that label's 12 cells, and a foil is uniform among the label's remaining cells.
 *
 * TONES. Drawing an encoded set uniformly over the spacing-feasible sets over-uses the edge
 * ranks (about 25 % more than the middle: an edge rank has fewer neighbours to clash with, so it
 * lies in more feasible sets). Instead, for every number of on-pattern items (0..3) the set is
 * drawn from a fixed weighted distribution whose marginal inclusion probability of every cell is
 * exactly uniform (iterative proportional fitting, below). The foils are drawn given the
 * encoded set from a fixed weighted distribution (weights per cell) fitted in the same way so
 * that the foil-cell marginal is uniform as well (uniform weights would favour the edge ranks by
 * about 1.5x). Both are therefore equal in expectation for every cell; neither depends on
 * anything but the trial's own labels. The fit uses only + - * / and sqrt (exactly rounded in
 * IEEE-754), no rng, no Math.pow / exp / log, so the weights are bit-identical on every
 * engine and a seed gives the same plan everywhere. The fit is computed lazily, once per
 * process, and cached.
 */
import { onPatternCells, offPatternCells, nonCentreCells } from '../grid.js';
import { toneForCell } from '../audio/tones.js';
import { MIN_TONE_GAP_RANKS } from './tone-spacing.js';

const ON = onPatternCells();
const OFF = offPatternCells();
const NON_CENTRE = nonCentreCells();
const RANK = new Map(NON_CENTRE.map((c) => [c, toneForCell(c).rank]));
const gapOk2 = (a, b) => Math.abs(RANK.get(a) - RANK.get(b)) >= MIN_TONE_GAP_RANKS;

function combos(arr, k) {
  const out = [];
  const rec = (s, p) => {
    if (p.length === k) {
      out.push(p.slice());
      return;
    }
    for (let i = s; i < arr.length; i++) {
      p.push(arr[i]);
      rec(i + 1, p);
      p.pop();
    }
  };
  rec(0, []);
  return out;
}
const gapOk = (cells) => {
  for (let i = 0; i < cells.length; i++)
    for (let j = i + 1; j < cells.length; j++) if (!gapOk2(cells[i], cells[j])) return false;
  return true;
};

/* A uniform draw in [0, 1) from the integer interface every seeded PRNG of the project has. */
const unit = (rng) => rng.int(1073741824) / 1073741824;
function pickCum(rng, cum) {
  const u = unit(rng) * cum[cum.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > u) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
const cumulative = (w) => {
  let s = 0;
  return w.map((x) => (s += x));
};

/* ------------------------------ tones: fitted weights ------------------------------ */
/* Number of foils of one label in a trial is 0..2 (a trial has 0..3 foils, no probe type more than twice). */
const MAX_FOILS_PER_LABEL = 2;
const FIT_TOLERANCE = 1e-10;
const FIT_MAX_ITERATIONS = 3000;

const toneModels = new Map();
/**
 * Everything fixed about the tone draw for trials with `onC` on-pattern items: the spacing-feasible
 * encoded sets (each leaving >= 2 admissible foil cells of each label, so any foil schedule of a
 * trial is feasible), their fitted weights, and per-set admissible foil cells.
 */
function toneModel(onC) {
  if (toneModels.has(onC)) return toneModels.get(onC);
  const sets = [];
  for (const a of combos(ON, onC))
    for (const b of combos(OFF, 3 - onC)) {
      const enc = [...a, ...b];
      if (!gapOk(enc)) continue;
      const allowed = (pool) =>
        pool.filter((c) => !enc.includes(c) && enc.every((e) => gapOk2(c, e)));
      const allowedOn = allowed(ON);
      const allowedOff = allowed(OFF);
      if (allowedOn.length < MAX_FOILS_PER_LABEL || allowedOff.length < MAX_FOILS_PER_LABEL)
        continue;
      sets.push({ on: a, off: b, enc, allowedOn, allowedOff });
    }
  if (!sets.length) throw new Error(`tone model: no feasible encoded set for ${onC} on items`);
  /* encoded sets: exact I-projection onto "P(cell in set) = share of its label" for every cell */
  const w = sets.map(() => 1);
  const target = (c) => (ON.includes(c) ? onC : 3 - onC) / 12;
  for (let it = 0; it < FIT_MAX_ITERATIONS; it++) {
    let worst = 0;
    for (const c of [...ON, ...OFF]) {
      const t = target(c);
      if (t === 0) continue;
      let tot = 0;
      let inn = 0;
      sets.forEach((s, i) => {
        tot += w[i];
        if (s.enc.includes(c)) inn += w[i];
      });
      worst = Math.max(worst, Math.abs(inn / tot - t) / t);
      const f = (t * (tot - inn)) / ((1 - t) * inn);
      sets.forEach((s, i) => {
        if (s.enc.includes(c)) w[i] *= f;
      });
    }
    if (worst < FIT_TOLERANCE) break;
  }
  const model = { sets, setWeights: w, setCum: cumulative(w), foil: new Map() };
  toneModels.set(onC, model);
  return model;
}

/* Foil weights for `k` foils of one label given the on-count class: a foil subset F of the admissible
 * cells has probability proportional to the product of its cells' weights; the weights are fitted
 * so that, over the fitted distribution of encoded sets, P(cell is a foil) = k / 12 for every cell. */
function foilModel(onC, label, k) {
  const model = toneModel(onC);
  const key = `${label}|${k}`;
  if (model.foil.has(key)) return model.foil.get(key);
  const pool = label === 'on' ? ON : OFF;
  const total = model.setWeights.reduce((a, b) => a + b, 0);
  const p = model.setWeights.map((x) => x / total);
  const subs = model.sets.map((s) => combos(label === 'on' ? s.allowedOn : s.allowedOff, k));
  const w = new Map(pool.map((c) => [c, 1]));
  const t = k / 12;
  for (let it = 0; it < FIT_MAX_ITERATIONS; it++) {
    const m = new Map(pool.map((c) => [c, 0]));
    model.sets.forEach((_, i) => {
      const ws = subs[i].map((f) => f.reduce((q, c) => q * w.get(c), 1));
      const sum = ws.reduce((a, b) => a + b, 0);
      subs[i].forEach((f, j) => f.forEach((c) => m.set(c, m.get(c) + (p[i] * ws[j]) / sum)));
    });
    let worst = 0;
    for (const c of pool) worst = Math.max(worst, Math.abs(m.get(c) - t) / t);
    if (worst < FIT_TOLERANCE) break;
    for (const c of pool) w.set(c, w.get(c) * Math.sqrt(t / m.get(c)));
  }
  const fm = { weights: w };
  model.foil.set(key, fm);
  return fm;
}

/* ------------------------------ public draws ------------------------------ */

/**
 * Encoded cells of a trial: `onC` on-pattern cells and `3 - onC` off-pattern cells.
 * @returns {{on: number[], off: number[]}}  (unordered; the caller assigns them to items)
 */
export function drawEncodedCells(rng, tone, onC) {
  if (!tone)
    return {
      on: rng.shuffle(ON.slice()).slice(0, onC),
      off: rng.shuffle(OFF.slice()).slice(0, 3 - onC),
    };
  const m = toneModel(onC);
  const s = m.sets[pickCum(rng, m.setCum)];
  return { on: s.on.slice(), off: s.off.slice() };
}

/**
 * Foil cells of a trial given its encoded cells (never an encoded cell; for tones also >= 3 ranks from
 * every encoded tone; distinct).
 * @param {number} onC  number of on-pattern encoded cells (selects the fitted tone weights)
 * @returns {{on: number[], off: number[]}}
 */
export function drawFoilCells(rng, tone, enc, onC, kOn, kOff) {
  const encAll = [...enc.on, ...enc.off];
  if (!tone) {
    return {
      on: rng.shuffle(ON.filter((c) => !encAll.includes(c))).slice(0, kOn),
      off: rng.shuffle(OFF.filter((c) => !encAll.includes(c))).slice(0, kOff),
    };
  }
  const admissible = (pool) =>
    pool.filter((c) => !encAll.includes(c) && encAll.every((e) => gapOk2(c, e)));
  const one = (pool, label, k) => {
    if (k === 0) return [];
    const allowed = admissible(pool);
    if (allowed.length < k) throw new Error('drawFoilCells: no admissible foil cell');
    const fm = foilModel(onC, label, k);
    const subs = combos(allowed, k);
    const ws = subs.map((f) => f.reduce((q, c) => q * fm.weights.get(c), 1));
    return subs[pickCum(rng, cumulative(ws))];
  };
  return { on: rng.shuffle(one(ON, 'on', kOn)), off: rng.shuffle(one(OFF, 'off', kOff)) };
}

/** Star cells: uniform among the label's cells outside `used`. */
export function drawStarCells(rng, used, nOn, nOff) {
  return {
    on: rng.shuffle(ON.filter((c) => !used.has(c))).slice(0, nOn),
    off: rng.shuffle(OFF.filter((c) => !used.has(c))).slice(0, nOff),
  };
}

/** Dummy cells: uniform among the non-centre cells outside `used`. */
export function drawDummyCells(rng, used, n) {
  return rng.shuffle(NON_CENTRE.filter((c) => !used.has(c))).slice(0, n);
}

/**
 * Expected cell marginals of the tone draw, by exact computation (no sampling): for `onC` on-pattern
 * items, P(cell is in the encoded set) and, for each foil count k, P(cell is a foil of that label).
 * Used by the tests and the audit script to report the achieved uniformity.
 * @returns {{encoded: Map<number, number>, foilOn: Map<number, Map<number,number>>, foilOff: Map<number, Map<number,number>>}}
 */
export function toneMarginals(onC) {
  const m = toneModel(onC);
  const total = m.setWeights.reduce((a, b) => a + b, 0);
  const encoded = new Map([...ON, ...OFF].map((c) => [c, 0]));
  m.sets.forEach((s, i) =>
    s.enc.forEach((c) => encoded.set(c, encoded.get(c) + m.setWeights[i] / total))
  );
  const foil = (label) => {
    const out = new Map();
    for (const k of [1, 2]) {
      const fm = foilModel(onC, label, k);
      const pool = label === 'on' ? ON : OFF;
      const marg = new Map(pool.map((c) => [c, 0]));
      m.sets.forEach((s, i) => {
        const subs = combos(label === 'on' ? s.allowedOn : s.allowedOff, k);
        const ws = subs.map((f) => f.reduce((q, c) => q * fm.weights.get(c), 1));
        const sum = ws.reduce((a, b) => a + b, 0);
        subs.forEach((f, j) =>
          f.forEach((c) => marg.set(c, marg.get(c) + (m.setWeights[i] / total) * (ws[j] / sum)))
        );
      });
      out.set(k, marg);
    }
    return out;
  };
  return { encoded, foilOn: foil('on'), foilOff: foil('off') };
}
