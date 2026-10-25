/**
 * Pattern-reminder schedule (src/scheduler/pattern-reminders.js).
 *
 * The trial order is random, so a fixed "every 8th slot" rule lands on a
 * memory-only trial about 40 % of the time. The planner puts one reminder in
 * every window of F trials, on an imagery trial, balanced across the three
 * imagery conditions, with a hard bound on how long an imagery trial can wait.
 * These tests check those guarantees on the real main plans of many seeds
 * (same code path as the runtime) plus the planner's edge cases.
 */
import { describe, it, expect } from 'vitest';
import { createPRNG } from '../src/prng.js';
import { config } from '../src/config.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import {
  IMAGERY_BEARING_TYPES,
  REMINDER_CONDITIONS,
  maxGapTrials,
  planPatternReminders,
} from '../src/scheduler/pattern-reminders.js';

const F = config.pattern.pattern_phase_frequency_trials;
const N_SEEDS = 150;

function planFor(seed) {
  resetSequencePools();
  return generateMainPlan({ prng: createPRNG(`pattern-reminder-${seed}`) });
}

function flags(plan) {
  return [plan.mainA, plan.mainB].map((b) =>
    b.trialParams.map((p) => ({
      reminded: p.trial_meta.pattern_reminder,
      since: p.trial_meta.trials_since_pattern_reminder,
      type: p.trial_meta.condition,
    }))
  );
}

describe('planPatternReminders: unit behaviour', () => {
  it('rejects a bad schedule or frequency', () => {
    expect(() => planPatternReminders({ schedule: 'x' })).toThrow(/array/);
    expect(() => planPatternReminders({ schedule: ['i_d'], frequency: 0 })).toThrow(/≥ 1/);
    expect(() => planPatternReminders({ schedule: ['i_d'], frequency: 2.5 })).toThrow(/≥ 1/);
  });

  it('reminds the first imagery trial even when slot 0 is memory-only', () => {
    const r = planPatternReminders({ schedule: ['d_only', 't_only', 'i_d', 'd_only'] });
    expect(r.reminded).toEqual([false, false, true, false]);
    expect(r.since).toEqual([null, null, 0, null]);
  });

  it('gives a block without imagery trials no reminder', () => {
    const r = planPatternReminders({ schedule: ['d_only', 't_only', 'd_only'] });
    expect(r.reminded.some(Boolean)).toBe(false);
    expect(r.since.every((v) => v === null)).toBe(true);
  });

  it('skips a window that holds no imagery trial and still bounds the next wait', () => {
    /* window 1 (slots 8-15) is memory-only; the imagery trial at slot 16 is
     * far past the last reminder, so it must be reminded */
    const schedule = [
      'i_d',
      ...Array(15).fill('d_only'),
      'i_t',
      'i_only',
      ...Array(6).fill('t_only'),
    ];
    const r = planPatternReminders({ schedule });
    expect(r.reminded[0]).toBe(true);
    expect(r.reminded[16]).toBe(true);
    expect(r.reminded.filter(Boolean)).toHaveLength(2);
    expect(r.since[17]).toBe(1);
  });

  it('brings a delivery forward when the wait bound would otherwise break', () => {
    /* frequency 4 → bound 5. Reminder at slot 0 (i_d). Window 1 (slots 4-7):
     * imagery trials at 4..7; slot 6 would wait 6 > 5 trials, so the reminder
     * is at slot 6 at the latest. With the tie-break on counts the planner
     * prefers an i_t / i_only trial (fewer reminders so far). */
    const schedule = ['i_d', 'd_only', 'd_only', 'd_only', 'i_d', 'i_d', 'i_t', 'i_only'];
    const r = planPatternReminders({ schedule, frequency: 4 });
    const second = r.reminded.indexOf(true, 1);
    expect(second).toBeLessThanOrEqual(6);
    expect(['i_t', 'i_only']).toContain(schedule[second]);
    for (let i = 0; i < schedule.length; i++) {
      if (IMAGERY_BEARING_TYPES.has(schedule[i])) {
        expect(r.since[i]).toBeLessThanOrEqual(maxGapTrials(4));
      }
    }
  });

  it('balances conditions using the counts carried over from an earlier block', () => {
    const schedule = ['i_only', 'i_d', 'i_t', 'd_only', 'i_only', 'i_d', 'i_t', 'd_only'];
    const r = planPatternReminders({ schedule, counts: { i_only: 5, i_d: 5, i_t: 0 } });
    /* slot 0 is forced (first imagery trial); the window's single reminder is
     * the first imagery trial, whatever its condition */
    expect(r.reminded[0]).toBe(true);
    const second = planPatternReminders({
      schedule: ['d_only', 'i_only', 'i_d', 'i_t'],
      counts: { i_only: 5, i_d: 5, i_t: 0 },
    });
    /* first imagery trial (slot 1) is always reminded regardless of counts */
    expect(second.reminded).toEqual([false, true, false, false]);
    /* later windows follow the counts: i_t has the fewest reminders */
    const later = planPatternReminders({
      schedule: [
        'i_d',
        'd_only',
        'd_only',
        'd_only',
        'd_only',
        'd_only',
        'd_only',
        'd_only',
        'i_only',
        'i_d',
        'i_t',
      ],
      counts: { i_only: 3, i_d: 3, i_t: 0 },
    });
    expect(later.reminded[10]).toBe(true);
    expect(later.counts.i_t).toBe(1);
  });

  it('does not mutate the counts it is given', () => {
    const counts = { i_only: 1, i_d: 2, i_t: 3 };
    planPatternReminders({ schedule: ['i_d', 'i_t'], counts });
    expect(counts).toEqual({ i_only: 1, i_d: 2, i_t: 3 });
  });
});

