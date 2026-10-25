/**
 * Per-block trial-parameter generator for D-only and T-only.
 *
 * Wraps `within-trial.js` (encoding sequence) and `probe-pool.js`
 * (T_on/T_off/F_on/F_off counterbalance) into a single call that returns one
 * block's worth of fully-specified trial parameters. The conditions modules
 * (`d_only.js`, `t_only.js`) consume this output and translate each trial
 * spec into a jsPsych timeline.
 *
 * Per trial:
 *   - 3 memory items per trial: their on/off-pattern labels are balanced
 *     across the block rather than fixed at the trial level. A given trial
 *     can therefore contain 1, 2, or 3 on-pattern items so long as its
 *     target-probe schedule remains feasible.
 *   - 3 probes per trial drawn from the canonical types:
 *       T_on / T_off — must match encoded on/off items from this trial
 *       F_on / F_off — must NOT match any encoded item, and must have the
 *                      stated label
 *     Probe-type balance is enforced across the block by probe position,
 *     not within every individual trial: across 24 trials each
 *     (probe_type × probe_position) cell hits exactly 6 times
 *     (4 types × 3 positions = 12 cells; 24 × 3 / 12 = 6 per cell).
 *   - Probe presentation order from `generateProbeOrders` (3 probes per
 *     trial drawn from the four labels T_on/T_off/F_on/F_off, types may
 *     repeat within a trial, balanced per position over 24 trials).
 *   - 3 dummy events per trial (open squares, slot-matched to where stars
 *     would appear in the dual-task version) — cells drawn from non-centre
 *     cells not already used by the trial's memory items.
 *   - Foils never reuse a cell already shown earlier in the trial.
 */
import { getSessionPRNG } from '../prng.js';
import { stratifiedRotationAngles } from './rotation-balance.js';
import { onPatternCells, offPatternCells, nonCentreCells } from '../grid.js';
import { drawBlockSequences } from './within-trial.js';
import {
  generateProbeOrders,
  generateFeasibleEncodingPositionMappings,
  buildFixedMemoryLabelsByTrial,
} from './probe-pool.js';
import { pickFeasibleEncodingSet, filterAllowedFoilCells } from './tone-spacing.js';
import { generateMemoryLabelRows, assertMemoryLabelBalance } from './memory-label-balance.js';
import { balancedShadesForBlock } from './background-shade.js';

const ITEMS_PER_TRIAL = 3;

/**
 * Generate one block of D-only or T-only trials.
 *
 * @param {object} opts
 * @param {'d_only'|'t_only'} opts.trialType
 * @param {number} opts.blockSize     trial count (24 for main block; smaller for practice)
 * @param {string} opts.sequencePoolLabel  isolates this condition's sequence pool
 * @param {object} [opts.prng]        session PRNG; defaults to getSessionPRNG()
 * @returns {object[]}  array of trial parameters; see field doc below
 */
export function generateMemoryBlock({ trialType, blockSize, sequencePoolLabel, prng } = {}) {
  if (trialType !== 'd_only' && trialType !== 't_only') {
    throw new Error(
      `generateMemoryBlock: trialType must be 'd_only' or 't_only', got '${trialType}'`
    );
  }
  const rng = prng ?? getSessionPRNG();
  const sequences = drawBlockSequences({
    blockSize,
    label: sequencePoolLabel ?? trialType,
    prng: rng,
  });
  const probeOrders = generateProbeOrders(blockSize, rng);
  /* Same plan as the dual-task blocks: each probe is tied to an encoding
   * position, the probed item's on/off label is pinned by the probe type,
   * and the remaining labels fill the block-level 12 / 12 schedule. */
  const encPosMappings = generateFeasibleEncodingPositionMappings(blockSize, probeOrders, rng);
  const memoryLabelsByTrial = generateMemoryLabelRows({
    blockSize,
    positions: ITEMS_PER_TRIAL,
    fixedLabelsByTrial: buildFixedMemoryLabelsByTrial(probeOrders, encPosMappings),
    prng: rng,
  });
  assertMemoryLabelBalance(memoryLabelsByTrial, blockSize, 'generateMemoryBlock');

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
        memoryLabelsByTrial[i],
        backgroundShades[i],
        rng
      )
    );
  }
  if (trialType !== 'd_only') return trials;
  /* D-only trials show the grid turned by an angle drawn like the imagery
   * conditions' angles, so dot positions on screen are comparable across
   * conditions. The angles are drawn after every per-trial draw above, so
   * those draws are identical with or without the rotation. */
  const displayRotations = stratifiedRotationAngles(blockSize, rng);
  return trials.map((trial, i) =>
    Object.freeze({ ...trial, display_rotation_deg: displayRotations[i] })
  );
}

