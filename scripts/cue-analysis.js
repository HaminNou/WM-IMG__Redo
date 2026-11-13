#!/usr/bin/env node
/**
 * Cell-history cue analysis of the main plan.
 *
 *   node scripts/cue-analysis.js [plans=800]
 *
 * Question: can a participant who remembers WHICH CELLS appeared earlier in the session (as
 * encoded dots/tones or as probes of the same condition) tell a target probe from a foil probe
 * better than chance? Method: for every probe, the participant-visible history of its cell
 * (how often that cell was encoded in earlier trials of the same condition, how often it was
 * probed, and which block the trial is in) is the only feature. A lookup classifier is trained
 * on the probes of even-numbered plans and scored on odd-numbered plans (held out). Accuracy
 * near 0.50 means that history carries no information about target vs foil status.
 *
 * Reference result (800 plans): 0.505 with independent cell draws (shipped); 0.694 when every
 * cell was used an exact number of times with greedy picking of foil cells (the rejected design).
 * With 0-3 targets per trial (pinned histogram 3/9/9/3 per pool) the base rate is exactly 0.5 and
 * the lookup scores 0.504 over 200 plans.
 */
import { pathToFileURL } from 'node:url';
import { createPRNG } from '../src/prng.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';

const TYPES = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];

/** Feature rows (one per probe) of `plans` plans; `seedPrefix` selects the seed family. */
export function cueRows(plans, seedPrefix = 'cue') {
  const rows = [];
  for (let s = 0; s < plans; s++) {
    const p = generateMainPlan({ prng: createPRNG(seedPrefix + s) });
    const trials = [...p.mainA.trialParams, ...p.mainB.trialParams];
    const st = {};
    for (const t of TYPES) st[t] = { enc: Array(25).fill(0), pr: Array(25).fill(0), n: 0 };
    for (const t of trials) {
      const S = st[t.trial_type];
      for (const pr of t.probes ?? [])
        rows.push({
          s,
          blk: S.n < 12 ? 0 : 1,
          enc: Math.min(S.enc[pr.cell], 3),
          pr: Math.min(S.pr[pr.cell], 3),
          y: pr.is_target ? 1 : 0,
        });
      for (const m of t.memory_items ?? []) S.enc[m.cell]++;
      for (const pr of t.probes ?? []) S.pr[pr.cell]++;
      S.n++;
    }
  }
  return rows;
}

/** Held-out accuracy of the lookup classifier, with the number of test probes and base rate. */
export function cueAccuracy(plans, seedPrefix = 'cue') {
  const rows = cueRows(plans, seedPrefix);
  const train = rows.filter((r) => r.s % 2 === 0);
  const test = rows.filter((r) => r.s % 2 === 1);
  const key = (r) => `${r.blk}|${r.enc}|${r.pr}`;
  const tab = {};
  for (const r of train) (tab[key(r)] ??= [0, 0])[r.y]++;
  let ok = 0;
  for (const r of test) {
    const t = tab[key(r)] ?? [0, 0];
    if ((t[1] > t[0] ? 1 : 0) === r.y) ok++;
  }
  const targets = test.filter((r) => r.y === 1).length;
  return { accuracy: ok / test.length, n: test.length, baseRate: targets / test.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plans = Number(process.argv[2]) || 800;
  const r = cueAccuracy(plans);
  console.log(
    `held-out accuracy of the cell-history lookup (prior encoded count, prior probe ` +
      `appearances, block) over ${plans} plans: ${r.accuracy.toFixed(4)} ` +
      `(${r.n} test probes; always-guess-majority = ${Math.max(r.baseRate, 1 - r.baseRate).toFixed(4)})`
  );
}
