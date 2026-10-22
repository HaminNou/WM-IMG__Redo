/**
 * Tests for src/scheduler/main-blocks.js — the 24-and-split orchestrator
 * with 3 items per trial.
 *
 * The counterbalances are enforced by the per-condition generators ONLY at
 * blockSize = 24. This module's whole reason for existing is to preserve that
 * guarantee across Main A + Main B by generating 24 trials per type at
 * session level and splitting 12 + 12. Hit counts shifted with set-size 3:
 *   - (probe_type × probe_position): 4 × 3 = 12 cells, 6 per cell.
 *   - (encoding_position × probe_position): 3 × 3 = 9 cells, 8 per cell.
 *
 * What we verify here:
 *   - each per-type pool has exactly 24 trials,
 *   - halfA + halfB union has exactly 24 trials per type and partitions the pool,
 *   - the two halves are disjoint (no trial appears in both),
 *   - each half's trial-type schedule is independent (the two main blocks
 *     don't share the same type order),
 *   - returned objects are deeply frozen,
 *   - mainA / mainB nodes contain pattern-phase nodes at slot 0.
 *
 * @vitest-environment jsdom
 *
 * jsdom is required because main-blocks.js transitively imports the per-
 * condition trial composers (jsPsych v8 plugin side-effects touch `window`).
 * No rendering happens — we only inspect data on the nodes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { generateMainBlockPair } from '../src/scheduler/main-blocks.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { setSessionPRNG } from '../src/prng.js';

const ALL_TYPES = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];

beforeEach(() => {
  setSessionPRNG('main-blocks-test-seed');
  resetSequencePools();
});

describe('generateMainBlockPair: 24-and-split', () => {
  it('returns mainA, mainB, and trialParamsByType with the expected shape', () => {
    const pair = generateMainBlockPair();
    expect(pair).toHaveProperty('mainA');
    expect(pair).toHaveProperty('mainB');
    expect(pair).toHaveProperty('trialParamsByType');
    expect(pair.mainA).toHaveProperty('schedule');
    expect(pair.mainA).toHaveProperty('trialParams');
    expect(pair.mainA).toHaveProperty('nodes');
    expect(pair.mainB).toHaveProperty('schedule');
    expect(pair.mainB).toHaveProperty('trialParams');
    expect(pair.mainB).toHaveProperty('nodes');
  });

  it('produces exactly 24 trials per type at the session level', () => {
    const pair = generateMainBlockPair();
    for (const type of ALL_TYPES) {
      expect(pair.trialParamsByType[type].all).toHaveLength(24);
    }
  });

  it('splits each type into halfA and halfB of length 12 each', () => {
    const pair = generateMainBlockPair();
    for (const type of ALL_TYPES) {
      expect(pair.trialParamsByType[type].halfA).toHaveLength(12);
      expect(pair.trialParamsByType[type].halfB).toHaveLength(12);
    }
  });

  it('halfA and halfB partition the 24-trial pool (disjoint, union = pool)', () => {
    const pair = generateMainBlockPair();
    for (const type of ALL_TYPES) {
      const all = pair.trialParamsByType[type].all;
      const a = pair.trialParamsByType[type].halfA;
      const b = pair.trialParamsByType[type].halfB;
      const aSet = new Set(a);
      const bSet = new Set(b);
      /* Disjoint. */
      for (const t of a) expect(bSet.has(t)).toBe(false);
      /* Union covers the pool. */
      for (const t of all) expect(aSet.has(t) || bSet.has(t)).toBe(true);
      expect(a.length + b.length).toBe(all.length);
    }
  });

  it('each Main A and Main B schedule has 60 trials (12 × 5)', () => {
    const pair = generateMainBlockPair();
    expect(pair.mainA.schedule).toHaveLength(60);
    expect(pair.mainB.schedule).toHaveLength(60);
    expect(pair.mainA.trialParams).toHaveLength(60);
    expect(pair.mainB.trialParams).toHaveLength(60);
  });

  it('each Main A schedule has exactly 12 of each type', () => {
    const pair = generateMainBlockPair();
    const counts = {};
    for (const t of pair.mainA.schedule) counts[t] = (counts[t] ?? 0) + 1;
    for (const type of ALL_TYPES) expect(counts[type]).toBe(12);
  });

  it('each Main B schedule has exactly 12 of each type', () => {
    const pair = generateMainBlockPair();
    const counts = {};
    for (const t of pair.mainB.schedule) counts[t] = (counts[t] ?? 0) + 1;
    for (const type of ALL_TYPES) expect(counts[type]).toBe(12);
  });

  it('Main A and Main B trial-type schedules are not identical', () => {
    /* With 60-trial schedules drawn independently, identical sequences are
     * astronomically unlikely. This guards against a regression where a
     * single schedule got reused for both halves. */
    const pair = generateMainBlockPair();
    const sameOrder = pair.mainA.schedule.every((t, i) => t === pair.mainB.schedule[i]);
    expect(sameOrder).toBe(false);
  });

  it('main A and main B do not share any trial-param objects', () => {
    const pair = generateMainBlockPair();
    const aSet = new Set(pair.mainA.trialParams);
    for (const t of pair.mainB.trialParams) {
      expect(aSet.has(t)).toBe(false);
    }
  });

  it('main A pattern-phase mounts at nodes[1] iff slot 0 is imagery-bearing', () => {
    /* The pattern-phase node is suppressed when the
     * trial at the cadence boundary is memory-only. Under the gate-first
     * ordering the trial-start gate is `nodes[0]` and the
     * pattern-phase splice lands at `nodes[1]` when injected, so the
     * presence of pattern_phase is checked at index 1 — `nodes[0]` is
     * always a `*_trial_start` gate. */
    const pair = generateMainBlockPair();
    const slot0Type = pair.mainA.schedule[0];
    const imagery = new Set(['i_only', 'i_d', 'i_t']);
    expect(pair.mainA.nodes[0]?.data?.phase).toBe(`${slot0Type}_trial_start`);
    if (imagery.has(slot0Type)) {
      expect(pair.mainA.nodes[1]?.data?.phase).toBe('pattern_phase');
    } else {
      expect(pair.mainA.nodes[1]?.data?.phase).not.toBe('pattern_phase');
    }
  });

  it('main B pattern-phase mounts at nodes[1] iff slot 0 is imagery-bearing', () => {
    const pair = generateMainBlockPair();
    const slot0Type = pair.mainB.schedule[0];
    const imagery = new Set(['i_only', 'i_d', 'i_t']);
    expect(pair.mainB.nodes[0]?.data?.phase).toBe(`${slot0Type}_trial_start`);
    if (imagery.has(slot0Type)) {
      expect(pair.mainB.nodes[1]?.data?.phase).toBe('pattern_phase');
    } else {
      expect(pair.mainB.nodes[1]?.data?.phase).not.toBe('pattern_phase');
    }
  });

  it('no pattern-phase node in main A or main B precedes a d_only or t_only trial', () => {
    /* Stronger end-to-end guard: walk both main-block node lists and
     * confirm that whenever a `pattern_phase` node appears, the trial
     * that follows is imagery-bearing. */
    const pair = generateMainBlockPair();
    for (const block of [pair.mainA, pair.mainB]) {
      for (let i = 0; i < block.nodes.length; i++) {
        if (block.nodes[i]?.data?.phase !== 'pattern_phase') continue;
        const nextPhase = block.nodes[i + 1]?.data?.phase ?? '';
        expect(nextPhase.startsWith('d_only')).toBe(false);
        expect(nextPhase.startsWith('t_only')).toBe(false);
      }
    }
  });

  it('returned trialParamsByType is frozen (top level and per-type)', () => {
    const pair = generateMainBlockPair();
    expect(Object.isFrozen(pair.trialParamsByType)).toBe(true);
    for (const type of ALL_TYPES) {
      expect(Object.isFrozen(pair.trialParamsByType[type])).toBe(true);
      expect(Object.isFrozen(pair.trialParamsByType[type].all)).toBe(true);
      expect(Object.isFrozen(pair.trialParamsByType[type].halfA)).toBe(true);
      expect(Object.isFrozen(pair.trialParamsByType[type].halfB)).toBe(true);
    }
  });

  it('trialParams for main A all carry trial_type matching the schedule slot', () => {
    const pair = generateMainBlockPair();
    for (let i = 0; i < pair.mainA.schedule.length; i++) {
      expect(pair.mainA.trialParams[i].trial_type).toBe(pair.mainA.schedule[i]);
    }
  });

  it('trialParams for main B all carry trial_type matching the schedule slot', () => {
    const pair = generateMainBlockPair();
    for (let i = 0; i < pair.mainB.schedule.length; i++) {
      expect(pair.mainB.trialParams[i].trial_type).toBe(pair.mainB.schedule[i]);
    }
  });

  it('is reproducible from the same seed', () => {
    setSessionPRNG('repro-seed');
    resetSequencePools();
    const a = generateMainBlockPair();
    setSessionPRNG('repro-seed');
    resetSequencePools();
    const b = generateMainBlockPair();
    expect(a.mainA.schedule).toEqual(b.mainA.schedule);
    expect(a.mainB.schedule).toEqual(b.mainB.schedule);
  });

  it('produces different schedules for different seeds', () => {
    setSessionPRNG('seed-x');
    resetSequencePools();
    const a = generateMainBlockPair();
    setSessionPRNG('seed-y');
    resetSequencePools();
    const b = generateMainBlockPair();
    /* Astronomically unlikely to collide if seeds differ. */
    const sameA = a.mainA.schedule.every((t, i) => t === b.mainA.schedule[i]);
    expect(sameA).toBe(false);
  });
});

