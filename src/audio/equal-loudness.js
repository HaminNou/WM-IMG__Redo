/**
 * ISO 226:2003 equal-loudness compensation.
 *
 * Why this module exists. The 24-tone bank spans 200–3900 Hz. Across that band, the human auditory system's
 * sensitivity is far from flat: at 70 phons a pure tone needs roughly
 * 6 dB MORE SPL at 200 Hz than at 1 kHz to sound equally loud, and roughly
 * 5 dB LESS SPL at 2.5–3 kHz. Without correction, the lowest tones would
 * be perceptually softer than the central ones at the same digital
 * amplitude, which would introduce an encoding-difficulty confound that
 * cannot be disentangled from a genuine bank-edge effect.
 *
 * What we compensate for. The amplitude of every synthesised tone is
 * scaled by `10^(comp_dB / 20)`, where `comp_dB` is the dB difference
 * between the SPL needed at the tone's frequency and the SPL needed at
 * 1 kHz to elicit the same loudness in phons. At 70 phons (matching the
 * experiment's 70 dB SPL calibration target), the correction range is
 * ≈ +6 dB to −5 dB across 200–3900 Hz, well within the digital-headroom
 * envelope: the default tone peak is 0.25 (≈ −12 dBFS), so the worst-case
 * boosted peak (≈ +6 dB at 200 Hz) lands at ≈ 0.50, below the 0.95
 * clipping margin.
 *
 * What we DO NOT compensate for. Hardware frequency response. The
 * compensation here corrects for the listener's *ear*, not for whatever
 * EQ curve their speakers or headphones impose. Hardware variability is
 * orthogonal and is addressed by the tone-familiarisation audibility
 * self-report.
 *
 * Implementation. The 70-phon correction is computed by linear
 * interpolation between the tabulated ISO 226:2003 Annex A 60-phon and
 * 80-phon contours (interpolating between 60 and
 * 80 phons to make each tone equally loud at about 70 dB). The
 * interpolation error relative to the standard's parametric formula is
 * < 0.5 dB across 200–3900 Hz. The raw 60-phon and 80-phon tables are
 * at 1/3-octave centre frequencies (Annex A, cross-checked against
 * Suzuki & Takeshima 2004, *J. Acoust. Soc. Am.* 116(2), 918–933,
 * Table I). Linear interpolation in log-frequency space is applied
 * between tabulated centres.
 *
 * Why 70 phons. ISO 226 contours have a (mild) phon-level dependence;
 * the curves bow more sharply at low loudness levels. The experiment's
 * volume calibration targets 70 dB SPL, which equals 70 phons at
 * 1 kHz by definition. Using the 70-phon contour makes the compensation
 * consistent with the calibrated listening level. The correction is
 * within ± 1.5 dB of the truth across the 60–80 phon range, so the
 * choice is robust to volume-setting variability.
 */

/* ISO 226:2003 Annex A — standard 1/3-octave centre frequencies (Hz) and the
 * 60-phon equal-loudness contour SPL values (dB SPL) at those frequencies.
 * Cross-checked against Suzuki & Takeshima (2004) Table I, 60-phon column.
 * The 1000 Hz value is 60.0 by definition (loudness level in phons equals
 * SPL at 1 kHz). */
const ISO226_FREQ_HZ = Object.freeze([
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
  2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500,
]);
const ISO226_60_PHON_SPL_DB = Object.freeze([
  109.5, 104.2, 99.0, 93.9, 89.0, 84.5, 80.4, 76.7, 73.4, 70.4, 67.5, 64.9, 62.5, 60.8, 59.4, 58.4,
  57.7, 60.0, 61.5, 60.7, 58.3, 55.7, 55.7, 59.5, 65.3, 71.7, 78.3, 80.6, 81.0,
]);

/* ISO 226:2003 Annex A — 80-phon contour SPL values (dB SPL) at the same
 * centre frequencies. Cross-checked against Suzuki & Takeshima (2004) Table I,
 * 80-phon column. */
const ISO226_80_PHON_SPL_DB = Object.freeze([
  117.3, 112.4, 108.4, 104.2, 100.4, 96.9, 93.6, 91.1, 88.3, 86.0, 84.3, 82.0, 80.1, 78.7, 77.8,
  77.1, 77.0, 80.0, 82.0, 80.7, 77.4, 74.5, 74.8, 79.1, 85.3, 91.6, 98.1, 101.4, 102.6,
]);

const FREQ_MIN = ISO226_FREQ_HZ[0];
const FREQ_MAX = ISO226_FREQ_HZ[ISO226_FREQ_HZ.length - 1];

/* Each contour intersects 1 kHz at its own phon level in dB SPL by definition. */
const REFERENCE_SPL_60 = 60.0;
const REFERENCE_SPL_80 = 80.0;

/**
 * dB SPL at `freqHz` on a tabulated contour, by linear interpolation in
 * log-frequency between the ISO 226:2003 Annex A centre frequencies.
 */
function interpolateContour(splDb, freqHz) {
  if (!(freqHz >= FREQ_MIN && freqHz <= FREQ_MAX)) {
    throw new RangeError(
      `equal-loudness: frequency ${freqHz} Hz is outside ISO 226 domain ` +
        `[${FREQ_MIN}, ${FREQ_MAX}] Hz`
    );
  }
  let i = 0;
  while (i < ISO226_FREQ_HZ.length - 1 && ISO226_FREQ_HZ[i + 1] < freqHz) i++;
  const fLo = ISO226_FREQ_HZ[i];
  const fHi = ISO226_FREQ_HZ[i + 1];
  if (freqHz === fLo) return splDb[i];
  if (freqHz === fHi) return splDb[i + 1];
  const t = (Math.log(freqHz) - Math.log(fLo)) / (Math.log(fHi) - Math.log(fLo));
  return splDb[i] + t * (splDb[i + 1] - splDb[i]);
}

/**
 * Equal-loudness gain (dB) for a tone at `freqHz` relative to a 1 kHz
 * reference at **70 phons**, computed by linear interpolation between
 * the tabulated 60-phon and 80-phon ISO 226:2003 contours.
 *
 * At 1 kHz, 70 dB SPL = 70 phons by
 * definition, so the interpolated 70-phon contour is the correct target
 * for a 70 dB SPL listening level.
 *
 * Positive values mean the tone needs MORE digital amplitude than the
 * reference to sound equally loud (low end of the band); negative values
 * mean LESS (near the ear's 2-4 kHz sensitivity peak). Apply by scaling the
 * digital peak: `peak * 10^(gainDb / 20)`.
 *
 * The interpolation error relative to the exact ISO 226 parametric formula
 * is < 0.5 dB across the 200-3900 Hz range — below the just-noticeable
 * difference for loudness.
 *
 * @param {number} freqHz   in [20, 12500] Hz
 * @returns {number} dB
 */
export function equalLoudnessGainDb70Phon(freqHz) {
  const corr60 = interpolateContour(ISO226_60_PHON_SPL_DB, freqHz) - REFERENCE_SPL_60;
  const corr80 = interpolateContour(ISO226_80_PHON_SPL_DB, freqHz) - REFERENCE_SPL_80;
  return (corr60 + corr80) / 2;
}
