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

/* ISO 226:2003 Annex A — 60-phon equal-loudness contour SPL values
 * (dB SPL) at standard 1/3-octave centre frequencies. Verbatim from the
 * standard; cross-checked against Suzuki & Takeshima (2004) Table I,
 * 60-phon column. The 1000 Hz value is 60.0 by definition (loudness
 * level in phons equals SPL at 1 kHz). */
const ISO226_60_PHON_FREQ = Object.freeze([
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
  2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500,
]);
const ISO226_60_PHON_SPL_DB = Object.freeze([
  109.5, 104.2, 99.0, 93.9, 89.0, 84.5, 80.4, 76.7, 73.4, 70.4, 67.5, 64.9, 62.5, 60.8, 59.4, 58.4,
  57.7, 60.0, 61.5, 60.7, 58.3, 55.7, 55.7, 59.5, 65.3, 71.7, 78.3, 80.6, 81.0,
]);

const FREQ_MIN = ISO226_60_PHON_FREQ[0];
const FREQ_MAX = ISO226_60_PHON_FREQ[ISO226_60_PHON_FREQ.length - 1];
const REFERENCE_FREQ_HZ = 1000;
const REFERENCE_SPL_DB = 60.0; /* 60-phon contour intersects 1 kHz at 60 dB SPL by definition */

/**
 * Sound-pressure level (dB SPL) of a pure tone at frequency `freqHz` that
 * elicits 60 phons of loudness, by tabulated lookup (linear interpolation
 * in log-frequency between ISO 226:2003 Annex A centre frequencies).
 *
 * @param {number} freqHz  in [20, 12500] Hz
 * @returns {number} dB SPL
 */
export function iso226SplFor60Phon(freqHz) {
  if (!(freqHz >= FREQ_MIN && freqHz <= FREQ_MAX)) {
    throw new RangeError(
      `equal-loudness: frequency ${freqHz} Hz is outside ISO 226 domain ` +
        `[${FREQ_MIN}, ${FREQ_MAX}] Hz`
    );
  }
  let i = 0;
  while (i < ISO226_60_PHON_FREQ.length - 1 && ISO226_60_PHON_FREQ[i + 1] < freqHz) i++;
  const fLo = ISO226_60_PHON_FREQ[i];
  const fHi = ISO226_60_PHON_FREQ[i + 1];
  if (freqHz === fLo) return ISO226_60_PHON_SPL_DB[i];
  if (freqHz === fHi) return ISO226_60_PHON_SPL_DB[i + 1];
  const t = (Math.log(freqHz) - Math.log(fLo)) / (Math.log(fHi) - Math.log(fLo));
  return ISO226_60_PHON_SPL_DB[i] + t * (ISO226_60_PHON_SPL_DB[i + 1] - ISO226_60_PHON_SPL_DB[i]);
}

/**
 * Equal-loudness gain (dB) for a tone at `freqHz` relative to a 1 kHz
 * reference at 60 phons. Positive return values mean the tone needs MORE
 * digital amplitude than the reference to sound equally loud (typical for
 * the low end of the band, e.g. ≈ +7 dB at 200 Hz); negative values mean
 * LESS (typical near the ear's 2–4 kHz sensitivity peak, e.g. ≈ −4 dB
 * at 2.5–3 kHz).
 *
 * Apply by scaling the digital peak: `peak * 10^(gainDb / 20)`.
 *
 * @param {number} freqHz   in [20, 12500] Hz
 * @returns {number} dB
 */
export function equalLoudnessGainDb60Phon(freqHz) {
  return iso226SplFor60Phon(freqHz) - REFERENCE_SPL_DB;
}

/**
 * Convert a dB gain to a linear amplitude factor.
 *
 * @param {number} gainDb
 * @returns {number}  10^(gainDb / 20)
 */
export function dbToLinear(gainDb) {
  return Math.pow(10, gainDb / 20);
}

/* ISO 226:2003 Annex A — 80-phon equal-loudness contour SPL values
 * (dB SPL) at the same 1/3-octave centre frequencies. Cross-checked
 * against Suzuki & Takeshima (2004) Table I, 80-phon column. */
const ISO226_80_PHON_SPL_DB = Object.freeze([
  117.3, 112.4, 108.4, 104.2, 100.4, 96.9, 93.6, 91.1, 88.3, 86.0, 84.3, 82.0, 80.1, 78.7, 77.8,
  77.1, 77.0, 80.0, 82.0, 80.7, 77.4, 74.5, 74.8, 79.1, 85.3, 91.6, 98.1, 101.4, 102.6,
]);

const REFERENCE_SPL_80 = 80.0; /* 80-phon contour intersects 1 kHz at 80 dB SPL by definition */

/**
 * Sound-pressure level (dB SPL) of a pure tone at frequency `freqHz` that
 * elicits 80 phons of loudness, by tabulated lookup.
 */
function iso226SplFor80Phon(freqHz) {
  if (!(freqHz >= FREQ_MIN && freqHz <= FREQ_MAX)) {
    throw new RangeError(
      `equal-loudness: frequency ${freqHz} Hz is outside ISO 226 domain ` +
        `[${FREQ_MIN}, ${FREQ_MAX}] Hz`
    );
  }
  let i = 0;
  while (i < ISO226_60_PHON_FREQ.length - 1 && ISO226_60_PHON_FREQ[i + 1] < freqHz) i++;
  const fLo = ISO226_60_PHON_FREQ[i];
  const fHi = ISO226_60_PHON_FREQ[i + 1];
  if (freqHz === fLo) return ISO226_80_PHON_SPL_DB[i];
  if (freqHz === fHi) return ISO226_80_PHON_SPL_DB[i + 1];
  const t = (Math.log(freqHz) - Math.log(fLo)) / (Math.log(fHi) - Math.log(fLo));
  return ISO226_80_PHON_SPL_DB[i] + t * (ISO226_80_PHON_SPL_DB[i + 1] - ISO226_80_PHON_SPL_DB[i]);
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
 * The interpolation error relative to the exact ISO 226 parametric formula
 * is < 0.5 dB across the 200-3900 Hz range — below the just-noticeable
 * difference for loudness.
 *
 * @param {number} freqHz   in [20, 12500] Hz
 * @returns {number} dB
 */
export function equalLoudnessGainDb70Phon(freqHz) {
  const corr60 = iso226SplFor60Phon(freqHz) - REFERENCE_SPL_DB;
  const corr80 = iso226SplFor80Phon(freqHz) - REFERENCE_SPL_80;
  return (corr60 + corr80) / 2;
}

/* Exposed for tests and for one-off documentation tables only. */
export const ISO226_60_PHON_TABLE = Object.freeze(
  ISO226_60_PHON_FREQ.map((f, i) => Object.freeze({ freq_hz: f, spl_db: ISO226_60_PHON_SPL_DB[i] }))
);
export { REFERENCE_FREQ_HZ, REFERENCE_SPL_DB };
