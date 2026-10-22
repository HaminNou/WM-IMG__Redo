/**
 * Tests for src/scheduler/trial-type.js — the cross-condition trial-type
 * scheduler. Verifies count integrity, run-length cap honour, deadlock
 * resilience, frozen output, and input validation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { generateTrialTypeSchedule } from '../src/scheduler/trial-type.js';
import { setSessionPRNG } from '../src/prng.js';
import { config } from '../src/config.js';

function maxRunLength(schedule) {
  let maxRun = 0;
  let cur = 0;
  let prev = null;
  for (const t of schedule) {
    if (t === prev) cur += 1;
    else {
      cur = 1;
      prev = t;
    }
    if (cur > maxRun) maxRun = cur;
  }
  return maxRun;
}

function countByType(schedule) {
  const counts = {};
  for (const t of schedule) counts[t] = (counts[t] ?? 0) + 1;
  return counts;
}

describe('trial-type: count integrity', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-trial-type-counts');
  });

  it('returns the requested total length', () => {
    const counts = { d_only: 12, t_only: 12, i_only: 12, i_d: 12, i_t: 12 };
    const schedule = generateTrialTypeSchedule({ countsByType: counts });
    expect(schedule).toHaveLength(60);
  });

  it('honours each per-type count exactly', () => {
    const counts = { d_only: 12, t_only: 12, i_only: 12, i_d: 12, i_t: 12 };
    const schedule = generateTrialTypeSchedule({ countsByType: counts });
    expect(countByType(schedule)).toEqual(counts);
  });

  it('handles uneven counts (e.g. practice 3 of each)', () => {
    const counts = { d_only: 3, t_only: 3, i_only: 3, i_d: 3, i_t: 3 };
    const schedule = generateTrialTypeSchedule({ countsByType: counts });
    expect(schedule).toHaveLength(15);
    expect(countByType(schedule)).toEqual(counts);
  });

  it('handles asymmetric counts', () => {
    const counts = { d_only: 4, t_only: 8, i_only: 0, i_d: 6, i_t: 2 };
    const schedule = generateTrialTypeSchedule({ countsByType: counts });
    expect(schedule).toHaveLength(20);
    expect(countByType(schedule)).toEqual({ d_only: 4, t_only: 8, i_d: 6, i_t: 2 });
  });

  it('returns empty for all-zero counts', () => {
    const schedule = generateTrialTypeSchedule({ countsByType: {} });
    expect(schedule).toHaveLength(0);
    const schedule2 = generateTrialTypeSchedule({
      countsByType: { d_only: 0, t_only: 0 },
    });
    expect(schedule2).toHaveLength(0);
  });

  it('handles a single-type schedule (cap permitting)', () => {
    /* runLengthCap = 5 lets us fit 5 of one type with no other types. */
    const schedule = generateTrialTypeSchedule({
      countsByType: { d_only: 5 },
      runLengthCap: 5,
    });
    expect(schedule).toHaveLength(5);
    expect(schedule.every((t) => t === 'd_only')).toBe(true);
  });
});

