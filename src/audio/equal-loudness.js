/**
 * ISO 226:2023 equal-loudness compensation.
 *
 * Why this module exists. The 24-tone bank spans 200–3900 Hz. Across that
 * band, the human auditory system's sensitivity is far from flat: at 70
 * phons a pure tone needs roughly 8 dB MORE SPL at 200 Hz than at 1 kHz to
 * sound equally loud, and roughly 2–3 dB LESS SPL at 2.5–3.5 kHz. Without
 * correction, the lowest tones would be perceptually softer than the
 * central ones at the same digital amplitude, which would introduce an
 * encoding-difficulty confound that cannot be disentangled from a genuine
 * bank-edge effect.
 *
 * What we compensate for. The amplitude of every synthesised tone is
 * scaled by `10^(comp_dB / 20)`, where `comp_dB` is the dB difference
 * between the SPL needed at the tone's frequency and the SPL needed at
 * 1 kHz to elicit the same loudness in phons. At 70 phons (the nominal
 * listening level assumed by the design), the correction range is
 * ≈ +7.8 dB to −3.0 dB across 200–3900 Hz, well within the digital-headroom
 * envelope: the default tone peak is 0.25 (≈ −12 dBFS), so the worst-case
 * boosted peak (≈ +7.8 dB at 200 Hz) lands at ≈ 0.62, below the 0.95
 * clipping margin.
 *
 * What we DO NOT compensate for. Hardware frequency response. The
 * compensation here corrects for the listener's *ear*, not for whatever
 * EQ curve their speakers or headphones impose. Hardware variability is
 * orthogonal and is addressed by the tone-familiarisation audibility
 * self-report.
 *
 * Implementation. The SPL of the equal-loudness contour for a loudness
 * level LN (phons) is computed with Formula (1) of ISO 226:2023 §4.1 (the
 * current, third edition; the 2003 edition is withdrawn), using the
 * exponent αf, magnitude LU and hearing threshold Tf tabulated in the
 * standard's Table 1 at the 29 1/3-octave centre frequencies 20–12500 Hz:
 *
 *   Lf = (10/αf) * log10( (4e-10)^(0.3 - αf) * [10^(0.03 LN) - 10^0.072]
 *                         + 10^(αf (Tf + LU)/10) ) - LU
 *
 * Between centre frequencies, Lf is interpolated linearly in
 * log-frequency (the standard defines the contours only at the centres).
 * The 70-phon contour is evaluated directly, not interpolated between the
 * 60- and 80-phon contours. Over the 24-tone bank the 2023 gains differ
 * from the withdrawn 2003 edition's by at most 0.16 dB (Suzuki, Takeshima
 * & Kurakata, 2024, Acoust. Sci. & Tech. 45(1), report ≤ 0.3 dB between
 * editions for loudness levels above 10 phon).
 *
 * Why 70 phons, and what this does NOT guarantee. The browser cannot read
 * the system volume or the sound level at the ear, so the experiment never
 * calibrates to a measured SPL: the volume step only anchors the system
 * volume near the middle of its range and lets the participant choose a
 * comfortable level (`user_playback_gain`). 70 phons (70 dB SPL at 1 kHz,
 * by definition of the phon) is therefore a NOMINAL listening level, a
 * typical comfortable level for pure tones, not a measured one. ISO 226
 * contours depend on level (the low end is boosted more at lower levels):
 * if the true level is 60 or 80 phons rather than 70, every tone's gain
 * moves by at most 1.9 dB (at 200 Hz; <= 0.5 dB for tones from 500 Hz up). The
 * compensation removes the average ear's frequency dependence at about
 * that level; it does not equate loudness exactly for any one participant
 * or headphone.
 */

/* ISO 226:2023(E) Table 1 — parameters of Formula (1) at the 1/3-octave
 * centre frequencies: ISO226_AF = αf (exponent for loudness perception),
 * ISO226_LU = LU (dB, magnitude of the linear transfer function
 * normalised at 1 kHz), ISO226_TF = Tf (dB, threshold of hearing).
 * Transcribed from, and machine-checked cell by cell (29 rows × 3) against,
 * the standard's text as printed in the publisher's preview PDF
 * (https://cdn.standards.iteh.ai/samples/83117/6afa5bd94e0e4f32812c28c3b0a7b8ac/ISO-226-2023.pdf,
 * Table 1). */
