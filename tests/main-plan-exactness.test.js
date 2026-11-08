/**
 * Determinism of the plan and the FAILURE PATH of the block-exact design: a plan that is not exact must
 * throw, never be shipped. Failures are forced at two places:
 *   1. the pool generator returns a pool with one wrong label (the pool validator must reject every
 *      attempt, so generateMainPlan throws);
 *   2. something AFTER generation corrupts a trial (a label moved between slots / trials by the order
 *      planner): only the final `planInvariantViolations` assertion can catch that.
 * Plus: a generator that throws a few times is retried from the same stream and still gives the same
 * exact plan as an undisturbed run would after the same draws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hooks = vi.hoisted(() => ({ corruptPool: null, corruptOrder: null, failFirst: 0, calls: 0 }));

vi.mock('../src/scheduler/balanced-pool.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    generateBalancedPool: (...args) => {
      hooks.calls++;
      if (hooks.failFirst > 0) {
        hooks.failFirst--;
        throw new Error('forced generator failure');
      }
      const pool = actual.generateBalancedPool(...args);
      return hooks.corruptPool ? hooks.corruptPool(pool, args[0]) : pool;
    },
  };
});
vi.mock('../src/scheduler/rotation-balance.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    arrangeTrialOrder: (...args) => {
      const out = actual.arrangeTrialOrder(...args);
      return hooks.corruptOrder ? hooks.corruptOrder(out) : out;
    },
  };
});

import { createPRNG } from '../src/prng.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';
import { planInvariantViolations } from '../src/scheduler/balance-invariants.js';

const sig = (p) => JSON.stringify([p.mainA.trialParams, p.mainB.trialParams, p.trialParamsByType]);

beforeEach(() => {
  hooks.corruptPool = null;
  hooks.corruptOrder = null;
  hooks.failFirst = 0;
  hooks.calls = 0;
});

describe('determinism', () => {
  it('the same seed gives an identical plan; another seed gives a different one', () => {
    const a = generateMainPlan({ prng: createPRNG('det-1') });
    const b = generateMainPlan({ prng: createPRNG('det-1') });
    const c = generateMainPlan({ prng: createPRNG('det-2') });
    expect(sig(a)).toBe(sig(b));
    expect(sig(a)).not.toBe(sig(c));
    expect(planInvariantViolations(a)).toEqual([]);
  });
});

describe('a plan that is not exact is never returned', () => {
  it('throws when the pool generator keeps returning a pool with one wrong label', () => {
    hooks.corruptPool = (pool, type) => {
      if (type !== 'i_d') return pool;
      const halfA = pool.halfA.map((t, i) => {
        if (i !== 0) return t;
        const s = t.stars[0];
        const stars = [
          { ...s, pattern_label: s.pattern_label === 'on' ? 'off' : 'on' },
          ...t.stars.slice(1),
        ];
        return Object.freeze({ ...t, stars });
      });
      return { halfA, halfB: pool.halfB };
    };
    expect(() => generateMainPlan({ prng: createPRNG('force-1') })).toThrow(
      /pool invariants \(i_d\)/
    );
    /* it retried (25 attempts for the first failing type) and did not give up silently */
    expect(hooks.calls).toBeGreaterThan(20);
  });

  it('throws when a trial label is changed after generation (final plan assertion)', () => {
    hooks.corruptOrder = (ordered) => {
      const out = ordered.slice();
      const i = out.findIndex((t) => t.trial_type === 'i_t');
      const t = out[i];
      const s = t.stars[0];
      out[i] = {
        ...t,
        stars: [
          { ...s, pattern_label: s.pattern_label === 'on' ? 'off' : 'on' },
          ...t.stars.slice(1),
        ],
      };
      return out;
    };
    expect(() => generateMainPlan({ prng: createPRNG('force-2') })).toThrow(/plan invariants/);
  });

  it('throws when two trials of one type exchange their memory items after generation', () => {
    hooks.corruptOrder = (ordered) => {
      const out = ordered.slice();
      const idx = out.map((t, i) => (t.trial_type === 'd_only' ? i : -1)).filter((i) => i >= 0);
      const [p, q] = [idx[0], idx[1]];
      out[p] = { ...out[p], memory_items: out[q].memory_items, probes: out[q].probes };
      out[q] = { ...out[q], memory_items: ordered[p].memory_items, probes: ordered[p].probes };
      return out;
    };
    expect(() => generateMainPlan({ prng: createPRNG('force-3') })).toThrow(/plan invariants/);
  });

  it('throws when every generator attempt fails', () => {
    hooks.failFirst = 10000;
    expect(() => generateMainPlan({ prng: createPRNG('force-4') })).toThrow(
      /forced generator failure/
    );
  });

  it('retries a generator that fails a few times and still returns an exact plan', () => {
    hooks.failFirst = 3;
    const plan = generateMainPlan({ prng: createPRNG('force-5') });
    expect(planInvariantViolations(plan)).toEqual([]);
    expect(hooks.calls).toBe(5 + 3);
  });
});
