/**
 * Tests for src/scheduler/block.js — the block assembler. Verifies that
 *   - per-type counts are respected,
 *   - the schedule matches the trialParams 1:1,
 *   - pattern-phase nodes are injected at slot 0, F, 2F, …,
 *   - the across-trial run-length cap is honoured (delegated, but checked
 *     here too as an end-to-end smoke-test),
 *   - input validation rejects bad arguments.
 *
 * The composer-level node sequences (encoding + retention + probes + …) are
 * *not* re-tested here — they are covered by the per-condition test files.
 * What we check is that the assembler stitches them together correctly and
 * surrounds them with pattern phases at the right indices.
 *
 * @vitest-environment jsdom
 *
 * jsdom is required because block.js transitively imports the per-condition
 * composers, which import jsPsych plugins; jsPsych v8's module side-effects
 * touch `window` at import time. We don't render anything — we only inspect
 * the trial-param objects and the data fields on each node.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { assembleBlock } from '../src/scheduler/block.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { setSessionPRNG } from '../src/prng.js';
import { config } from '../src/config.js';

const ALL_TYPES = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];
const IMAGERY_BEARING_TYPES = new Set(['i_only', 'i_d', 'i_t']);
const MEMORY_ONLY_TYPES = new Set(['d_only', 't_only']);

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

function patternPhaseIndices(nodes) {
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i]?.data?.phase === 'pattern_phase') out.push(i);
  }
  return out;
}

describe('assembleBlock: 5-trial mini-block (one of each type)', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-block-mini');
    resetSequencePools();
  });

  it('returns {schedule, trialParams, nodes} of the right shape', () => {
    const out = assembleBlock({
      blockLabel: 'mini',
      countsByType: { d_only: 1, t_only: 1, i_only: 1, i_d: 1, i_t: 1 },
    });
    expect(Array.isArray(out.schedule)).toBe(true);
    expect(Array.isArray(out.trialParams)).toBe(true);
    expect(Array.isArray(out.nodes)).toBe(true);
  });

  it('schedule has length 5 and one of each type', () => {
    const out = assembleBlock({
      blockLabel: 'mini',
      countsByType: { d_only: 1, t_only: 1, i_only: 1, i_d: 1, i_t: 1 },
    });
    expect(out.schedule).toHaveLength(5);
    expect(countByType(out.schedule)).toEqual({
      d_only: 1,
      t_only: 1,
      i_only: 1,
      i_d: 1,
      i_t: 1,
    });
  });

  it('trialParams aligns 1:1 with the schedule by trial_type', () => {
    const out = assembleBlock({
      blockLabel: 'mini',
      countsByType: { d_only: 1, t_only: 1, i_only: 1, i_d: 1, i_t: 1 },
    });
    expect(out.trialParams).toHaveLength(out.schedule.length);
    for (let i = 0; i < out.schedule.length; i++) {
      expect(out.trialParams[i].trial_type).toBe(out.schedule[i]);
    }
  });

  it('contains a pattern-phase node only when slot 0 is imagery-bearing', () => {
    const out = assembleBlock({
      blockLabel: 'mini',
      countsByType: { d_only: 1, t_only: 1, i_only: 1, i_d: 1, i_t: 1 },
    });
    /* For a 5-trial block with frequency 8, the only candidate pattern-phase
     * boundary is slot 0. The injection only fires if
     * slot 0 is imagery-bearing; otherwise no pattern phase appears. */
    const ppNodes = out.nodes.filter((n) => n?.data?.phase === 'pattern_phase');
    const slot0Type = out.schedule[0];
    if (IMAGERY_BEARING_TYPES.has(slot0Type)) {
      expect(ppNodes).toHaveLength(1);
      /* Gate-first ordering: the trial-start gate is now
       * nodes[0]; the pattern phase is spliced at composer index 1. */
      expect(out.nodes[1].data.phase).toBe('pattern_phase');
    } else {
      expect(ppNodes).toHaveLength(0);
      expect(out.nodes[1]?.data?.phase).not.toBe('pattern_phase');
    }
  });

  it('pattern-phase node carries block_label and trial_index_in_block when injected', () => {
    /* Force an imagery-bearing trial at slot 0 by passing a single i_only
     * trial — guaranteed schedule, guaranteed pattern-phase injection. */
    const out = assembleBlock({
      blockLabel: 'mini',
      countsByType: { i_only: 1 },
    });
    /* nodes[0] is the trial-start gate; pattern phase is at nodes[1]. */
    const pp = out.nodes[1];
    expect(pp.data.phase).toBe('pattern_phase');
    expect(pp.data.block_label).toBe('mini');
    expect(pp.data.trial_index_in_block).toBe(0);
    expect(pp.trial_duration).toBe(config.pattern.pattern_phase_duration_ms);
  });
});