const ISO226_FREQ_HZ = Object.freeze([
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600,
  2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500,
]);
const ISO226_AF = Object.freeze([
  0.635, 0.602, 0.569, 0.537, 0.509, 0.482, 0.456, 0.433, 0.412, 0.391, 0.373, 0.357, 0.343, 0.33,
  0.32, 0.311, 0.303, 0.3, 0.295, 0.292, 0.29, 0.29, 0.289, 0.289, 0.289, 0.293, 0.303, 0.323,
  0.354,
]);
const ISO226_LU = Object.freeze([
  -31.5, -27.2, -23.1, -19.3, -16.1, -13.1, -10.4, -8.2, -6.3, -4.6, -3.2, -2.1, -1.2, -0.5, 0.0,
  0.4, 0.5, 0.0, -2.7, -4.2, -1.2, 1.4, 2.3, 1.0, -2.3, -7.2, -11.2, -10.9, -3.5,
]);
const ISO226_TF = Object.freeze([
  78.1, 68.7, 59.5, 51.1, 44.0, 37.5, 31.5, 26.5, 22.1, 17.9, 14.4, 11.4, 8.6, 6.2, 4.4, 3.0, 2.2,
  2.4, 3.5, 1.7, -1.3, -4.2, -6.0, -5.4, -1.5, 6.0, 12.6, 13.9, 12.3,
]);

const FREQ_MIN = ISO226_FREQ_HZ[0];
const FREQ_MAX = ISO226_FREQ_HZ[ISO226_FREQ_HZ.length - 1];
const REFERENCE_FREQ_HZ = 1000;

/* ISO 226:2023 Formula (1) at centre-frequency index i. */
function splAtCentre(phon, i) {
  const af = ISO226_AF[i];
  const inner =
    Math.pow(4e-10, 0.3 - af) * (Math.pow(10, 0.03 * phon) - Math.pow(10, 0.072)) +
    Math.pow(10, (af * (ISO226_TF[i] + ISO226_LU[i])) / 10);
  return (10 / af) * Math.log10(inner) - ISO226_LU[i];
}

/**
 * Sound-pressure level (dB SPL) of a pure tone at `freqHz` that elicits
 * `phon` phons of loudness (ISO 226:2023 Formula (1) at the centre
 * frequencies, linear interpolation in log-frequency between them).
 *
 * @param {number} freqHz  in [20, 12500] Hz
 * @param {number} phon    loudness level, 20–90 phons per the standard
 * @returns {number} dB SPL
 */
export function iso226SplForPhon(freqHz, phon) {
  if (!(freqHz >= FREQ_MIN && freqHz <= FREQ_MAX)) {
    throw new RangeError(
      `equal-loudness: frequency ${freqHz} Hz is outside ISO 226 domain ` +
        `[${FREQ_MIN}, ${FREQ_MAX}] Hz`
    );
  }
  let i = 0;
  while (i < ISO226_FREQ_HZ.length - 2 && ISO226_FREQ_HZ[i + 1] < freqHz) i++;
  const fLo = ISO226_FREQ_HZ[i];
  const fHi = ISO226_FREQ_HZ[i + 1];
  if (freqHz === fLo) return splAtCentre(phon, i);
  if (freqHz === fHi) return splAtCentre(phon, i + 1);
  const t = (Math.log(freqHz) - Math.log(fLo)) / (Math.log(fHi) - Math.log(fLo));
  const lo = splAtCentre(phon, i);
  return lo + t * (splAtCentre(phon, i + 1) - lo);
}

/**
 * Equal-loudness gain (dB) for a tone at `freqHz` relative to a 1 kHz
 * reference at **70 phons**, evaluated directly from the ISO 226:2023
 * 70-phon contour. At 1 kHz, 70 dB SPL = 70 phons by definition, so this
 * is the correct target for a 70 dB SPL listening level.
 *
 * Positive values mean the tone needs MORE digital amplitude than the
 * reference to sound equally loud (low end of the band); negative values
 * mean LESS (near the ear's 2-4 kHz sensitivity peak). Apply by scaling the
 * digital peak: `peak * 10^(gainDb / 20)`.
 *
 * @param {number} freqHz   in [20, 12500] Hz
 * @returns {number} dB
 */
export function equalLoudnessGainDb70Phon(freqHz) {
  return iso226SplForPhon(freqHz, 70) - iso226SplForPhon(REFERENCE_FREQ_HZ, 70);
}
