/**
 * @vitest-environment jsdom
 *
 * Tests for the instructions composer (`src/instructions/index.js`) and the
 * per-trial-type instruction modules. The composer's responsibility is
 * structural — produce a timeline that interleaves per-type teaching screens
 * with their per-type practice trials, scattering the three attention
 * checks at the boundaries of the memory / imagery / dual teaching arcs
 *, and wrap the whole thing in an accuracy-gated `loop_function`
 *.
 *
 * jsdom is required because the modules import jsPsych plugins which touch
 * `window` at module load.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { dOnlyInstructionNode, tOnlyInstructionNode } from '../src/instructions/memory.js';
import { iOnlyInstructionNode } from '../src/instructions/imagery.js';
import { iDInstructionNode, iTInstructionNode } from '../src/instructions/dual.js';
import { assembleInstructionsAndPractice } from '../src/instructions/index.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { setSessionPRNG } from '../src/prng.js';

beforeEach(() => {
  setSessionPRNG('instructions-test-seed');
  resetSequencePools();
  Object.defineProperty(window, 'jsPsych', {
    value: { data: { get: () => ({ count: () => 0, values: () => [] }) } },
    configurable: true,
    writable: true,
  });
});

describe('per-type instruction node accessors', () => {
  it('dOnlyInstructionNode tags phase = instructions_memory_d_only', () => {
    expect(dOnlyInstructionNode().data.phase).toBe('instructions_memory_d_only');
  });
  it('tOnlyInstructionNode tags phase = instructions_memory_t_only', () => {
    expect(tOnlyInstructionNode().data.phase).toBe('instructions_memory_t_only');
  });
  it('iOnlyInstructionNode tags phase = instructions_imagery_i_only', () => {
    expect(iOnlyInstructionNode().data.phase).toBe('instructions_imagery_i_only');
  });
  it('iDInstructionNode tags phase = instructions_dual_i_d', () => {
    expect(iDInstructionNode().data.phase).toBe('instructions_dual_i_d');
  });
  it('iTInstructionNode tags phase = instructions_dual_i_t', () => {
    expect(iTInstructionNode().data.phase).toBe('instructions_dual_i_t');
  });
  it('every per-type node uses the space key as the forward-advance gate', () => {
    /* The instructions plugin paginates each long teaching screen across
     * several short pages. Space (key_forward) advances to the next page
     * and, on the final page, advances out of the trial — keeping the
     * "Space to continue" experience uniform across the experiment. */
    for (const node of [
      dOnlyInstructionNode(),
      tOnlyInstructionNode(),
      iOnlyInstructionNode(),
      iDInstructionNode(),
      iTInstructionNode(),
    ]) {
      expect(node.key_forward).toBe(' ');
    }
  });

  it('every per-type node delivers more than one short page (paginated long instructions)', () => {
    for (const node of [
      dOnlyInstructionNode(),
      tOnlyInstructionNode(),
      iOnlyInstructionNode(),
      iDInstructionNode(),
      iTInstructionNode(),
    ]) {
      expect(Array.isArray(node.pages)).toBe(true);
      expect(node.pages.length).toBeGreaterThan(1);
    }
  });
});

describe('rotation cue framing — design constraint', () => {
  /* The rotation cue arrow is shown ONLY in trial types that involve
   * imagery (I-only, I+D, I+T). D-only and T-only screens must not
   * mention an "arrow" or "rotation cue", because no such cue appears
   * to the participant in those trials. The grid layout still rotates
   * in the abstract design, but the participant sees no arrow. */
  it('D-only and T-only screens do NOT mention rotation or the rotation cue', () => {
    /* "Right arrow" / "Left arrow" key references are allowed (and
     * present); the prohibition is on rotation language, which would
     * misleadingly imply a rotation step in non-imagery trials. */
    for (const node of [dOnlyInstructionNode(), tOnlyInstructionNode()]) {
      const text = node.pages.join(' ').toLowerCase();
      expect(text).not.toContain('rotat');
      expect(text).not.toContain('rotation cue');
    }
  });
  it('I-only, I+D, and I+T screens DO mention a turning/rotating arrow cue', () => {
    /* The plain-language rewrite uses "turn" rather than "rotate" because
     * the participant pool is general-public Prolific, not psych students
     * (no jargon). Either verb satisfies the design constraint that
     * imagery-bearing screens describe an arrow-driven mental rotation. */
    for (const node of [iOnlyInstructionNode(), iDInstructionNode(), iTInstructionNode()]) {
      const text = node.pages.join(' ').toLowerCase();
      expect(text).toMatch(/(rotat|turn)/);
      expect(text).toContain('arrow');
    }
  });
  it('rotation-cue screens do NOT show a specific rotation angle', () => {
    /* The arrow is the cue; the
     * specific angle (e.g., "45 degrees") must not be written into
     * instruction copy because it would over-specify the cue and could
     * bias attention to the prototype angles. */
    for (const node of [iOnlyInstructionNode(), iDInstructionNode(), iTInstructionNode()]) {
      const text = node.pages.join(' ');
      expect(text).not.toMatch(/\d+\s*deg/i);
      expect(text).not.toMatch(/\d+\s*°/);
    }
  });
});

