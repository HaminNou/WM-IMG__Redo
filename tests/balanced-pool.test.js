/**
 * The block-exact pool generator (src/scheduler/balanced-pool.js): every condition's 24-trial pool is
 * generated as two exact 12-trial halves. Checked with the shipped validator AND the independent oracle
 * (tests/helpers/block-oracle.js). Seeds per condition: 60 by default, WMIMG_MC_SEEDS to enlarge.
 */
import { describe, it, expect } from 'vitest';
import { createPRNG } from '../src/prng.js';
import {
  BALANCED_TYPES,
  generateBalancedPool,
  newGenerationStats,
} from '../src/scheduler/balanced-pool.js';
import { poolInvariantViolations } from '../src/scheduler/balance-invariants.js';
import { generateMemoryBlock } from '../src/scheduler/memory-block.js';
import { generateImageryBlock } from '../src/scheduler/imagery-block.js';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { onPatternCells, offPatternCells } from '../src/grid.js';
import { toneMarginals } from '../src/scheduler/cell-draw.js';
import { toneForCell } from '../src/audio/tones.js';
import { checkBlock, checkPool } from './helpers/block-oracle.js';

const SEEDS = Number(process.env.WMIMG_MC_SEEDS) || 60;
const ALL = [...onPatternCells(), ...offPatternCells()];
const gen = (type, seed) => generateBalancedPool(type, createPRNG(`bp|${type}|${seed}`));

