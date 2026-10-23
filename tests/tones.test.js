/**
 * Tests for src/audio/tones.js.
 *
 * Pinned invariants under test , p. 150):
 *   1. 24 tones, log-equally spaced between `low_freq_hz` (= 200 Hz) and
 *      `high_freq_hz` (= 3900 Hz). A chromatic spec (220 Hz × 2^(k/12))
 *      is avoided because every tone would land on a named pitch class,
 *      exposing the bank to note-name re-encoding by musically trained
 *      participants.
 *   2. The neighbour ratio `(3900/200)^(1/23)` ≈ 1.1379 (~ 13.9 %, ≈ 224
 *      cents) sits in the gap *between* a Western whole-tone (200 cents)
 *      and a minor third (300 cents) — it is not a labelled musical
 *      interval in any 12-tet system.
 *   3. **Li et al.'s no-simple-harmonic-relationship criterion.** No pair
 *      of tones in the bank stands in a near-integer-multiple harmonic
 *      relationship (no tone_j ≈ N × tone_i for N ∈ {2, 3, 4} within
 *      3 %) — this is the literal check Li et al. (2013) report ("the
 *      second harmonic of 200 Hz is 400 Hz, whereas the closest tone in
 *      our set was 771.6 Hz"). With 24 log-equal tones across the same
 *      19.5× span as Li's 12-tone bank, the closest integer-multiple pair
 *      is 3.5 % off (a 10-step ratio against 4×); the analogous gap in
 *      Li's bank was ~ 3.6 %. **Note (documented residue):** the
 *      C(24, 2) = 276 pairs include one cluster (~ 4-step intervals) that
 *      lands within ~ 0.6 % of the 5:3 just-intonation ratio (a major
 *      sixth in just intonation, ≈ 10 cents flat of equal-tempered). This
 *      is a geometric inevitability of 24 evenly-log-spaced tones across
 *      a 19.5× ratio and is *not* the relationship Li flagged — Li's
 *      check is integer-multiple harmonics, not equal-tempered intervals.
 *      The post-experiment music-experience questionnaire is the analyst's
 *      hedge if any participant turns out to have absolute pitch.
 *   4. Every tone has a paired non-centre cell; the pairing is a bijection.
 *      Rank parity (odd → on-pattern, even → off-pattern) is preserved
 *      because the rule is rank-based, not
 *      frequency-value-based.
 *   5. Frequency rank parity matches pattern label (odd rank → on, even → off).
 */
import { describe, it, expect } from 'vitest';
import { getToneBank, toneForCell } from '../src/audio/tones.js';
import { config } from '../src/config.js';
import { onPatternCells, offPatternCells, patternLabel } from '../src/grid.js';

const FLOAT_EPSILON = 1e-9;
const COUNT = 24;

