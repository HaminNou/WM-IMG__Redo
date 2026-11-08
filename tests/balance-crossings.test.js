/**
 * NEGATIVE controls for the crossings with the page background (shade) and with the rotation stratum:
 * memory label x shade, star label x shade, probe type x shade, probe type x test position x shade,
 * memory label x rotation stratum. Each control corrupts ONE thing in an otherwise valid half (two
 * trials swap their shade, or their rotation angle), and both the shipped validator and the
 * independent oracle must name that crossing. Pool-level codes are checked the same way.
 */
import { describe, it, expect } from 'vitest';
import { createPRNG } from '../src/prng.js';
import { generateBalancedPool } from '../src/scheduler/balanced-pool.js';
import { rotationStratumIndex } from '../src/scheduler/rotation-balance.js';
import {
  blockInvariantViolations,
  poolInvariantViolations,
} from '../src/scheduler/balance-invariants.js';
import { checkBlock, checkPool } from './helpers/block-oracle.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const pool = (type, seed) => generateBalancedPool(type, createPRNG(`cross|${seed}|${type}`));
const angleKey = (t) => (t === 'd_only' ? 'display_rotation_deg' : 'rotation_deg');
const memOn = (t) => t.memory_items.filter((m) => m.pattern_label === 'on').length;
const starOn = (t) => t.stars.filter((s) => s.pattern_label === 'on').length;
const TYPES = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];
const hasMem = (t) => t !== 'i_only';
const hasStar = (t) => t.startsWith('i_');
const rotates = (t) => t !== 't_only';
const oracleBlock = (b, type) => checkBlock(b, type, { histOK: true }).viol.join(' | ');

/* count of probes by [shade][type] (x position when withPos) in a half */
function typeCells(half, withPos) {
  const c = {};
  for (const t of half)
    for (const p of t.probes) {
      const k = `${t.background_shade}|${p.type}${withPos ? `|${p.probe_position}` : ''}`;
      c[k] = (c[k] ?? 0) + 1;
    }
  return c;
}
const swapShade = (b, i, j) => {
  [b[i].background_shade, b[j].background_shade] = [b[j].background_shade, b[i].background_shade];
};
const swapAngle = (b, i, j, key) => {
  [b[i][key], b[j][key]] = [b[j][key], b[i][key]];
};

/* first (seed, i, j) whose corruption `breaks(copy)` is true; trial pairs with different shades */
function find(type, wantPair, mutate, breaks) {
  for (let s = 0; s < 60; s++) {
    const { halfA, halfB } = pool(type, s);
    for (let i = 0; i < 12; i++)
      for (let j = i + 1; j < 12; j++) {
        if (!wantPair(halfA, i, j)) continue;
        const copy = clone(halfA);
        mutate(copy, i, j);
        if (breaks(copy)) return { copy, halfB };
      }
  }
  throw new Error(`no corruptible pair found for ${type}`);
}
const diffShade = (b, i, j) => b[i].background_shade !== b[j].background_shade;

const onShade = (b, f) =>
  b.filter((t) => t.background_shade === 'white').reduce((s, t) => s + f(t), 0);
const cellsBad = (b, withPos, ok) => {
  const c = typeCells(b, withPos);
  const keys = [];
  for (const sh of ['white', 'gray'])
    for (const ty of ['T_on', 'T_off', 'F_on', 'F_off'])
      if (withPos) for (const j of [0, 1, 2]) keys.push(`${sh}|${ty}|${j}`);
      else keys.push(`${sh}|${ty}`);
  return keys.some((k) => !ok.includes(c[k] ?? 0));
};

