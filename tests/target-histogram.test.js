/**
 * Targets per trial: 0-3 allowed, with the number of trials per target count PINNED
 * ((2,4,4,2) in one 12-trial half, (1,5,5,1) in the other; pool (3,9,9,3)), the per-type
 * cap (<= 2) kept. Also measures the within-trial predictability of the third probe.
 */
import { describe, it, expect } from 'vitest';
import { createPRNG } from '../src/prng.js';
import {
  generateBalancedPool,
  createAttemptBudget,
  MAX_POOL_TRIES,
} from '../src/scheduler/balanced-pool.js';
import {
  poolInvariantViolations,
  blockInvariantViolations,
} from '../src/scheduler/balance-invariants.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';
import { toneForCell } from '../src/audio/tones.js';
import { MIN_TONE_GAP_RANKS } from '../src/scheduler/tone-spacing.js';

const MEMORY = ['d_only', 't_only', 'i_d', 'i_t'];
const SEEDS = 200;
const hist = (half) =>
  [0, 1, 2, 3].map(
    (k) => half.filter((t) => t.probes.filter((p) => p.is_target).length === k).length
  );
const gen = (type, s, opts) => generateBalancedPool(type, createPRNG(`th|${type}|${s}`), opts);

describe('pinned targets-per-trial histogram', () => {
  it(`per half (2,4,4,2) or (1,5,5,1), pool (3,9,9,3), all other invariants exact (${SEEDS} seeds x 4 tasks)`, () => {
    const orders = new Set();
    const times = {};
    let worstAttempts = 0;
    const seen = { three_foils: 0, zero_foils: 0 };
    for (const type of MEMORY) {
      times[type] = [];
      for (let s = 0; s < SEEDS; s++) {
        const budget = createAttemptBudget(MAX_POOL_TRIES * 200);
        const t0 = performance.now();
        const { halfA, halfB } = gen(type, s, { budget });
        times[type].push(performance.now() - t0);
        worstAttempts = Math.max(worstAttempts, budget.used);
        const a = hist(halfA).join();
        const b = hist(halfB).join();
        expect([`${a}|${b}`]).toSatisfy(
          ([x]) => x === '2,4,4,2|1,5,5,1' || x === '1,5,5,1|2,4,4,2'
        );
        orders.add(a);
        expect(poolInvariantViolations(halfA, halfB, type)).toEqual([]);
        for (const t of [...halfA, ...halfB]) {
          const foils = t.probes.filter((p) => !p.is_target);
          if (foils.length === 3) seen.three_foils++;
          if (foils.length === 0) seen.zero_foils++;
          const enc = t.memory_items.map((m) => m.cell);
          const others = [...(t.stars ?? []), ...(t.dummies ?? [])].map((x) => x.cell);
          for (const f of foils) {
            expect(enc).not.toContain(f.cell);
            expect(others).not.toContain(f.cell);
            if (type === 't_only' || type === 'i_t')
              for (const e of enc)
                expect(
                  Math.abs(toneForCell(f.cell).rank - toneForCell(e).rank)
                ).toBeGreaterThanOrEqual(MIN_TONE_GAP_RANKS);
          }
          expect(new Set(foils.map((f) => f.cell)).size).toBe(foils.length);
        }
      }
    }
    expect([...orders].sort()).toEqual(['1,5,5,1', '2,4,4,2']);
    expect(seen.three_foils).toBeGreaterThan(0);
    expect(seen.zero_foils).toBeGreaterThan(0);
    const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    console.log(
      `worst attempts per pool: ${worstAttempts}; ms median/max per pool: ` +
        MEMORY.map(
          (t) => `${t} ${med(times[t]).toFixed(1)}/${Math.max(...times[t]).toFixed(0)}`
        ).join(', ')
    );
  });

  it('the per-type cap holds (no probe type 3 times) and a block validator rejects a wrong histogram', () => {
    const { halfA } = gen('d_only', 7);
    for (const t of halfA) {
      const c = {};
      t.probes.forEach((p) => (c[p.type] = (c[p.type] ?? 0) + 1));
      expect(Math.max(...Object.values(c))).toBeLessThanOrEqual(2);
    }
    expect(blockInvariantViolations(halfA, 'd_only')).toEqual([]);
    /* turn a 2-target trial into a 3-target trial (breaks the histogram) */
    const bad = halfA.map((t) => ({ ...t }));
    const i = bad.findIndex((t) => t.probes.filter((p) => p.is_target).length === 2);
    const foilIdx = bad[i].probes.findIndex((p) => !p.is_target);
    bad[i] = {
      ...bad[i],
      probes: bad[i].probes.map((p, j) => (j === foilIdx ? { ...p, is_target: true } : p)),
    };
    expect(blockInvariantViolations(bad, 'd_only').join('|')).toMatch(
      /targets_histogram|is_target/
    );
  });

  it('is deterministic per seed', () => {
    for (const type of MEMORY)
      expect(JSON.stringify(gen(type, 11))).toBe(JSON.stringify(gen(type, 11)));
  });

  it('a full main plan generates within its attempt budget', () => {
    for (let s = 0; s < 8; s++)
      expect(() => generateMainPlan({ prng: createPRNG(`plan|${s}`) })).not.toThrow();
  });
});

describe('within-trial predictability of the probe sequence (cap kept)', () => {
  it('measured over 400 sessions: third probe is not inferable from the first two', () => {
    const S = 400;
    const pat = {};
    let n = 0;
    for (let s = 0; s < S; s++)
      for (const type of MEMORY) {
        const { halfA, halfB } = generateBalancedPool(type, createPRNG(`pred|${type}|${s}`));
        for (const t of [...halfA, ...halfB]) {
          const k = t.probes.map((p) => (p.is_target ? 'T' : 'F')).join('');
          pat[k] = (pat[k] ?? 0) + 1;
          n++;
        }
      }
    const g = (k) => pat[k] ?? 0;
    const cond = (a, b) => g(a) / (g(a) + g(b));
    const third = {
      TT: cond('TTT', 'TTF'),
      FF: cond('FFT', 'FFF'),
      TF: cond('TFT', 'TFF'),
      FT: cond('FTT', 'FTF'),
    };
    const sum = (ks) => ks.reduce((x, k) => x + g(k), 0);
    const second = {
      T: sum(['TTT', 'TTF']) / sum(['TTT', 'TTF', 'TFT', 'TFF']),
      F: sum(['FTT', 'FTF']) / sum(['FTT', 'FTF', 'FFT', 'FFF']),
    };
    const freq = Object.fromEntries(
      ['TTT', 'TTF', 'TFT', 'TFF', 'FTT', 'FTF', 'FFT', 'FFF'].map((k) => [k, g(k) / n])
    );
    console.log(
      'P(3rd=T | first two):',
      JSON.stringify(third),
      'P(2nd=T | 1st):',
      JSON.stringify(second)
    );
    console.log('pattern frequencies:', JSON.stringify(freq));
    for (const p of [...Object.values(third), ...Object.values(second)])
      expect(Math.abs(p - 0.5)).toBeLessThan(0.04);
    for (const p of Object.values(freq)) expect(Math.abs(p - 1 / 8)).toBeLessThan(0.012);
  });
});
