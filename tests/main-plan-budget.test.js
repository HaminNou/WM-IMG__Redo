// @vitest-environment jsdom
/**
 * Global attempt budget of generateMainPlan (an attempt COUNT, never time, so plans stay
 * reproducible). A degenerate random stream must fail fast with a clear error (the runner then shows
 * its start-up failure screen); real seeds must stay far below the budget.
 */
import { describe, it, expect } from 'vitest';
import { createPRNG } from '../src/prng.js';
import { generateMainPlan, MAX_TOTAL_ATTEMPTS } from '../src/scheduler/main-plan.js';
import { generateMainBlockPair } from '../src/scheduler/main-blocks.js';
import { createAttemptBudget } from '../src/scheduler/balanced-pool.js';

function constantPRNG(v) {
  return {
    next: () => v,
    int: (m) => Math.floor(v * m),
    pick: (a) => a[Math.floor(v * a.length)],
    shuffle(a) {
      const o = a.slice();
      for (let i = o.length - 1; i > 0; i--) {
        const j = Math.floor(v * (i + 1));
        [o[i], o[j]] = [o[j], o[i]];
      }
      return o;
    },
  };
}

describe('attempt budget', () => {
  for (const v of [0, 0.5, 0.9999999]) {
    it(`constant PRNG ${v}: throws a clear error within 3 s`, () => {
      const t0 = performance.now();
      expect(() => generateMainPlan({ prng: constantPRNG(v) })).toThrow(
        /attempt budget .* exhausted/
      );
      expect(performance.now() - t0).toBeLessThan(3000);
    });
  }

  it('the error reaches the caller of generateMainBlockPair (runner start-up failure screen)', () => {
    expect(() => generateMainBlockPair({ prng: constantPRNG(0.5) })).toThrow(/attempt budget/);
  });

  it('real seeds use well under a tenth of the budget (the recorded maximum is in the audit)', () => {
    let max = 0;
    for (let s = 0; s < 150; s++) {
      const budget = createAttemptBudget(MAX_TOTAL_ATTEMPTS);
      generateMainPlan({ prng: createPRNG(`budget-test|${s}`), budget });
      max = Math.max(max, budget.used);
    }
    expect(max).toBeLessThan(MAX_TOTAL_ATTEMPTS / 10);
  }, 120000);

  it('the plan does not depend on the budget object (reproducible from the seed)', () => {
    const a = generateMainPlan({ prng: createPRNG('repro') });
    const b = generateMainPlan({ prng: createPRNG('repro'), budget: createAttemptBudget(1e9) });
    expect(JSON.stringify(a.mainA.trialParams)).toBe(JSON.stringify(b.mainA.trialParams));
  });
});