const SHADE_CONTROLS = [
  {
    name: 'two trials swap shade so memory on-items per shade are no longer 9 / 9',
    when: hasMem,
    code: 'mem_label_x_shade',
    oracle: /mem label x shade/,
    pair: (b, i, j) => diffShade(b, i, j) && memOn(b[i]) !== memOn(b[j]),
    breaks: (b) => onShade(b, memOn) !== 9,
    poolCode: 'pool_mem_label_x_shade',
  },
  {
    name: 'two trials swap shade so star on-items per shade are no longer 9 / 9',
    when: hasStar,
    code: 'star_label_x_shade',
    oracle: /star label x shade/,
    pair: (b, i, j) => diffShade(b, i, j) && starOn(b[i]) !== starOn(b[j]),
    breaks: (b) => onShade(b, starOn) !== 9,
    poolCode: 'pool_star_label_x_shade',
  },
  {
    name: 'two trials swap shade so a probe-type x shade cell leaves {4, 5}',
    when: hasMem,
    code: 'probe_type_x_shade',
    oracle: /probe type x shade/,
    pair: diffShade,
    breaks: (b) => cellsBad(b, false, [4, 5]),
    poolCode: 'pool_probe_type_x_shade',
  },
  {
    name: 'two trials swap shade so a probe-type x test-position x shade cell leaves {1, 2}',
    when: hasMem,
    code: 'probe_type_x_position_x_shade',
    oracle: /probe type x pos x shade/,
    pair: diffShade,
    breaks: (b) => cellsBad(b, true, [1, 2]),
    poolCode: 'pool_probe_type_x_position_x_shade',
  },
];

describe('shade crossings: one corrupted swap is named by validator and oracle (block and pool)', () => {
  for (const type of TYPES)
    for (const c of SHADE_CONTROLS) {
      if (!c.when(type)) continue;
      it(`${type}: ${c.name}`, () => {
        const { copy, halfB } = find(type, c.pair, (b, i, j) => swapShade(b, i, j), c.breaks);
        expect(blockInvariantViolations(copy, type).join('\n')).toContain(c.code);
        expect(oracleBlock(copy, type)).toMatch(c.oracle);
        /* the shade count itself is still 6 / 6: only the crossing is broken */
        expect(blockInvariantViolations(copy, type).join('\n')).not.toMatch(/^shade/m);
        expect(poolInvariantViolations(copy, halfB, type).join('\n')).toContain(c.poolCode);
        expect(checkPool(copy, halfB, type).viol.join(' | ')).toMatch(/pool: /);
      });
    }
});

describe('memory label x rotation stratum: swapped angles are named by validator and oracle', () => {
  for (const type of TYPES.filter((t) => hasMem(t) && rotates(t)))
    it(`${type}: two trials from different strata swap angle, memory on-counts differ`, () => {
      const key = angleKey(type);
      const { copy, halfB } = find(
        type,
        (b, i, j) =>
          rotationStratumIndex(b[i][key]) !== rotationStratumIndex(b[j][key]) &&
          memOn(b[i]) !== memOn(b[j]),
        (b, i, j) => swapAngle(b, i, j, key),
        () => true
      );
      expect(blockInvariantViolations(copy, type).join('\n')).toContain('mem_label_x_stratum');
      expect(oracleBlock(copy, type)).toMatch(/mem label x stratum/);
      expect(poolInvariantViolations(copy, halfB, type).join('\n')).toContain(
        'pool_mem_label_x_stratum'
      );
      expect(checkPool(copy, halfB, type).viol.join(' | ')).toMatch(/mem label x stratum/);
    });
  it('t_only has no rotation, so no memory-label x stratum code is ever reported for it', () => {
    const { halfA, halfB } = pool('t_only', 0);
    expect(blockInvariantViolations(halfA, 't_only').join()).not.toMatch(/stratum/);
    expect(poolInvariantViolations(halfA, halfB, 't_only').join()).not.toMatch(/stratum/);
  });
});

describe('pool-only controls: valid halves from two different pools break the shade crossings', () => {
  const POOL_CODES = [
    ['pool_probe_type_x_shade', /pool: probe type x shade/],
    ['pool_probe_type_x_position_x_shade', /pool: probe type x pos x shade/],
  ];
  for (const type of ['d_only', 't_only', 'i_d', 'i_t'])
    for (const [code, orc] of POOL_CODES)
      it(`${type}: half A of one pool with half B of another reports ${code}`, () => {
        const halves = Array.from({ length: 30 }, (_, s) => pool(type, s));
        let found = false;
        for (let s = 0; s + 1 < halves.length && !found; s++) {
          const a = halves[s].halfA;
          const b = halves[s + 1].halfB;
          expect(blockInvariantViolations(a, type)).toEqual([]);
          expect(blockInvariantViolations(b, type)).toEqual([]);
          if (!poolInvariantViolations(a, b, type).join('\n').includes(code)) continue;
          expect(checkPool(a, b, type).viol.join(' | ')).toMatch(orc);
          found = true;
        }
        expect(found).toBe(true);
      });
});
