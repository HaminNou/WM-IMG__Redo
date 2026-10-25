/**
 * Pattern-reminder planner: which trials of a block carry the 4 s reminder of
 * the gray imagery pattern.
 *
 * Why the reminders exist. The star judgements (is this star on the pattern?)
 * depend on a mental image of the pattern, which the participant has to keep
 * fresh over a 60-trial block. The reminder is mounted inside an
 * imagery-bearing trial (i_only / i_d / i_t), right after the trial-start
 * gate (see `assembleBlock`).
 *
 * Why not "every 8th trial". The trial order is random, so the 8th, 16th, ...
 * slot is a memory-only trial (d_only / t_only) about 40 % of the time. The
 * old rule dropped the reminder then, so a session got 9.5 reminders on average
 * (4 to 14), and an imagery trial could come 60 trials after the last
 * reminder. Delivering the reminder before memory-only trials instead would
 * show a pattern the participant does not need and break up memory trials.
 *
 * The scheme (windowed, condition-balanced):
 *   - The block is cut into windows of F trials (F =
 *     `config.pattern.pattern_phase_frequency_trials`, 8): slots 0..F-1,
 *     F..2F-1, ...
 *   - One reminder is due per window and is delivered to ONE imagery-bearing
 *     trial inside it. A window with no imagery trial has none.
 *   - The first imagery trial of a block is always reminded (the block starts
 *     after instructions or a rest).
 *   - Among the imagery trials of the window, the reminder goes to the one
 *     whose condition has had the fewest reminders so far in the session
 *     (ties: earliest). I-only, I+D and I+T therefore get the same reminder
 *     exposure (counts differ by one or two), instead of a random split.
 *   - Bound: no imagery trial starts more than F + 1 trials after the last
 *     reminder. The delivery is brought forward to the first imagery trial
 *     that would otherwise break the bound.
 *
 * Everything is a function of the (seeded) trial-type schedule: no extra
 * randomness, so the same seed gives the same reminders, and the plan can be
 * rebuilt from the stored seed. The decision is written to every row of the
 * trial (`pattern_reminder`, `trials_since_pattern_reminder`) by
 * `planBlockTrials`.
 *
 * Monte Carlo comparison with the alternatives:
 * `scripts/pattern-reminder-montecarlo.js`.
 */
import { config } from '../config.js';

export const IMAGERY_BEARING_TYPES = Object.freeze(new Set(['i_only', 'i_d', 'i_t']));
export const REMINDER_CONDITIONS = Object.freeze(['i_only', 'i_d', 'i_t']);

/** Longest allowed wait, in trials, between the last reminder and an imagery trial. */
export function maxGapTrials(frequency = config.pattern.pattern_phase_frequency_trials) {
  return frequency + 1;
}

export function emptyReminderCounts() {
  return { i_only: 0, i_d: 0, i_t: 0 };
}

/**
 * @param {object} opts
 * @param {string[]} opts.schedule     trial types of the block, in presentation order
 * @param {number} [opts.frequency]    window length F (default from config)
 * @param {{i_only: number, i_d: number, i_t: number}} [opts.counts]
 *                                     reminders already given per imagery condition earlier in
 *                                     the session (Main A passes nothing; Main B passes A's)
 * @returns {{reminded: boolean[], since: (number|null)[], counts: object}}
 *   reminded[i]  the trial in slot i carries the reminder
 *   since[i]     trials since the last reminder (0 on a reminded trial); null for memory-only
 *                trials and for imagery trials before the first reminder (cannot happen: the
 *                first imagery trial is always reminded)
 *   counts       updated per-condition reminder counts (a new object)
 */
export function planPatternReminders({ schedule, frequency, counts } = {}) {
  const freq = frequency ?? config.pattern.pattern_phase_frequency_trials;
  if (!Array.isArray(schedule)) {
    throw new Error('planPatternReminders: schedule must be an array of trial types');
  }
  if (!Number.isInteger(freq) || freq < 1) {
    throw new Error(`planPatternReminders: frequency must be an integer ≥ 1, got ${freq}`);
  }
  const maxGap = maxGapTrials(freq);
  const tally = { ...emptyReminderCounts(), ...(counts ?? {}) };
  const n = schedule.length;
  const reminded = new Array(n).fill(false);

  let last = null;
  for (let start = 0; start < n; start += freq) {
    const end = Math.min(n, start + freq);
    const candidates = [];
    for (let j = start; j < end; j++) {
      if (IMAGERY_BEARING_TYPES.has(schedule[j])) candidates.push(j);
    }
    if (candidates.length === 0) continue;

    /* Latest allowed delivery: the end of the window, brought forward to the
     * first imagery trial that would otherwise start more than maxGap trials
     * after the last reminder. The first imagery trial of the block is always
     * reminded. */
    let deadline = candidates[candidates.length - 1];
    if (last === null) {
      deadline = candidates[0];
    } else {
      const forced = candidates.find((j) => j - last > maxGap);
      if (forced !== undefined) deadline = Math.min(deadline, forced);
    }
    const eligible = candidates.filter((j) => j <= deadline);

    let pick = eligible[0];
    for (const j of eligible) {
      if (tally[schedule[j]] < tally[schedule[pick]]) pick = j;
    }
    reminded[pick] = true;
    tally[schedule[pick]] += 1;
    last = pick;
  }

  const since = new Array(n).fill(null);
  let lastSeen = null;
  for (let i = 0; i < n; i++) {
    if (reminded[i]) lastSeen = i;
    if (IMAGERY_BEARING_TYPES.has(schedule[i]) && lastSeen !== null) since[i] = i - lastSeen;
  }
  return { reminded, since, counts: tally };
}
