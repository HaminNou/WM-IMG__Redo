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
 *   - Bound: no imagery trial starts more than F + 1 trials after the last
 *     reminder.
 *   - Within those rules the reminders are placed so that I-only, I+D and I+T
 *     end up with the fewest possible difference in reminder exposure: the
 *     planner searches all placements that satisfy the rules above (dynamic
 *     programming over the windows, carrying the per-condition counts of the
 *     whole session) and keeps the smallest final difference between the
 *     conditions' counts, which is at most one for the block planned together
 *     with the counts it starts from. The whole-session guarantee is made by
 *     `generateMainPlan` (main-plan.js), which plans Main B on Main A's counts and
 *     draws the plan again until the totals of both blocks differ by at most
 *     one. Among placements that reach
 *     that optimum it takes, window by window, the imagery trial whose
 *     condition has had the fewest reminders so far (ties: earliest). The
 *     difference is exactly one rather than zero whenever the session's
 *     number of reminders is not a multiple of three.
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

  /* Windows that contain at least one imagery trial, each with its imagery slots. */
  const windows = [];
  for (let start = 0; start < n; start += freq) {
    const end = Math.min(n, start + freq);
    const candidates = [];
    for (let j = start; j < end; j++) {
      if (IMAGERY_BEARING_TYPES.has(schedule[j])) candidates.push(j);
    }
    if (candidates.length > 0) windows.push(candidates);
  }
  const imagery = [];
  for (let j = 0; j < n; j++) if (IMAGERY_BEARING_TYPES.has(schedule[j])) imagery.push(j);

  /* A reminder at `p`, after the previous one at `last`, is allowed if no
   * imagery trial strictly between them starts more than maxGap after `last`
   * (the first reminder of the block must sit on the first imagery trial). */
  const placeOk = (last, p) => {
    if (last === null) return p === imagery[0];
    for (const j of imagery) if (j > last && j < p && j - last > maxGap) return false;
    return true;
  };
  /* After the final reminder, the imagery trials that remain must be in range. */
  const tailOk = (last) => {
    if (last === null) return imagery.length === 0;
    for (const j of imagery) if (j > last && j - last > maxGap) return false;
    return true;
  };

  const kinds = REMINDER_CONDITIONS;
  const kindOf = (j) => kinds.indexOf(schedule[j]);
  const spreadOf = (c) => Math.max(...c) - Math.min(...c);
  /* Smallest final spread of the per-condition counts reachable from window
   * `w` onward, given the last reminder position and the counts so far. */
  const memo = new Map();
  const bestSpread = (w, last, c) => {
    if (w === windows.length) return tailOk(last) ? spreadOf(c) : Infinity;
    const key = `${w}|${last}|${c.join(',')}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let best = Infinity;
    for (const p of windows[w]) {
      if (!placeOk(last, p)) continue;
      const next = c.slice();
      next[kindOf(p)] += 1;
      const v = bestSpread(w + 1, p, next);
      if (v < best) best = v;
    }
    memo.set(key, best);
    return best;
  };

  let last = null;
  const running = kinds.map((k) => tally[k]);
  for (let w = 0; w < windows.length; w++) {
    const optimum = bestSpread(w, last, running);
    let pick = null;
    for (const p of windows[w]) {
      if (!placeOk(last, p)) continue;
      const next = running.slice();
      next[kindOf(p)] += 1;
      if (bestSpread(w + 1, p, next) !== optimum) continue;
      if (pick === null || running[kindOf(p)] < running[kindOf(pick)]) pick = p;
    }
    if (pick === null) throw new Error('planPatternReminders: no placement satisfies the rules');
    reminded[pick] = true;
    running[kindOf(pick)] += 1;
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
