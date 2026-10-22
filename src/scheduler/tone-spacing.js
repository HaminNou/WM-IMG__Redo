/**
 * Within-trial tone-spacing constraint.
 *
 * Rule: for every pair of encoded tones in
 * the same T-only or I+T trial, the two tone ranks must differ by at least
 * `MIN_TONE_GAP_RANKS = 3`. Concretely: if a trial uses tone rank 4, ranks
 * 5 and 6 are forbidden in that same trial, and the next allowed rank is 7.
 *
 * Why a pre-computed enumeration rather than rejection-sample-on-the-fly?
 *   - Determinism: the set of valid count-matched on/off combinations is small
 *     (~hundreds) and finite. Pre-computing once lets `pickValidEncodingSet`
 *     resolve in O(1) lookups with no failure mode.
 *   - Audit trail: tests can enumerate and assert exact counts, catching
 *     accidental drift if anyone changes the gap constant or the cell↔tone
 *     bijection.
 *
 * Scope:
 *   - Applied to ENCODED memory items: pairwise rank-distance ≥ 3 across
 *     the 3 encoded tones in t_only / i_t trials (`enumerateValidEncodingSets`).
 *   - Applied to PROBE FOILS: every foil in a t_only / i_t trial must be
 *     ≥ 3 ranks from every encoded tone (`filterAllowedFoilCells`). Targets
 *     are themselves drawn from the encoded set so they need no extra check.
 *   - Conditions affected: t_only, i_t. d_only / i_d / i_only have no
 *     encoded tones and run unmodified.
 *
 * Why constrain foils too: an encoded tone of rank 6 placed against a foil
 * of rank 5 (distance 1) is below the chromatic resolution most non-musician
 * participants discriminate confidently — confusability there is a measurement
 * artefact, not signal. The same ≥ 3 gap that keeps the encoded set
 * discriminable keeps target-vs-foil discrimination above chance for
 * baseline pitch acuity.
 */
import { onPatternCells, offPatternCells } from '../grid.js';
import { toneForCell } from '../audio/tones.js';

export const MIN_TONE_GAP_RANKS = 3;

/**
 * Tone-rank distance between two cells. Cells map to tones via the
 * deterministic bijection in `audio/tones.js`. Rank == bank-index + 1
 * so the absolute difference of either is identical; we use `.rank` here to
 * keep the spec-language ("rank") visible in the code.
 */
export function rankDistance(cellA, cellB) {
  return Math.abs(toneForCell(cellA).rank - toneForCell(cellB).rank);
}

/**
 * Predicate: do all C(n,2) pairs in `cells` satisfy rank-distance ≥ minGap?
 */
export function setRespectsToneSpacing(cells, minGap = MIN_TONE_GAP_RANKS) {
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      if (rankDistance(cells[i], cells[j]) < minGap) return false;
    }
  }
  return true;
}

const CACHED_VALID_SETS = new Map();

function combinations(items, chooseCount, start = 0, prefix = [], out = []) {
  if (prefix.length === chooseCount) {
    out.push(prefix.slice());
    return out;
  }
  for (let i = start; i <= items.length - (chooseCount - prefix.length); i++) {
    prefix.push(items[i]);
    combinations(items, chooseCount, i + 1, prefix, out);
    prefix.pop();
  }
  return out;
}

function cacheKey(onCount, offCount, minGap) {
  return `${onCount}|${offCount}|${minGap}`;
}

function allowedFoilCells(candidates, encodedCells, minGap = MIN_TONE_GAP_RANKS) {
  const encodedRanks = encodedCells.map((c) => toneForCell(c).rank);
  return candidates.filter((cell) => {
    const r = toneForCell(cell).rank;
    for (const er of encodedRanks) {
      if (Math.abs(r - er) < minGap) return false;
    }
    return true;
  });
}

/**
 * Enumerate every (on-count, off-count) cell selection that respects the
 * tone-spacing rule across all encoded tones. Memoised per count/gap tuple.
 *
 * Returned objects are deeply frozen; do not mutate.
 *
 * @param {object|number} [opts]
 * @param {number} [opts.onCount]
 * @param {number} [opts.offCount]
 * @param {number} [opts.minGap]
 * @returns {ReadonlyArray<{onCells: ReadonlyArray<number>, offCells: ReadonlyArray<number>}>}
 */
