/**
 * Per-block trial-parameter generator for the dual-task conditions I+D and
 * I+T. One dual-task trial carries:
 *
 *   - 3 memory items (M-slots): in I+D each item is a white dot at a cell;
 *     in I+T each item is a tone keyed to a cell (audio-only). Memory-item
 *     on/off labels are balanced across the block rather than fixed at the
 *     trial level, while still satisfying each trial's target-probe schedule.
 *   - 3 stars (S-slots): each judged on/off the rotated pattern. Star
 *     on/off labels are balanced across the block by serial position rather
 *     than fixed within every trial. Stars carry the same feedback rule as
 *     I-only: answered stars recolour after the response; skipped stars
 *     receive no feedback.
 *   - 3 recognition probes (post-retention) drawn from the canonical types
 *     {T_on, T_off, F_on, F_off}; in I+D the probe is a dot, in I+T a tone.
 *     Probe-type balance is enforced across the block, not within every trial.
 *   - 1 rotation angle, sampled uniformly from -90° to +90°.
 *
 * Two counterbalances are enforced exactly across a 24-trial block:
 *
 *   1. (probe_type × probe_position): 6 of each across 12 cells. Each of the
 *      4 probe types appears at each of the 3 probe positions exactly 6
 *      times (24 trials × 3 probes / (4 × 3) = 6 per cell).
 *   2. (encoding_position × probe_position): 8 of each across 9 cells, by
 *      drawing a 6-permutation pool of [0,1,2] (3! = 6) and using each
 *      mapping 4 times (24 trials × 3 probes / (3 × 3) = 8 per cell).
 *      Pool replicated 4× then shuffled (probe-pool.js,
 *      generateEncodingPositionMappings).
 *
 * The two pools are paired uniformly at random across the 24 trials, so the
 * joint (encoding_position × probe_type) distribution is approximately
 * uniform — fine for the design (the 3-way joint need not be
 * exact).
 *
 * The per-trial cell assignment must respect target constraints: any
 * encoding_position assigned to T_on must hold an on-pattern memory item,
 * and any encoding_position assigned to T_off must hold an off-pattern item.
 * The remaining encoding positions are filled so the block stays balanced
 * overall without making every trial transparently 2-on/2-off.
 *
 * Cell-uniqueness rule within a trial:
 *   - Stars use cells disjoint from the trial's memory-item cells in BOTH
 *     dual-task conditions.
 *   - Foils are drawn only from cells that were not previously used by a
 *     memory item or a star in that trial.
 *   - Target probes intentionally repeat the corresponding encoded item's cell.
 *
 * This generator does NOT emit pattern-phase events — pattern presentation
 * is a block-level concern (every 8 trials), handled by the
 * trial-type scheduler.
 */
import { getSessionPRNG } from '../prng.js';
import { onPatternCells, offPatternCells } from '../grid.js';
import { stratifiedRotationAngles, balanceStarLabels } from './rotation-balance.js';
import { drawBlockSequences } from './within-trial.js';
import {
  generateProbeOrders,
  generateFeasibleEncodingPositionMappings,
  buildFixedMemoryLabelsByTrial,
} from './probe-pool.js';
import { pickFeasibleEncodingSet, filterAllowedFoilCells } from './tone-spacing.js';
import { generatePositionBalancedTrials } from './position-balance.js';
import { generateMemoryLabelRows, assertMemoryLabelBalance } from './memory-label-balance.js';
import { balancedShadesForBlock } from './background-shade.js';

const ITEMS_PER_TRIAL = 3;
const STARS_PER_TRIAL = 3;

/**
 * Generate one block of dual-task trials.
 *
 * @param {object}  opts
 * @param {'i_d'|'i_t'} opts.trialType
 * @param {number}  opts.blockSize             trial count (24 for main; smaller for practice)
 * @param {string}  [opts.sequencePoolLabel]   isolates this condition's sequence pool
 * @param {object}  [opts.prng]                session PRNG; defaults to getSessionPRNG()
 * @returns {object[]}                         array of frozen trial-parameter objects
 */
