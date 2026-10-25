/**
 * The run id must differ on every page load, whatever the browser offers.
 *
 * Without `crypto.randomUUID` the id used to be the first 8 DIGITS of
 * `Date.now()` (a 13-digit number), which changes only every 100,000 ms: a reload within
 * about 100 seconds of the previous load reused the run id, so
 * file names collided (FILE_EXISTS counts as delivered), the exporter merged the two
 * runs and (run_id, seq) de-duplication could drop rows. Firefox 92-94 has every
 * other API the study needs but not randomUUID (final independent review).
 */
import { describe, expect, it } from 'vitest';
import { makeRunId } from '../src/storage.js';

const HEX8 = /^[0-9a-f]{8}$/;
const NOW = 1_761_400_000_000;

describe('makeRunId', () => {
  it('documents the old defect: the first 8 digits of the clock repeat for ~100 seconds', () => {
    const old = (now) => `${now}-${Math.random()}`.slice(0, 8);
    expect(old(NOW)).toBe(old(NOW + 60_000)); /* a reload a minute later: the SAME id */
    expect(old(NOW)).toBe(old(NOW + 90_000));
  });

  it('uses randomUUID when there is one', () => {
    const id = makeRunId({
      crypto: { randomUUID: () => 'abcdef12-3456-4789-8abc-def012345678' },
    });
    expect(id).toBe('abcdef12');
  });

  it('falls back to getRandomValues (Firefox 92-94): 8 hex characters, new each time', () => {
    let n = 0;
    const cr = {
      getRandomValues: (a) => {
        a[0] = (0x9e3779b1 * ++n) >>> 0;
        return a;
      },
    };
    const ids = Array.from({ length: 200 }, () => makeRunId({ crypto: cr, now: NOW }));
    for (const id of ids) expect(id).toMatch(HEX8);
    expect(new Set(ids).size).toBe(200);
  });

  it('with no crypto at all it is still random (not a function of the clock alone)', () => {
    const ids = Array.from({ length: 300 }, () => makeRunId({ crypto: null, now: NOW }));
    for (const id of ids) expect(id).toMatch(HEX8);
    /* 32 random-ish bits: 300 draws from the real Math.random collide with
     * probability ~1e-5 */
    expect(new Set(ids).size).toBeGreaterThan(295);
  });

  it('two loads a minute apart differ even when only the clock-based fallback exists', () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) ids.add(makeRunId({ crypto: undefined, now: NOW + i * 1000 }));
    expect(ids.size).toBeGreaterThan(48);
  });

  it('a malformed randomUUID result is not used', () => {
    const id = makeRunId({ crypto: { randomUUID: () => 'not-a-uuid!' } });
    expect(id).toMatch(HEX8);
  });
});
