/**
 * @vitest-environment jsdom
 *
 * Golden test: the practice path (blockSize 2, via assembleBlock) and the legacy
 * per-condition generators (used directly by practice and by many unit tests) must
 * stay bit-identical for fixed seeds when the main plan moves to the block-exact
 * design. Digests were captured BEFORE the block-exact generator was written.
 * Regenerate (only on purpose) with: WMIMG_WRITE_GOLDEN=1 npx vitest run tests/legacy-generators-golden.test.js
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { generateMemoryBlock } from '../src/scheduler/memory-block.js';
import { generateImageryBlock } from '../src/scheduler/imagery-block.js';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { singleTypePractice, practiceBlock } from '../src/scheduler/practice.js';

const GOLDEN = resolve(process.cwd(), 'tests/golden/legacy-generators.json');
const TYPES = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];
const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 24);

function legacy(type, size, rng, label) {
  if (type === 'd_only' || type === 't_only')
    return generateMemoryBlock({
      trialType: type,
      blockSize: size,
      sequencePoolLabel: label,
      prng: rng,
    });
  if (type === 'i_only')
    return generateImageryBlock({ blockSize: size, sequencePoolLabel: label, prng: rng });
  return generateDualBlock({
    trialType: type,
    blockSize: size,
    sequencePoolLabel: label,
    prng: rng,
  });
}

function capture() {
  const out = {};
  for (const seed of ['g1', 'g2', 'g3']) {
    for (const type of TYPES) {
      for (const size of [2, 3, 24]) {
        resetSequencePools();
        out[`gen|${type}|${size}|${seed}`] = digest(
          legacy(type, size, createPRNG(`${seed}|${type}`), `L${seed}`)
        );
      }
      resetSequencePools();
      const sp = singleTypePractice({ trialType: type, prng: createPRNG(`sp|${seed}|${type}`) });
      out[`single|${type}|${seed}`] = digest({ s: sp.schedule, t: sp.trialParams });
    }
    resetSequencePools();
    const pb = practiceBlock({ prng: createPRNG(`pb|${seed}`) });
    out[`practiceBlock|${seed}`] = digest({ s: pb.schedule, t: pb.trialParams });
  }
  return out;
}

describe('legacy generators + practice: golden digests', () => {
  it('match the digests captured before the block-exact change', () => {
    const now = capture();
    if (process.env.WMIMG_WRITE_GOLDEN) {
      writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n');
      return;
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden).sort());
    expect(now).toEqual(golden);
  });
  it('is deterministic run to run', () => {
    expect(capture()).toEqual(capture());
  });
});