export function generateDualBlock({ trialType, blockSize, sequencePoolLabel, prng } = {}) {
  if (trialType !== 'i_d' && trialType !== 'i_t') {
    throw new Error(`generateDualBlock: trialType must be 'i_d' or 'i_t', got '${trialType}'`);
  }
  if (typeof blockSize !== 'number' || blockSize < 1) {
    throw new Error(`generateDualBlock: blockSize must be ≥ 1, got ${blockSize}`);
  }
  const rng = prng ?? getSessionPRNG();
  const sequences = drawBlockSequences({
    blockSize,
    label: sequencePoolLabel ?? trialType,
    prng: rng,
  });
  const probeOrders = generateProbeOrders(blockSize, rng);
  const encPosMappings = generateFeasibleEncodingPositionMappings(blockSize, probeOrders, rng);
  const rotationAngles = stratifiedRotationAngles(blockSize, rng);
  const fixedMemoryLabelsByTrial = buildFixedMemoryLabelsByTrial(probeOrders, encPosMappings);
  const memoryLabelsByTrial = generateMemoryLabelRows({
    blockSize,
    positions: ITEMS_PER_TRIAL,
    fixedLabelsByTrial: fixedMemoryLabelsByTrial,
    prng: rng,
    /* No trial-level validator: probe-target on/off labels are pinned by
     * `fixedLabelsByTrial` (probe targets force the encoding-position label),
     * so no further trial-level constraint is applied (all-off trials are
     * allowed). */
  });
  assertMemoryLabelBalance(memoryLabelsByTrial, blockSize, 'generateDualBlock');
  const starLabelDraw = generatePositionBalancedTrials({
    labels: ['on', 'off'],
    positions: STARS_PER_TRIAL,
    blockSize,
    prng: rng,
    /* No trial-level validator — see memory-block.js for the all-off
     * concession rationale. Stars use the same balance + concession. */
  });
  /* Re-pair the labels with trials so on/off is also balanced over the six
   * S-slots and the six angle strata (serial-position totals unchanged). */
  const starLabelsByTrial =
    blockSize === 24
      ? balanceStarLabels({
          sequences,
          starLabels: starLabelDraw,
          angles: rotationAngles,
          prng: rng,
        })
      : starLabelDraw;

  const backgroundShades = balancedShadesForBlock(blockSize, rng);
  const trials = [];
  for (let i = 0; i < blockSize; i++) {
    trials.push(
      generateOneTrial(
        i,
        trialType,
        sequences[i],
        probeOrders[i],
        encPosMappings[i],
        rotationAngles[i],
        memoryLabelsByTrial[i],
        starLabelsByTrial[i],
        backgroundShades[i],
        rng
      )
    );
  }
  return trials;
}

