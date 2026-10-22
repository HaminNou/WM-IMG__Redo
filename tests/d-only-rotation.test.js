/**
 * @vitest-environment jsdom
 *
 * Display rotation of D-only trials: stratified like the imagery angles,
 * ordered under the same rules, drawn after every other draw of the block,
 * and absent from the other memory condition.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMemoryBlock } from '../src/scheduler/memory-block.js';
import * as rotationBalance from '../src/scheduler/rotation-balance.js';
import {
  ROTATION_STRATA,
  arrangeTrialOrder,
  orderViolations,
  rotationStratumIndex,
  trialAngleDeg,
} from '../src/scheduler/rotation-balance.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { createPRNG, setSessionPRNG } from '../src/prng.js';
import { generateMainBlockPair } from '../src/scheduler/main-blocks.js';

function dOnlyBlock(seed, blockSize = 24) {
  setSessionPRNG(seed);
  resetSequencePools();
  return generateMemoryBlock({ trialType: 'd_only', blockSize });
}

afterEach(() => vi.restoreAllMocks());

describe('d_only display_rotation_deg', () => {
  it('is an integer in -90..90, never 0, and unique within a 24-trial block', () => {
    const angles = dOnlyBlock('d-rot-1').map((t) => t.display_rotation_deg);
    expect(angles).toHaveLength(24);
    for (const a of angles) {
      expect(Number.isInteger(a)).toBe(true);
      expect(Math.abs(a)).toBeGreaterThanOrEqual(1);
      expect(Math.abs(a)).toBeLessThanOrEqual(90);
    }
    expect(new Set(angles).size).toBe(24);
  });

  it.each(['d-rot-a', 'd-rot-b', 'd-rot-c'])(
    'has exactly 4 angles in each of the six 30-degree strata (%s)',
    (seed) => {
      const counts = Array(ROTATION_STRATA.length).fill(0);
      for (const t of dOnlyBlock(seed)) counts[rotationStratumIndex(t.display_rotation_deg)] += 1;
      expect(counts).toEqual([4, 4, 4, 4, 4, 4]);
    }
  );

  it('splits evenly between clockwise and counter-clockwise', () => {
    const angles = dOnlyBlock('d-rot-sign').map((t) => t.display_rotation_deg);
    expect(angles.filter((a) => a > 0)).toHaveLength(12);
    expect(angles.filter((a) => a < 0)).toHaveLength(12);
  });

  it('is absent from t_only trials', () => {
    setSessionPRNG('t-rot');
    resetSequencePools();
    const block = generateMemoryBlock({ trialType: 't_only', blockSize: 24 });
    for (const t of block) expect(t).not.toHaveProperty('display_rotation_deg');
  });

  it('is drawn after every other draw: the rest of each trial does not depend on it', () => {
    const withRotation = dOnlyBlock('d-rot-stream');
    vi.spyOn(rotationBalance, 'stratifiedRotationAngles').mockImplementation((n) =>
      Array.from({ length: n }, () => 1)
    );
    const withoutDraw = dOnlyBlock('d-rot-stream');
    const strip = ({ display_rotation_deg: _drop, ...rest }) => rest;
    expect(withRotation.map(strip)).toEqual(withoutDraw.map(strip));
    expect(withRotation.map((t) => t.display_rotation_deg)).not.toEqual(
      withoutDraw.map((t) => t.display_rotation_deg)
    );
  });
});

describe('order rules apply to display rotations', () => {
  const trial = (display_rotation_deg, extra = {}) => ({
    trial_type: 'd_only',
    background_shade: 'gray',
    display_rotation_deg,
    ...extra,
  });

  it('trialAngleDeg reads the imagery angle or the display angle', () => {
    expect(trialAngleDeg({ rotation_deg: 40 })).toBe(40);
    expect(trialAngleDeg({ display_rotation_deg: -40 })).toBe(-40);
    expect(trialAngleDeg({ trial_type: 't_only' })).toBeNull();
  });

  it('counts a run of seven same-sign d_only rotations', () => {
    const run = [10, 20, 30, 40, 50, 60, 70].map((a, i) =>
      trial(a, { background_shade: i % 2 ? 'white' : 'gray' })
    );
    expect(orderViolations(run)).toBe(1);
    expect(orderViolations(run.slice(0, 6))).toBe(0);
  });

  it('counts consecutive d_only angles closer than the minimum step', () => {
    expect(orderViolations([trial(10), trial(11)])).toBe(1);
    expect(orderViolations([trial(10), trial(13)])).toBe(0);
  });

  it('pools d_only and imagery rotations in one sequence', () => {
    const mixed = [trial(10), { trial_type: 'i_only', rotation_deg: 11, background_shade: 'gray' }];
    expect(orderViolations(mixed)).toBe(1);
  });

  it('ignores trials without any rotation', () => {
    const t = { trial_type: 't_only', background_shade: 'gray' };
    expect(orderViolations([trial(10), t, trial(80)])).toBe(0);
  });

  it('arrangeTrialOrder removes violations from a 24-trial d_only block', () => {
    const block = dOnlyBlock('d-rot-arrange');
    const arranged = arrangeTrialOrder(block, createPRNG('arrange-seed'));
    expect(arranged).toHaveLength(24);
    expect(new Set(arranged)).toEqual(new Set(block));
    expect(orderViolations(arranged)).toBe(0);
  });

  it.each(['d-main-1', 'd-main-2', 'd-main-3'])(
    'the main blocks built for %s satisfy the order rules including d_only angles',
    (seed) => {
      setSessionPRNG(seed);
      resetSequencePools();
      const pair = generateMainBlockPair();
      for (const b of [pair.mainA, pair.mainB]) {
        const params = b.trialParams;
        const dOnly = params.filter((p) => p.trial_type === 'd_only');
        expect(dOnly).toHaveLength(12);
        expect(dOnly.every((p) => Number.isInteger(p.display_rotation_deg))).toBe(true);
        expect(orderViolations(params)).toBe(0);
      }
    }
  );
});
