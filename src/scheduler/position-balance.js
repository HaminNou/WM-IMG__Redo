import { getSessionPRNG } from '../prng.js';

function balancedCounts(labels, blockSize, prng) {
  const base = Math.floor(blockSize / labels.length);
  const remainder = blockSize % labels.length;
  const counts = new Map(labels.map((label) => [label, base]));
  const extras = prng.shuffle(labels.slice()).slice(0, remainder);
  for (const label of extras) counts.set(label, counts.get(label) + 1);
  return counts;
}

function expandCounts(labels, counts) {
  const out = [];
  for (const label of labels) {
    for (let i = 0; i < counts.get(label); i++) out.push(label);
  }
  return out;
}

function normaliseCounts(labels, countsLike) {
  const counts = new Map(labels.map((label) => [label, 0]));
  if (countsLike instanceof Map) {
    for (const label of labels) counts.set(label, Number(countsLike.get(label) ?? 0));
    return counts;
  }
  if (countsLike && typeof countsLike === 'object') {
    for (const label of labels) counts.set(label, Number(countsLike[label] ?? 0));
    return counts;
  }
  throw new Error('generatePositionBalancedTrials: countsByPosition entries must be Map-like.');
}

/**
 * Build `blockSize` trial-label rows by balancing label frequencies within
 * each serial position and then rejecting schedules that violate an optional
 * per-trial validator. This keeps balance at the block level without forcing
 * every trial to carry the same label composition.
 *
 * @param {object} opts
 * @param {ReadonlyArray<string>} opts.labels
 * @param {number} opts.positions
 * @param {number} opts.blockSize
 * @param {object} [opts.prng]
 * @param {Array<Array<string|null|undefined>>} [opts.fixedLabelsByTrial]
 * @param {Array<Map<string, number>|Object>} [opts.countsByPosition]
 * @param {(trialLabels: string[], trialIndex: number) => boolean} [opts.trialValidator]
 * @param {number} [opts.maxAttempts]
 * @returns {string[][]}
 */
export function generatePositionBalancedTrials({
  labels,
  positions,
  blockSize,
  prng,
  fixedLabelsByTrial = [],
  countsByPosition = null,
  trialValidator = () => true,
  maxAttempts = 5000,
} = {}) {
  if (!Array.isArray(labels) || labels.length < 2) {
    throw new Error('generatePositionBalancedTrials: labels must contain at least two values.');
  }
  if (typeof positions !== 'number' || positions < 1) {
    throw new Error(`generatePositionBalancedTrials: positions must be ≥ 1, got ${positions}`);
  }
  if (typeof blockSize !== 'number' || blockSize < 1) {
    throw new Error(`generatePositionBalancedTrials: blockSize must be ≥ 1, got ${blockSize}`);
  }

  const rng = prng ?? getSessionPRNG();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const columns = [];
    let impossible = false;
    for (let pos = 0; pos < positions; pos++) {
      const counts =
        countsByPosition?.[pos] !== undefined
          ? normaliseCounts(labels, countsByPosition[pos])
          : balancedCounts(labels, blockSize, rng);

      const fixedCounts = new Map(labels.map((label) => [label, 0]));
      const column = new Array(blockSize).fill(null);
      const freeTrials = [];

      for (let trialIdx = 0; trialIdx < blockSize; trialIdx++) {
        const fixedLabel = fixedLabelsByTrial[trialIdx]?.[pos] ?? null;
        if (fixedLabel === null) {
          freeTrials.push(trialIdx);
          continue;
        }
        if (!labels.includes(fixedLabel)) {
          throw new Error(
            `generatePositionBalancedTrials: fixed label '${fixedLabel}' is not in labels [${labels.join(', ')}].`
          );
        }
        column[trialIdx] = fixedLabel;
        fixedCounts.set(fixedLabel, fixedCounts.get(fixedLabel) + 1);
      }

      const remainingCounts = new Map();
      let remainingLabelSlots = 0;
      for (const label of labels) {
        const remaining = counts.get(label) - fixedCounts.get(label);
        if (remaining < 0) {
          impossible = true;
          break;
        }
        remainingCounts.set(label, remaining);
        remainingLabelSlots += remaining;
      }
      if (impossible || remainingLabelSlots !== freeTrials.length) {
        impossible = true;
        break;
      }

      const remainingLabels = rng.shuffle(expandCounts(labels, remainingCounts));
      const trialOrder = rng.shuffle(freeTrials.slice());
      for (let i = 0; i < trialOrder.length; i++) {
        column[trialOrder[i]] = remainingLabels[i];
      }

      columns.push(column);
    }
    if (impossible) continue;

    const trials = Array.from({ length: blockSize }, (_, trialIdx) =>
      columns.map((column) => column[trialIdx])
    );

    if (trials.every((trial, trialIdx) => trialValidator(trial, trialIdx))) return trials;
  }

  throw new Error(
    `generatePositionBalancedTrials: failed to find a valid schedule after ${maxAttempts} attempts.`
  );
}