describe('tones: log-equal, non-musical frequency bank', () => {
  it('has exactly 24 tones', () => {
    expect(getToneBank()).toHaveLength(COUNT);
  });

  it('first tone is the configured low anchor (200 Hz by default)', () => {
    expect(getToneBank()[0].freq_hz).toBeCloseTo(config.tones.low_freq_hz, 9);
    expect(config.tones.low_freq_hz).toBe(200);
  });

  it('last tone is the configured high anchor (3900 Hz by default)', () => {
    expect(getToneBank()[COUNT - 1].freq_hz).toBeCloseTo(config.tones.high_freq_hz, 6);
    expect(config.tones.high_freq_hz).toBe(3900);
  });

  it('every adjacent pair has the same log-equal step ratio (within float epsilon)', () => {
    const bank = getToneBank();
    const expected = Math.pow(
      config.tones.high_freq_hz / config.tones.low_freq_hz,
      1 / (COUNT - 1)
    );
    for (let i = 1; i < bank.length; i++) {
      const ratio = bank[i].freq_hz / bank[i - 1].freq_hz;
      expect(Math.abs(ratio - expected)).toBeLessThan(FLOAT_EPSILON);
    }
  });

  it('frequencies match the explicit log-equal formula f_k = low × (high/low)^((k−1)/(N−1))', () => {
    const bank = getToneBank();
    for (let k = 1; k <= COUNT; k++) {
      const expected =
        config.tones.low_freq_hz *
        Math.pow(config.tones.high_freq_hz / config.tones.low_freq_hz, (k - 1) / (COUNT - 1));
      expect(bank[k - 1].freq_hz).toBeCloseTo(expected, 6);
      expect(bank[k - 1].rank).toBe(k);
    }
  });

  it('neighbour step sits in the gap between Western whole-tone and minor third', () => {
    /* The replacement bank's defining property: each step is a fixed log-
     * equal ratio that does *not* coincide with any 12-tet labelled interval.
     * Whole-tone = 2^(2/12) ≈ 1.1225; minor third = 2^(3/12) ≈ 1.1892. The
     * 24-tone fit across 200..3900 Hz puts the step at ≈ 1.1379, comfortably
     * inside that gap — a non-nameable interval. */
    const bank = getToneBank();
    const step = bank[1].freq_hz / bank[0].freq_hz;
    expect(step).toBeGreaterThan(Math.pow(2, 2 / 12)); /* > whole-tone */
    expect(step).toBeLessThan(Math.pow(2, 3 / 12)); /* < minor third */
    expect(step).toBeCloseTo(1.1379, 3);
  });

  it('no pair of tones is within 3 % of an integer-multiple harmonic relationship (2×, 3×, 4×)', () => {
    /* Li, Cowan & Saults (2013, p. 150) state their bank had "no simple
     * harmonic relationship" — the worked example in the paper is the 2nd
     * harmonic of 200 Hz (= 400 Hz), with the closest in-bank tone landing
     * at 771.6 Hz (~ 3.6 % off when projected to the 4× target the next
     * partial up). We reproduce that criterion: walk every pair of tones
     * and assert no tone lands within 3 % of N × another tone for
     * N ∈ {2, 3, 4}. With our 24-tone log-equal bank the closest integer
     * pair is ~ 3.5 % off (the 4× check), giving a passing margin
     * comparable to Li's own bank. */
    const bank = getToneBank();
    const freqs = bank.map((t) => t.freq_hz);
    const offenders = [];
    for (const f of freqs) {
      for (const mult of [2, 3, 4]) {
        const target = f * mult;
        for (const g of freqs) {
          if (g === f) continue;
          const dev = Math.abs(g / target - 1);
          if (dev < 0.03) {
            offenders.push({
              f: f.toFixed(2),
              mult,
              target: target.toFixed(2),
              g: g.toFixed(2),
              dev: dev.toFixed(4),
            });
          }
        }
      }
    }
    expect(offenders, `integer-multiple offenders: ${JSON.stringify(offenders)}`).toHaveLength(0);
  });

  it('every tone carries an ISO 226 70-phon equal-loudness gain in the expected sign pattern', () => {
    /* Interpolated between 60- and 80-phon tabulated contours. The tone-bank record exposes a `gain_compensation_db`
     * field equal to the dB difference between the SPL needed at the
     * tone's frequency and the SPL needed at 1 kHz to elicit the same
     * loudness in phons. The bank's lowest tones should boost (positive
     * gain), and tones near the ear's 2–4 kHz sensitivity peak should
     * cut (negative gain). The reference frequency (1 kHz) is not in
     * the bank exactly, but the closest tones either side should
     * straddle 0 dB once the lookup is interpolated. */
    const bank = getToneBank();
    const lowest = bank[0];
    expect(lowest.gain_compensation_db).toBeGreaterThan(5); /* low end always boosts */
    expect(lowest.gain_compensation_db).toBeLessThan(10);
    /* Find the tone with the most negative gain — should land near
     * 2.5–3 kHz (ear's sensitivity peak). */
    const minGainTone = bank.reduce((acc, t) =>
      t.gain_compensation_db < acc.gain_compensation_db ? t : acc
    );
    expect(minGainTone.gain_compensation_db).toBeLessThan(0);
    expect(minGainTone.freq_hz).toBeGreaterThan(1500);
    expect(minGainTone.freq_hz).toBeLessThan(4000);
    /* No tone in the locked bank should require a boost outside the
     * digital-headroom envelope (peak 0.25 × 10^(g/20) < 0.95 →
     * g < ~11.6 dB). */
    for (const t of bank) {
      expect(t.gain_compensation_db).toBeLessThan(11.6);
    }
  });

  it('every tone sits within the 200–4000 Hz band (Sek & Moore 1995 similar-DLF range)', () => {
    /* Sek & Moore (1995, JASA 97(4), 2479–2486) report similar frequency
     * difference limens up to ~ 4000 Hz; above that, DLFs rise quickly and
     * the high tones would be perceptually less discriminable than the low
     * ones. Pinning a hard ceiling at 4000 Hz keeps the whole bank in a
     * regime of comparable pitch acuity. The 200 Hz floor matches Li et
     * al.'s own band and avoids the low-end roll-off of consumer audio
     * output. */
    for (const t of getToneBank()) {
      expect(t.freq_hz).toBeGreaterThanOrEqual(200);
      expect(t.freq_hz).toBeLessThanOrEqual(4000);
    }
  });
});

