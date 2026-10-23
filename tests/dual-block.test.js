/**
 * Tests for src/scheduler/dual-block.js — the I+D and I+T dual-task block
 * generators. Verifies the counterbalance invariants with 3 items per trial: both (probe_type × probe_position) and
 * (encoding_position × probe_position) are exactly counterbalanced across
 * 24 trials. The expected hit counts shifted accordingly:
 *   - (probe_type × probe_position): 4 × 3 = 12 cells, 6 per cell
 *     (24 × 3 / 12).
 *   - (encoding_position × probe_position): 3 × 3 = 9 cells, 8 per cell
 *     (24 × 3 / 9).
 *   - block totals: 72 memory items (36 on / 36 off), 72 stars (36/36).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { isValidSequence } from './helpers/valid-sequence.js';
import { setSessionPRNG } from '../src/prng.js';
import { onPatternCells, offPatternCells } from '../src/grid.js';
import { config } from '../src/config.js';

describe.each([['i_d'], ['i_t']])('dual-block: %s — structural invariants', (trialType) => {
  beforeEach(() => {
    setSessionPRNG(`test-seed-dual-block-struct-${trialType}`);
    resetSequencePools();
  });

  it('produces 24 trials for a 24-trial block', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    expect(block).toHaveLength(24);
  });

  it(`every trial has trial_type = "${trialType}"`, () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    for (const trial of block) expect(trial.trial_type).toBe(trialType);
  });

  it('every trial has a valid 6-event sequence (3 M + 3 S, run-length ≤ 2)', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    for (const trial of block) expect(isValidSequence(trial.sequence)).toBe(true);
  });

  it('every trial has 3 memory items, 3 stars, and 3 probes', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      expect(trial.memory_items).toHaveLength(3);
      expect(trial.stars).toHaveLength(3);
      expect(trial.probes).toHaveLength(3);

      /* With 3 items per trial there is no the per-trial
       * all-off ban. Trials may carry 0..3 on-pattern items / stars; block-
       * level 12-on/12-off per encoding-position is what counts. */
      const mOn = trial.memory_items.filter((m) => m.pattern_label === 'on').length;
      const mOff = trial.memory_items.filter((m) => m.pattern_label === 'off').length;
      expect(mOn).toBeGreaterThanOrEqual(0);
      expect(mOn).toBeLessThanOrEqual(3);
      expect(mOff).toBe(3 - mOn);

      const sOn = trial.stars.filter((s) => s.pattern_label === 'on').length;
      expect(sOn).toBeGreaterThanOrEqual(0);
      expect(sOn).toBeLessThanOrEqual(3);
    }
  });

  it('memory items occupy the M-slots (in temporal order, encoding_position 0..2)', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      const mSlotIdx = trial.sequence
        .map((c, idx) => (c === 'M' ? idx : -1))
        .filter((idx) => idx !== -1);
      const itemSlots = trial.memory_items.map((m) => m.slot_index_in_seq);
      expect(itemSlots).toEqual(mSlotIdx); /* preserved in temporal order */

      const positions = trial.memory_items.map((m) => m.encoding_position).sort((a, b) => a - b);
      expect(positions).toEqual([0, 1, 2]);
    }
  });

  it('stars occupy the S-slots of the encoding sequence', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      const sSlotIdx = trial.sequence
        .map((c, idx) => (c === 'S' ? idx : -1))
        .filter((idx) => idx !== -1);
      const starSlots = trial.stars.map((s) => s.slot_index_in_seq).sort((a, b) => a - b);
      expect(starSlots).toEqual(sSlotIdx);
    }
  });

  it('star pattern_label and is_on_pattern match cell membership', () => {
    const onSet = new Set(onPatternCells());
    const offSet = new Set(offPatternCells());
    const block = generateDualBlock({ trialType, blockSize: 24 });
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

  it('probes use only canonical labels and stay feasible', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
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

  it('targets reference encoded cells; foils do not', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      const itemCells = new Set(trial.memory_items.map((m) => m.cell));
      for (const p of trial.probes) {
        if (p.is_target) expect(itemCells.has(p.cell)).toBe(true);
        else expect(itemCells.has(p.cell)).toBe(false);
      }
    }
  });

  it('target probe cell == memory item cell at probe.encoding_position; matched pattern label', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      const itemAtPos = new Map();
      for (const m of trial.memory_items) itemAtPos.set(m.encoding_position, m);
      for (const p of trial.probes) {
        if (!p.is_target) continue;
        const item = itemAtPos.get(p.encoding_position);
        expect(item).toBeDefined();
        expect(p.cell).toBe(item.cell);
        expect(p.pattern_label).toBe(item.pattern_label);
      }
    }
  });

  it('probe pattern labels respect the on / off pools', () => {
    const onSet = new Set(onPatternCells());
    const offSet = new Set(offPatternCells());
    const block = generateDualBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      for (const p of trial.probes) {
        if (p.pattern_label === 'on') expect(onSet.has(p.cell)).toBe(true);
        if (p.pattern_label === 'off') expect(offSet.has(p.cell)).toBe(true);
      }
    }
  });

  it('rotation angles stay within the inclusive configured range', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      expect(Number.isInteger(trial.rotation_deg)).toBe(true);
      expect(trial.rotation_deg).toBeGreaterThanOrEqual(config.grid.rotation_min_deg);
      expect(trial.rotation_deg).toBeLessThanOrEqual(config.grid.rotation_max_deg);
    }
  });

  it('trial objects and their inner arrays are frozen', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      expect(Object.isFrozen(trial)).toBe(true);
      expect(Object.isFrozen(trial.memory_items)).toBe(true);
      expect(Object.isFrozen(trial.stars)).toBe(true);
      expect(Object.isFrozen(trial.probes)).toBe(true);
    }
  });
});

