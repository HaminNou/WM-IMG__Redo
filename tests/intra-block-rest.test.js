/**
 * @vitest-environment jsdom
 *
 * Tests for the intra-block forced-rest insertion.
 *
 * Spec under test:
 *   - A 30-second forced rest is spliced into each main block after every
 *     20 trials (within-block trials 20→21 and 40→41).
 *   - Each rest is immediately followed by a "press both arrow keys to
 *     start the next trial" gate (`rest_resume_gate`).
 *   - Splice happens AFTER trial-number stamping, so the gate-numbering
 *     (1..120) is unchanged and `main_trial_number_overall` still reads
 *     1..60 for Main A and 61..120 for Main B.
 *   - Rest data rows are tagged with block-distinct labels
 *     (`intra_main_a` vs `intra_main_b`) so the export can separate them
 *     from the existing inter-block rest (`inter_block`, added by the
 *     runner).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { generateMainBlockPair } from '../src/scheduler/main-blocks.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { setSessionPRNG } from '../src/prng.js';

beforeEach(() => {
  setSessionPRNG('intra-rest-test-seed');
  resetSequencePools();
});

function gatesIn(nodes) {
  return nodes.filter((n) => n?.data?.phase && /_trial_start$/.test(n.data.phase));
}

function findIndexOfGate(nodes, overallTrialNumber) {
  return nodes.findIndex(
    (n) =>
      n?.data?.phase &&
      /_trial_start$/.test(n.data.phase) &&
      n.data.main_trial_number_overall === overallTrialNumber
  );
}

describe('intra-block rest insertion', () => {
  it('splices a (rest, rest_resume_gate) pair before within-block trials 21 and 41 of each main block', () => {
    const pair = generateMainBlockPair();

    /* Main A: rest pairs precede gate of trials 21 and 41. */
    for (const overallN of [21, 41]) {
      const idx = findIndexOfGate(pair.mainA.nodes, overallN);
      expect(idx).toBeGreaterThan(1);
      expect(pair.mainA.nodes[idx - 2]?.data?.phase).toBe('rest');
      expect(pair.mainA.nodes[idx - 1]?.data?.phase).toBe('rest_resume_gate');
    }

    /* Main B: same within-block offsets — overall trials 81 and 101. */
    for (const overallN of [81, 101]) {
      const idx = findIndexOfGate(pair.mainB.nodes, overallN);
      expect(idx).toBeGreaterThan(1);
      expect(pair.mainB.nodes[idx - 2]?.data?.phase).toBe('rest');
      expect(pair.mainB.nodes[idx - 1]?.data?.phase).toBe('rest_resume_gate');
    }
  });

  it('inserts exactly two rest pairs per main block (no extras, no missing)', () => {
    const pair = generateMainBlockPair();

    const aRests = pair.mainA.nodes.filter((n) => n?.data?.phase === 'rest');
    const aGates = pair.mainA.nodes.filter((n) => n?.data?.phase === 'rest_resume_gate');
    expect(aRests).toHaveLength(2);
    expect(aGates).toHaveLength(2);

    const bRests = pair.mainB.nodes.filter((n) => n?.data?.phase === 'rest');
    const bGates = pair.mainB.nodes.filter((n) => n?.data?.phase === 'rest_resume_gate');
    expect(bRests).toHaveLength(2);
    expect(bGates).toHaveLength(2);
  });

  it('rest rows carry block-distinct labels separating them from the inter-block rest', () => {
    const pair = generateMainBlockPair();

    for (const node of pair.mainA.nodes.filter((n) => n?.data?.phase === 'rest')) {
      expect(node.data.block_label).toBe('intra_main_a');
    }
    for (const node of pair.mainA.nodes.filter((n) => n?.data?.phase === 'rest_resume_gate')) {
      expect(node.data.block_label).toBe('intra_main_a');
    }
    for (const node of pair.mainB.nodes.filter((n) => n?.data?.phase === 'rest')) {
      expect(node.data.block_label).toBe('intra_main_b');
    }
  });

  it('intra-block rest duration matches the configured 30-second rest', () => {
    const pair = generateMainBlockPair();
    const aRest = pair.mainA.nodes.find((n) => n?.data?.phase === 'rest');
    expect(aRest?.data?.duration_ms).toBe(30000);
  });

  it('trial numbering is unchanged after splicing – gates still read 1..60 (A) and 61..120 (B)', () => {
    const pair = generateMainBlockPair();
    const aNumbers = gatesIn(pair.mainA.nodes).map((n) => n.data.main_trial_number_overall);
    const bNumbers = gatesIn(pair.mainB.nodes).map((n) => n.data.main_trial_number_overall);
    expect(aNumbers).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(bNumbers).toEqual(Array.from({ length: 60 }, (_, i) => i + 61));
  });

  it('the rest does NOT precede the FIRST trial of a block (no spurious rest at within-block trial 1)', () => {
    /* If we mis-coded the breakpoint as `trial % 20 === 0` instead of
     * `trial within {20, 40}`, a rest could end up before trial 1 of
     * Main B (where within-block trial = 1 maps to overall = 61). */
    const pair = generateMainBlockPair();
    const firstAGateIdx = findIndexOfGate(pair.mainA.nodes, 1);
    /* The very first gate is the first node in Main A's array (or
     * preceded only by an optional pattern_phase node — but never by
     * rest / rest_resume_gate). */
    for (let i = 0; i < firstAGateIdx; i++) {
      expect(pair.mainA.nodes[i]?.data?.phase).not.toBe('rest');
      expect(pair.mainA.nodes[i]?.data?.phase).not.toBe('rest_resume_gate');
    }

    const firstBGateIdx = findIndexOfGate(pair.mainB.nodes, 61);
    for (let i = 0; i < firstBGateIdx; i++) {
      expect(pair.mainB.nodes[i]?.data?.phase).not.toBe('rest');
      expect(pair.mainB.nodes[i]?.data?.phase).not.toBe('rest_resume_gate');
    }
  });

  it('the rest does NOT trail the LAST trial of a block (no rest after within-block trial 60)', () => {
    /* The inter-block rest (between A and B) and the end-of-task screen
     * are appended OUTSIDE the per-block nodes array, so adding an extra
     * intra-block rest after the last trial would double up. */
    const pair = generateMainBlockPair();
    const lastA = findIndexOfGate(pair.mainA.nodes, 60);
    /* Walk forward — no rest_resume_gate or rest with intra_* label
     * should appear after the trial-60 gate's full composition ends. */
    for (let i = lastA; i < pair.mainA.nodes.length; i++) {
      const phase = pair.mainA.nodes[i]?.data?.phase;
      const lbl = pair.mainA.nodes[i]?.data?.block_label;
      if (phase === 'rest' || phase === 'rest_resume_gate') {
        /* Any rest at the tail must NOT be flagged as intra-block. */
        expect(lbl).not.toBe('intra_main_a');
      }
    }
  });
});
