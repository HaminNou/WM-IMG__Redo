/**
 * Tests for src/audio/equal-loudness.js — the 70-phon compensation applied
 * to every tone, evaluated from ISO 226:2023 Formula (1) with the Table 1
 * parameters (αf, LU, Tf).
 */
import { describe, it, expect } from 'vitest';
import { equalLoudnessGainDb70Phon, iso226SplForPhon } from '../src/audio/equal-loudness.js';

describe('iso226SplForPhon (ISO 226:2023 Formula (1))', () => {
  it('returns the loudness level itself at 1 kHz (definitional)', () => {
    for (const phon of [40, 60, 70, 80, 90]) {
      expect(iso226SplForPhon(1000, phon)).toBeCloseTo(phon, 9);
    }
  });

  it('matches spot values of the 2023 60-phon contour (guards the Table 1 parameters)', () => {
    const expected = {
      20: 109.37,
      100: 78.5,
      200: 69.73,
      500: 62.06,
      2000: 60.0,
      3150: 56.36,
      4000: 57.65,
      8000: 71.5,
    };
    for (const [freq, spl] of Object.entries(expected)) {
      expect(iso226SplForPhon(Number(freq), 60)).toBeCloseTo(spl, 1);
    }
  });

  it('interpolates linearly in log-frequency between centre frequencies', () => {
    const mid = Math.sqrt(200 * 250);
    expect(iso226SplForPhon(mid, 70)).toBeCloseTo(
      (iso226SplForPhon(200, 70) + iso226SplForPhon(250, 70)) / 2,
      9
    );
  });
});

describe('equalLoudnessGainDb70Phon', () => {
  it('returns exactly 0 dB at the 1 kHz reference', () => {
    expect(equalLoudnessGainDb70Phon(1000)).toBe(0);
  });

  it('boosts the low end (+7.83 dB at 200 Hz) and cuts near the 3 kHz peak', () => {
    expect(equalLoudnessGainDb70Phon(200)).toBeCloseTo(7.83, 1);
    expect(equalLoudnessGainDb70Phon(500)).toBeCloseTo(1.47, 1);
    expect(equalLoudnessGainDb70Phon(3150)).toBeCloseTo(-3.24, 1);
  });

  it('the bank minimum is about −3.04 dB, near 3 kHz', () => {
    let min = Infinity;
    let at = 0;
    for (let i = 0; i < 24; i++) {
      const f = 200 * (3900 / 200) ** (i / 23);
      const g = equalLoudnessGainDb70Phon(f);
      if (g < min) {
        min = g;
        at = f;
      }
    }
    expect(min).toBeCloseTo(-3.04, 1);
    expect(at).toBeGreaterThan(2800);
    expect(at).toBeLessThan(3200);
  });

  it('worst-case boost at the default 0.25 peak stays below the 0.95 clipping margin', () => {
    const samplePoints = [200, 250, 315, 400, 500, 800, 1000, 1600, 2000, 2500, 3150, 3900];
    const maxPeak = Math.max(
      ...samplePoints.map((f) => 0.25 * 10 ** (equalLoudnessGainDb70Phon(f) / 20))
    );
    expect(maxPeak).toBeLessThan(0.95);
    expect(maxPeak).toBeCloseTo(0.62, 1);
  });

  it('throws a RangeError outside the ISO 226 domain [20, 12500] Hz', () => {
    expect(() => equalLoudnessGainDb70Phon(10)).toThrow(RangeError);
    expect(() => equalLoudnessGainDb70Phon(20000)).toThrow(RangeError);
    expect(() => equalLoudnessGainDb70Phon(NaN)).toThrow(RangeError);
  });
});