describe('generateBalancedPool', () => {
  for (const type of BALANCED_TYPES) {
    it(`${type}: ${SEEDS} seeds, every block and pool invariant exact (validator and oracle agree)`, () => {
      const stats = newGenerationStats();
      const bad = [];
      for (let s = 0; s < SEEDS; s++) {
        const { halfA, halfB } = generateBalancedPool(type, createPRNG(`bp|${type}|${s}`), {
          stats,
        });
        const mine = poolInvariantViolations(halfA, halfB, type);
        const a = checkBlock(halfA, type, { histOK: true }).viol;
        const b = checkBlock(halfB, type, { histOK: true }).viol;
        const p = checkPool(halfA, halfB, type);
        if (mine.length || a.length || b.length || p.viol.length)
          bad.push(`seed ${s}: ${[...mine, ...a, ...b, ...p.viol].slice(0, 3).join('; ')}`);
      }
      expect(bad).toEqual([]);
      /* bounded work: far below the budget of 60 redraws per half */
      expect(stats.halfAttempts / stats.halves).toBeLessThan(2);
    });
  }

  it('is reproducible from the seed and differs between seeds', () => {
    for (const type of BALANCED_TYPES) {
      const a = JSON.stringify(gen(type, 1));
      expect(JSON.stringify(gen(type, 1))).toBe(a);
      expect(JSON.stringify(gen(type, 2))).not.toBe(a);
    }
  });

  it('indexes the halves 0..11 and 12..23 (index in the 24-trial pool) and freezes the trials', () => {
    for (const type of BALANCED_TYPES) {
      const { halfA, halfB } = gen(type, 3);
      expect(halfA.map((t) => t.trial_index_in_block)).toEqual([...Array(12).keys()]);
      expect(halfB.map((t) => t.trial_index_in_block)).toEqual(
        [...Array(12).keys()].map((i) => i + 12)
      );
      for (const t of [...halfA, ...halfB]) {
        expect(Object.isFrozen(t)).toBe(true);
        expect(t.trial_type).toBe(type);
      }
    }
  });

  it('emits the same fields as the legacy per-condition generators (downstream nodes read them)', () => {
    const legacy = {
      d_only: generateMemoryBlock({ trialType: 'd_only', blockSize: 24, prng: createPRNG('l1') }),
      t_only: generateMemoryBlock({ trialType: 't_only', blockSize: 24, prng: createPRNG('l2') }),
      i_only: generateImageryBlock({ blockSize: 24, prng: createPRNG('l3') }),
      i_d: generateDualBlock({ trialType: 'i_d', blockSize: 24, prng: createPRNG('l4') }),
      i_t: generateDualBlock({ trialType: 'i_t', blockSize: 24, prng: createPRNG('l5') }),
    };
    const shape = (t) => ({
      top: Object.keys(t).sort(),
      item: t.memory_items ? Object.keys(t.memory_items[0]).sort() : null,
      star: t.stars ? Object.keys(t.stars[0]).sort() : null,
      dummy: t.dummies ? Object.keys(t.dummies[0]).sort() : null,
      probe: t.probes ? Object.keys(t.probes[0]).sort() : null,
    });
    for (const type of BALANCED_TYPES) {
      const { halfA } = gen(type, 4);
      expect(shape(halfA[0])).toEqual(shape(legacy[type][0]));
    }
  });

  it('the two halves leave out different complement pairs, drawn from the four unrestricted ones', () => {
    const allowed = new Set([
      'SMSMSM',
      'SMSMMS',
      'SMMSSM',
      'SMMSMS',
      'MSMSMS',
      'MSMSSM',
      'MSSMMS',
      'MSSMSM',
    ]);
    for (let s = 0; s < 40; s++) {
      const { halfA, halfB } = gen('i_d', 100 + s);
      const used = (h) => new Set(h.map((t) => t.sequence.join('')));
      const omitted = (h) => {
        const u = used(h);
        return halfA
          .concat(halfB)
          .map((t) => t.sequence.join(''))
          .filter((k) => !u.has(k));
      };
      for (const h of [halfA, halfB]) {
        const om = new Set(omitted(h));
        expect(om.size).toBe(2);
        for (const k of om) expect(allowed.has(k)).toBe(true);
      }
    }
  });

  it('cells are drawn independently: per-cell usage over many pools is close to uniform', () => {
    const pools = Number(process.env.WMIMG_CELL_POOLS) || 100;
    for (const type of ['d_only', 't_only', 'i_only', 'i_d', 'i_t']) {
      const enc = Object.fromEntries(ALL.map((c) => [c, 0]));
      const foil = { ...enc };
      const star = { ...enc };
      for (let s = 0; s < pools; s++) {
        const { halfA, halfB } = gen(type, 1000 + s);
        for (const t of [...halfA, ...halfB]) {
          for (const m of t.memory_items ?? []) enc[m.cell]++;
          for (const p of t.probes ?? []) if (!p.is_target) foil[p.cell]++;
          for (const x of t.stars ?? []) star[x.cell]++;
        }
      }
      const check = (use, perPool) => {
        const exp = (pools * perPool) / 24;
        const sd = Math.sqrt(exp);
        for (const c of ALL)
          expect(Math.abs(use[c] - exp), `${type} cell ${c}`).toBeLessThan(5 * sd);
      };
      if (type !== 'i_only') {
        check(enc, 72);
        check(foil, 36);
      }
      if (type.startsWith('i_')) check(star, 72);
    }
  });

  it('tone draws: fitted marginals are uniform per rank (encoded and foil), exactly', () => {
    const rank = (c) => toneForCell(c).rank;
    for (const onC of [0, 1, 2, 3]) {
      const m = toneMarginals(onC);
      for (const c of ALL) {
        const share = (onPatternCells().includes(c) ? onC : 3 - onC) / 12;
        expect(Math.abs(m.encoded.get(c) - share)).toBeLessThan(1e-8);
      }
      for (const [fm, k] of [
        [m.foilOn, 1],
        [m.foilOn, 2],
        [m.foilOff, 1],
        [m.foilOff, 2],
      ])
        for (const [c, p] of fm.get(k))
          expect(Math.abs(p / (k / 12) - 1), `rank ${rank(c)}`).toBeLessThan(1e-6);
    }
  });

  it('rejects an unknown type', () => {
    expect(() => generateBalancedPool('x_only', createPRNG('x'))).toThrow(/unknown trial type/);
  });
});