function generateOneTrial(
  trialIndex,
  trialType,
  sequence,
  probeOrder,
  encPosMap,
  rotationAngle,
  memoryLabels,
  starLabels,
  backgroundShade,
  rng
) {
  const mSlotIndices = sequence.map((c, idx) => (c === 'M' ? idx : -1)).filter((idx) => idx !== -1);
  const sSlotIndices = sequence.map((c, idx) => (c === 'S' ? idx : -1)).filter((idx) => idx !== -1);
  if (mSlotIndices.length !== ITEMS_PER_TRIAL) {
    throw new Error(
      `dual-block: sequence has ${mSlotIndices.length} M-slots, expected ${ITEMS_PER_TRIAL}`
    );
  }
  if (sSlotIndices.length !== STARS_PER_TRIAL) {
    throw new Error(
      `dual-block: sequence has ${sSlotIndices.length} S-slots, expected ${STARS_PER_TRIAL}`
    );
  }

  /* I+T encodes tones; the tone-spacing rule (≥3 rank gap pairwise across the
   * 3 encoded tones) draws from a count-matched set of valid on/off cell
   * combinations that also leaves enough foil cells for the scheduled
   * F_on/F_off probes. I+D has no tones — uniform random pick is fine. */
  const onCount = memoryLabels.filter((label) => label === 'on').length;
  const offCount = memoryLabels.length - onCount;
  const fOnCount = probeOrder.filter((type) => type === 'F_on').length;
  const fOffCount = probeOrder.filter((type) => type === 'F_off').length;

  let selectedOnCells;
  let selectedOffCells;
  if (trialType === 'i_t') {
    const set = pickFeasibleEncodingSet(rng, {
      onCount,
      offCount,
      minFoilOn: fOnCount,
      minFoilOff: fOffCount,
    });
    selectedOnCells = rng.shuffle(set.onCells.slice());
    selectedOffCells = rng.shuffle(set.offCells.slice());
  } else {
    selectedOnCells = rng.shuffle(onPatternCells().slice()).slice(0, onCount);
    selectedOffCells = rng.shuffle(offPatternCells().slice()).slice(0, offCount);
  }

  const onCellsQueue = selectedOnCells.slice();
  const offCellsQueue = selectedOffCells.slice();
  const memoryItems = mSlotIndices.map((slotIdx, n) => {
    const label = memoryLabels[n];
    const cell = label === 'on' ? onCellsQueue.pop() : offCellsQueue.pop();
    return Object.freeze({
      slot_index_in_seq: slotIdx,
      encoding_position: n,
      cell,
      pattern_label: label,
    });
  });

  /* Probes: targets reference the encoded items at their assigned encoding
   * positions; foils reference cells of the right pattern label that are
   * NOT in the trial's encoded set.
   *
   * For I+T the foil pools are additionally filtered to keep every foil tone
   * ≥ MIN_TONE_GAP_RANKS from every encoded tone (see
   * tone-spacing.js). I+D foils have no auditory component — unconstrained. */
  const itemCells = new Set(memoryItems.map((m) => m.cell));
  const cellsUnavailableToFoils = new Set(itemCells);
  let onFoilPool = onPatternCells().filter((c) => !cellsUnavailableToFoils.has(c));
  let offFoilPool = offPatternCells().filter((c) => !cellsUnavailableToFoils.has(c));
  if (trialType === 'i_t') {
    const encodedCells = memoryItems.map((m) => m.cell);
    onFoilPool = filterAllowedFoilCells(onFoilPool, encodedCells);
    offFoilPool = filterAllowedFoilCells(offFoilPool, encodedCells);
  }
  const onFoilQueue = rng
    .shuffle(onFoilPool)
    .slice(0, probeOrder.filter((type) => type === 'F_on').length);
  const offFoilQueue = rng
    .shuffle(offFoilPool)
    .slice(0, probeOrder.filter((type) => type === 'F_off').length);

  /* Stars: on/off label schedule comes from the block-level counterbalance.
   * Star cells avoid every memory-item cell and every reserved foil cell, so
   * no lure ever lands on a cell that was shown earlier in the trial. */
  const starOnCount = starLabels.filter((label) => label === 'on').length;
  const starOffCount = starLabels.length - starOnCount;
  const unavailableToStars = new Set([...itemCells, ...onFoilQueue, ...offFoilQueue]);
  const starOnQueue = rng
    .shuffle(onPatternCells().filter((c) => !unavailableToStars.has(c)))
    .slice(0, starOnCount);
  const starOffQueue = rng
    .shuffle(offPatternCells().filter((c) => !unavailableToStars.has(c)))
    .slice(0, starOffCount);

  const stars = sSlotIndices.map((slotIdx, n) => {
    const label = starLabels[n];
    const cell = label === 'on' ? starOnQueue.pop() : starOffQueue.pop();
    return Object.freeze({
      slot_index_in_seq: slotIdx,
      probe_position: n /* 0..2, the n-th star in temporal order */,
      cell,
      pattern_label: label,
      is_on_pattern: label === 'on',
    });
  });
  const probes = probeOrder.map((type, position) => {
    const encodingPosition = encPosMap[position];
    if (type === 'T_on' || type === 'T_off') {
      const item = memoryItems[encodingPosition];
      return Object.freeze({
        probe_position: position,
        encoding_position: encodingPosition,
        type,
        cell: item.cell,
        is_target: true,
        pattern_label: item.pattern_label,
      });
    }
    if (type === 'F_on') {
      return Object.freeze({
        probe_position: position,
        encoding_position: encodingPosition,
        type,
        cell: onFoilQueue.pop(),
        is_target: false,
        pattern_label: 'on',
      });
    }
    return Object.freeze({
      probe_position: position,
      encoding_position: encodingPosition,
      type,
      cell: offFoilQueue.pop(),
      is_target: false,
      pattern_label: 'off',
    });
  });

  return Object.freeze({
    trial_type: trialType,
    trial_index_in_block: trialIndex,
    background_shade: backgroundShade,
    rotation_deg: rotationAngle,
    sequence,
    memory_items: Object.freeze(memoryItems),
    stars: Object.freeze(stars),
    probes: Object.freeze(probes),
  });
}