describe('assembleBlock: pattern-phase guard for memory-only types', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-block-mem-only-guard');
    resetSequencePools();
  });

  it('a single-type d_only block contains NO pattern-phase node', () => {
    const out = assembleBlock({
      blockLabel: 'practice',
      countsByType: { d_only: 3 },
      runLengthCap: 3,
    });
    const ppNodes = out.nodes.filter((n) => n?.data?.phase === 'pattern_phase');
    expect(ppNodes).toHaveLength(0);
  });

  it('a single-type t_only block contains NO pattern-phase node', () => {
    const out = assembleBlock({
      blockLabel: 'practice',
      countsByType: { t_only: 3 },
      runLengthCap: 3,
    });
    const ppNodes = out.nodes.filter((n) => n?.data?.phase === 'pattern_phase');
    expect(ppNodes).toHaveLength(0);
  });

  it('a single-type i_only block contains the expected pattern-phase nodes', () => {
    /* 8 i_only trials at freq=4 → pattern phases at slots 0 and 4. */
    const out = assembleBlock({
      blockLabel: 'practice',
      countsByType: { i_only: 8 },
      runLengthCap: 8,
      patternPhaseFrequency: 4,
    });
    const ppNodes = out.nodes.filter((n) => n?.data?.phase === 'pattern_phase');
    expect(ppNodes).toHaveLength(2);
    expect(ppNodes.map((n) => n.data.trial_index_in_block)).toEqual([0, 4]);
  });

  it('every pattern-phase node is followed by an imagery-bearing trial', () => {
    /* Build a long mixed block, then verify that for every slot-of-trial
     * recorded on each pattern-phase node, the trial at that slot is
     * imagery-bearing. */
    const out = assembleBlock({
      blockLabel: 'main_a',
      countsByType: { d_only: 12, t_only: 12, i_only: 12, i_d: 12, i_t: 12 },
    });
    const ppSlots = out.nodes
      .filter((n) => n?.data?.phase === 'pattern_phase')
      .map((n) => n.data.trial_index_in_block);
    for (const slot of ppSlots) {
      expect(IMAGERY_BEARING_TYPES.has(out.schedule[slot])).toBe(true);
    }
  });

  it('no pattern-phase node ever immediately precedes a memory-only trial', () => {
    /* Stronger version of the guard — verify by walking the node list and
     * checking that any node tagged `pattern_phase` is followed by a
     * trial-start gate whose phase is `i_only_*` / `i_d_*` / `i_t_*`,
     * never `d_only_*` / `t_only_*`. */
    const out = assembleBlock({
      blockLabel: 'main_a',
      countsByType: { d_only: 12, t_only: 12, i_only: 12, i_d: 12, i_t: 12 },
    });
    for (let i = 0; i < out.nodes.length; i++) {
      if (out.nodes[i]?.data?.phase !== 'pattern_phase') continue;
      const next = out.nodes[i + 1];
      const nextPhase = next?.data?.phase ?? '';
      expect(nextPhase.startsWith('d_only')).toBe(false);
      expect(nextPhase.startsWith('t_only')).toBe(false);
    }
  });

  it.each([...MEMORY_ONLY_TYPES])(
    'no schedule slot of type %s in a long mixed block is preceded by a pattern phase',
    (memType) => {
      const out = assembleBlock({
        blockLabel: 'main_a',
        countsByType: { d_only: 12, t_only: 12, i_only: 12, i_d: 12, i_t: 12 },
      });
      const ppSlots = new Set(
        out.nodes
          .filter((n) => n?.data?.phase === 'pattern_phase')
          .map((n) => n.data.trial_index_in_block)
      );
      for (let i = 0; i < out.schedule.length; i++) {
        if (out.schedule[i] === memType) {
          expect(ppSlots.has(i)).toBe(false);
        }
      }
    }
  );
});

