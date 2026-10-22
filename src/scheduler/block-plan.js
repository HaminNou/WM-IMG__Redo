/**
 * Pure part of block assembly: the order of the trials in a block and the
 * identity fields of each trial. No DOM and no jsPsych, so the same code
 * serves the runtime (`assembleBlock`) and the pilot simulator.
 */
import { getSessionPRNG } from '../prng.js';
import { generateTrialTypeSchedule } from './trial-type.js';
import { arrangeTrialOrder } from './rotation-balance.js';
import { buildTrialMeta } from './trial-meta.js';

/**
 * @param {object} opts
 * @param {string} opts.blockLabel
 * @param {Record<string, object[]>} opts.queues   per-condition trial params (consumed on a copy)
 * @param {Record<string, number>} opts.countsByType
 * @param {number} [opts.runLengthCap]
 * @param {{type: string, length: number}} [opts.previousTail]
 * @param {number} [opts.presentationOffset]       main-task trials presented before this block
 * @param {object} [opts.prng]
 * @returns {{schedule: string[], trialParams: object[]}}
 */
export function planBlockTrials({
  blockLabel,
  queues,
  countsByType,
  runLengthCap,
  previousTail,
  presentationOffset,
  prng,
}) {
  const rng = prng ?? getSessionPRNG();
  const schedule = generateTrialTypeSchedule({
    countsByType,
    runLengthCap,
    prng: rng,
    previousTail,
  });
  const work = {};
  for (const [type, queue] of Object.entries(queues)) work[type] = queue.slice();

  /* Pop the per-type queues in schedule order. For a full main block the
   * trials of one condition are then re-ordered among themselves so that
   * rotation direction and page background do not run on (see
   * `arrangeTrialOrder`); the condition sequence is not changed. */
  let ordered = schedule.map((type, i) => {
    const queue = work[type];
    if (!queue || queue.length === 0) {
      throw new Error(`planBlockTrials: ran out of trial-params for type '${type}' at slot ${i}`);
    }
    return queue.shift();
  });
  if (ordered.length >= 20) ordered = arrangeTrialOrder(ordered, rng);

  const trialParams = ordered.map((raw, i) => {
    const trial_meta = buildTrialMeta({
      condition: schedule[i],
      block_label: blockLabel,
      block_position: i,
      presentation_index: presentationOffset === undefined ? null : presentationOffset + i + 1,
      pool_index: raw.trial_index_in_block,
    });
    return Object.freeze({ ...raw, trial_meta });
  });
  return { schedule, trialParams };
}

export function trailingRun(schedule) {
  const last = schedule[schedule.length - 1];
  let length = 0;
  for (let i = schedule.length - 1; i >= 0 && schedule[i] === last; i--) length += 1;
  return { type: last, length };
}
