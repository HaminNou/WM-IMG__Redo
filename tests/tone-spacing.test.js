/**
 * Tests for src/scheduler/tone-spacing.js — within-trial tone-spacing rule.
 *
 * Locked invariants under test:
 *   1. `setRespectsToneSpacing` is a correct pairwise predicate.
 *   2. Every pre-enumerated valid encoding set matches the requested on/off
 *      counts and has tones pairwise ≥ MIN_TONE_GAP_RANKS apart.
 *   3. The enumeration is non-empty (catches regressions where a typo in the
 *      cell↔tone mapping nukes feasibility).
 *   4. `pickValidEncodingSet` is deterministic given a seeded PRNG (so the
 *      session schedule remains reproducible).
 *   5. Integration: every t_only and i_t trial generated at blockSize=24
 *      respects the spacing rule. d_only and i_d are unaffected (and not
 *      asserted to satisfy the rule since their items are dots, not tones).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MIN_TONE_GAP_RANKS,
  rankDistance,
  setRespectsToneSpacing,
  enumerateValidEncodingSets,
  pickValidEncodingSet,
  pickFeasibleEncodingSet,
  filterAllowedFoilCells,
  _resetToneSpacingCache,
} from '../src/scheduler/tone-spacing.js';
import { getToneBank, toneForCell } from '../src/audio/tones.js';
import { onPatternCells, offPatternCells } from '../src/grid.js';
import { createPRNG } from '../src/prng.js';
import { generateMemoryBlock } from '../src/scheduler/memory-block.js';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';

beforeEach(() => {
  _resetToneSpacingCache();
  resetSequencePools();
});

describe('rankDistance / setRespectsToneSpacing', () => {
  it('rankDistance is symmetric and 0 for identical cells', () => {
    const c0 = onPatternCells()[0];
    const c1 = offPatternCells()[0];
    expect(rankDistance(c0, c0)).toBe(0);
    expect(rankDistance(c0, c1)).toBe(rankDistance(c1, c0));
  });

  it('setRespectsToneSpacing returns true for an empty or singleton set', () => {
    expect(setRespectsToneSpacing([])).toBe(true);
    expect(setRespectsToneSpacing([onPatternCells()[0]])).toBe(true);
  });

  it('setRespectsToneSpacing rejects a pair below the minimum gap', () => {
    /* Find any two cells whose tone-rank distance is exactly 1. They exist:
     * adjacent ranks alternate on/off, so rank 1 (on) and rank 2 (off)
     * are 1-apart and on opposite labels, so cells exist on both sides. */
    const onCells = onPatternCells();
    const offCells = offPatternCells();
    const closePair = (() => {
      for (const a of onCells)
        for (const b of offCells) if (rankDistance(a, b) === 1) return [a, b];
      throw new Error('test setup: expected at least one rank-1 cell pair');
    })();
    expect(setRespectsToneSpacing(closePair)).toBe(false);
  });

  it('setRespectsToneSpacing accepts a wide-spread quadruple', () => {
    /* Pick cells whose tones are at ranks 1, 7, 13, 19 — pairwise ≥ 6. */
    const targets = [1, 7, 13, 19];
    const cells = targets.map((wantRank) => {
      for (const c of [...onPatternCells(), ...offPatternCells()]) {
        if (toneForCell(c).rank === wantRank) return c;
      }
      throw new Error(`test setup: no cell for rank ${wantRank}`);
    });
    expect(setRespectsToneSpacing(cells)).toBe(true);
  });
});

describe('enumerateValidEncodingSets', () => {
  it('produces a non-empty list (cell↔tone bijection is feasible at gap=3)', () => {
    const sets = enumerateValidEncodingSets();
    expect(sets.length).toBeGreaterThan(0);
  });

  it('supports the 1+3, 2+2, and 3+1 label-count families used by the schedulers', () => {
    expect(enumerateValidEncodingSets({ onCount: 1, offCount: 3 }).length).toBeGreaterThan(0);
    expect(enumerateValidEncodingSets({ onCount: 2, offCount: 2 }).length).toBeGreaterThan(0);
    expect(enumerateValidEncodingSets({ onCount: 3, offCount: 1 }).length).toBeGreaterThan(0);
  });

  it('every enumerated 2+2 set has exactly 2 on-cells and 2 off-cells, all distinct', () => {
    for (const set of enumerateValidEncodingSets()) {
      expect(set.onCells).toHaveLength(2);
      expect(set.offCells).toHaveLength(2);
      const all = [...set.onCells, ...set.offCells];
      expect(new Set(all).size).toBe(4);
      const onSet = new Set(onPatternCells());
      const offSet = new Set(offPatternCells());
      expect(set.onCells.every((c) => onSet.has(c))).toBe(true);
      expect(set.offCells.every((c) => offSet.has(c))).toBe(true);
    }
  });

  it('every enumerated set respects the pairwise ≥ MIN_TONE_GAP_RANKS rule', () => {
    for (const set of enumerateValidEncodingSets({ onCount: 3, offCount: 1 })) {
      const all = [...set.onCells, ...set.offCells];
      expect(setRespectsToneSpacing(all, MIN_TONE_GAP_RANKS)).toBe(true);
    }
  });

  it('returned sets are deeply frozen (calling code cannot mutate)', () => {
    const sets = enumerateValidEncodingSets();
    expect(Object.isFrozen(sets)).toBe(true);
    expect(Object.isFrozen(sets[0])).toBe(true);
    expect(Object.isFrozen(sets[0].onCells)).toBe(true);
    expect(Object.isFrozen(sets[0].offCells)).toBe(true);
  });

  it('memoises across calls (same array reference)', () => {
    const a = enumerateValidEncodingSets();
    const b = enumerateValidEncodingSets();
    expect(a).toBe(b);
  });

  it('respects a stricter minGap (gap=5 strictly subsets gap=3)', () => {
    _resetToneSpacingCache();
    const lax = enumerateValidEncodingSets({ minGap: 3 });
    _resetToneSpacingCache();
    const strict = enumerateValidEncodingSets({ minGap: 5 });
    expect(strict.length).toBeLessThan(lax.length);
    for (const set of strict) {
      expect(setRespectsToneSpacing([...set.onCells, ...set.offCells], 5)).toBe(true);
    }
  });
});

