/**
 * Pattern reminders across BOTH main blocks: the per-condition counts differ by at
 * most one in every session.
 *
 * `planPatternReminders` is optimal within a block, but Main A was planned without
 * knowing Main B, so a session could end 4 / 6 / 5 (seed `fin-1197`; 1 in 4000
 * sessions): the claim "at most one in every session" in the pre-registration was
 * false (found by the final independent review). `generateMainPlan` now re-plans
 * until the totals of the whole session are within one, as it already did for the
 * run limits across the block boundary.
 */
import { describe, it, expect } from 'vitest';
import { createPRNG } from '../src/prng.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { orderViolations } from '../src/scheduler/rotation-balance.js';

const IMAGERY = ['i_only', 'i_d', 'i_t'];

/** Per-condition reminder counts recounted from the trials themselves, both blocks. */
function recount(plan) {
  const c = { i_only: 0, i_d: 0, i_t: 0 };
  for (const t of [...plan.mainA.trialParams, ...plan.mainB.trialParams]) {
    if (t.trial_meta.pattern_reminder) c[t.trial_type] += 1;
  }
  return c;
}
const spread = (c) => Math.max(...IMAGERY.map((k) => c[k])) - Math.min(...IMAGERY.map((k) => c[k]));

describe('reminder counts across both blocks', () => {
  it('seed fin-1197, which ended 4 / 6 / 5, now ends within one', () => {
    resetSequencePools();
    const plan = generateMainPlan({ prng: createPRNG('fin-1197') });
    const c = recount(plan);
    expect(spread(c), JSON.stringify(c)).toBeLessThanOrEqual(1);
    /* the reported tally agrees with the recount */
    expect(plan.mainB.reminderCounts).toMatchObject(c);
  });

  it('holds for 300 seeds, with the hard rules and the gap bound intact', () => {
    const bad = [];
    for (let s = 0; s < 300; s++) {
      resetSequencePools();
      const plan = generateMainPlan({ prng: createPRNG(`rs-${s}`) });
      const c = recount(plan);
      if (spread(c) > 1) bad.push(`rs-${s}: ${JSON.stringify(c)}`);
      const all = [...plan.mainA.trialParams, ...plan.mainB.trialParams];
      if (orderViolations(all) !== 0) bad.push(`rs-${s}: order rules`);
      for (const block of [plan.mainA, plan.mainB]) {
        let since = null;
        for (const t of block.trialParams) {
          const imagery = IMAGERY.includes(t.trial_type);
          if (t.trial_meta.pattern_reminder) {
            if (!imagery) bad.push(`rs-${s}: reminder on a ${t.trial_type} trial`);
            since = 0;
          } else if (imagery) {
            since = since === null ? null : since + 1;
          }
          /* trials since the last reminder at an imagery trial: at most 9 */
          if (imagery && t.trial_meta.trials_since_pattern_reminder > 9)
            bad.push(`rs-${s}: gap ${t.trial_meta.trials_since_pattern_reminder}`);
        }
      }
    }
    expect(bad, bad.slice(0, 5).join('\n')).toEqual([]);
  }, 120_000);

  it('is still reproducible from the seed', () => {
    resetSequencePools();
    const a = generateMainPlan({ prng: createPRNG('repro-1') });
    resetSequencePools();
    const b = generateMainPlan({ prng: createPRNG('repro-1') });
    expect(JSON.stringify(a.mainB.trialParams)).toBe(JSON.stringify(b.mainB.trialParams));
  });
});
