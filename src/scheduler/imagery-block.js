/**
 * Per-block trial-parameter generator for the I-only (imagery-only) condition.
 *
 * Reuses the shared 14-string within-trial sampler (`within-trial.js`) but
 * inverts the slot semantics relative to D-only / T-only: in I-only, the
 * **S-slots carry the real stars** (the imagery probe stimuli) and the
 * **M-slots carry dummies** (event-rate fillers participants are told to
 * ignore).
 *
 * I-only dummies are uniform **open-square visual placeholders** — the
 * same primitive used by D-only and T-only's S-slot fillers. An empty
 * outline square in a non-star cell is the single I-only filler stimulus
 * across all trials. This (a) makes the participant-visible structure of
 * the three single-task conditions parallel ("3 targets + 3 empty
 * squares"), and (b) keeps the data record simple (no `dummy_mode`
 * field).
 *
 * Each star is judged on/off the rotated pattern. Star
 * on/off labels are balanced across the block by serial position rather
 * than fixed within every trial, so any given trial can contain a different
 * mix while the block total remains balanced.
 *
 * Each trial carries:
 *   - 3 stars: on/off labels from the block-level schedule, assigned to S-slots
 *   - 3 dummies: open-square outlines at non-star non-centre cells
 *   - 1 rotation angle, sampled uniformly from -90° to +90°
 *
 * Note: this generator does NOT emit pattern-phase events — pattern
 * presentation is a block-level concern (every 8 trials),
 * handled by the trial-type scheduler alongside the cross-condition
 * run-length cap.
 */
import { getSessionPRNG } from '../prng.js';
import { onPatternCells, offPatternCells, nonCentreCells } from '../grid.js';
import { stratifiedRotationAngles, balanceStarLabels } from './rotation-balance.js';
import { drawBlockSequences } from './within-trial.js';
import { generatePositionBalancedTrials } from './position-balance.js';
import { balancedShadesForBlock } from './background-shade.js';

const STARS_PER_TRIAL = 3;

/**
 * Generate one block of I-only trials.
 *
 * @param {object}  opts
 * @param {number}  opts.blockSize            trial count (24 for main; smaller for practice)
 * @param {string}  [opts.sequencePoolLabel]  isolates this condition's sequence pool
 * @param {object}  [opts.prng]               session PRNG; defaults to getSessionPRNG()
 * @returns {object[]}                        array of frozen trial-parameter objects
 */
export function generateImageryBlock({ blockSize, sequencePoolLabel, prng } = {}) {
  if (typeof blockSize !== 'number' || blockSize < 1) {
    throw new Error(`generateImageryBlock: blockSize must be ≥ 1, got ${blockSize}`);
  }
  const rng = prng ?? getSessionPRNG();
  const sequences = drawBlockSequences({
    blockSize,
    label: sequencePoolLabel ?? 'i_only',
    prng: rng,
  });
  const rotationAngles = stratifiedRotationAngles(blockSize, rng);
  const starLabelDraw = generatePositionBalancedTrials({
    labels: ['on', 'off'],
    positions: STARS_PER_TRIAL,
    blockSize,
    prng: rng,
    /* No trial-level validator: all-off trials are allowed. */
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
        sequences[i],
        rotationAngles[i],
        starLabelsByTrial[i],
        backgroundShades[i],
        rng
      )
    );
  }
  return trials;
}

function generateOneTrial(trialIndex, sequence, rotationAngle, starLabels, backgroundShade, rng) {
  /* Stars go in S-slots (the imagery probe positions). Their on/off labels
   * come from the block-level schedule; actual cells are drawn without
   * replacement from the corresponding on/off pools. */
  const onCount = starLabels.filter((label) => label === 'on').length;
  const offCount = starLabels.length - onCount;
  const onCellsPicked = rng.shuffle(onPatternCells().slice()).slice(0, onCount);
  const offCellsPicked = rng.shuffle(offPatternCells().slice()).slice(0, offCount);
  const onCellsQueue = onCellsPicked.slice();
  const offCellsQueue = offCellsPicked.slice();

  const sSlotIndices = sequence.map((c, idx) => (c === 'S' ? idx : -1)).filter((idx) => idx !== -1);
  if (sSlotIndices.length !== STARS_PER_TRIAL) {
    throw new Error(
      `imagery-block: sequence has ${sSlotIndices.length} S-slots, expected ${STARS_PER_TRIAL}`
    );
  }

  /* Rotation contract — `is_on_pattern` is defined by cell index against the
   * UPRIGHT on-pattern set, so it is rotation-invariant for a given cell.
   * What the rotation actually changes is the SCREEN POSITION at which the
   * star is rendered: `addStar(...)` places the polygon at
   * `rotatedCellCentreMm(cell, rotation_deg)`, so cell N moves to a different
   * pixel on screen as `rotation_deg` changes. The participant therefore sees
   * a fixed pixel position occupied by different cells across trials, and the
   * pattern membership of that fixed pixel position flips trial-to-trial —
   * even though the underlying rule (cell N is on-pattern iff N ∈
   * onPatternCells()) is stable. */
  const stars = sSlotIndices.map((slotIdx, n) => {
    const label = starLabels[n];
    const cell = label === 'on' ? onCellsQueue.pop() : offCellsQueue.pop();
    return Object.freeze({
      slot_index_in_seq: slotIdx,
      probe_position: n /* 0..2, the n-th star in temporal order */,
      cell,
      pattern_label: label,
      is_on_pattern: label === 'on',
    });
  });

  /* Dummies go in M-slots: open-square outlines at non-centre cells
   * disjoint from the star cells, mirroring D-only / T-only's filler
   * semantics. */
  const mSlotIndices = sequence.map((c, idx) => (c === 'M' ? idx : -1)).filter((idx) => idx !== -1);
  const usedCells = new Set(stars.map((star) => star.cell));
  const candidatePool = rng.shuffle(nonCentreCells().filter((c) => !usedCells.has(c)));
  const dummyCells = candidatePool.slice(0, mSlotIndices.length);
  const dummies = mSlotIndices.map((slotIdx, n) =>
    Object.freeze({
      slot_index_in_seq: slotIdx,
      cell: dummyCells[n],
    })
  );

  return Object.freeze({
    trial_type: 'i_only',
    trial_index_in_block: trialIndex,
    background_shade: backgroundShade,
    rotation_deg: rotationAngle,
    sequence,
    stars: Object.freeze(stars),
    dummies: Object.freeze(dummies),
  });
}
