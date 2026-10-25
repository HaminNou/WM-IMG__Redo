/**
 * Pure part of block assembly: the order of the trials in a block and the
 * identity fields of each trial. No DOM and no jsPsych, so the same code
 * serves the runtime (`assembleBlock`) and the pilot simulator.
 */
import { getSessionPRNG } from '../prng.js';
import { generateTrialTypeSchedule } from './trial-type.js';
import { arrangeTrialOrder } from './rotation-balance.js';
import { buildTrialMeta } from './trial-meta.js';
import { planPatternReminders } from './pattern-reminders.js';

/**
 * @param {object} opts
 * @param {string} opts.blockLabel
 * @param {Record<string, object[]>} opts.queues   per-condition trial params (consumed on a copy)
 * @param {Record<string, number>} opts.countsByType
 * @param {number} [opts.runLengthCap]
 * @param {{type: string, length: number}} [opts.previousTail]
 * @param {number} [opts.presentationOffset]       main-task trials presented before this block
 * @param {number} [opts.patternPhaseFrequency]  window length of the reminder planner (default config)
 * @param {object} [opts.reminderCounts]          reminders already given per imagery condition earlier
 *                                                in the session (Main B receives Main A's)
 * @param {object} [opts.prng]
 * @returns {{schedule: string[], trialParams: object[], reminderCounts: object}}
 */
export function planBlockTrials({
  blockLabel,
  queues,
  countsByType,
  runLengthCap,
  previousTail,
  presentationOffset,
  patternPhaseFrequency,
  reminderCounts,
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

  /* Which trials carry the pattern reminder: a function of the type sequence
   * only (see pattern-reminders.js), so it is part of the pure plan and the
   * pilot simulator sees the same decision as the runtime. */
  const reminders = planPatternReminders({
    schedule,
    frequency: patternPhaseFrequency,
    counts: reminderCounts,
  });

  const trialParams = ordered.map((raw, i) => {
    const trial_meta = buildTrialMeta({
      condition: schedule[i],
      block_label: blockLabel,
      block_position: i,
      presentation_index: presentationOffset === undefined ? null : presentationOffset + i + 1,
      pool_index: raw.trial_index_in_block,
      pattern_reminder: reminders.reminded[i],
      trials_since_pattern_reminder: reminders.since[i],
    });
    return Object.freeze({ ...raw, trial_meta });
  });
  return { schedule, trialParams, reminderCounts: reminders.counts };
}

export function trailingRun(schedule) {
  const last = schedule[schedule.length - 1];
  let length = 0;
  for (let i = schedule.length - 1; i >= 0 && schedule[i] === last; i--) length += 1;
  return { type: last, length };
}
