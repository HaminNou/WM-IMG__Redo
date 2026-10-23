/**
 * Tests for src/audio/equal-loudness.js — the 70-phon compensation applied
 * to every tone, interpolated from the ISO 226:2003 Annex A 60- and 80-phon
 * contours (Suzuki & Takeshima 2004, JASA 116(2), Table I).
 */
import { describe, it, expect } from 'vitest';
import { equalLoudnessGainDb70Phon } from '../src/audio/equal-loudness.js';

/* Annex A SPL (dB) at the anchor frequency for the 60- and 80-phon contours. */
const ANCHORS = {
  200: [67.5, 84.3],
  250: [64.9, 82.0],
  1000: [60.0, 80.0],
  2500: [55.7, 74.5],
  3150: [55.7, 74.8],
  4000: [59.5, 79.1],
};

describe('equalLoudnessGainDb70Phon', () => {
  it('equals the mean of the 60- and 80-phon table corrections at anchor frequencies', () => {
    for (const [freq, [spl60, spl80]] of Object.entries(ANCHORS)) {
      const expected = (spl60 - 60 + (spl80 - 80)) / 2;
      expect(equalLoudnessGainDb70Phon(Number(freq))).toBeCloseTo(expected, 9);
    }
  });

  it('returns exactly 0 dB at the 1 kHz reference', () => {
    expect(equalLoudnessGainDb70Phon(1000)).toBe(0);
  });

  it('boosts the low end and cuts near the 2-4 kHz sensitivity peak', () => {
    expect(equalLoudnessGainDb70Phon(200)).toBeGreaterThan(4);
    expect(equalLoudnessGainDb70Phon(200)).toBeLessThan(8);
    expect(equalLoudnessGainDb70Phon(2500)).toBeLessThan(-4);
  });

  it('interpolates linearly in log-frequency between anchors', () => {
    const mid = Math.sqrt(200 * 250);
    const g200 = equalLoudnessGainDb70Phon(200);
    const g250 = equalLoudnessGainDb70Phon(250);
    expect(equalLoudnessGainDb70Phon(mid)).toBeCloseTo((g200 + g250) / 2, 9);
  });

  it('worst-case boost at the default 0.25 peak stays below the 0.95 clipping margin', () => {
    const samplePoints = [200, 250, 315, 400, 500, 800, 1000, 1600, 2000, 2500, 3150, 3900];
    const maxPeak = Math.max(
      ...samplePoints.map((f) => 0.25 * 10 ** (equalLoudnessGainDb70Phon(f) / 20))
    );
    expect(maxPeak).toBeLessThan(0.95);
    expect(maxPeak).toBeGreaterThan(0.4);
  });

  it('throws a RangeError outside the ISO 226 domain [20, 12500] Hz', () => {
    expect(() => equalLoudnessGainDb70Phon(10)).toThrow(RangeError);
    expect(() => equalLoudnessGainDb70Phon(20000)).toThrow(RangeError);
    expect(() => equalLoudnessGainDb70Phon(NaN)).toThrow(RangeError);
  });
});