describe.each([['i_d'], ['i_t']])('dual-block: %s — block-level counterbalance', (trialType) => {
  beforeEach(() => {
    setSessionPRNG(`test-seed-dual-block-counterbal-${trialType}`);
    resetSequencePools();
  });

  it('(probe_type × probe_position): 6 of each across 12 cells over 24 trials', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    const counts = {};
    for (const trial of block) {
      for (const p of trial.probes) {
        const k = `${p.type}@${p.probe_position}`;
        counts[k] = (counts[k] ?? 0) + 1;
      }
    }
    expect(Object.keys(counts)).toHaveLength(12);
    for (const k of Object.keys(counts)) expect(counts[k]).toBe(6);
  });

  it('(encoding_position × probe_position): 8 of each across 9 cells over 24 trials', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    const counts = {};
    for (const trial of block) {
      for (const p of trial.probes) {
        const k = `e${p.encoding_position}@${p.probe_position}`;
        counts[k] = (counts[k] ?? 0) + 1;
      }
    }
    expect(Object.keys(counts)).toHaveLength(9);
    for (const k of Object.keys(counts)) expect(counts[k]).toBe(8);
  });

  it('block-level on/off encoding balance: 36 on + 36 off memory items', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
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
    const block = generateDualBlock({ trialType, blockSize: 24 });
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

  it('block-level on/off star balance: 36 on + 36 off stars', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
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
    const block = generateDualBlock({ trialType, blockSize: 24 });
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

  it('the deterministic test seed produces at least one non-canonical angle', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    const canonical = new Set([-90, -45, 0, 45, 90]);
    expect(block.some((trial) => !canonical.has(trial.rotation_deg))).toBe(true);
  });
});

describe.each([['i_d'], ['i_t']])('dual-block: %s — visual disjointness', (trialType) => {
  beforeEach(() => {
    setSessionPRNG(`test-seed-dual-block-disjoint-${trialType}`);
    resetSequencePools();
  });

  it('star cells are disjoint from memory-item cells within each trial', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      const itemCells = new Set(trial.memory_items.map((m) => m.cell));
      for (const s of trial.stars) {
        expect(itemCells.has(s.cell)).toBe(false);
      }
    }
  });

  it('foil probes avoid every cell shown earlier in the trial', () => {
    const block = generateDualBlock({ trialType, blockSize: 24 });
    for (const trial of block) {
      const shownCells = new Set([
        ...trial.memory_items.map((m) => m.cell),
        ...trial.stars.map((s) => s.cell),
      ]);
      for (const probe of trial.probes.filter((p) => !p.is_target)) {
        expect(shownCells.has(probe.cell)).toBe(false);
      }
    }
  });
});

describe('dual-block: input validation and small-N behaviour', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-dual-block-validation');
    resetSequencePools();
  });

  it('rejects unknown trial types', () => {
    expect(() => generateDualBlock({ trialType: 'i_only', blockSize: 24 })).toThrow();
    expect(() => generateDualBlock({ trialType: 'd_only', blockSize: 24 })).toThrow();
    expect(() => generateDualBlock({ trialType: 'foo', blockSize: 24 })).toThrow();
  });

  it('rejects blockSize < 1', () => {
    expect(() => generateDualBlock({ trialType: 'i_d', blockSize: 0 })).toThrow();
    expect(() => generateDualBlock({ trialType: 'i_t', blockSize: -1 })).toThrow();
    expect(() => generateDualBlock({ trialType: 'i_d', blockSize: 'foo' })).toThrow();
  });

  it('handles practice-sized blocks (e.g. 3) with structural integrity', () => {
    const block = generateDualBlock({ trialType: 'i_d', blockSize: 3 });
    expect(block).toHaveLength(3);
    for (const trial of block) {
      expect(isValidSequence(trial.sequence)).toBe(true);
      expect(trial.memory_items).toHaveLength(3);
      expect(trial.stars).toHaveLength(3);
      expect(trial.probes).toHaveLength(3);
      const tOn = trial.probes.filter((p) => p.type === 'T_on').length;
      const tOff = trial.probes.filter((p) => p.type === 'T_off').length;
      expect(tOn).toBeLessThanOrEqual(2);
      expect(tOff).toBeLessThanOrEqual(2);
    }
  });
});

describe('dual-block: probe-pool tests for the encoding-position permutations', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-dual-block-encperm');
    resetSequencePools();
  });

  it('every trial probe set has exactly one probe at each encoding_position', () => {
    const block = generateDualBlock({ trialType: 'i_d', blockSize: 24 });
    for (const trial of block) {
      const positions = trial.probes.map((p) => p.encoding_position).sort((a, b) => a - b);
      expect(positions).toEqual([0, 1, 2]);
    }
  });

  it('at least one trial repeats a probe type, at least one memory trial varies in on/off split, and at least one star trial varies in on/off split', () => {
    const block = generateDualBlock({ trialType: 'i_d', blockSize: 24 });
    /* With 3 probes from 4 types, repeats ↔ Set size < 3. */
    expect(block.some((trial) => new Set(trial.probes.map((p) => p.type)).size < 3)).toBe(true);
    /* With 3 memory items and a 36/36 block-level balance, individual trials
     * cannot all share the same on-count — at least two distinct counts must
     * appear across the block. */
    const memOnCounts = new Set(
      block.map((trial) => trial.memory_items.filter((m) => m.pattern_label === 'on').length)
    );
    expect(memOnCounts.size).toBeGreaterThanOrEqual(2);
    const starOnCounts = new Set(
      block.map((trial) => trial.stars.filter((s) => s.pattern_label === 'on').length)
    );
    expect(starOnCounts.size).toBeGreaterThanOrEqual(2);
  });
});