export function enumerateValidEncodingSets(opts = {}) {
  const resolved = typeof opts === 'number' ? { minGap: opts } : (opts ?? {});
  const onCount = resolved.onCount ?? 2;
  const offCount = resolved.offCount ?? 2;
  const minGap = resolved.minGap ?? MIN_TONE_GAP_RANKS;
  const key = cacheKey(onCount, offCount, minGap);
  if (CACHED_VALID_SETS.has(key)) return CACHED_VALID_SETS.get(key);

  const onCells = onPatternCells();
  const offCells = offPatternCells();
  const valid = [];
  const onCombos = combinations(onCells, onCount).filter((cells) =>
    setRespectsToneSpacing(cells, minGap)
  );
  const offCombos = combinations(offCells, offCount).filter((cells) =>
    setRespectsToneSpacing(cells, minGap)
  );
  for (const chosenOn of onCombos) {
    for (const chosenOff of offCombos) {
      if (!setRespectsToneSpacing([...chosenOn, ...chosenOff], minGap)) continue;
      valid.push(
        Object.freeze({
          onCells: Object.freeze(chosenOn.slice()),
          offCells: Object.freeze(chosenOff.slice()),
        })
      );
    }
  }

  if (valid.length === 0) {
    throw new Error(
      `enumerateValidEncodingSets: no valid ${onCount}+${offCount} cell selections satisfy minGap=${minGap}; ` +
        `cell↔tone mapping or pattern definition may be broken.`
    );
  }

  const frozen = Object.freeze(valid);
  CACHED_VALID_SETS.set(key, frozen);
  return frozen;
}

/**
 * Pick a random valid encoding set using the supplied PRNG.
 * The PRNG must expose `.pick(array)` (matches `getSessionPRNG()` contract).
 */
export function pickValidEncodingSet(rng, opts = {}) {
  return rng.pick(enumerateValidEncodingSets(opts));
}

/**
 * Pick a valid encoding set that also leaves enough allowed foil cells of
 * each pattern label for the current trial's probe schedule.
 */
export function pickFeasibleEncodingSet(
  rng,
  { onCount = 2, offCount = 2, minFoilOn = 0, minFoilOff = 0, minGap = MIN_TONE_GAP_RANKS } = {}
) {
  const feasible = enumerateValidEncodingSets({ onCount, offCount, minGap }).filter((set) => {
    const encodedCells = [...set.onCells, ...set.offCells];
    const onCandidates = onPatternCells().filter((cell) => !set.onCells.includes(cell));
    const offCandidates = offPatternCells().filter((cell) => !set.offCells.includes(cell));
    return (
      allowedFoilCells(onCandidates, encodedCells, minGap).length >= minFoilOn &&
      allowedFoilCells(offCandidates, encodedCells, minGap).length >= minFoilOff
    );
  });

  if (!feasible.length) {
    throw new Error(
      `pickFeasibleEncodingSet: no valid ${onCount}+${offCount} set leaves enough foil cells ` +
        `(need on=${minFoilOn}, off=${minFoilOff}, minGap=${minGap}).`
    );
  }

  return rng.pick(feasible);
}

/**
 * Filter a foil candidate pool to only cells whose tone-rank is ≥ minGap
 * from every encoded tone in `encodedCells`. Used by the t_only and i_t
 * generators to keep probe foils perceptually distinguishable from the
 * encoded set.
 *
 * Throws if the resulting pool is empty — that should be impossible when
 * the encoded set itself respects the spacing rule (theoretical worst-case
 * coverage leaves several allowed candidates per label), so an empty pool
 * indicates a rule mis-application or a regression in cell↔tone bijection
 * and we want to fail loudly rather than silently fall back.
 *
 * @param {ReadonlyArray<number>} candidates       cell indices to filter
 * @param {ReadonlyArray<number>} encodedCells     cells of the trial's encoded tones
 * @param {number}                [minGap]         minimum rank-distance allowed
 * @returns {Array<number>}                        cells whose tone is ≥ minGap from every encoded tone
 */
export function filterAllowedFoilCells(candidates, encodedCells, minGap = MIN_TONE_GAP_RANKS) {
  const allowed = allowedFoilCells(candidates, encodedCells, minGap);
  if (allowed.length === 0) {
    const encodedRanks = encodedCells.map((c) => toneForCell(c).rank);
    throw new Error(
      `filterAllowedFoilCells: no candidates remain after filtering against encoded ranks ` +
        `[${encodedRanks.join(', ')}] at minGap=${minGap}. ` +
        `Encoded set probably violates the pairwise spacing rule upstream.`
    );
  }
  return allowed;
}

/**
 * Test-only: clear the memoised enumeration so a different `minGap` can be
 * exercised in the same test process.
 */
export function _resetToneSpacingCache() {
  CACHED_VALID_SETS.clear();
}