describe('assembleBlock: pattern-phase placement at frequency boundaries', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-block-pattern-freq');
    resetSequencePools();
  });

  /* Helper: a boundary slot only gets a pattern phase if its
   * trial type is imagery-bearing. So the expected pattern-phase slots are
   * the subset of {0, F, 2F, ...} that land on i_only / i_d / i_t. */
  function expectedPatternSlots(schedule, freq) {
    const out = [];
    for (let i = 0; i < schedule.length; i += freq) {
      if (IMAGERY_BEARING_TYPES.has(schedule[i])) out.push(i);
    }
    return out;
  }

  it('a 16-trial block at freq=8 emits pattern phases at the imagery-bearing subset of {0, 8}', () => {
    const out = assembleBlock({
      blockLabel: 'main_a',
      countsByType: { d_only: 4, t_only: 4, i_only: 4, i_d: 2, i_t: 2 },
      patternPhaseFrequency: 8,
    });
    const expected = expectedPatternSlots(out.schedule, 8);
    const ppNodes = out.nodes.filter((n) => n?.data?.phase === 'pattern_phase');
    expect(ppNodes.map((n) => n.data.trial_index_in_block)).toEqual(expected);
  });

  it('a 12-trial block at freq=8 emits pattern phases at the imagery-bearing subset of {0, 8}', () => {
    const out = assembleBlock({
      blockLabel: 'practice',
      countsByType: { d_only: 3, t_only: 3, i_only: 2, i_d: 2, i_t: 2 },
      patternPhaseFrequency: 8,
    });
    const expected = expectedPatternSlots(out.schedule, 8);
    const ppNodes = out.nodes.filter((n) => n?.data?.phase === 'pattern_phase');
    expect(ppNodes.map((n) => n.data.trial_index_in_block)).toEqual(expected);
  });

  it('honours a custom patternPhaseFrequency, still gated on imagery-bearing slots', () => {
    /* freq=4 over 12 trials → candidate slots {0, 4, 8}; the actual
     * pattern phases are the subset that land on imagery-bearing trials. */
    const out = assembleBlock({
      blockLabel: 'mini',
      countsByType: { d_only: 3, t_only: 3, i_only: 2, i_d: 2, i_t: 2 },
      patternPhaseFrequency: 4,
    });
    const expected = expectedPatternSlots(out.schedule, 4);
    const ppNodes = out.nodes.filter((n) => n?.data?.phase === 'pattern_phase');
    expect(ppNodes.map((n) => n.data.trial_index_in_block)).toEqual(expected);
  });
});

describe('assembleBlock: counts and run-length cap', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-block-counts');
    resetSequencePools();
  });

  it('a 60-trial block (12 of each type) honours requested counts', () => {
    const counts = { d_only: 12, t_only: 12, i_only: 12, i_d: 12, i_t: 12 };
    const out = assembleBlock({
      blockLabel: 'main_a',
      countsByType: counts,
    });
    expect(out.schedule).toHaveLength(60);
    expect(countByType(out.schedule)).toEqual(counts);
    expect(out.trialParams).toHaveLength(60);
  });

  it('honours the across-trial run-length cap from config', () => {
    const counts = { d_only: 12, t_only: 12, i_only: 12, i_d: 12, i_t: 12 };
    const out = assembleBlock({
      blockLabel: 'main_a',
      countsByType: counts,
    });
    expect(maxRunLength(out.schedule)).toBeLessThanOrEqual(
      config.sequencing.between_trial_run_length_cap
    );
  });

  it('every per-trial trialParams object carries the right trial_type', () => {
    const counts = { d_only: 3, t_only: 3, i_only: 3, i_d: 3, i_t: 3 };
    const out = assembleBlock({
      blockLabel: 'practice',
      countsByType: counts,
    });
    for (let i = 0; i < out.schedule.length; i++) {
      expect(out.trialParams[i].trial_type).toBe(out.schedule[i]);
      expect(ALL_TYPES).toContain(out.trialParams[i].trial_type);
    }
  });

  it('trialParams are returned in schedule order (not per-type-grouped)', () => {
    /* A different ordering would still satisfy the count check, but the
     * per-trial pairing in the runner depends on schedule[i] ↔ trialParams[i].
     * This test guards against a regression where the assembler emits trials
     * grouped by type. */
    const counts = { d_only: 3, t_only: 3, i_only: 3, i_d: 3, i_t: 3 };
    const out = assembleBlock({
      blockLabel: 'practice',
      countsByType: counts,
    });
    /* The two are exactly aligned, so transcribing trialParams to types gives
     * back the schedule. */
    const fromParams = out.trialParams.map((p) => p.trial_type);
    expect(fromParams).toEqual([...out.schedule]);
  });
});