/**
 * Counterbalance on the Main A ⊎ Main B union.
 *
 * The per-condition generator enforces (probe_type × probe_position) = 6 per
 * cell at blockSize=24, and the 24-and-split orchestrator (`main-blocks.js`)
 * generates ONE 24-trial pool per type and partitions it 12/12 across Main A
 * and Main B without changing any per-trial field. So the counterbalance invariant must
 * hold on the union by construction.
 *
 * The four probe-bearing conditions (d_only, t_only, i_d, i_t) each emit 3
 * probes per trial, 24 trials per type, 72 probes total → 12 (type, position)
 * cells → 6 / cell exactly. The two dual-task conditions additionally enforce
 * (encoding_position × probe_position) = 8 / cell across 9 cells.
 *
 * i_only has no recognition probes (stars only), so no probe-counterbalance
 * test applies; its star/serial-position counterbalance is covered separately
 * by the per-condition generator tests.
 *
 * Asserted only at the per-block
 * generator level; this re-tests it on the assembled union to lock the
 * orchestrator's "24-then-split" property in CI.
 */
describe('counterbalance survives the Main A ⊎ Main B partition', () => {
  const PROBE_TYPES = ['T_on', 'T_off', 'F_on', 'F_off'];
  const PROBE_POSITIONS = [0, 1, 2];
  const ENCODING_POSITIONS = [0, 1, 2];

  function tallyProbeTypeByPosition(trials) {
    const counts = {};
    for (const t of PROBE_TYPES) for (const p of PROBE_POSITIONS) counts[`${t}@${p}`] = 0;
    for (const trial of trials) {
      for (const probe of trial.probes) {
        counts[`${probe.type}@${probe.probe_position}`] += 1;
      }
    }
    return counts;
  }

  function tallyEncodingByProbePosition(trials) {
    const counts = {};
    for (const e of ENCODING_POSITIONS) for (const p of PROBE_POSITIONS) counts[`e${e}@p${p}`] = 0;
    for (const trial of trials) {
      for (const probe of trial.probes) {
        counts[`e${probe.encoding_position}@p${probe.probe_position}`] += 1;
      }
    }
    return counts;
  }

  it('(probe_type × probe_position) = 6 per cell across A∪B for d_only', () => {
    const pair = generateMainBlockPair();
    const union = pair.trialParamsByType.d_only.all;
    const counts = tallyProbeTypeByPosition(union);
    for (const [, v] of Object.entries(counts)) expect(v).toBe(6);
  });

  it('(probe_type × probe_position) = 6 per cell across A∪B for t_only', () => {
    const pair = generateMainBlockPair();
    const union = pair.trialParamsByType.t_only.all;
    const counts = tallyProbeTypeByPosition(union);
    for (const [, v] of Object.entries(counts)) expect(v).toBe(6);
  });

  it('(probe_type × probe_position) = 6 per cell across A∪B for i_d', () => {
    const pair = generateMainBlockPair();
    const union = pair.trialParamsByType.i_d.all;
    const counts = tallyProbeTypeByPosition(union);
    for (const [, v] of Object.entries(counts)) expect(v).toBe(6);
  });

  it('(probe_type × probe_position) = 6 per cell across A∪B for i_t', () => {
    const pair = generateMainBlockPair();
    const union = pair.trialParamsByType.i_t.all;
    const counts = tallyProbeTypeByPosition(union);
    for (const [, v] of Object.entries(counts)) expect(v).toBe(6);
  });

  it('(encoding_position × probe_position) = 8 per cell across A∪B for i_d', () => {
    const pair = generateMainBlockPair();
    const union = pair.trialParamsByType.i_d.all;
    const counts = tallyEncodingByProbePosition(union);
    for (const [, v] of Object.entries(counts)) expect(v).toBe(8);
  });

  it('(encoding_position × probe_position) = 8 per cell across A∪B for i_t', () => {
    const pair = generateMainBlockPair();
    const union = pair.trialParamsByType.i_t.all;
    const counts = tallyEncodingByProbePosition(union);
    for (const [, v] of Object.entries(counts)) expect(v).toBe(8);
  });
});
