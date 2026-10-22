/**
 * @vitest-environment jsdom
 *
 * Tests for the per-trial-type demo nodes (`src/instructions/demos.js`).
 * The demos are auto-playing mini-trials wedged between each instruction
 * screen and its practice block.
 *
 * The schedule animations themselves are time-driven and not exercised
 * here (they would require a full DOM playback harness); these tests pin
 * the structural invariants that downstream consumers depend on:
 *   - one node per trial type, each tagged with its locked phase
 *   - choices: 'NO_KEYS' so the controller-owned listener in buildDemoNode
 *     owns Space gating (first viewing must be watched to the end) and
 *     arrow-key absorption (no response-key leakage off a demo screen)
 *   - the composer wires a demo between every per-type instruction screen
 *     and that type's practice block
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  dOnlyDemoNode,
  tOnlyDemoNode,
  iOnlyDemoNode,
  iDDemoNode,
  iTDemoNode,
  DEMO_TRIAL_TYPES,
  DEMO_ROTATION_ANGLE_POOL,
  __test__,
} from '../src/instructions/demos.js';
import { assembleInstructionsAndPractice } from '../src/instructions/index.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { setSessionPRNG } from '../src/prng.js';

beforeEach(() => {
  setSessionPRNG('demos-test-seed');
  resetSequencePools();
  Object.defineProperty(window, 'jsPsych', {
    value: { data: { get: () => ({ count: () => 0, values: () => [] }) } },
    configurable: true,
    writable: true,
  });
});

describe('per-type demo node accessors', () => {
  it('exposes one factory per trial type', () => {
    expect(DEMO_TRIAL_TYPES).toEqual(['d_only', 't_only', 'i_only', 'i_d', 'i_t']);
  });

  it('each demo node is tagged with its locked phase', () => {
    expect(dOnlyDemoNode().data.phase).toBe('demo_d_only');
    expect(tOnlyDemoNode().data.phase).toBe('demo_t_only');
    expect(iOnlyDemoNode().data.phase).toBe('demo_i_only');
    expect(iDDemoNode().data.phase).toBe('demo_i_d');
    expect(iTDemoNode().data.phase).toBe('demo_i_t');
  });

  it('every demo mounts with choices: NO_KEYS so jsPsych never advances on a keypress (the controller-owned listener in buildDemoNode owns Space gating + arrow absorption)', () => {
    for (const node of [
      dOnlyDemoNode(),
      tOnlyDemoNode(),
      iOnlyDemoNode(),
      iDDemoNode(),
      iTDemoNode(),
    ]) {
      expect(node.choices).toBe('NO_KEYS');
      expect(node.response_ends_trial).toBe(false);
    }
  });

  it('every demo carries an on_load and on_finish hook', () => {
    for (const node of [
      dOnlyDemoNode(),
      tOnlyDemoNode(),
      iOnlyDemoNode(),
      iDDemoNode(),
      iTDemoNode(),
    ]) {
      expect(typeof node.on_load).toBe('function');
      expect(typeof node.on_finish).toBe('function');
    }
  });

  it('demo stimulus markup includes a caption slot, a grid mount, a button row, and a press-Space hint', () => {
    const node = iOnlyDemoNode();
    expect(node.stimulus).toContain('id="demo-caption"');
    expect(node.stimulus).toContain('id="demo-mount"');
    expect(node.stimulus).toContain('id="demo-buttons-row"');
    expect(node.stimulus).toContain('id="demo-hint"');
    expect(node.stimulus.toLowerCase()).toContain('press');
  });

  it('press-Space hint is rendered invisible (opacity 0 + aria-hidden) at mount time so it cannot be read during the demo body', () => {
    /* Visibility: the pill must be invisible to both
     * eyes and screen readers from the very first paint of every demo
     * slide. The demo controller flips it visible only at the genuine
     * end-of-events states (post-roll replay prompt and last-demo
     * handoff); a replay re-hides it. Without these inline defaults
     * the participant would see the "press Space" prompt during the
     * very first mini-trial body, contradicting the persistent
     * watch-and-listen banner mounted at the top of the slide. */
    for (const node of [
      dOnlyDemoNode(),
      tOnlyDemoNode(),
      iOnlyDemoNode(),
      iDDemoNode(),
      iTDemoNode(),
    ]) {
      const hintMatch = node.stimulus.match(/<div id="demo-hint"([\s\S]*?)>/);
      expect(hintMatch).toBeTruthy();
      const openTag = hintMatch[0];
      expect(openTag).toMatch(/aria-hidden="true"/);
      expect(openTag).toMatch(/opacity:\s*0\b/);
      expect(openTag).toMatch(/transition:\s*opacity\s/);
    }
  });

  it('layout stacks vertically with the caption panel directly under the centred grid mount', () => {
    /* Layout: title → grid (centred) → caption panel
     * (under grid) → button row → press-Space hint. Caption panel has fixed
     * `width: 30rem` + `height: 6rem` (constant — neither grows nor shrinks
     * with caption length) so the box geometry is identical from the first
     * caption through to the final press-outcome readout, mirroring the
     * accompanying lock on the slide-stimulus caption-row placeholder so
     * the bull's-eye Y position is pixel-stable across instruction → demo. */
    const stim = iOnlyDemoNode().stimulus;
    expect(stim).toContain('flex-direction: column');
    expect(stim).toContain('width: 30rem');
    expect(stim).toContain('height: 6rem');
  });

  it('button row reserves vertical space (min-height) so mounting/clearing buttons never shifts the circle', () => {
    expect(iOnlyDemoNode().stimulus).toMatch(/min-height:\s*6\.5rem/);
  });

  it('demo headings name the task number + plain-language title', () => {
    expect(dOnlyDemoNode().stimulus).toContain('Task 1');
    expect(dOnlyDemoNode().stimulus).toContain('Remember the dots');
    expect(tOnlyDemoNode().stimulus).toContain('Task 2');
    expect(tOnlyDemoNode().stimulus).toContain('Remember the tones');
    expect(iOnlyDemoNode().stimulus).toContain('Task 3');
    expect(iOnlyDemoNode().stimulus).toContain('Picture the pattern');
    expect(iDDemoNode().stimulus).toContain('Task 4');
    expect(iDDemoNode().stimulus).toContain('Dots and pattern together');
    expect(iTDemoNode().stimulus).toContain('Task 5');
    expect(iTDemoNode().stimulus).toContain('Tones and pattern together');
  });
});