describe('pickValidEncodingSet – determinism', () => {
  it('returns the same sequence of picks under the same seed', () => {
    const rngA = createPRNG('tone-spacing-seed-1');
    const rngB = createPRNG('tone-spacing-seed-1');
    const picksA = Array.from({ length: 10 }, () =>
      pickValidEncodingSet(rngA, { onCount: 3, offCount: 1 })
    );
    const picksB = Array.from({ length: 10 }, () =>
      pickValidEncodingSet(rngB, { onCount: 3, offCount: 1 })
    );
    expect(picksA).toEqual(picksB);
  });
});

describe('pickFeasibleEncodingSet – foil-aware selection', () => {
  it('returns a set that leaves enough foil cells for the requested probe counts', () => {
    const rng = createPRNG('tone-feasible-set-seed');
    const set = pickFeasibleEncodingSet(rng, {
      onCount: 3,
      offCount: 1,
      minFoilOn: 2,
      minFoilOff: 1,
    });
    const encoded = [...set.onCells, ...set.offCells];
    const onFoils = filterAllowedFoilCells(
      onPatternCells().filter((cell) => !set.onCells.includes(cell)),
      encoded
    );
    const offFoils = filterAllowedFoilCells(
      offPatternCells().filter((cell) => !set.offCells.includes(cell)),
      encoded
    );
    expect(onFoils.length).toBeGreaterThanOrEqual(2);
    expect(offFoils.length).toBeGreaterThanOrEqual(1);
  });
});

describe('filterAllowedFoilCells – foil constraint', () => {
  it('worked example: encoded={6, 9} → forbidden foil ranks={4, 5, 7, 8, 10, 11} (and 6, 9 themselves)', () => {
    /* The user's spec example. We pass ALL non-encoded cells as candidates
     * (across both labels) to verify the rank-based filter, independent of
     * the on/off split that happens in the schedulers. */
    const cellRank6 = getToneBank()[5].paired_cell; /* rank 6 == bank index 5 */
    const cellRank9 = getToneBank()[8].paired_cell; /* rank 9 == bank index 8 */
    const encodedCells = [cellRank6, cellRank9];

    const allCells = [...onPatternCells(), ...offPatternCells()];
    const candidates = allCells.filter((c) => !encodedCells.includes(c));
    const allowed = filterAllowedFoilCells(candidates, encodedCells, 3);
    const allowedRanks = new Set(allowed.map((c) => toneForCell(c).rank));
    const forbiddenRanks = [4, 5, 7, 8, 10, 11];
    for (const r of forbiddenRanks) expect(allowedRanks.has(r)).toBe(false);
    /* Spot-check: ranks at distance ≥ 3 ARE allowed. */
    expect(allowedRanks.has(3)).toBe(true); /* |3-6|=3 ≥ 3 ✓ */
    expect(allowedRanks.has(12)).toBe(true); /* |12-9|=3 ≥ 3 ✓ */
    expect(allowedRanks.has(1)).toBe(true);
    expect(allowedRanks.has(24)).toBe(true);
  });

  it('throws if no candidate satisfies the constraint', () => {
    /* Synthetic worst case: an encoded set covering enough rank space that
     * a deliberately tight candidate pool (just one cell at distance 1 from
     * an encoded tone) collapses to empty. */
    const cellRank10 = getToneBank()[9].paired_cell;
    const cellRank11 = getToneBank()[10].paired_cell; /* distance 1 → forbidden */
    expect(() => filterAllowedFoilCells([cellRank11], [cellRank10], 3)).toThrow(
      /no candidates remain/
    );
  });

  it('returns all candidates if encoded set is empty', () => {
    const cands = onPatternCells().slice(0, 4);
    expect(filterAllowedFoilCells(cands, [], 3)).toEqual(cands);
  });
});

