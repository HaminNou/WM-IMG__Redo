/**
 * Integration tests for src/scheduler/memory-block.js — combines the
 * within-trial sampler, the probe-pool counterbalance, and the per-trial
 * item / probe selection. Verifies the locked invariants for one full
 * 24-trial D-only or T-only block with 3 items per trial: 3 memory items, 3 dummies, 3 probes per trial.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { generateMemoryBlock } from '../src/scheduler/memory-block.js';
import { resetSequencePools, isValidSequence } from '../src/scheduler/within-trial.js';
import { setSessionPRNG } from '../src/prng.js';
import { onPatternCells, offPatternCells } from '../src/grid.js';

describe.each([['d_only'], ['t_only']])('memory-block: %s', (trialType) => {
  beforeEach(() => {
    setSessionPRNG(`test-seed-memory-block-${trialType}`);
    resetSequencePools();
  });

  it('produces 24 trials for a 24-trial block', () => {
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    expect(block).toHaveLength(24);
  });

  it('every trial has a valid 6-event sequence (3 M + 3 S, run-length ≤ 2)', () => {
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      expect(isValidSequence(trial.sequence)).toBe(true);
    }
  });

  it('every trial has 3 memory items, 3 dummies, and 3 probes, with 0–3 on-pattern memory items', () => {
    /* With 3 items per trial there is no the per-trial all-off
     * ban — see src/scheduler/memory-block.js for the rationale. Trials may
     * therefore carry 0..3 on-pattern items; block-level 12-on/12-off per
     * encoding-position is what actually counts. */
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      expect(trial.memory_items).toHaveLength(3);
      expect(trial.dummies).toHaveLength(3);
      expect(trial.probes).toHaveLength(3);
      const onCount = trial.memory_items.filter((m) => m.pattern_label === 'on').length;
      const offCount = trial.memory_items.filter((m) => m.pattern_label === 'off').length;
      expect(onCount).toBeGreaterThanOrEqual(0);
      expect(onCount).toBeLessThanOrEqual(3);
      expect(offCount).toBe(3 - onCount);
    }
  });

  it('memory items occupy the M-slots of the encoding sequence', () => {
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      const mSlotIdx = trial.sequence
        .map((c, idx) => (c === 'M' ? idx : -1))
        .filter((idx) => idx !== -1);
      const itemSlots = trial.memory_items.map((m) => m.slot_index_in_seq).sort((a, b) => a - b);
      expect(itemSlots).toEqual(mSlotIdx);
    }
  });

  it('dummies occupy the S-slots and use cells distinct from memory items', () => {
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      const sSlotIdx = trial.sequence
        .map((c, idx) => (c === 'S' ? idx : -1))
        .filter((idx) => idx !== -1);
      const dummySlots = trial.dummies.map((d) => d.slot_index_in_seq).sort((a, b) => a - b);
      expect(dummySlots).toEqual(sSlotIdx);

      const itemCells = new Set(trial.memory_items.map((m) => m.cell));
      for (const d of trial.dummies) expect(itemCells.has(d.cell)).toBe(false);
    }
  });

  it('every trial uses only canonical probe types and stays feasible', () => {
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      const tOn = trial.probes.filter((p) => p.type === 'T_on').length;
      const tOff = trial.probes.filter((p) => p.type === 'T_off').length;
      const fOn = trial.probes.filter((p) => p.type === 'F_on').length;
      const fOff = trial.probes.filter((p) => p.type === 'F_off').length;
      const targets = tOn + tOff;
      for (const probe of trial.probes) {
        expect(['T_on', 'T_off', 'F_on', 'F_off'].includes(probe.type)).toBe(true);
      }
      const onCount = trial.memory_items.filter((m) => m.pattern_label === 'on').length;
      const offCount = trial.memory_items.filter((m) => m.pattern_label === 'off').length;
      expect(tOn).toBeLessThanOrEqual(onCount);
      expect(tOff).toBeLessThanOrEqual(offCount);
      expect(fOn).toBeLessThanOrEqual(2);
      expect(fOff).toBeLessThanOrEqual(2);
      expect(targets).toBeGreaterThanOrEqual(1);
      expect(targets).toBeLessThanOrEqual(2);
    }
  });

  it('targets reference cells that ARE in the trial; foils reference cells that are NOT', () => {
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      const itemCells = new Set(trial.memory_items.map((m) => m.cell));
      const dummyCells = new Set(trial.dummies.map((d) => d.cell));
      for (const p of trial.probes) {
        if (p.is_target) {
          expect(itemCells.has(p.cell)).toBe(true);
        } else {
          expect(itemCells.has(p.cell)).toBe(false);
          expect(dummyCells.has(p.cell)).toBe(false);
        }
      }
    }
  });

  it('probe pattern labels are consistent with the cell pools', () => {
    const onSet = new Set(onPatternCells());
    const offSet = new Set(offPatternCells());
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      for (const p of trial.probes) {
        if (p.pattern_label === 'on') expect(onSet.has(p.cell)).toBe(true);
        if (p.pattern_label === 'off') expect(offSet.has(p.cell)).toBe(true);
      }
    }
  });

  it('block-level (probe-type × probe-position) counterbalance: 6 of each across 12 cells over 24 trials', () => {
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    const counts = {};
    for (const trial of block) {
      for (const p of trial.probes) {
        const k = `${p.type}@${p.probe_position}`;
        counts[k] = (counts[k] ?? 0) + 1;
      }
    }
    /* 4 types × 3 positions = 12 cells, each must hit 6. */
    expect(Object.keys(counts)).toHaveLength(12);
    for (const k of Object.keys(counts)) expect(counts[k]).toBe(6);
  });

  it('block-level on/off encoding balance: 36 on + 36 off across 72 items', () => {
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    let on = 0,
      off = 0;
    for (const trial of block) {
      for (const m of trial.memory_items) {
        if (m.pattern_label === 'on') on++;
        else off++;
      }
    }
    expect(on).toBe(36);
    expect(off).toBe(36);
  });

  it('each encoding position receives exactly 12 on-pattern and 12 off-pattern memory items', () => {
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    const counts = Array.from({ length: 3 }, () => ({ on: 0, off: 0 }));
    for (const trial of block) {
      for (const item of trial.memory_items) counts[item.encoding_position][item.pattern_label]++;
    }
    expect(counts).toEqual([
      { on: 12, off: 12 },
      { on: 12, off: 12 },
      { on: 12, off: 12 },
    ]);
  });

  it('at least one trial repeats a probe type, so probe balance is not enforced within trial', () => {
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    expect(block.some((trial) => new Set(trial.probes.map((p) => p.type)).size < 3)).toBe(true);
  });

  it('on-pattern counts vary across trials — block-level (not trial-level) on/off balance', () => {
    const block = generateMemoryBlock({ trialType, blockSize: 24 });
    const onCounts = new Set(
      block.map((trial) => trial.memory_items.filter((m) => m.pattern_label === 'on').length)
    );
    /* With 3 items per trial and 36/36 block-level balance, individual trials
     * cannot all share the same onCount (3 doesn't divide 36 into a single
     * value — would need 1.5/trial). At least two distinct values must appear. */
    expect(onCounts.size).toBeGreaterThanOrEqual(2);
  });
});

describe('memory-block: input validation', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-memory-block-validation');
    resetSequencePools();
  });

  it('rejects unknown trial types', () => {
    expect(() => generateMemoryBlock({ trialType: 'i_only', blockSize: 24 })).toThrow();
    expect(() => generateMemoryBlock({ trialType: 'foo', blockSize: 24 })).toThrow();
  });
});