describe('assembleInstructionsAndPractice', () => {
  it('returns a flat array of jsPsych timeline nodes', () => {
    const chain = assembleInstructionsAndPractice();
    expect(Array.isArray(chain)).toBe(true);
    for (const node of chain) {
      expect(node).toBeDefined();
    }
  });

  it('starts with the instructions overview screen', () => {
    const chain = assembleInstructionsAndPractice();
    expect(chain[0]?.data?.phase).toBe('instructions_overview');
  });

  it('the second element is a jsPsych timeline node with loop_function (the gated practice block)', () => {
    const chain = assembleInstructionsAndPractice();
    const loopNode = chain[1];
    expect(Array.isArray(loopNode.timeline)).toBe(true);
    expect(typeof loopNode.loop_function).toBe('function');
  });

  it('the last element is the attention-check summary node (phase set in on_finish)', () => {
    const chain = assembleInstructionsAndPractice();
    const last = chain[chain.length - 1];
    expect(typeof last.on_finish).toBe('function');
  });

  it('the inner loop timeline contains all five per-type instruction screens in fixed order', () => {
    const chain = assembleInstructionsAndPractice();
    const inner = chain[1].timeline;
    const phases = inner.map((n) => {
      const data = typeof n.data === 'function' ? n.data() : n.data;
      return data?.phase;
    });
    const idxDOnly = phases.indexOf('instructions_memory_d_only');
    const idxTOnly = phases.indexOf('instructions_memory_t_only');
    const idxIOnly = phases.indexOf('instructions_imagery_i_only');
    const idxID = phases.indexOf('instructions_dual_i_d');
    const idxIT = phases.indexOf('instructions_dual_i_t');
    /* Must appear and must be in the design's per-task teaching order. */
    expect(idxDOnly).toBeGreaterThan(-1);
    expect(idxTOnly).toBeGreaterThan(idxDOnly);
    expect(idxIOnly).toBeGreaterThan(idxTOnly);
    expect(idxID).toBeGreaterThan(idxIOnly);
    expect(idxIT).toBeGreaterThan(idxID);
  });

  it('each per-type instruction screen is followed by trial nodes of that type before the next instruction screen', () => {
    /* Smoke-test for the interleaved structure: between consecutive
     * instruction phases, there must be at least one node tagged with
     * the matching block_label='practice' on its data. */
    const chain = assembleInstructionsAndPractice();
    const inner = chain[1].timeline;
    /* The data is sometimes a function for instruction screens too — pull
     * resolved data uniformly. */
    const resolved = inner.map((n) => (typeof n.data === 'function' ? n.data() : n.data));
    const instructionPhases = [
      'instructions_memory_d_only',
      'instructions_memory_t_only',
      'instructions_imagery_i_only',
      'instructions_dual_i_d',
      'instructions_dual_i_t',
    ];
    for (let p = 0; p < instructionPhases.length; p++) {
      const startIdx = resolved.findIndex((d) => d?.phase === instructionPhases[p]);
      expect(startIdx).toBeGreaterThan(-1);
      /* The next instruction phase (or AC, or feedback) should occur after
       * at least one practice-labelled node has appeared. */
      let sawPractice = false;
      for (let i = startIdx + 1; i < resolved.length; i++) {
        if (resolved[i]?.block_label === 'practice') {
          sawPractice = true;
          break;
        }
        if (instructionPhases.includes(resolved[i]?.phase)) break;
      }
      expect(sawPractice, `expected practice trials after ${instructionPhases[p]}`).toBe(true);
    }
  });

  it('contains exactly 3 typed-attention-check nodes inside the loop, scattered between teaching arcs', () => {
    const chain = assembleInstructionsAndPractice();
    const inner = chain[1].timeline;
    const acIdxs = [];
    for (let i = 0; i < inner.length; i++) {
      const data = typeof inner[i].data === 'function' ? inner[i].data() : inner[i].data;
      if (data?.phase === 'attention_check') acIdxs.push(i);
    }
    expect(acIdxs).toHaveLength(3);
    /* AC1 must come AFTER memory teaching arc (t_only screen);
     * AC2 between imagery and dual; AC3 after the dual arc. */
    const phases = inner.map((n) => {
      const data = typeof n.data === 'function' ? n.data() : n.data;
      return data?.phase;
    });
    expect(acIdxs[0]).toBeGreaterThan(phases.indexOf('instructions_memory_t_only'));
    expect(acIdxs[0]).toBeLessThan(phases.indexOf('instructions_imagery_i_only'));
    expect(acIdxs[1]).toBeGreaterThan(phases.indexOf('instructions_imagery_i_only'));
    expect(acIdxs[1]).toBeLessThan(phases.indexOf('instructions_dual_i_d'));
    expect(acIdxs[2]).toBeGreaterThan(phases.indexOf('instructions_dual_i_t'));
  });

  it('inner timeline begins with an iteration-start marker and ends with practice feedback', () => {
    const chain = assembleInstructionsAndPractice();
    const inner = chain[1].timeline;
    const firstData = typeof inner[0].data === 'function' ? inner[0].data() : inner[0].data;
    const lastData =
      typeof inner[inner.length - 1].data === 'function'
        ? inner[inner.length - 1].data()
        : inner[inner.length - 1].data;
    expect(firstData.phase).toBe('practice_iteration_start');
    expect(lastData.phase).toBe('practice_feedback');
  });
});
