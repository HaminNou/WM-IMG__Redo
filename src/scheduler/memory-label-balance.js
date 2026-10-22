import { getSessionPRNG } from '../prng.js';
import { generatePositionBalancedTrials } from './position-balance.js';

const MEMORY_LABELS = Object.freeze(['on', 'off']);

function countFixedLabels(fixedLabelsByTrial, blockSize, positions) {
  const fixedOn = Array(positions).fill(0);
  const fixedOff = Array(positions).fill(0);

  for (let trialIdx = 0; trialIdx < blockSize; trialIdx++) {
    const row = fixedLabelsByTrial[trialIdx] ?? [];
    for (let pos = 0; pos < positions; pos++) {
      const label = row[pos] ?? null;
      if (label === 'on') fixedOn[pos]++;
      else if (label === 'off') fixedOff[pos]++;
      else if (label !== null) {
        throw new Error(
          `generateMemoryLabelRows: fixed label '${label}' must be 'on', 'off', or null.`
        );
      }
    }
  }

  return { fixedOn, fixedOff };
}

function computeOnQuotas(fixedLabelsByTrial, blockSize, positions, rng, targetOverride) {
  const { fixedOn, fixedOff } = countFixedLabels(fixedLabelsByTrial, blockSize, positions);
  /* At positions=3, `blockSize *
   * positions` is odd whenever `blockSize` is odd (e.g. mini-blocks of 1 / 3
   * trials in tests, practice-leftover slots). When that happens the
   * per-position 50/50 balance can't be exact — we round the total on-count
   * to the nearest integer and let the equal-target distribution loop spread
   * the residual across positions (resulting in at most a 1-trial deviation
   * from perfect equality, which is the closest valid balance). */
  const quotas = fixedOn.slice();
  const maxOn = fixedOff.map((offCount) => blockSize - offCount);
  const fixedOnSum = quotas.reduce((sum, count) => sum + count, 0);
  const maxFeasibleOn = maxOn.reduce((sum, max) => sum + max, 0);
  /* Bound the global target by feasibility: the fixed labels already pin
   * `fixedOnSum` on-positions, and `maxFeasibleOn` is the largest total
   * achievable without overflowing any position's per-position cap. Without
   * this clamp, small-N blocks (e.g. mini-block sanity tests, single-trial
   * practice overrides) can request a `Math.round`-rounded target that the
   * fixed labels make infeasible — manifesting as the "no eligible encoding
   * positions" error. */
  const naiveTarget = targetOverride ?? Math.round((blockSize * positions) / 2);
  const totalOnTarget = Math.max(fixedOnSum, Math.min(naiveTarget, maxFeasibleOn));

  let remaining = totalOnTarget - fixedOnSum;
  if (remaining < 0) {
    throw new Error(
      'generateMemoryLabelRows: fixed target constraints already exceed the available on-pattern quota.'
    );
  }

  const equalTarget = totalOnTarget / positions;
  while (remaining > 0) {
    const eligible = quotas
      .map((count, pos) => ({ count, pos }))
      .filter(({ count, pos }) => count < maxOn[pos]);
    if (!eligible.length) {
      throw new Error(
        'generateMemoryLabelRows: no eligible encoding positions remain while distributing on-pattern quotas.'
      );
    }

    const belowEqual = eligible.filter(({ count }) => count < equalTarget);
    const pool = belowEqual.length ? belowEqual : eligible;
    const minCount = Math.min(...pool.map(({ count }) => count));
    const candidates = pool.filter(({ count }) => count === minCount).map(({ pos }) => pos);
    const chosenPos = rng.pick(candidates);
    quotas[chosenPos]++;
    remaining--;
  }

  return quotas;
}

/**
 * Build a block-level schedule of memory-item on/off labels.
 *
 * The labels are balanced across the block, not fixed within each trial.
 * Exact 12/12 position-wise balance is preserved when the target schedule
 * allows it; otherwise the schedule stays as close to that equality as the
 * fixed target constraints permit.
 */
export function generateMemoryLabelRows({
  blockSize,
  positions,
  fixedLabelsByTrial = [],
  prng,
  trialValidator = () => true,
  maxAttempts,
} = {}) {
  if (typeof positions !== 'number' || positions < 1) {
    throw new Error(
      `generateMemoryLabelRows: positions must be ≥ 1, got ${positions}. ` +
        `Callers must specify positions explicitly (no implicit default).`
    );
  }
  if (typeof blockSize !== 'number' || blockSize < 1) {
    throw new Error(`generateMemoryLabelRows: blockSize must be ≥ 1, got ${blockSize}`);
  }
  const rng = prng ?? getSessionPRNG();
  const innerMaxAttempts = maxAttempts ?? (blockSize === 24 ? 20000 : 8000);

  /* Outer retry: at small block sizes (e.g. blockSize=1 in mini-blocks /
   * single-trial practice overrides), a single deterministic on-quota choice
   * may be incompatible with the trial-level probe-feasibility validator
   * (e.g. probe order `[T_on, T_off, T_off]` needs onCount=1, but the naive
   * round picked onCount=2). We retry across the feasible target totals,
   * preferring the naive `Math.round`-rounded target first, then
   * progressively widening to ±1, ±2, ... around it. On the main 24-trial
   * blocks the first attempt always succeeds (the 12/12 per-position
   * balance is exact and the validator is loose); the outer loop only
   * exists for the small-block edge cases. */
  const total = blockSize * positions;
  const halfTarget = total / 2;
  const naiveTarget = Math.round(halfTarget);
  /* Build a list of candidate targets in [0, total], sorted by distance
   * from the naive target so the deterministic seed-mapping for normal-
   * sized blocks stays unchanged. */
  const candidateTargets = [];
  for (let delta = 0; delta <= total; delta++) {
    const up = naiveTarget + delta;
    const down = naiveTarget - delta;
    if (delta === 0) candidateTargets.push(naiveTarget);
    else {
      if (up <= total) candidateTargets.push(up);
      if (down >= 0) candidateTargets.push(down);
    }
  }

  let lastError;
  for (const target of candidateTargets) {
    const onQuotas = computeOnQuotas(fixedLabelsByTrial, blockSize, positions, rng, target);
    const countsByPosition = onQuotas.map(
      (onCount) =>
        new Map([
          ['on', onCount],
          ['off', blockSize - onCount],
        ])
    );
    try {
      return generatePositionBalancedTrials({
        labels: MEMORY_LABELS,
        positions,
        blockSize,
        prng: rng,
        fixedLabelsByTrial,
        countsByPosition,
        trialValidator,
        maxAttempts: innerMaxAttempts,
      });
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/**
 * The pre-registered block balance is 36 on-pattern and 36 off-pattern memory
 * items: exactly blockSize / 2 on-pattern items at each encoding position
 * (12 of 24 in the main block). `generateMemoryLabelRows` widens its target
 * when the search fails, so callers check the result and fail loudly instead
 * of shipping a block that misses the balance.
 */
export function assertMemoryLabelBalance(labelsByTrial, blockSize, caller = 'memory block') {
  if (blockSize !== 24) return;
  const positions = labelsByTrial[0]?.length ?? 0;
  for (let pos = 0; pos < positions; pos++) {
    const on = labelsByTrial.filter((row) => row[pos] === 'on').length;
    if (on !== blockSize / 2) {
      throw new Error(
        `${caller}: encoding position ${pos} has ${on} on-pattern items, expected ${blockSize / 2}`
      );
    }
  }
}