describe('rotation-angle pool (imagery-bearing demos)', () => {
  it('contains 12 unique integer angles within ±90° excluding 0°', () => {
    expect(DEMO_ROTATION_ANGLE_POOL).toHaveLength(12);
    const set = new Set(DEMO_ROTATION_ANGLE_POOL);
    expect(set.size).toBe(12); /* unique */
    for (const a of DEMO_ROTATION_ANGLE_POOL) {
      expect(Number.isInteger(a)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(-90);
      expect(a).toBeLessThanOrEqual(90);
      expect(a).not.toBe(0);
    }
  });

  it('the pool spans the full ±90° range so participants see large rotations too', () => {
    expect(DEMO_ROTATION_ANGLE_POOL).toContain(-90);
    expect(DEMO_ROTATION_ANGLE_POOL).toContain(90);
  });

  it('pickDemoRotationAngle always returns a member of the pool (PRNG-driven)', () => {
    const seen = new Set();
    for (let i = 0; i < 50; i++) seen.add(__test__.pickDemoRotationAngle());
    /* Every drawn angle is in the pool. */
    for (const a of seen) expect(DEMO_ROTATION_ANGLE_POOL).toContain(a);
    /* With 50 draws from a 12-element pool we expect substantial variety
     * (not always-the-same-value). Lower bound 4 distinct values is a
     * very loose check that won't false-fail under any reasonable PRNG. */
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });
});

describe('press-outcome caption (button-press demonstration)', () => {
  /* Caption is label-driven : the participant-facing voice
   * names the chosen response by its meaning ("Yes" / "No" for memory
   * probes, "On-pattern" / "Not on-pattern" for star judgements) rather
   * than by keyboard side. Directional language ("Right arrow" / "Left
   * arrow") does not apply. */
  it('green wording when the chosen label matches the correct label', () => {
    const text = __test__.pressOutcomeCaption({
      pressedLabel: 'Yes',
      correctLabel: 'Yes',
      isCorrect: true,
      stimulusName: 'dot',
    });
    expect(text).toContain('Yes');
    expect(text.toLowerCase()).toContain('correct');
    expect(text.toLowerCase()).toContain('green');
    expect(text.toLowerCase()).toContain('dot');
  });

  it('red wording when the chosen label differs from the correct label, naming both', () => {
    const text = __test__.pressOutcomeCaption({
      pressedLabel: 'Not on-pattern',
      correctLabel: 'On-pattern',
      isCorrect: false,
      stimulusName: 'star',
    });
    expect(text).toContain('Not on-pattern');
    expect(text).toContain('On-pattern');
    expect(text.toLowerCase()).toContain('incorrect');
    expect(text.toLowerCase()).toContain('red');
    expect(text.toLowerCase()).toContain('star');
  });

  it('uses the supplied stimulus name (so dot/star/question-mark phrasing matches the visible feedback target)', () => {
    expect(
      __test__.pressOutcomeCaption({
        pressedLabel: 'Yes',
        correctLabel: 'No',
        isCorrect: false,
        stimulusName: 'question mark',
      })
    ).toContain('question mark');
  });

  it('caption never names a keyboard side ("Right" / "Left" / arrow)', () => {
    /* With 3 items per trial there is no directional language across
     * participant-facing copy. The caption must not leak it back. */
    for (const args of [
      { pressedLabel: 'Yes', correctLabel: 'Yes', isCorrect: true, stimulusName: 'dot' },
      { pressedLabel: 'No', correctLabel: 'Yes', isCorrect: false, stimulusName: 'dot' },
      {
        pressedLabel: 'On-pattern',
        correctLabel: 'Not on-pattern',
        isCorrect: false,
        stimulusName: 'star',
      },
    ]) {
      const text = __test__.pressOutcomeCaption(args).toLowerCase();
      expect(text).not.toMatch(/\bright\b/);
      expect(text).not.toMatch(/\bleft\b/);
      expect(text).not.toContain('arrow');
      expect(text).not.toContain('→');
      expect(text).not.toContain('←');
    }
  });
});

describe('demo wiring in the instructions composer', () => {
  it('every per-type instruction screen is followed by its demo before any practice trial', () => {
    const chain = assembleInstructionsAndPractice();
    const inner = chain[1].timeline;
    const resolved = inner.map((n) => (typeof n.data === 'function' ? n.data() : n.data));

    /* For each instruction → demo pair, the demo must be the IMMEDIATE next
     * data-bearing node so participants see the demo before any practice
     * trial. */
    const pairs = [
      ['instructions_memory_d_only', 'demo_d_only'],
      ['instructions_memory_t_only', 'demo_t_only'],
      ['instructions_imagery_i_only', 'demo_i_only'],
      ['instructions_dual_i_d', 'demo_i_d'],
      ['instructions_dual_i_t', 'demo_i_t'],
    ];
    for (const [instructionPhase, demoPhase] of pairs) {
      const instructionIdx = resolved.findIndex((d) => d?.phase === instructionPhase);
      const demoIdx = resolved.findIndex((d) => d?.phase === demoPhase);
      expect(instructionIdx, `${instructionPhase} not in timeline`).toBeGreaterThan(-1);
      expect(demoIdx, `${demoPhase} not in timeline`).toBe(instructionIdx + 1);
    }
  });

  it('all five demos appear exactly once in the inner timeline', () => {
    const chain = assembleInstructionsAndPractice();
    const inner = chain[1].timeline;
    const resolved = inner.map((n) => (typeof n.data === 'function' ? n.data() : n.data));
    const demoPhases = resolved.filter((d) => d?.phase?.startsWith('demo_')).map((d) => d.phase);
    expect(demoPhases.sort()).toEqual([
      'demo_d_only',
      'demo_i_d',
      'demo_i_only',
      'demo_i_t',
      'demo_t_only',
    ]);
  });

  it('teaching arc preserved: demo precedes practice (block_label="practice") for every type', () => {
    const chain = assembleInstructionsAndPractice();
    const inner = chain[1].timeline;
    const resolved = inner.map((n) => (typeof n.data === 'function' ? n.data() : n.data));
    for (const trialType of DEMO_TRIAL_TYPES) {
      const demoIdx = resolved.findIndex((d) => d?.phase === `demo_${trialType}`);
      expect(demoIdx).toBeGreaterThan(-1);
      /* Look forward — the next practice-block-labelled node should appear
       * before any other demo / instruction phase. */
      let sawPractice = false;
      for (let i = demoIdx + 1; i < resolved.length; i++) {
        if (resolved[i]?.block_label === 'practice') {
          sawPractice = true;
          break;
        }
        if (
          resolved[i]?.phase?.startsWith('demo_') ||
          resolved[i]?.phase?.startsWith('instructions_')
        ) {
          break;
        }
      }
      expect(sawPractice, `expected practice trials after demo_${trialType}`).toBe(true);
    }
  });
});
