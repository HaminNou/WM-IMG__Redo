/**
 * Monte-Carlo comparison of pattern-reminder schemes on real main plans.
 * Usage: node scripts/pattern-reminder-montecarlo.js [nSeeds=300]
 *
 * Every seed builds the real main plan (same code path as the runtime), then each
 * scheme chooses which trials get the 4 s pattern reminder. Metrics are computed at
 * IMAGERY trials (i_only / i_d / i_t) — the only trials that need the pattern image.
 */
import { createPRNG } from '../src/prng.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { planPatternReminders } from '../src/scheduler/pattern-reminders.js';

const F = 8;
const IMG = new Set(['i_only', 'i_d', 'i_t']);
const STAR = ['i_only', 'i_d', 'i_t'];

/* each scheme: (types[], blockState) -> Set of slot indices carrying a reminder
 * (a reminder is spliced into the trial at that slot; "between" schemes mark a slot
 * the reminder precedes, regardless of type). */
const schemes = {
  'a current (slot%8, dropped on memory-only)': (t) =>
    new Set(t.map((x, i) => (i % F === 0 && IMG.has(x) ? i : -1)).filter((i) => i >= 0)),
  'b between trials every 8, any type': (t) =>
    new Set(t.map((_, i) => i).filter((i) => i % F === 0)),
  'c due every 8, deferred to next imagery trial': (t) => {
    const out = new Set();
    for (let d = 0; d < t.length; d += F) {
      for (let j = d; j < Math.min(t.length, d + F); j++) {
        if (IMG.has(t[j])) {
          out.add(j);
          break;
        }
      }
    }
    return out;
  },
  'd rolling: first imagery trial with gap>=8': (t) => {
    const out = new Set();
    let last = null;
    for (let j = 0; j < t.length; j++) {
      if (!IMG.has(t[j])) continue;
      if (last === null || j - last >= F) {
        out.add(j);
        last = j;
      }
    }
    return out;
  },
};

/* e: windowed + condition-balanced. One reminder is due per window of F trials; it is
 * delivered at an imagery trial inside the window, chosen to equalise the three imagery
 * conditions' reminder counts (ties: earliest), but never later than the first imagery trial
 * whose trials-since-reminder would exceed B. B = F-1 reduces to scheme c. */
function balanced(B, cond) {
  return (t, st) => {
    const out = new Set();
    let last = null;
    for (let d = 0; d < t.length; d += F) {
      const end = Math.min(t.length, d + F);
      const cand = [];
      for (let j = d; j < end; j++) if (IMG.has(t[j])) cand.push(j);
      if (!cand.length) continue;
      /* forced deadline: first imagery trial (from the window start on) whose gap would exceed B */
      let deadline = cand[cand.length - 1];
      if (last === null) deadline = cand[0]; /* first imagery trial of a block is always reminded */
      else {
        const forced = cand.find((j) => j - last > B);
        if (forced !== undefined) deadline = Math.min(deadline, forced);
      }
      const elig = cand.filter((j) => j <= deadline);
      let best = elig[0];
      if (cond) {
        let bc = st.counts[t[best]];
        for (const j of elig) {
          const c = st.counts[t[j]];
          if (c < bc) {
            best = j;
            bc = c;
          }
        }
      }
      out.add(best);
      last = best;
      st.counts[t[best]]++;
    }
    return out;
  };
}
/* the implemented planner (src/scheduler/pattern-reminders.js): must equal scheme e with gap<=9 */
schemes['IMPLEMENTED planner (e, gap<=F+1)'] = (t, st) => {
  const r = planPatternReminders({ schedule: t, frequency: F, counts: st.counts });
  Object.assign(st.counts, r.counts);
  return new Set(r.reminded.flatMap((x, i) => (x ? [i] : [])));
};
for (const B of [9, 11, 13]) schemes[`e window+balance, gap<=${B}`] = balanced(B, true);

function metrics(blocks, chosen) {
  /* blocks: [types[], types[]]; chosen: [Set, Set] */
  const perCond = { i_only: 0, i_d: 0, i_t: 0 };
  let count = 0;
  const gaps = [];
  const gapByCond = { i_only: [], i_d: [], i_t: [] };
  const shown = { i_only: 0, i_d: 0, i_t: 0 };
  const total = { i_only: 0, i_d: 0, i_t: 0 };
  blocks.forEach((t, b) => {
    let last = null;
    t.forEach((x, j) => {
      const rem = chosen[b].has(j);
      if (rem) {
        count++;
        last = j;
        if (IMG.has(x)) perCond[x]++;
      }
      if (IMG.has(x)) {
        const g =
          last === null ? t.length : j - last; /* trials since last reminder; 0 = this trial */
        gaps.push(g);
        gapByCond[x].push(g);
        total[x]++;
        if (rem) shown[x]++;
      }
    });
  });
  return { count, perCond, gaps, gapByCond, shown, total };
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

const nSeeds = Number(process.argv[2] ?? 300);
const agg = {};
for (const k of Object.keys(schemes))
  agg[k] = {
    counts: [],
    maxGap: [],
    meanGap: [],
    condSpread: [],
    condGapSpread: [],
    memOnlyShown: [],
    dropped: [],
  };
for (let s = 0; s < nSeeds; s++) {
  resetSequencePools();
  const prng = createPRNG(`pr-mc-${s}`);
  const plan = generateMainPlan({ prng });
  const blocks = [plan.mainA.schedule, plan.mainB.schedule];
  for (const [k, fn] of Object.entries(schemes)) {
    const st = { counts: { i_only: 0, i_d: 0, i_t: 0 } };
    const chosen = blocks.map((t) => fn(t, st));
    const m = metrics(blocks, chosen);
    const a = agg[k];
    a.counts.push(m.count);
    a.maxGap.push(Math.max(...m.gaps));
    a.meanGap.push(mean(m.gaps));
    const pc = Object.values(m.perCond);
    a.condSpread.push(Math.max(...pc) - Math.min(...pc));
    const gm = STAR.map((c) => mean(m.gapByCond[c]));
    a.condGapSpread.push(Math.max(...gm) - Math.min(...gm));
    a.memOnlyShown.push(
      blocks.reduce((n, t, b) => n + [...chosen[b]].filter((j) => !IMG.has(t[j])).length, 0)
    );
  }
}
const f = (v) => v.toFixed(2);
console.log(`seeds=${nSeeds}  (60+60 trials; 36+36 imagery trials)\n`);
console.log(
  'scheme | reminders mean[min-max] | max trials-since-reminder at imagery trials (mean/worst) | mean gap | cond count spread (max-min, mean) | cond mean-gap spread | reminders before memory-only trials'
);
for (const [k, a] of Object.entries(agg)) {
  console.log(
    `${k} | ${f(mean(a.counts))} [${Math.min(...a.counts)}-${Math.max(...a.counts)}] | ${f(mean(a.maxGap))}/${Math.max(...a.maxGap)} | ${f(mean(a.meanGap))} | ${f(mean(a.condSpread))} | ${f(mean(a.condGapSpread))} | ${f(mean(a.memOnlyShown))}`
  );
}
