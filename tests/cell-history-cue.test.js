/**
 * GUARD against reintroducing exact cell usage.
 *
 * An earlier build used every grid cell an exact number of times per pool and picked foil cells
 * greedily (least used first). A participant who remembers which cells appeared earlier could then
 * tell a target probe from a foil probe: a held-out lookup classifier on the participant-visible
 * cell history reached 0.694 accuracy. Cells are now drawn independently and uniformly given their
 * label and exclusions, and the same classifier gives about 0.505 (800 plans,
 * `node scripts/cue-analysis.js 800`).
 *
 * This test runs 150 plans (75 held-out, about 21600 probes). Binomial standard error of an
 * accuracy at chance is 0.0034; probes of one trial are correlated, so we allow double that (0.007)
 * and a 5-sigma margin: 5 * 0.007 = 0.035 around 0.50. The test is two-sided with
 * |accuracy - 0.5| < 0.03 (observed about 0.505; the band is over 4 sd on each side, and the
 * sampling sd of 0.007 is itself a conservative double of the binomial value). The rejected
 * design (0.694) is far outside it, and an accuracy far below 0.5 would flag an anti-cue.
 */
import { describe, it, expect } from 'vitest';
import { cueAccuracy } from '../scripts/cue-analysis.js';

describe('cell-history cue', () => {
  it('participant-visible cell history does not predict target vs foil (held-out accuracy ~ 0.5)', () => {
    const { accuracy, n, baseRate } = cueAccuracy(150, 'cue-test');
    expect(n).toBeGreaterThan(15000);
    expect(baseRate).toBeCloseTo(0.5, 2);
    expect(Math.abs(accuracy - 0.5)).toBeLessThan(0.03);
  }, 120000);
});
