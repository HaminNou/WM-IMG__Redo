/**
 * Auditory tone bank + analytic cell↔tone mapping.
 *
 * The bank is **24 sine tones logarithmically spaced from 200 Hz to 3900 Hz**. Frequencies are
 *   f_k = lowFreqHz × (highFreqHz / lowFreqHz)^((k−1) / (count−1))
 * which puts neighbouring tones at a ratio of (3900/200)^(1/23) ≈ 1.138
 * (~13.8 % per step) — a non-Western interval that adapts Li, Cowan &
 * Saults (2013, *APP* 75(1), p. 150) to a 24-tone variant. A
 * chromatic ladder (220 × 2^((k−1)/12)) is avoided because every tone
 * would land on a named pitch class, exposing the bank to note-name
 * re-encoding by musically trained participants. The full rationale (Shepard 1982
 * octave-equivalence avoidance, Sek & Moore 1995 DLF range) sits in
 * `src/config.js`; see `src/audio/dsp.js#buildToneBank`.
 *
 * The cell↔tone mapping is *purely analytic* — a tone is **never**
 * shown on the grid and the grid never lights up when a tone plays. The map
 * exists so every tone inherits the on-/off-pattern label of its paired cell,
 * which lets the analyst tabulate the four canonical probe types (T_on, T_off,
 * F_on, F_off) in the same way across auditory and visual memory trials.
 *
 * Mapping rule (rank-based, not frequency-value-based, so the cell↔tone
 * bijection does not depend on the frequency values):
 *   - Tones are ranked 1..24 by frequency (rank 1 = lowest = bank index 0).
 *   - Odd-ranked tones (rank 1, 3, ..., 23 — bank indices 0, 2, ..., 22)
 *     pair with the 12 on-pattern cells, in cell-index order.
 *   - Even-ranked tones (rank 2, 4, ..., 24 — bank indices 1, 3, ..., 23)
 *     pair with the 12 off-pattern cells, in cell-index order.
 *
 * The interleaving prevents a "high tones are on-pattern, low are off"
 * shortcut and equates within-trial pitch dispersion across labels.
 */
import { config } from '../config.js';
import { onPatternCells, offPatternCells } from '../grid.js';
import { buildToneBank, playSineTone } from './dsp.js';
import { equalLoudnessGainDb70Phon } from './equal-loudness.js';

let TONE_BANK = null;
let CELL_TO_TONE = null;

function buildOnce() {
  if (TONE_BANK !== null) return;

  const { count, low_freq_hz, high_freq_hz } = config.tones;
  const raw = buildToneBank(count, low_freq_hz, high_freq_hz);
  const bank = raw.map((t) => ({
    index: t.index,
    rank: t.index + 1,
    freq_hz: t.freq_hz,
    /* ISO 226:2023 70-phon equal-loudness compensation, computed from the
     * standard's Formula (1) at 70 phons (parameters in `equal-loudness.js`).
     * The dB value is the gain needed at this tone's frequency to elicit the
     * same loudness as a 1 kHz reference at 70 phons. Applied at synthesis
     * time by `playToneByIndex`. Range across 200..3900 Hz is roughly +7.8 dB
     * at the low end to −3.0 dB near the ear's 3 kHz sensitivity peak. */
    gain_compensation_db: equalLoudnessGainDb70Phon(t.freq_hz),
    pattern_label: t.index % 2 === 0 ? 'on' : 'off' /* odd rank ⇔ even index ⇔ 'on' */,
    paired_cell: null /* filled below */,
  }));

  const onCells = onPatternCells();
  const offCells = offPatternCells();
  if (onCells.length * 2 !== count || offCells.length * 2 !== count) {
    throw new Error(
      `Tone bank build: expected 12 on-pattern + 12 off-pattern cells for 24 tones; got ${onCells.length} + ${offCells.length}`
    );
  }

  /* Walk the bank: even-index tones (0, 2, 4, ...) take on-pattern cells in
   * order; odd-index tones take off-pattern cells in order. */
  let onCursor = 0;
  let offCursor = 0;
  for (const tone of bank) {
    if (tone.pattern_label === 'on') {
      tone.paired_cell = onCells[onCursor++];
    } else {
      tone.paired_cell = offCells[offCursor++];
    }
  }

  if (onCursor !== onCells.length || offCursor !== offCells.length) {
    throw new Error(
      `Tone bank build: cursor mismatch (on ${onCursor}/${onCells.length}, off ${offCursor}/${offCells.length})`
    );
  }

  TONE_BANK = Object.freeze(bank.map((t) => Object.freeze(t)));

  const cellMap = new Map();
  for (const t of TONE_BANK) cellMap.set(t.paired_cell, t);
  CELL_TO_TONE = cellMap;
}

export function getToneBank() {
  buildOnce();
  return TONE_BANK;
}

function toneByIndex(toneIndex) {
  buildOnce();
  const t = TONE_BANK[toneIndex];
  if (!t) throw new Error(`toneByIndex: ${toneIndex} out of range 0..${TONE_BANK.length - 1}`);
  return t;
}

export function toneForCell(cellIndex) {
  buildOnce();
  const t = CELL_TO_TONE.get(cellIndex);
  if (!t)
    throw new Error(`toneForCell: cell ${cellIndex} has no paired tone (centre or out of range)`);
  return t;
}

/**
 * Play a tone identified by its bank index (or by cell, via toneForCell).
 * Returns a Promise that resolves when the tone has finished.
 */
export function playToneByIndex(toneIndex, opts = {}) {
  const t = toneByIndex(toneIndex);
  return playSineTone(t.freq_hz, {
    durationMs: opts.durationMs ?? config.tones.duration_ms,
    rampMs: opts.rampMs ?? config.tones.cosine_ramp_ms,
    peak: opts.peak,
    /* Per-tone equal-loudness compensation. Caller can override (the
     * tone-familiarisation step does not, but only for tools that need an uncompensated tone). */
    gainDb: opts.gainDb ?? t.gain_compensation_db,
    when: opts.when,
  });
}

export function playToneByCell(cellIndex, opts = {}) {
  return playToneByIndex(toneForCell(cellIndex).index, opts);
}