describe(`pattern reminders on real main plans (${N_SEEDS} seeds)`, () => {
  const sessions = [];
  for (let s = 0; s < N_SEEDS; s++) sessions.push(flags(planFor(s)));

  it('only imagery trials carry a reminder; memory-only trials never do', () => {
    for (const blocks of sessions) {
      for (const block of blocks) {
        for (const t of block) {
          if (t.reminded) expect(IMAGERY_BEARING_TYPES.has(t.type)).toBe(true);
          if (!IMAGERY_BEARING_TYPES.has(t.type)) expect(t.since).toBeNull();
        }
      }
    }
  });

  it('the first imagery trial of each block is reminded', () => {
    for (const blocks of sessions) {
      for (const block of blocks) {
        const first = block.find((t) => IMAGERY_BEARING_TYPES.has(t.type));
        expect(first.reminded).toBe(true);
        expect(first.since).toBe(0);
      }
    }
  });

  it(`no imagery trial starts more than ${maxGapTrials()} trials after the last reminder`, () => {
    let worst = 0;
    for (const blocks of sessions) {
      for (const block of blocks) {
        for (const t of block) {
          if (IMAGERY_BEARING_TYPES.has(t.type)) worst = Math.max(worst, t.since);
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(maxGapTrials());
  });

  it('every block gets one reminder per window of F trials that holds an imagery trial', () => {
    let sessionsOf16 = 0;
    for (const blocks of sessions) {
      let total = 0;
      for (const block of blocks) {
        let windowsWithImagery = 0;
        for (let w = 0; w < block.length; w += F) {
          if (block.slice(w, w + F).some((t) => IMAGERY_BEARING_TYPES.has(t.type))) {
            windowsWithImagery += 1;
          }
        }
        const n = block.filter((t) => t.reminded).length;
        expect(n).toBe(windowsWithImagery);
        total += n;
      }
      expect(total).toBeGreaterThanOrEqual(14);
      expect(total).toBeLessThanOrEqual(16);
      if (total === 16) sessionsOf16 += 1;
    }
    /* a window with no imagery trial is rare (about 4 % of sessions lose one) */
    expect(sessionsOf16 / N_SEEDS).toBeGreaterThan(0.9);
  });

  it('I-only, I+D and I+T get the fewest-possible difference in reminder exposure', () => {
    /* The planner searches all rule-abiding placements for the smallest final
     * difference between the conditions' counts, so it is at most 1 in EVERY
     * session (and 0 when the session total is a multiple of 3). Measured over
     * 600 seeds: 28 sessions with 0, 572 with 1, none higher. */
    const spreads = [];
    const totals = { i_only: 0, i_d: 0, i_t: 0 };
    for (const blocks of sessions) {
      const c = { i_only: 0, i_d: 0, i_t: 0 };
      for (const block of blocks) for (const t of block) if (t.reminded) c[t.type] += 1;
      const v = REMINDER_CONDITIONS.map((k) => c[k]);
      spreads.push(Math.max(...v) - Math.min(...v));
      for (const k of REMINDER_CONDITIONS) totals[k] += c[k];
      const sum = v.reduce((a, b) => a + b, 0);
      if (sum % 3 === 0) expect(Math.max(...v) - Math.min(...v)).toBe(0);
    }
    expect(Math.max(...spreads)).toBeLessThanOrEqual(1);
    /* no condition is favoured on average over seeds (measured: 5.34 / 5.32 / 5.30) */
    const means = REMINDER_CONDITIONS.map((k) => totals[k] / N_SEEDS);
    expect(Math.max(...means) - Math.min(...means)).toBeLessThan(0.2);
  });

  it('reaches the smallest spread that any rule-abiding placement can reach (brute force)', () => {
    const types = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];
    const isImagery = (t) => IMAGERY_BEARING_TYPES.has(t);
    const rng = createPRNG('reminder-bruteforce');
    const maxGap = maxGapTrials(F);
    for (let trial = 0; trial < 150; trial++) {
      const schedule = Array.from({ length: 24 }, () => types[rng.int(types.length)]);
      const counts = { i_only: rng.int(4), i_d: rng.int(4), i_t: rng.int(4) };
      /* independent enumeration of every placement: one imagery trial per window that has one */
      const windows = [];
      for (let w = 0; w < schedule.length; w += F) {
        const c = [];
        for (let j = w; j < Math.min(schedule.length, w + F); j++)
          if (isImagery(schedule[j])) c.push(j);
        if (c.length) windows.push(c);
      }
      const imagery = schedule.map((t, j) => (isImagery(t) ? j : -1)).filter((j) => j >= 0);
      let bestSpread = Infinity;
      const walk = (w, picks) => {
        if (w === windows.length) {
          /* validity: first imagery trial reminded; every imagery trial within maxGap of a reminder */
          if (picks.length === 0 || picks[0] !== imagery[0]) return;
          for (const j of imagery) {
            const prior = picks.filter((p) => p <= j);
            if (prior.length === 0 || j - Math.max(...prior) > maxGap) return;
          }
          const c = { ...counts };
          for (const p of picks) c[schedule[p]] += 1;
          const v = Object.values(c);
          bestSpread = Math.min(bestSpread, Math.max(...v) - Math.min(...v));
          return;
        }
        for (const p of windows[w]) walk(w + 1, [...picks, p]);
      };
      walk(0, []);
      const plan = planPatternReminders({ schedule, counts });
      const v = REMINDER_CONDITIONS.map((k) => plan.counts[k]);
      if (windows.length === 0) continue;
      expect(Math.max(...v) - Math.min(...v)).toBe(bestSpread);
    }
  });

  it('the recorded trials_since_pattern_reminder agrees with the reminder flags', () => {
    for (const blocks of sessions) {
      for (const block of blocks) {
        let last = null;
        block.forEach((t, i) => {
          if (t.reminded) last = i;
          if (IMAGERY_BEARING_TYPES.has(t.type)) expect(t.since).toBe(i - last);
        });
      }
    }
  });

  it('is deterministic: the same seed gives the same reminders', () => {
    for (const s of [0, 7, 42]) {
      expect(flags(planFor(s))).toEqual(flags(planFor(s)));
    }
  });

  it('does not depend on rotation, shade or on/off label: reminded trials look like the rest', () => {
    /* The reminder choice sees only the condition sequence, so reminded and
     * non-reminded imagery trials should have the same mix of rotation
     * magnitude and page background over seeds. */
    let remAbs = 0;
    let remN = 0;
    let othAbs = 0;
    let othN = 0;
    let remGray = 0;
    let othGray = 0;
    for (let s = 0; s < N_SEEDS; s++) {
      const plan = planFor(s);
      for (const block of [plan.mainA, plan.mainB]) {
        for (const p of block.trialParams) {
          if (!IMAGERY_BEARING_TYPES.has(p.trial_meta.condition)) continue;
          const rot = Math.abs(p.rotation_deg ?? 0);
          const gray = p.background_shade === 'gray' ? 1 : 0;
          if (p.trial_meta.pattern_reminder) {
            remAbs += rot;
            remN += 1;
            remGray += gray;
          } else {
            othAbs += rot;
            othN += 1;
            othGray += gray;
          }
        }
      }
    }
    expect(Math.abs(remAbs / remN - othAbs / othN)).toBeLessThan(3); /* degrees */
    expect(Math.abs(remGray / remN - othGray / othN)).toBeLessThan(0.05);
  });
});