function generateOneTrial(
  trialIndex,
  trialType,
  sequence,
  probeOrder,
  encPosMap,
  memoryLabels,
  backgroundShade,
  rng
) {
  /* T-only encodes tones; the tone-spacing rule (≥3 rank gap pairwise across
   * the 3 encoded tones) draws from a count-matched set of valid on/off cell
   * combinations. D-only has no tones — uniform random pick is fine. */
  const onCount = memoryLabels.filter((label) => label === 'on').length;
  const offCount = memoryLabels.length - onCount;
  const fOnCount = probeOrder.filter((type) => type === 'F_on').length;
  const fOffCount = probeOrder.filter((type) => type === 'F_off').length;

  let selectedOnCells;
  let selectedOffCells;
  if (trialType === 't_only') {
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

  /* Map M-slot positions in the sequence to the 3 chosen items. We
   * randomise *which* M-slot gets which item so encoding-position is
   * counterbalanced across the block. */
  const mSlotIndices = sequence.map((c, idx) => (c === 'M' ? idx : -1)).filter((idx) => idx !== -1);
  if (mSlotIndices.length !== ITEMS_PER_TRIAL) {
    throw new Error(
      `generateOneTrial: sequence has ${mSlotIndices.length} M-slots, expected ${ITEMS_PER_TRIAL}`
    );
  }
  const onCellQueue = selectedOnCells.slice();
  const offCellQueue = selectedOffCells.slice();

  const memoryItems = mSlotIndices.map((slotIdx, n) => {
    const label = memoryLabels[n];
    const cell = label === 'on' ? onCellQueue.pop() : offCellQueue.pop();
    return Object.freeze({
      slot_index_in_seq: slotIdx,
      encoding_position: n /* 0..2, the n-th memory item in temporal order */,
      cell,
      pattern_label: label,
    });
  });

  const itemCells = memoryItems.map((item) => item.cell);
  const cellsUnavailableToFoils = new Set(itemCells);
  let onFoilPool = onPatternCells().filter((c) => !cellsUnavailableToFoils.has(c));
  let offFoilPool = offPatternCells().filter((c) => !cellsUnavailableToFoils.has(c));
  if (trialType === 't_only') {
    onFoilPool = filterAllowedFoilCells(onFoilPool, itemCells);
    offFoilPool = filterAllowedFoilCells(offFoilPool, itemCells);
  }
  const onFoilQueue = rng.shuffle(onFoilPool).slice(0, fOnCount);
  const offFoilQueue = rng.shuffle(offFoilPool).slice(0, fOffCount);

  /* Dummy cells (open squares) — drawn from non-centre cells not already
   * used by the memory items or reserved for later foil probes. This keeps
   * every foil cell unique within the trial even though the dummies appear
   * earlier in time. */
  const sSlotIndices = sequence.map((c, idx) => (c === 'S' ? idx : -1)).filter((idx) => idx !== -1);
  const usedCells = new Set([...itemCells, ...onFoilQueue, ...offFoilQueue]);
  const candidatePool = rng.shuffle(nonCentreCells().filter((c) => !usedCells.has(c)));
  const dummyCells = candidatePool.slice(0, sSlotIndices.length);
  const dummies = sSlotIndices.map((slotIdx, n) =>
    Object.freeze({
      slot_index_in_seq: slotIdx,
      cell: dummyCells[n],
    })
  );

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
    const isOn = type === 'F_on';
    return Object.freeze({
      probe_position: position,
      encoding_position: encodingPosition,
      type,
      cell: isOn ? onFoilQueue.pop() : offFoilQueue.pop(),
      is_target: false,
      pattern_label: isOn ? 'on' : 'off',
    });
  });

  return Object.freeze({
    trial_type: trialType,
    trial_index_in_block: trialIndex,
    background_shade: backgroundShade,
    sequence,
    memory_items: Object.freeze(memoryItems),
    dummies: Object.freeze(dummies),
    probes: Object.freeze(probes),
  });
}
