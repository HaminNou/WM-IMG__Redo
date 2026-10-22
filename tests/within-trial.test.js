/**
 * Tests for src/scheduler/within-trial.js — the enumeration of valid
 * length-6 binary sequences (3 M, 3 S) under run-length cap = 2, plus the
 * sample-without-replacement pool. The exact count of 14 is the
 * load-bearing invariant for counterbalance with 3 items per trial.
 *
 * Combinatorial argument: C(6,3) = 20 binary strings with 3 M's and 3 S's.
 * Strings containing MMM: 4 (positions 0..3); strings containing SSS: 4.
 * The two intersecting strings are MMMSSS and SSSMMM. By inclusion-exclusion
 * 4 + 4 − 2 = 6 invalid → 20 − 6 = 14 valid sequences.
 *
 * Slot-balance with a 14-sequence pool: 24-trial blocks need 24 sequences
 * but the pool size is < 24, so uniqueness is no longer satisfiable.
 * `drawBlockSequences` switches to with-replacement sampling with rejection
 * on the 12-M / 12-S per-position constraint instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  enumerateValidSequences,
  withinRunLengthCap,
  isValidSequence,
  createSequencePool,
  drawBlockSequences,
  resetSequencePools,
} from '../src/scheduler/within-trial.js';
import { setSessionPRNG } from '../src/prng.js';

describe('within-trial: enumeration', () => {
  it('produces exactly 14 valid sequences', () => {
    expect(enumerateValidSequences()).toHaveLength(14);
  });

  it('every sequence has length 6 with 3 M and 3 S', () => {
    for (const seq of enumerateValidSequences()) {
      expect(seq).toHaveLength(6);
      const m = seq.filter((c) => c === 'M').length;
      const s = seq.filter((c) => c === 'S').length;
      expect(m).toBe(3);
      expect(s).toBe(3);
    }
  });

  it('every sequence respects run-length cap = 2', () => {
    for (const seq of enumerateValidSequences()) {
      expect(withinRunLengthCap(seq, 2)).toBe(true);
    }
  });

  it('rejects sequences that violate the run-length cap', () => {
    expect(withinRunLengthCap(['M', 'M', 'M', 'S', 'S', 'S'], 2)).toBe(false);
    expect(withinRunLengthCap(['S', 'S', 'S', 'M', 'M', 'M'], 2)).toBe(false);
  });

  it('isValidSequence agrees with the enumeration', () => {
    for (const seq of enumerateValidSequences()) {
      expect(isValidSequence(seq)).toBe(true);
    }
    expect(isValidSequence(['M', 'M', 'M', 'S', 'S', 'S'])).toBe(false);
    expect(isValidSequence(['S', 'S', 'S', 'M', 'M', 'M'])).toBe(false);
    expect(isValidSequence(['M', 'S', 'M', 'S', 'M', 'S'])).toBe(true);
  });

  it('all 14 sequences are unique', () => {
    const set = new Set(enumerateValidSequences().map((s) => s.join('')));
    expect(set.size).toBe(14);
  });

  it('sequences and their inner arrays are frozen', () => {
    const arr = enumerateValidSequences();
    expect(Object.isFrozen(arr)).toBe(true);
    for (const seq of arr) expect(Object.isFrozen(seq)).toBe(true);
  });
});

describe('within-trial: sequence pool', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-within-trial');
    resetSequencePools();
  });

  it('produces every sequence exactly once before reshuffling', () => {
    const pool = createSequencePool('test-cond-1');
    const drawn = [];
    for (let i = 0; i < 14; i++) drawn.push(pool.next().join(''));
    /* All 14 distinct sequences should now have been drawn. */
    expect(new Set(drawn).size).toBe(14);
  });

  it('reshuffles after exhaustion (15th draw is one of the 14)', () => {
    const pool = createSequencePool('test-cond-2');
    for (let i = 0; i < 14; i++) pool.next();
    const next = pool.next();
    expect(isValidSequence(next)).toBe(true);
  });

  it('different labels maintain independent draw histories', () => {
    const a = createSequencePool('A');
    const b = createSequencePool('B');
    /* Different shuffles (vanishingly unlikely they align by chance with this seed). */
    const sA = [];
    const sB = [];
    for (let i = 0; i < 5; i++) {
      sA.push(a.next().join(''));
      sB.push(b.next().join(''));
    }
    expect(sA).not.toEqual(sB);
  });

  it('drawing 24 sequences for a full block returns 24 valid sequences', () => {
    const pool = createSequencePool('block24');
    for (let i = 0; i < 24; i++) {
      const s = pool.next();
      expect(isValidSequence(s)).toBe(true);
    }
    expect(pool.drawn_count).toBe(24);
  });

  it('drawBlockSequences returns 24 valid sequences with exact slot-position balance (with-replacement)', () => {
    const block = drawBlockSequences({ blockSize: 24, label: 'balanced-main' });
    expect(block).toHaveLength(24);
    /* Uniqueness no longer holds — the 14-sequence pool is smaller than the
     * 24-trial block, so repetition is forced. The load-bearing invariant
     * is slot balance, not uniqueness. */
    for (const seq of block) expect(isValidSequence(seq)).toBe(true);

    for (let pos = 0; pos < 6; pos++) {
      let mCount = 0;
      for (const seq of block) if (seq[pos] === 'M') mCount++;
      expect(mCount).toBe(12);
      expect(block.length - mCount).toBe(12);
    }
  });
});
