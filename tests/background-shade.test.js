/**
 * Tests for the per-trial background-shade counterbalance.
 *
 * @vitest-environment jsdom
 *
 * jsdom is required because `main-blocks.js` transitively imports the per-
 * condition trial composers, which import jsPsych v8 plugins whose module
 * load touches `window`. No rendering happens here — we only inspect data
 * stamped on the trial-param objects.
 *
 * The contract tested here:
 *   1. `balancedShadesForBlock(N)` returns exactly N shades drawn from the
 *      `{white, gray}` palette.
 *   2. For even N, the split is exactly 50/50.
 *   3. For odd N, the split is N/2 and N/2+1 (off by one).
 *   4. Output ordering varies between PRNG seeds (i.e. it actually shuffles).
 *   5. The shade values are the canonical lower-case strings the rest of
 *      the pipeline (`createGridFrame`, `setTrialPageBackground`, CSV
 *      `Background_Shade` column) expects.
 *   6. Block generators stamp `background_shade` on every emitted trial
 *      spec so the page-flip + colour primitives have something to read.
 *   7. `main-blocks` stratified split preserves the 50/50 balance within
 *      each half of every per-type pool.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import { balancedShadesForBlock } from '../src/scheduler/background-shade.js';
import {
  BACKGROUND_SHADES,
  BACKGROUND_FILLS,
  PATTERN_FILLS_BY_BG,
  isValidBackgroundShade,
} from '../src/visuals/colour-palette.js';
import { createPRNG, setSessionPRNG } from '../src/prng.js';
import { generateMemoryBlock } from '../src/scheduler/memory-block.js';
import { generateImageryBlock } from '../src/scheduler/imagery-block.js';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { generateMainBlockPair } from '../src/scheduler/main-blocks.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';

beforeEach(() => {
  setSessionPRNG('background-shade-test-seed');
  resetSequencePools();
});

describe('balancedShadesForBlock', () => {
  it('returns exactly N shades drawn from the palette', () => {
    const rng = createPRNG('shade-len-test');
    for (const N of [1, 2, 6, 12, 24, 25]) {
      const out = balancedShadesForBlock(N, rng);
      expect(out).toHaveLength(N);
      for (const s of out) expect(BACKGROUND_SHADES).toContain(s);
    }
  });

  it('produces an exact 50/50 split for even block sizes', () => {
    const rng = createPRNG('shade-even-test');
    for (const N of [2, 4, 6, 8, 12, 24, 48]) {
      const out = balancedShadesForBlock(N, rng);
      const whites = out.filter((s) => s === 'white').length;
      const grays = out.filter((s) => s === 'gray').length;
      expect(whites).toBe(N / 2);
      expect(grays).toBe(N / 2);
    }
  });

  it('off-by-one balance for odd block sizes', () => {
    const rng = createPRNG('shade-odd-test');
    for (const N of [1, 3, 5, 7, 11, 25]) {
      const out = balancedShadesForBlock(N, rng);
      const whites = out.filter((s) => s === 'white').length;
      const grays = out.filter((s) => s === 'gray').length;
      expect(whites + grays).toBe(N);
      expect(Math.abs(whites - grays)).toBe(1);
    }
  });

  it('different seeds produce different shade orderings', () => {
    const rngA = createPRNG('seed-A');
    const rngB = createPRNG('seed-B');
    const a = balancedShadesForBlock(24, rngA);
    const b = balancedShadesForBlock(24, rngB);
    expect(a).not.toEqual(b);
  });

  it('rejects blockSize < 1', () => {
    expect(() => balancedShadesForBlock(0)).toThrow();
    expect(() => balancedShadesForBlock(-1)).toThrow();
    expect(() => balancedShadesForBlock(undefined)).toThrow();
  });
});

describe('colour-palette constants', () => {
  it('exposes white + gray fills as the documented hex codes', () => {
    expect(BACKGROUND_FILLS.white).toBe('#FFFFFF');
    expect(BACKGROUND_FILLS.gray).toBe('#D3D3D3');
  });

  it('pattern fill is the complementary shade of the background', () => {
    expect(PATTERN_FILLS_BY_BG.white).toBe(BACKGROUND_FILLS.gray);
    expect(PATTERN_FILLS_BY_BG.gray).toBe(BACKGROUND_FILLS.white);
  });

  it('isValidBackgroundShade only accepts the canonical strings', () => {
    expect(isValidBackgroundShade('white')).toBe(true);
    expect(isValidBackgroundShade('gray')).toBe(true);
    expect(isValidBackgroundShade('grey')).toBe(false);
    expect(isValidBackgroundShade('WHITE')).toBe(false);
    expect(isValidBackgroundShade(null)).toBe(false);
    expect(isValidBackgroundShade(undefined)).toBe(false);
  });
});

describe('block generators stamp background_shade on every trial spec', () => {
  it('memory blocks (d_only / t_only) stamp shade with 50/50 balance', () => {
    for (const trialType of ['d_only', 't_only']) {
      const trials = generateMemoryBlock({
        trialType,
        blockSize: 24,
        sequencePoolLabel: `bg-shade-test-${trialType}`,
        prng: createPRNG(`bg-shade-${trialType}`),
      });
      expect(trials).toHaveLength(24);
      for (const t of trials) {
        expect(isValidBackgroundShade(t.background_shade)).toBe(true);
      }
      const whites = trials.filter((t) => t.background_shade === 'white').length;
      expect(whites).toBe(12);
    }
  });

  it('imagery block (i_only) stamps shade with 50/50 balance', () => {
    const trials = generateImageryBlock({
      blockSize: 24,
      sequencePoolLabel: 'bg-shade-i-only',
      prng: createPRNG('bg-shade-i-only'),
    });
    expect(trials).toHaveLength(24);
    for (const t of trials) {
      expect(isValidBackgroundShade(t.background_shade)).toBe(true);
    }
    const whites = trials.filter((t) => t.background_shade === 'white').length;
    expect(whites).toBe(12);
  });

  it('dual blocks (i_d / i_t) stamp shade with 50/50 balance', () => {
    for (const trialType of ['i_d', 'i_t']) {
      const trials = generateDualBlock({
        trialType,
        blockSize: 24,
        sequencePoolLabel: `bg-shade-test-${trialType}`,
        prng: createPRNG(`bg-shade-${trialType}`),
      });
      expect(trials).toHaveLength(24);
      for (const t of trials) {
        expect(isValidBackgroundShade(t.background_shade)).toBe(true);
      }
      const whites = trials.filter((t) => t.background_shade === 'white').length;
      expect(whites).toBe(12);
    }
  });
});

describe('main-blocks stratified split preserves 50/50 balance per half', () => {
  it('every per-type half of Main A and Main B has exactly 6 of each shade', () => {
    const pair = generateMainBlockPair({ prng: createPRNG('main-block-shade-test') });
    /* Each per-type pool is 24 trials → split 12+12 with exactly 6/6
     * per shade in each half. The split is shade-stratified so neither
     * half can drift. trialParamsByType.<type>.{halfA,halfB} carry the
     * authoritative split (assembleBlock's `trialParams` is the same
     * trial set, just iterated in cross-condition order). */
    for (const trialType of ['d_only', 't_only', 'i_only', 'i_d', 'i_t']) {
      const halves = pair.trialParamsByType[trialType];
      for (const half of [halves.halfA, halves.halfB]) {
        expect(half).toHaveLength(12);
        const whites = half.filter((p) => p.background_shade === 'white').length;
        expect(whites).toBe(6);
      }
    }
  });
});
