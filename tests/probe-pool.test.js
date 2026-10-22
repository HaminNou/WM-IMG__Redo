/**
 * Tests for src/scheduler/probe-pool.js.
 *
 * The locked invariant is block-level
 * balance, not trial-level one-of-each: across a 24-trial block with 3 probes
 * per trial, every (probe-type × probe-position) cell must appear exactly
 * 6 times (4 types × 3 positions = 12 cells; 24 × 3 / 12 = 6 per cell), while
 * individual trials are allowed to repeat probe types as long as the schedule
 * stays feasible (1 ≤ targets ≤ 2 with 3 probes; per-type cap ≤ 2).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PROBE_TYPES, PROBES_PER_TRIAL, generateProbeOrders } from '../src/scheduler/probe-pool.js';
import { setSessionPRNG } from '../src/prng.js';

describe('probe-pool: constants', () => {
  it('PROBE_TYPES has exactly the four canonical types', () => {
    expect(PROBE_TYPES).toEqual(['T_on', 'T_off', 'F_on', 'F_off']);
  });

  it('PROBES_PER_TRIAL is 3', () => {
    expect(PROBES_PER_TRIAL).toBe(3);
  });
});

describe('probe-pool: full-block (24-trial) counterbalance', () => {
  beforeEach(() => setSessionPRNG('test-seed-probe-pool'));

  it('returns 24 probe orders for a 24-trial block', () => {
    const orders = generateProbeOrders(24);
    expect(orders).toHaveLength(24);
  });

  it('every order contains 3 canonical probe labels', () => {
    const orders = generateProbeOrders(24);
    for (const order of orders) {
      expect(order).toHaveLength(3);
      for (const type of order) expect(PROBE_TYPES.includes(type)).toBe(true);
    }
  });

  it('every (type, position) pair appears exactly 6 times across the block', () => {
    const orders = generateProbeOrders(24);
    const counts = {};
    for (const t of PROBE_TYPES) for (const pos of [0, 1, 2]) counts[`${t}@${pos}`] = 0;
    for (const order of orders) {
      for (let pos = 0; pos < order.length; pos++) {
        counts[`${order[pos]}@${pos}`]++;
      }
    }
    for (const k of Object.keys(counts)) expect(counts[k]).toBe(6);
  });

  it('every probe type appears exactly 18 times across the block (24 × 3 / 4 = 18)', () => {
    const orders = generateProbeOrders(24);
    const flat = orders.flat();
    const c = { T_on: 0, T_off: 0, F_on: 0, F_off: 0 };
    for (const t of flat) c[t]++;
    expect(c).toEqual({ T_on: 18, T_off: 18, F_on: 18, F_off: 18 });
  });

  it('at least one trial repeats a probe type, so balance is not enforced within trial', () => {
    const orders = generateProbeOrders(24);
    expect(orders.some((order) => new Set(order).size < 3)).toBe(true);
  });

  it('every trial stays feasible for the block-level memory-label schedule', () => {
    const orders = generateProbeOrders(24);
    for (const order of orders) {
      const tOn = order.filter((type) => type === 'T_on').length;
      const tOff = order.filter((type) => type === 'T_off').length;
      const fOn = order.filter((type) => type === 'F_on').length;
      const fOff = order.filter((type) => type === 'F_off').length;
      const targets = tOn + tOff;
      expect(tOn).toBeLessThanOrEqual(2);
      expect(tOff).toBeLessThanOrEqual(2);
      expect(fOn).toBeLessThanOrEqual(2);
      expect(fOff).toBeLessThanOrEqual(2);
      expect(targets).toBeGreaterThanOrEqual(1);
      expect(targets).toBeLessThanOrEqual(2);
    }
  });
});

describe('probe-pool: practice / non-main blocks', () => {
  beforeEach(() => setSessionPRNG('test-seed-probe-pool-practice'));

  it('returns blockSize permutations for blockSize ≠ 24', () => {
    expect(generateProbeOrders(3)).toHaveLength(3);
    expect(generateProbeOrders(5)).toHaveLength(5);
  });

  it('every returned order uses only canonical probe labels and stays feasible', () => {
    for (const order of generateProbeOrders(7)) {
      expect(order).toHaveLength(3);
      for (const type of order) expect(PROBE_TYPES.includes(type)).toBe(true);
      const tOn = order.filter((type) => type === 'T_on').length;
      const tOff = order.filter((type) => type === 'T_off').length;
      const fOn = order.filter((type) => type === 'F_on').length;
      const fOff = order.filter((type) => type === 'F_off').length;
      const targets = tOn + tOff;
      expect(tOn).toBeLessThanOrEqual(2);
      expect(tOff).toBeLessThanOrEqual(2);
      expect(fOn).toBeLessThanOrEqual(2);
      expect(fOff).toBeLessThanOrEqual(2);
      expect(targets).toBeGreaterThanOrEqual(1);
      expect(targets).toBeLessThanOrEqual(2);
    }
  });
});