describe('integration – t_only blocks respect the spacing rule', () => {
  it('every memory_items 4-tuple in a 24-trial t_only block is pairwise ≥3 ranks apart', () => {
    const rng = createPRNG('t-only-spacing-test-seed');
    const trials = generateMemoryBlock({
      trialType: 't_only',
      blockSize: 24,
      sequencePoolLabel: 't_only_test',
      prng: rng,
    });
    expect(trials).toHaveLength(24);
    for (const trial of trials) {
      const cells = trial.memory_items.map((m) => m.cell);
      expect(setRespectsToneSpacing(cells, MIN_TONE_GAP_RANKS)).toBe(true);
    }
  });

  it('every memory_items 4-tuple in a 24-trial i_t block is pairwise ≥3 ranks apart', () => {
    const rng = createPRNG('i-t-spacing-test-seed');
    const trials = generateDualBlock({
      trialType: 'i_t',
      blockSize: 24,
      sequencePoolLabel: 'i_t_test',
      prng: rng,
    });
    expect(trials).toHaveLength(24);
    for (const trial of trials) {
      const cells = trial.memory_items.map((m) => m.cell);
      expect(setRespectsToneSpacing(cells, MIN_TONE_GAP_RANKS)).toBe(true);
    }
  });

  it('every t_only foil tone is ≥3 ranks from every encoded tone', () => {
    const rng = createPRNG('t-only-foil-spacing-seed');
    const trials = generateMemoryBlock({
      trialType: 't_only',
      blockSize: 24,
      sequencePoolLabel: 't_only_foil_test',
      prng: rng,
    });
    for (const trial of trials) {
      const encodedRanks = trial.memory_items.map((m) => toneForCell(m.cell).rank);
      const foilProbes = trial.probes.filter((p) => p.is_target === false);
      expect(foilProbes.length).toBeGreaterThanOrEqual(1);
      for (const foil of foilProbes) {
        const foilRank = toneForCell(foil.cell).rank;
        for (const er of encodedRanks) {
          expect(Math.abs(foilRank - er)).toBeGreaterThanOrEqual(MIN_TONE_GAP_RANKS);
        }
      }
    }
  });

  it('every i_t foil tone is ≥3 ranks from every encoded tone', () => {
    const rng = createPRNG('i-t-foil-spacing-seed');
    const trials = generateDualBlock({
      trialType: 'i_t',
      blockSize: 24,
      sequencePoolLabel: 'i_t_foil_test',
      prng: rng,
    });
    for (const trial of trials) {
      const encodedRanks = trial.memory_items.map((m) => toneForCell(m.cell).rank);
      const foilProbes = trial.probes.filter((p) => p.is_target === false);
      expect(foilProbes.length).toBeGreaterThanOrEqual(1);
      for (const foil of foilProbes) {
        const foilRank = toneForCell(foil.cell).rank;
        for (const er of encodedRanks) {
          expect(Math.abs(foilRank - er)).toBeGreaterThanOrEqual(MIN_TONE_GAP_RANKS);
        }
      }
    }
  });

  it('d_only foils are NOT constrained by the rank-distance rule (control)', () => {
    /* Empirical check: across 50 d_only blocks, at least one foil somewhere
     * is < 3 ranks from an encoded item — proving the filter is not applied. */
    let foundCloseFoil = false;
    for (let s = 0; s < 50 && !foundCloseFoil; s++) {
      resetSequencePools();
      const rng = createPRNG(`d-only-foil-control-seed-${s}`);
      const trials = generateMemoryBlock({
        trialType: 'd_only',
        blockSize: 24,
        sequencePoolLabel: 'd_only_foil_test',
        prng: rng,
      });
      for (const trial of trials) {
        const encodedRanks = trial.memory_items.map((m) => toneForCell(m.cell).rank);
        const foilProbes = trial.probes.filter((p) => p.is_target === false);
        for (const foil of foilProbes) {
          const foilRank = toneForCell(foil.cell).rank;
          if (encodedRanks.some((er) => Math.abs(foilRank - er) < MIN_TONE_GAP_RANKS)) {
            foundCloseFoil = true;
            break;
          }
        }
        if (foundCloseFoil) break;
      }
    }
    expect(foundCloseFoil).toBe(true);
  });

  it('d_only blocks are NOT constrained by the spacing rule (control)', () => {
    /* Sanity: at least one d_only block, somewhere in 50 generated, will
     * contain a cell-pair whose tones would be < MIN apart. (We're not
     * applying the rule — we just want to be sure we didn't accidentally
     * apply it.) */
    let foundCloseDot = false;
    for (let s = 0; s < 50 && !foundCloseDot; s++) {
      resetSequencePools();
      const rng = createPRNG(`d-only-control-seed-${s}`);
      const trials = generateMemoryBlock({
        trialType: 'd_only',
        blockSize: 24,
        sequencePoolLabel: 'd_only_test',
        prng: rng,
      });
      for (const trial of trials) {
        const cells = trial.memory_items.map((m) => m.cell);
        if (!setRespectsToneSpacing(cells, MIN_TONE_GAP_RANKS)) {
          foundCloseDot = true;
          break;
        }
      }
    }
    expect(foundCloseDot).toBe(true);
  });
});