describe('trial-type: run-length cap', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-trial-type-runlength');
  });

  it('uses the config default cap when none is passed', () => {
    const counts = { d_only: 12, t_only: 12, i_only: 12, i_d: 12, i_t: 12 };
    const schedule = generateTrialTypeSchedule({ countsByType: counts });
    expect(maxRunLength(schedule)).toBeLessThanOrEqual(
      config.sequencing.between_trial_run_length_cap
    );
  });

  it('honours an explicit runLengthCap = 2', () => {
    const counts = { d_only: 12, t_only: 12, i_only: 12, i_d: 12, i_t: 12 };
    const schedule = generateTrialTypeSchedule({ countsByType: counts, runLengthCap: 2 });
    expect(maxRunLength(schedule)).toBeLessThanOrEqual(2);
  });

  it('honours an explicit runLengthCap = 3', () => {
    const counts = { d_only: 12, t_only: 12, i_only: 12, i_d: 12, i_t: 12 };
    const schedule = generateTrialTypeSchedule({ countsByType: counts, runLengthCap: 3 });
    expect(maxRunLength(schedule)).toBeLessThanOrEqual(3);
  });

  it('honours runLengthCap = 1 (strict alternation)', () => {
    /* With 5 types of 4 each (20 total) and cap = 1, every adjacent pair must
     * differ — feasible since each type ≤ 4 of 20. */
    const counts = { d_only: 4, t_only: 4, i_only: 4, i_d: 4, i_t: 4 };
    const schedule = generateTrialTypeSchedule({ countsByType: counts, runLengthCap: 1 });
    expect(maxRunLength(schedule)).toBe(1);
    expect(countByType(schedule)).toEqual(counts);
  });

  it('throws when the cap is too tight to satisfy the counts', () => {
    /* 10 of one type and 1 of another with cap = 1: impossible, since the
     * max-count type would need 10 ones and only 1 separator is available. */
    expect(() =>
      generateTrialTypeSchedule({
        countsByType: { d_only: 10, t_only: 1 },
        runLengthCap: 1,
      })
    ).toThrow();
  });
});

describe('trial-type: stability across seeds', () => {
  it('produces valid schedules for many independent seeds', () => {
    const counts = { d_only: 12, t_only: 12, i_only: 12, i_d: 12, i_t: 12 };
    for (let s = 0; s < 50; s++) {
      setSessionPRNG(`seed-${s}`);
      const schedule = generateTrialTypeSchedule({ countsByType: counts });
      expect(schedule).toHaveLength(60);
      expect(countByType(schedule)).toEqual(counts);
      expect(maxRunLength(schedule)).toBeLessThanOrEqual(2);
    }
  });

  it('different seeds produce different schedules (same counts)', () => {
    const counts = { d_only: 12, t_only: 12, i_only: 12, i_d: 12, i_t: 12 };
    setSessionPRNG('seed-A');
    const a = generateTrialTypeSchedule({ countsByType: counts }).join(',');
    setSessionPRNG('seed-B');
    const b = generateTrialTypeSchedule({ countsByType: counts }).join(',');
    expect(a).not.toBe(b);
  });
});

describe('trial-type: output is frozen', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-trial-type-frozen');
  });

  it('returned schedule is frozen', () => {
    const schedule = generateTrialTypeSchedule({
      countsByType: { d_only: 3, t_only: 3 },
    });
    expect(Object.isFrozen(schedule)).toBe(true);
  });
});

describe('trial-type: input validation', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-trial-type-validation');
  });

  it('rejects missing or invalid countsByType', () => {
    expect(() => generateTrialTypeSchedule({})).toThrow();
    expect(() => generateTrialTypeSchedule({ countsByType: null })).toThrow();
    expect(() => generateTrialTypeSchedule({ countsByType: 'foo' })).toThrow();
  });

  it('rejects negative or non-integer counts', () => {
    expect(() => generateTrialTypeSchedule({ countsByType: { d_only: -1 } })).toThrow();
    expect(() => generateTrialTypeSchedule({ countsByType: { d_only: 1.5 } })).toThrow();
    expect(() => generateTrialTypeSchedule({ countsByType: { d_only: 'foo' } })).toThrow();
  });

  it('rejects runLengthCap < 1', () => {
    expect(() =>
      generateTrialTypeSchedule({
        countsByType: { d_only: 1, t_only: 1 },
        runLengthCap: 0,
      })
    ).toThrow();
    expect(() =>
      generateTrialTypeSchedule({
        countsByType: { d_only: 1, t_only: 1 },
        runLengthCap: -2,
      })
    ).toThrow();
    expect(() =>
      generateTrialTypeSchedule({
        countsByType: { d_only: 1, t_only: 1 },
        runLengthCap: 1.5,
      })
    ).toThrow();
  });
});