describe('tones: cell pairing bijection', () => {
  it('every tone has a non-null paired_cell', () => {
    for (const t of getToneBank()) {
      expect(t.paired_cell).toBeTypeOf('number');
      expect(t.paired_cell).toBeGreaterThanOrEqual(0);
      expect(t.paired_cell).toBeLessThan(25);
      expect(t.paired_cell).not.toBe(config.grid.centre_cell_index);
    }
  });

  it('paired_cell values are unique across the bank (= bijection)', () => {
    const seen = new Set();
    for (const t of getToneBank()) {
      expect(seen.has(t.paired_cell)).toBe(false);
      seen.add(t.paired_cell);
    }
    expect(seen.size).toBe(COUNT);
  });

  it('toneForCell maps each paired cell back to its tone', () => {
    for (const t of getToneBank()) {
      expect(toneForCell(t.paired_cell).index).toBe(t.index);
    }
  });

  it('every on-pattern cell pairs with an "on"-labelled tone', () => {
    for (const cell of onPatternCells()) {
      const t = toneForCell(cell);
      expect(t.pattern_label).toBe('on');
      expect(patternLabel(cell)).toBe('on');
    }
  });

  it('every off-pattern cell pairs with an "off"-labelled tone', () => {
    for (const cell of offPatternCells()) {
      const t = toneForCell(cell);
      expect(t.pattern_label).toBe('off');
      expect(patternLabel(cell)).toBe('off');
    }
  });
});

describe('tones: on/off label distribution', () => {
  it('12 tones labelled "on", 12 labelled "off"', () => {
    const bank = getToneBank();
    expect(bank.filter((t) => t.pattern_label === 'on')).toHaveLength(12);
    expect(bank.filter((t) => t.pattern_label === 'off')).toHaveLength(12);
  });

  it('odd-ranked tones are "on", even-ranked are "off" (rank = bank-index + 1)', () => {
    for (const t of getToneBank()) {
      const isOddRank = t.rank % 2 === 1;
      expect(t.pattern_label).toBe(isOddRank ? 'on' : 'off');
    }
  });

  it('on-tone frequencies and off-tone frequencies interleave on the scale', () => {
    /* Sort by frequency, walk: should alternate strictly on/off/on/off... */
    const sorted = getToneBank()
      .slice()
      .sort((a, b) => a.freq_hz - b.freq_hz);
    for (let i = 0; i < sorted.length; i++) {
      expect(sorted[i].pattern_label).toBe(i % 2 === 0 ? 'on' : 'off');
    }
  });
});

describe('tones: input validation', () => {
  it('toneForCell throws on the centre cell or out-of-range', () => {
    expect(() => toneForCell(config.grid.centre_cell_index)).toThrow();
    expect(() => toneForCell(99)).toThrow();
  });
});
