/**
 * Tests for src/scheduler/imagery-block.js — the I-only block generator
 * with 3 items per trial.
 *
 * Locked invariants:
 *   - 24 trials per block; every trial has a valid 6-event sequence (3M+3S,
 *     run-length ≤ 2 — same enumerator as d_only / t_only)
 *   - Per trial: 3 stars, 3 dummies, stars in S-slots, dummies in M-slots
 *   - Block-level: 36 on-pattern + 36 off-pattern stars across 24 trials
 *   - Per star serial position (0..2): 12 on + 12 off
 *   - Rotation angles drawn uniformly from the inclusive range [-90, +90]
 *   - All dummies are open-square visual fillers at non-star non-centre
 *     cells, so I-only's participant-visible structure
 *     mirrors D-only / T-only ("3 targets + 3 empty squares").
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { generateImageryBlock } from '../src/scheduler/imagery-block.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { isValidSequence } from './helpers/valid-sequence.js';
import { setSessionPRNG } from '../src/prng.js';
import { onPatternCells, offPatternCells, nonCentreCells } from '../src/grid.js';
import { config } from '../src/config.js';

describe('imagery-block: structural invariants', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-imagery-block');
    resetSequencePools();
  });

  it('produces 24 trials for a 24-trial block', () => {
    const block = generateImageryBlock({ blockSize: 24 });
    expect(block).toHaveLength(24);
  });

  it('every trial has trial_type = "i_only"', () => {
    const block = generateImageryBlock({ blockSize: 24 });
    for (const trial of block) expect(trial.trial_type).toBe('i_only');
  });

  it('every trial has a valid 6-event sequence (3 M + 3 S, run-length ≤ 2)', () => {
    const block = generateImageryBlock({ blockSize: 24 });
    for (const trial of block) expect(isValidSequence(trial.sequence)).toBe(true);
  });

  it('every trial has 3 stars and 3 dummies', () => {
    const block = generateImageryBlock({ blockSize: 24 });
    for (const trial of block) {
      expect(trial.stars).toHaveLength(3);
      expect(trial.dummies).toHaveLength(3);
      /* With 3 items per trial there is no the per-trial
       * all-off ban — see src/scheduler/memory-block.js. Stars may now
       * appear 0..3 on-pattern per trial. */
      const onCount = trial.stars.filter((s) => s.pattern_label === 'on').length;
      expect(onCount).toBeGreaterThanOrEqual(0);
      expect(onCount).toBeLessThanOrEqual(3);
    }
  });

  it('stars occupy the S-slots of the encoding sequence', () => {
    const block = generateImageryBlock({ blockSize: 24 });
    for (const trial of block) {
      const sSlotIdx = trial.sequence
        .map((c, idx) => (c === 'S' ? idx : -1))
        .filter((idx) => idx !== -1);
      const starSlots = trial.stars.map((s) => s.slot_index_in_seq).sort((a, b) => a - b);
      expect(starSlots).toEqual(sSlotIdx);
    }
  });

  it('dummies occupy the M-slots of the encoding sequence', () => {
    const block = generateImageryBlock({ blockSize: 24 });
    for (const trial of block) {
      const mSlotIdx = trial.sequence
        .map((c, idx) => (c === 'M' ? idx : -1))
        .filter((idx) => idx !== -1);
      const dummySlots = trial.dummies.map((d) => d.slot_index_in_seq).sort((a, b) => a - b);
      expect(dummySlots).toEqual(mSlotIdx);
    }
  });

  it('star pattern_label matches cell membership', () => {
    const onSet = new Set(onPatternCells());
    const offSet = new Set(offPatternCells());
    const block = generateImageryBlock({ blockSize: 24 });
    for (const trial of block) {
      for (const s of trial.stars) {
        if (s.pattern_label === 'on') {
          expect(onSet.has(s.cell)).toBe(true);
          expect(s.is_on_pattern).toBe(true);
        } else {
          expect(offSet.has(s.cell)).toBe(true);
          expect(s.is_on_pattern).toBe(false);
        }
      }
    }
  });

  it('dummies use non-null, non-centre cells disjoint from star cells', () => {
    const nonCentre = new Set(nonCentreCells());
    const block = generateImageryBlock({ blockSize: 24 });
    for (const trial of block) {
      const starCells = new Set(trial.stars.map((s) => s.cell));
      for (const d of trial.dummies) {
        expect(d.cell).not.toBeNull();
        expect(starCells.has(d.cell)).toBe(false);
        expect(nonCentre.has(d.cell)).toBe(true);
      }
    }
  });
});

