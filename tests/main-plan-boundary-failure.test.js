/**
 * A plan that breaks the run limits across the Main A / Main B boundary must never
 * be returned silently.
 *
 * `generateMainPlan` re-plans Main B up to a fixed number of times until the
 * shade / rotation run limits hold across the boundary. If every try failed, the
 * loop used to end and the violating plan shipped without a word (found by the final
 * independent review; with the real cap of 25 it happens in 0 of 4000 seeds, but a
 * silent give-up is not acceptable). It now throws.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/scheduler/rotation-balance.js', async (importOriginal) => {
  const actual = await importOriginal();
  /* main-plan.js calls this export to judge the boundary; the planner inside
   * rotation-balance.js uses its own copy and is not affected. */
  return { ...actual, orderViolations: vi.fn(() => 1) };
});

import { createPRNG } from '../src/prng.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';

describe('boundary rules that cannot be met', () => {
  it('throws instead of returning a plan that violates them', () => {
    resetSequencePools();
    expect(() => generateMainPlan({ prng: createPRNG('boundary-fail') })).toThrow(
      /boundary|run limits|order rules/i
    );
  });
});
