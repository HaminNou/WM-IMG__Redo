/**
 * Seeded PRNG.
 *
 * Single source of randomness for every counterbalance step in the experiment.
 * Schedules are reproducible from the saved seed (see data record `prng_seed`),
 * which lets us verify a participant's schedule post-hoc and lets us bisect any
 * counterbalance regression by replaying with their seed.
 *
 * xmur3 mixes the seed string into a uint32; Mulberry32 is the actual generator.
 * Both are short, well-known, and fast — they have no cryptographic guarantees,
 * which is exactly what we want for behavioural counterbalancing.
 */

function xmur3Hash(input) {
  let h = 1779033703 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

export function mulberry32(seedUint32) {
  let a = seedUint32 >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createPRNG(seedString) {
  const seed = xmur3Hash(seedString)();
  const next = mulberry32(seed);
  return {
    seed,
    next,
    int(maxExclusive) {
      return Math.floor(next() * maxExclusive);
    },
    pick(array) {
      return array[Math.floor(next() * array.length)];
    },
    shuffle(array) {
      const out = array.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

/* Lazy session-level singleton. Seeded once per session in prolific.js using a
 * concatenation of URL params so the seed is reproducible if Prolific reissues
 * the same PID (rare but documented). */
let sessionPRNG = null;

export function setSessionPRNG(seedString) {
  sessionPRNG = createPRNG(seedString);
  return sessionPRNG;
}

export function getSessionPRNG() {
  if (!sessionPRNG) {
    throw new Error('Session PRNG accessed before setSessionPRNG() was called.');
  }
  return sessionPRNG;
}
