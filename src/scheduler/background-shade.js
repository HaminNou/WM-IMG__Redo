/**
 * Per-trial background-shade balancer.
 *
 * Each trial has a white (RGB 255,255,255) or gray (RGB 211,211,211)
 * background, changing from trial to trial. The flip is applied across all
 * 5 trial types so every block of every type contains an exact
 * 50/50 split of the two shades. The per-trial colour is then plumbed
 * through to the page-flip mechanism (`visuals/page-background.js`) and
 * to the SVG primitives (bull's-eye, fixation, dots, stars, pattern,
 * rotation arrow) via the trial's `background_shade` parameter.
 *
 * Block-level balance is enforced exactly when `blockSize` is even (the
 * normal case — 24 main-block trials, 8/12-trial practice blocks, etc.).
 * For odd block sizes the residual trial is assigned to whichever shade
 * the PRNG draws — the imbalance is at most one trial in that block, and
 * the across-block average remains 50/50 in expectation. We never raise
 * an error so a small practice run can always be assembled.
 */
import { getSessionPRNG } from '../prng.js';
import { BACKGROUND_SHADES } from '../visuals/colour-palette.js';

/**
 * Return a shuffled length-`blockSize` array of 'white' / 'gray' shades
 * containing as close to a 50/50 split as `blockSize` allows.
 *
 * @param {number} blockSize
 * @param {object} [prng]
 * @returns {string[]}
 */
export function balancedShadesForBlock(blockSize, prng) {
  if (typeof blockSize !== 'number' || blockSize < 1) {
    throw new Error(`balancedShadesForBlock: blockSize must be ≥ 1, got ${blockSize}`);
  }
  const rng = prng ?? getSessionPRNG();
  const half = Math.floor(blockSize / 2);
  const remainder = blockSize % 2;
  const counts = new Map(BACKGROUND_SHADES.map((s) => [s, half]));
  if (remainder === 1) {
    /* PRNG decides which shade absorbs the leftover — across many odd-size
     * blocks the imbalance averages out. */
    const winner = BACKGROUND_SHADES[rng.int(BACKGROUND_SHADES.length)];
    counts.set(winner, counts.get(winner) + 1);
  }
  const out = [];
  for (const shade of BACKGROUND_SHADES) {
    for (let i = 0; i < counts.get(shade); i++) out.push(shade);
  }
  return rng.shuffle(out);
}
