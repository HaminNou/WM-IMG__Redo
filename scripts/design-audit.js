#!/usr/bin/env node
/**
 * Large-scale audit of the block-exact main-task design.
 *
 *   node scripts/design-audit.js [--plans 2000] [--pools 5000] [--offset 0]
 *
 *   --plans N   full plans (`generateMainPlan`, the runtime code path): every plan
 *               is checked with `planInvariantViolations`; generation time is
 *               reported (mean / p50 / p99 / max, milliseconds)
 *   --pools N   half-pool generators alone, N seeds per trial type: failures (shipped validator
 *               and independent oracle),
 *               retries, and the per-cell usage marginals (max/min ratio over
 *               pools; cells are drawn independently, so equal in expectation only)
 *   --offset K  first seed index (to audit a different range)
 *
 * Exit code 1 when any plan / pool throws or violates an invariant.
 */
import { createPRNG } from '../src/prng.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';
import {
  BALANCED_TYPES,
  generateBalancedPool,
  newGenerationStats,
} from '../src/scheduler/balanced-pool.js';
import {
  planInvariantViolations,
  poolInvariantViolations,
} from '../src/scheduler/balance-invariants.js';
import { checkBlock, checkPool } from '../tests/helpers/block-oracle.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}
const PLANS = arg('plans', 2000);
const POOLS = arg('pools', 5000);
const OFFSET = arg('offset', 0);

const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const fmt = (x) => x.toFixed(1);
let failed = false;
const ratio = (u) => {
  const v = Object.values(u);
  return v.length === 24 ? (Math.max(...v) / Math.min(...v)).toFixed(3) : 'n/a';
};

if (POOLS > 0) {
  console.log(`half-pool generators: ${POOLS} seeds per type (offset ${OFFSET})`);
  for (const type of BALANCED_TYPES) {
    const stats = newGenerationStats();
    const ms = [];
    let thrown = 0;
    let violations = 0;
    const use = { enc: {}, foil: {}, star: {} };
    const bump = (u, c) => (u[c] = (u[c] ?? 0) + 1);
    const reasons = {};
    for (let s = 0; s < POOLS; s++) {
      const t0 = performance.now();
      try {
        const pool = generateBalancedPool(type, createPRNG(`audit-pool|${type}|${s + OFFSET}`), {
          stats,
        });
        ms.push(performance.now() - t0);
        /* the shipped validator (all block + pool codes, including the shade and stratum crossings)
         * AND the independent oracle must both be clean */
        const v = poolInvariantViolations(pool.halfA, pool.halfB, type);
        const o = [
          ...checkBlock(pool.halfA, type, { histOK: true }).viol,
          ...checkBlock(pool.halfB, type, { histOK: true }).viol,
          ...checkPool(pool.halfA, pool.halfB, type).viol,
        ];
        if (v.length || o.length) {
          violations++;
          for (const x of [...v.map((y) => y.split(':')[0]), ...o.map((y) => `oracle ${y}`)])
            reasons[x] = (reasons[x] ?? 0) + 1;
        }
        for (const t of [...pool.halfA, ...pool.halfB]) {
          for (const m of t.memory_items ?? []) bump(use.enc, m.cell);
          for (const p of t.probes ?? []) if (!p.is_target) bump(use.foil, p.cell);
          for (const x of t.stars ?? []) bump(use.star, x.cell);
        }
      } catch (e) {
        thrown++;
        reasons[e.message.slice(0, 90)] = (reasons[e.message.slice(0, 90)] ?? 0) + 1;
      }
    }
    ms.sort((a, b) => a - b);
    const retries = stats.halfAttempts - stats.halves;
    if (thrown || violations) failed = true;
    console.log(
      `  ${type}: ok=${ms.length}/${POOLS} thrown=${thrown} violations=${violations} ` +
        `half-retries=${retries} pool-redraws=${stats.poolAttempts - POOLS} ` +
        `ms/pool mean=${fmt(ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length))} ` +
        `p99=${fmt(quantile(ms, 0.99))} max=${fmt(ms[ms.length - 1])} ` +
        `cell-usage max/min enc=${ratio(use.enc)} foil=${ratio(use.foil)} star=${ratio(use.star)}`
    );
    if (Object.keys(reasons).length) console.log('    reasons', JSON.stringify(reasons));
  }
}

if (PLANS > 0) {
  console.log(`full plans: ${PLANS} seeds (offset ${OFFSET})`);
  const ms = [];
  let thrown = 0;
  let violations = 0;
  const reasons = {};
  for (let s = 0; s < PLANS; s++) {
    const t0 = performance.now();
    let plan;
    try {
      plan = generateMainPlan({ prng: createPRNG(`audit-plan|${s + OFFSET}`) });
      ms.push(performance.now() - t0);
    } catch (e) {
      thrown++;
      reasons[e.message.slice(0, 90)] = (reasons[e.message.slice(0, 90)] ?? 0) + 1;
      continue;
    }
    const v = planInvariantViolations(plan);
    if (v.length) {
      violations++;
      reasons[v[0]] = (reasons[v[0]] ?? 0) + 1;
    }
  }
  ms.sort((a, b) => a - b);
  if (thrown || violations) failed = true;
  console.log(
    `  plans ok=${ms.length}/${PLANS} thrown=${thrown} violations=${violations} ` +
      `ms mean=${fmt(ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length))} p50=${fmt(quantile(ms, 0.5))} ` +
      `p99=${fmt(quantile(ms, 0.99))} max=${fmt(ms[ms.length - 1])}`
  );
  if (Object.keys(reasons).length) console.log('  reasons', JSON.stringify(reasons));
}

process.exit(failed ? 1 : 0);
