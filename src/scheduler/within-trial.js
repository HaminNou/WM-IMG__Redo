/**
 * Within-trial encoding-sequence sampler.
 *
 * Each dual-task trial has 3 memory items (M) and 3 imagery probes / stars
 * (S), arranged as a length-6 string over {M, S}. The design constraint is
 * **run-length ≤ 2** (no three M's or three S's in a row), with first and
 * last positions free. Brute-force enumeration over all C(6,3) = 20 binary
 * strings with 3 M's and 3 S's, minus the 6 strings that contain a run of
 * three (4 with MMM, 4 with SSS, intersection MMMSSS / SSSMMM = 2; by
 * inclusion-exclusion 4 + 4 − 2 = 6 invalid), yields **14** valid strings.
 *
 * Single-task trials (D-only, T-only, I-only) reuse the same 14-string pool,
 * with the unused-modality slots filled by open-square dummies — so single-
 * and dual-task trials have an identical temporal envelope.
 *
 * For arbitrary block sizes, the sampler uses sample-without-replacement:
 * it draws each of the 14 sequences exactly once, then re-shuffles. For the
 * 24-trial main-condition blocks, the constraint is **slot-position
 * balance**: each of the 6 positions hosts M on exactly 12 trials and S on
 * exactly 12 trials. The pool of 14 valid sequences is smaller than the
 * 24-trial block, so sequence repetition is mathematically forced (each
 * sequence is used 1.71× on average). The 24-trial draw is built from 12
 * complement pairs (a sequence plus its M/S swap), which gives the exact
 * slot balance by construction and uses every sequence once or twice.
 */
import { getSessionPRNG } from '../prng.js';
import { config } from '../config.js';

const SEQUENCE_LENGTH = 6;
const M_COUNT = 3;

let CACHED_VALID = null;

/**
 * Returns the full enumeration of valid length-6 sequences as an array of
 * arrays (each inner array length 6, entries 'M' or 'S'). Built once and
 * memoised. Sequence order is canonical (sorted as binary strings) so the
 * enumeration is deterministic across runs and tests can rely on the order.
 */
export function enumerateValidSequences() {
  if (CACHED_VALID !== null) return CACHED_VALID;
  const cap = config.sequencing.within_trial_run_length_cap;
  const out = [];

  for (let mask = 0; mask < 1 << SEQUENCE_LENGTH; mask++) {
    const seq = [];
    let ones = 0;
    for (let bit = SEQUENCE_LENGTH - 1; bit >= 0; bit--) {
      const b = (mask >> bit) & 1;
      seq.push(b === 1 ? 'M' : 'S');
      ones += b;
    }
    if (ones !== M_COUNT) continue;
    if (!withinRunLengthCap(seq, cap)) continue;
    out.push(Object.freeze(seq));
  }

  CACHED_VALID = Object.freeze(out);
  return CACHED_VALID;
}

function withinRunLengthCap(seq, cap) {
  let runChar = null;
  let runLen = 0;
  for (const c of seq) {
    if (c === runChar) {
      runLen += 1;
      if (runLen > cap) return false;
    } else {
      runChar = c;
      runLen = 1;
    }
  }
  return true;
}

/**
 * Stateful sample-without-replacement pool. Calling next() returns a single
 * sequence (a frozen array). When the underlying shuffled list is exhausted,
 * a new one is shuffled in place and sampling continues. The pool is keyed
 * by `label` so D-only, T-only, I-only, I+D, I+T can each maintain their own
 * independent draw history (avoids one condition's random walk biasing
 * another's, which would matter if conditions were drawn from the same pool
 * with run-length constraints).
 */
const POOLS = new Map();

export function createSequencePool(label, prng = getSessionPRNG()) {
  if (POOLS.has(label)) return POOLS.get(label);
  const valid = enumerateValidSequences();
  const state = {
    label,
    prng,
    queue: prng.shuffle(valid.slice()),
    cursor: 0,
    drawn_count: 0,
    next() {
      if (state.cursor >= state.queue.length) {
        state.queue = state.prng.shuffle(valid.slice());
        state.cursor = 0;
      }
      const seq = state.queue[state.cursor++];
      state.drawn_count += 1;
      return seq;
    },
  };
  POOLS.set(label, state);
  return state;
}

export function resetSequencePools() {
  POOLS.clear();
}

function complementSequence(seq) {
  return Object.freeze(seq.map((c) => (c === 'M' ? 'S' : 'M')));
}

/* The 14 valid sequences form 7 complement pairs (swap M and S at every
 * slot; run lengths and the 3 + 3 composition are unchanged). */
function complementPairs() {
  const valid = enumerateValidSequences();
  const byKey = new Map(valid.map((s) => [s.join(''), s]));
  const seen = new Set();
  const pairs = [];
  for (const s of valid) {
    const key = s.join('');
    if (seen.has(key)) continue;
    const comp = byKey.get(complementSequence(s).join(''));
    seen.add(key);
    seen.add(comp.join(''));
    pairs.push([s, comp]);
  }
  return pairs;
}

/* Exact slot balance by construction. A block of 2k trials is built from k
 * complement pairs, so every slot holds M on exactly k trials and S on
 * exactly k trials. The k pairs are drawn so that every pair is used
 * floor(k / 7) times and the remaining k mod 7 pairs are chosen at random
 * without replacement. For the 24-trial block (k = 12) every one of the 14
 * sequences is used once or twice (ten sequences twice, four once), and the
 * draw cannot fail. */
function drawSlotBalancedBlock(blockSize, prng) {
  if (blockSize % 2 !== 0) {
    throw new Error(
      `drawBlockSequences: exact slot-position balance requires an even block size, got ${blockSize}.`
    );
  }
  const pairs = complementPairs();
  const k = blockSize / 2;
  const chosen = [];
  for (let r = 0; r < Math.floor(k / pairs.length); r++) chosen.push(...pairs);
  chosen.push(...prng.shuffle(pairs.slice()).slice(0, k % pairs.length));
  const out = [];
  for (const [a, b] of chosen) out.push(a, b);
  return Object.freeze(prng.shuffle(out));
}

/**
 * Draw a block's worth of within-trial M/S sequences.
 *
 * For 24-trial condition blocks, returns a sequence set with exact
 * slot-position balance (12 M / 12 S at every one of the 6 positions),
 * sampled with replacement from the 14-sequence pool. For smaller blocks
 * such as practice, falls back to the stateful sample-without-replacement
 * pool.
 */
export function drawBlockSequences({
  blockSize,
  label,
  prng = getSessionPRNG(),
  exactSlotBalance = blockSize === 24,
} = {}) {
  if (typeof blockSize !== 'number' || blockSize < 1) {
    throw new Error(`drawBlockSequences: blockSize must be ≥ 1, got ${blockSize}`);
  }

  if (exactSlotBalance) {
    return drawSlotBalancedBlock(blockSize, prng);
  }

  const pool = createSequencePool(label ?? 'default', prng);
  const out = [];
  for (let i = 0; i < blockSize; i++) out.push(pool.next());
  return Object.freeze(out);
}