describe('imagery-block: block-level counterbalance', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-imagery-block-counterbal');
    resetSequencePools();
  });

  it('block-level on/off star balance: 36 on + 36 off across 72 stars', () => {
    const block = generateImageryBlock({ blockSize: 24 });
    let on = 0,
      off = 0;
    for (const trial of block) {
      for (const s of trial.stars) {
        if (s.pattern_label === 'on') on++;
        else off++;
      }
    }
    expect(on).toBe(36);
    expect(off).toBe(36);
  });

  it('each star serial position receives exactly 12 on-pattern and 12 off-pattern stars', () => {
    const block = generateImageryBlock({ blockSize: 24 });
    const counts = Array.from({ length: 3 }, () => ({ on: 0, off: 0 }));
    for (const trial of block) {
      for (const star of trial.stars) counts[star.probe_position][star.pattern_label]++;
    }
    expect(counts).toEqual([
      { on: 12, off: 12 },
      { on: 12, off: 12 },
      { on: 12, off: 12 },
    ]);
  });

  it('rotation angles stay within the inclusive configured range', () => {
    const block = generateImageryBlock({ blockSize: 24 });
    for (const trial of block) {
      expect(Number.isInteger(trial.rotation_deg)).toBe(true);
      expect(trial.rotation_deg).toBeGreaterThanOrEqual(config.grid.rotation_min_deg);
      expect(trial.rotation_deg).toBeLessThanOrEqual(config.grid.rotation_max_deg);
    }
  });

  it('the deterministic test seed produces at least one non-canonical angle', () => {
    const block = generateImageryBlock({ blockSize: 24 });
    const canonical = new Set([-90, -45, 0, 45, 90]);
    expect(block.some((trial) => !canonical.has(trial.rotation_deg))).toBe(true);
  });

  it('trial objects and their inner arrays are frozen', () => {
    const block = generateImageryBlock({ blockSize: 24 });
    for (const trial of block) {
      expect(Object.isFrozen(trial)).toBe(true);
      expect(Object.isFrozen(trial.stars)).toBe(true);
      expect(Object.isFrozen(trial.dummies)).toBe(true);
      for (const s of trial.stars) expect(Object.isFrozen(s)).toBe(true);
      for (const d of trial.dummies) expect(Object.isFrozen(d)).toBe(true);
    }
  });
});

describe('imagery-block: input validation and small-N behaviour', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-imagery-block-small');
    resetSequencePools();
  });

  it('rejects blockSize < 1', () => {
    expect(() => generateImageryBlock({ blockSize: 0 })).toThrow();
    expect(() => generateImageryBlock({ blockSize: -1 })).toThrow();
    expect(() => generateImageryBlock({ blockSize: 'foo' })).toThrow();
  });

  it('handles practice-sized blocks (e.g. 3) with 3 stars + 3 dummies per trial', () => {
    const block = generateImageryBlock({ blockSize: 3 });
    expect(block).toHaveLength(3);
    for (const trial of block) {
      expect(trial.stars).toHaveLength(3);
      expect(trial.dummies).toHaveLength(3);
    }
  });

  it('star on-counts vary across trials – block-level (not trial-level) on/off balance', () => {
    const block = generateImageryBlock({ blockSize: 24 });
    /* With 3 stars per trial and 36/36 across 24 trials, individual trials
     * cannot all share the same on-count (3 doesn't divide 36 into a single
     * value — would need 1.5/trial). At least two distinct values must
     * appear. */
    const onCounts = new Set(
      block.map((trial) => trial.stars.filter((s) => s.pattern_label === 'on').length)
    );
    expect(onCounts.size).toBeGreaterThanOrEqual(2);
  });
});