describe('assembleBlock: block_label stamping (every emitted node)', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-block-stamping');
    resetSequencePools();
  });

  it('every emitted node carries data.block_label === blockLabel', () => {
    /* Pilot summary and analysis scripts filter rows on `block_label` to tell
     * practice from main. The assembler is the single source of truth for
     * stamping it; if any composer-emitted node slips through unstamped, those
     * downstream filters silently drop the row. */
    const out = assembleBlock({
      blockLabel: 'main_a',
      countsByType: { d_only: 1, t_only: 1, i_only: 1, i_d: 1, i_t: 1 },
    });
    for (const node of out.nodes) {
      expect(node.data?.block_label).toBe('main_a');
    }
  });

  it('stamps the practice label too (so practice rows are filterable)', () => {
    const out = assembleBlock({
      blockLabel: 'practice',
      countsByType: { d_only: 1, t_only: 1, i_only: 1, i_d: 1, i_t: 1 },
    });
    for (const node of out.nodes) {
      expect(node.data?.block_label).toBe('practice');
    }
  });
});

describe('assembleBlock: missing-type handling', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-block-missing');
    resetSequencePools();
  });

  it('treats absent keys as 0 (no trials of that type)', () => {
    const out = assembleBlock({
      blockLabel: 'mini',
      countsByType: { d_only: 2, t_only: 2 },
    });
    expect(out.schedule).toHaveLength(4);
    expect(countByType(out.schedule)).toEqual({ d_only: 2, t_only: 2 });
  });

  it('explicit zeros are equivalent to missing keys', () => {
    const out = assembleBlock({
      blockLabel: 'mini',
      countsByType: { d_only: 2, t_only: 2, i_only: 0, i_d: 0, i_t: 0 },
    });
    expect(out.schedule).toHaveLength(4);
    expect(countByType(out.schedule)).toEqual({ d_only: 2, t_only: 2 });
  });
});

describe('assembleBlock: input validation', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-block-validation');
    resetSequencePools();
  });

  it('rejects missing blockLabel', () => {
    expect(() =>
      assembleBlock({
        countsByType: { d_only: 1 },
      })
    ).toThrow();
    expect(() =>
      assembleBlock({
        blockLabel: '',
        countsByType: { d_only: 1 },
      })
    ).toThrow();
  });

  it('rejects missing or invalid countsByType', () => {
    expect(() => assembleBlock({ blockLabel: 'x' })).toThrow();
    expect(() => assembleBlock({ blockLabel: 'x', countsByType: null })).toThrow();
  });

  it('rejects unknown trial-type keys in countsByType', () => {
    expect(() =>
      assembleBlock({
        blockLabel: 'x',
        countsByType: { unknown_type: 1 },
      })
    ).toThrow();
    expect(() =>
      assembleBlock({
        blockLabel: 'x',
        countsByType: { d_only: 1, foo: 1 },
      })
    ).toThrow();
  });

  it('rejects patternPhaseFrequency < 1 or non-integer', () => {
    expect(() =>
      assembleBlock({
        blockLabel: 'x',
        countsByType: { d_only: 1 },
        patternPhaseFrequency: 0,
      })
    ).toThrow();
    expect(() =>
      assembleBlock({
        blockLabel: 'x',
        countsByType: { d_only: 1 },
        patternPhaseFrequency: 1.5,
      })
    ).toThrow();
  });
});

describe('assembleBlock: nodes layout', () => {
  beforeEach(() => {
    setSessionPRNG('test-seed-block-nodes');
    resetSequencePools();
  });

  it('pattern phase mounts at nodes[1] (after the trial-start gate) when slot 0 is imagery-bearing', () => {
    /* Force slot 0 to imagery-bearing by making i_only the only type.
     * Gate-first ordering: every trial begins with the
     * trial-start gate, so nodes[0] is the gate and the pattern-phase
     * splice lands at nodes[1]. */
    const out = assembleBlock({
      blockLabel: 'mini',
      countsByType: { i_only: 1 },
    });
    expect(out.nodes[0]?.data?.phase).toBe('i_only_trial_start');
    expect(out.nodes[1]?.data?.phase).toBe('pattern_phase');
  });

  it('pattern-phase indices are strictly increasing', () => {
    const out = assembleBlock({
      blockLabel: 'main',
      countsByType: { d_only: 5, t_only: 5, i_only: 5, i_d: 5, i_t: 5 },
      patternPhaseFrequency: 5,
    });
    const idx = patternPhaseIndices(out.nodes);
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    }
  });
});
