/**
 * Tests for src/audio/equal-loudness.js.
 *
 * Pinned invariants under test:
 *   1. The tabulated SPL values match the published ISO 226:2003 Annex A
 *      60-phon contour (cross-checked against Suzuki & Takeshima 2004,
 *      JASA 116(2), 918–933, Table I).
 *   2. The 1 kHz reference returns 60.0 dB SPL exactly (definitional).
 *   3. Gain in dB at 1 kHz is 0 (the reference); gain at 200 Hz is
 *      positive and roughly +7 dB (low-end boost); gain at 2.5–3 kHz is
 *      negative and roughly −2 to −5 dB (sensitivity peak).
 *   4. Linear interpolation in log-frequency between tabulated centres
 *      is monotonic in the directions implied by the tabulated table.
 *   5. Out-of-band frequencies throw a RangeError.
 *   6. `dbToLinear` round-trips numerically.
 */
import { describe, it, expect } from 'vitest';
import {
  iso226SplFor60Phon,
  equalLoudnessGainDb60Phon,
  dbToLinear,
  ISO226_60_PHON_TABLE,
  REFERENCE_FREQ_HZ,
  REFERENCE_SPL_DB,
} from '../src/audio/equal-loudness.js';

describe('ISO 226:2003 Annex A 60-phon table', () => {
  it('contains 29 anchor points spanning 20 Hz to 12.5 kHz', () => {
    expect(ISO226_60_PHON_TABLE).toHaveLength(29);
    expect(ISO226_60_PHON_TABLE[0].freq_hz).toBe(20);
    expect(ISO226_60_PHON_TABLE[ISO226_60_PHON_TABLE.length - 1].freq_hz).toBe(12500);
  });

  it('the 1 kHz row reports 60.0 dB SPL by definition (loudness in phons = SPL at 1 kHz)', () => {
    const row = ISO226_60_PHON_TABLE.find((r) => r.freq_hz === 1000);
    expect(row).toBeDefined();
    expect(row.spl_db).toBe(60.0);
    expect(REFERENCE_FREQ_HZ).toBe(1000);
    expect(REFERENCE_SPL_DB).toBe(60.0);
  });

  it('matches a sample of canonical Annex A values within 0.1 dB', () => {
    /* Spot-checks against Suzuki & Takeshima 2004 Table I, 60-phon column.
     * If any of these drift, the table has been edited away from the
     * published standard — fail loudly. */
    const expected = {
      100: 76.7,
      200: 67.5,
      500: 59.4,
      1000: 60.0,
      2000: 58.3,
      3150: 55.7,
      4000: 59.5,
      8000: 78.3,
    };
    for (const [freq, splDb] of Object.entries(expected)) {
      expect(iso226SplFor60Phon(Number(freq))).toBeCloseTo(splDb, 1);
    }
  });
});

describe('iso226SplFor60Phon — interpolation', () => {
  it('returns the tabulated value exactly at anchor frequencies', () => {
    for (const row of ISO226_60_PHON_TABLE) {
      expect(iso226SplFor60Phon(row.freq_hz)).toBe(row.spl_db);
    }
  });

  it('linearly interpolates in log-frequency between anchors', () => {
    /* Halfway between 200 and 250 Hz in log-space is sqrt(200 * 250) ≈
     * 223.61 Hz; the SPL there should be the simple average of the two
     * anchor values (67.5 and 64.9). */
    const fLog = Math.sqrt(200 * 250);
    const expected = (67.5 + 64.9) / 2;
    expect(iso226SplFor60Phon(fLog)).toBeCloseTo(expected, 6);
  });

  it('throws a RangeError for frequencies outside [20, 12500] Hz', () => {
    expect(() => iso226SplFor60Phon(10)).toThrow(RangeError);
    expect(() => iso226SplFor60Phon(20000)).toThrow(RangeError);
    expect(() => iso226SplFor60Phon(NaN)).toThrow(RangeError);
  });
});

describe('equalLoudnessGainDb60Phon', () => {
  it('returns 0 dB at the 1 kHz reference', () => {
    expect(equalLoudnessGainDb60Phon(1000)).toBe(0);
  });

  it('returns a positive (boost) value at 200 Hz, roughly +7 dB', () => {
    const g = equalLoudnessGainDb60Phon(200);
    expect(g).toBeGreaterThan(0);
    expect(g).toBeCloseTo(7.5, 0);
  });

  it('returns a negative (cut) value near the 2–3 kHz sensitivity peak', () => {
    /* The ear's peak sensitivity sits around 2–4 kHz; at 60 phons the
     * tabulated SPL there dips to ~55.7 dB, ~4 dB below the 1 kHz
     * reference of 60.0 dB. */
    const gAt2500 = equalLoudnessGainDb60Phon(2500);
    const gAt3150 = equalLoudnessGainDb60Phon(3150);
    expect(gAt2500).toBeLessThan(0);
    expect(gAt3150).toBeLessThan(0);
    expect(gAt2500).toBeCloseTo(-4.3, 0);
  });

  it('the locked tone bank worst-case boost stays within digital headroom', () => {
    /* Worst-case boost across 200..3900 Hz at peak 0.25 must keep the
     * final amplitude below 0.95 (the clipping margin we keep). */
    const samplePoints = [200, 250, 315, 400, 500, 800, 1000, 1600, 2000, 2500, 3150, 3900];
    let maxLinearPeak = 0;
    for (const f of samplePoints) {
      const peak = 0.25 * dbToLinear(equalLoudnessGainDb60Phon(f));
      if (peak > maxLinearPeak) maxLinearPeak = peak;
    }
    expect(maxLinearPeak).toBeLessThan(0.95);
    expect(maxLinearPeak).toBeGreaterThan(0.4); /* sanity: there *is* a low-end boost */
  });
});

describe('equalLoudnessGainDb70Phon (interpolated 60/80)', () => {
  const { equalLoudnessGainDb70Phon } = require('../src/audio/equal-loudness.js');

  it('returns 0 dB at 1 kHz (70 phons = 70 dB SPL at 1 kHz by definition)', () => {
    expect(equalLoudnessGainDb70Phon(1000)).toBe(0);
  });

  it('returns a positive correction at 200 Hz (low-end boost, smaller than 60-phon)', () => {
    const g70 = equalLoudnessGainDb70Phon(200);
    const g60 = equalLoudnessGainDb60Phon(200);
    expect(g70).toBeGreaterThan(4);
    expect(g70).toBeLessThan(8);
    expect(g70).toBeLessThan(g60); /* 70-phon contour is flatter than 60-phon */
  });

  it('worst-case boost at peak 0.25 stays below 0.95 clipping margin', () => {
    const samplePoints = [200, 250, 315, 400, 500, 800, 1000, 1600, 2000, 2500, 3150, 3900];
    let maxLinearPeak = 0;
    for (const f of samplePoints) {
      const peak = 0.25 * dbToLinear(equalLoudnessGainDb70Phon(f));
      if (peak > maxLinearPeak) maxLinearPeak = peak;
    }
    expect(maxLinearPeak).toBeLessThan(0.95);
  });
});

describe('dbToLinear', () => {
  it('returns 1 at 0 dB', () => {
    expect(dbToLinear(0)).toBe(1);
  });

  it('returns ~2 at +6.0206 dB and ~0.5 at −6.0206 dB', () => {
    expect(dbToLinear(20 * Math.log10(2))).toBeCloseTo(2, 9);
    expect(dbToLinear(-20 * Math.log10(2))).toBeCloseTo(0.5, 9);
  });
});
