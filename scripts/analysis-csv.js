#!/usr/bin/env node
/**
 * The ANALYSIS file: `ALL_TRIALS.csv` (trials-to-csv.js) reduced to the columns the planned
 * statistical analyses can use. One line per trial, the same rows in the same order; only columns
 * are removed, no value is changed, nothing is recalculated.
 *
 * `ALL_TRIALS.csv` stays the complete record (731 columns: pixel geometry, timing internals,
 * audio-latency diagnostics, per-event copies of facts repeated in the probe and star blocks, ...).
 * This tool never modifies it. Re-run it whenever the full file is regenerated.
 *
 * KEPT (see KEEP_TRIAL / KEEP_SLOT / KEEP_PROBE / KEEP_STAR below, the single source of truth)
 *   who / which run   subject, is_analysed_run, is_pilot_run, debug_mode, run_status
 *   the trial         trial_uid, condition (task), block_label, is_practice, presentation_index,
 *                     block_position, pool_index, rotation, background shade, the stimulus
 *                     sequence, outcome counts, the exclusion flags the registered rules use
 *   slot1_..slot6_    the stimulus at each serial position (1-6 among ALL stimuli): modality,
 *                     visibility, serial position (overall / within modality), cell, on/off-pattern,
 *                     tone, whether and at which test position it was probed
 *   probe1_..probe3_  type (T_on/T_off/F_on/F_off), target or foil, label, cell, encoding and test
 *                     serial positions, response, correct, RT, anticipatory flag, distance and
 *                     pitch covariates
 *   star1_..star3_    serial position, slot, cell, on/off, response, correct, RT, anticipatory flag,
 *                     whether the star was displayed or cut short
 *
 * DROPPED, by design: identifiers that are not needed once `subject` exists (participant_id,
 * run_id, study_id, session_id, row_key), screen geometry in mm and px, phase onset times and
 * planned/actual timing errors, key-log and audio diagnostics, build and schema versions, the
 * event-level copies of test and star outcomes (they are in the probe and star blocks), and the
 * probe's copies of the three encoding positions. Use `--keep <col>[,<col>...]` to add any column
 * of the full file back, and `--keep-timing` to add the onset/offset/silence columns of the
 * six slots (the timing of the hidden placeholders included).
 *
 * Checks: every kept column must exist in the input; the output is re-read with an independent
 * reader and compared cell by cell with the input; a manifest (`<out>.manifest.json`) lists the
 * kept and the dropped columns and the hashes of both files, and the dropped columns that held no
 * information at all (empty or constant) are counted.
 *
 * Usage: node scripts/analysis-csv.js --in ALL_TRIALS.csv --out ANALYSIS_TRIALS.csv
 *          [--keep col,col] [--keep-timing] [--main-trials-only]
 * Exit codes: 0 ok; 2 usage; 3 unreadable input, missing column or failed verification.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseCsv } from './raw-to-csv.js';
import { debugRunsWarning } from './participant-rules.js';

export const ANALYSIS_CSV_VERSION = '1.0.0';
export const N_SLOTS = 6;
export const N_PROBES = 3;
export const N_STARS = 3;

export const KEEP_TRIAL = Object.freeze([
  'subject',
  'run_status',
  'is_analysed_run',
  'is_pilot_run',
  'debug_mode',
  'trial_uid',
  'condition',
  'block_label',
  'is_practice',
  'presentation_index',
  'block_position',
  'pool_index',
  'rotation_deg',
  'rotation_abs_deg',
  'rotation_sign',
  'rotation_stratum',
  'background_shade',
  'sequence',
  'rest_before_trial',
  'trial_has_stars',
  'n_stars_correct',
  'n_stars_incorrect',
  'n_stars_no_response',
  'n_stars_anticipatory',
  'n_stars_missing_row',
  'trial_star_excluded',
  'star_correct_all',
  'n_probes_correct',
  'n_probes_no_response',
  'n_probes_anticipatory',
  'n_probes_missing_row',
  'trial_guard_excluded',
  'debug_reveal_seen',
]);

export const KEEP_SLOT = Object.freeze([
  'event_modality',
  'is_visible_stimulus',
  'serial_position_overall',
  'serial_position_in_modality',
  'cell',
  'pattern_label',
  'is_on_pattern',
  'tone_index',
  'tested_later',
  'test_position',
  'test_probe_type',
]);

/** Added to each slot by --keep-timing. */
export const TIMING_SLOT = Object.freeze([
  'onset_ms',
  'offset_ms',
  'duration_ms',
  'silence_before_ms',
  'silence_after_ms',
  'onset_gap_ms',
]);

export const KEEP_PROBE = Object.freeze([
  'modality',
  'probe_type',
  'is_target',
  'pattern_label',
  'cell',
  'encoding_position',
  'target_slot',
  'test_position',
  'target_serial_position_overall',
  'target_serial_position_in_modality',
  'min_enc_dist_mm',
  'tone_index',
  'tone_freq_hz',
  'responded',
  'said_yes',
  'probe_correct',
  'rt_ms',
  'excluded_anticipatory',
]);

export const KEEP_STAR = Object.freeze([
  'serial_position_overall',
  'serial_position_in_modality',
  'slot_in_stream',
  'cell',
  'pattern_label',
  'is_on_pattern',
  'responded',
  'said_on',
  'star_correct',
  'rt_ms',
  'excluded_anticipatory',
  'displayed',
  'truncated',
]);

const prefixed = (prefix, n, names) =>
  Array.from({ length: n }, (_, i) => names.map((c) => `${prefix}${i + 1}_${c}`)).flat();

/** The wanted columns, in output order. */
export function wantedColumns({ keep = [], keepTiming = false } = {}) {
  const slotNames = keepTiming ? [...KEEP_SLOT, ...TIMING_SLOT] : KEEP_SLOT;
  return [
    ...new Set([
      ...KEEP_TRIAL,
      ...prefixed('slot', N_SLOTS, slotNames),
      ...prefixed('probe', N_PROBES, KEEP_PROBE),
      ...prefixed('star', N_STARS, KEEP_STAR),
      ...keep,
    ]),
  ];
}

const field = (c) => (c.quoted ? `"${c.text.replace(/"/g, '""')}"` : c.text);
const line = (cells) => cells.map(field).join(',');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Reduce a trial CSV text to the wanted columns.
 *
 * @param {string} text   the full ALL_TRIALS.csv text
 * @param {object} [opts] keep, keepTiming, mainTrialsOnly, excelBom
 * @returns {{csv: string, manifest: object}}
 */
export function composeAnalysisCsv(text, opts = {}) {
  const records = parseCsv(text.replace(/^\uFEFF/, ''));
  if (records.length === 0) throw new Error('analysis-csv: the input is empty');
  const header = records[0].map((c) => c.text);
  const index = new Map(header.map((h, i) => [h, i]));
  if (index.size !== header.length) throw new Error('analysis-csv: duplicate column names');
  const want = wantedColumns(opts);
  const missing = want.filter((c) => !index.has(c));
  if (missing.length > 0) {
    throw new Error(
      `analysis-csv: ${missing.length} column(s) not in the input: ${missing.slice(0, 8).join(', ')}`
    );
  }
  let body = records.slice(1);
  for (const [i, r] of body.entries()) {
    if (r.length !== header.length) {
      throw new Error(
        `analysis-csv: line ${i + 2} has ${r.length} fields, expected ${header.length}`
      );
    }
  }
  if (opts.mainTrialsOnly) {
    const k = index.get('is_practice');
    body = body.filter((r) => r[k].text !== 'TRUE');
  }
  const cols = want.map((c) => index.get(c));
  const out = [
    line(want.map((c) => ({ text: c, quoted: true }))),
    ...body.map((r) => line(cols.map((k) => r[k]))),
  ];
  const csv = `${out.join('\n')}\n`;

  // Independent check: re-read the output, compare every cell with the input cell it came from.
  const back = parseCsv(csv);
  const problems = [];
  if (back.length !== body.length + 1)
    problems.push(`row count ${back.length - 1} != ${body.length}`);
  back[0].forEach((c, j) => c.text !== want[j] && problems.push(`header ${j}`));
  body.forEach((r, i) =>
    cols.forEach((k, j) => {
      const a = r[k];
      const b = back[i + 1]?.[j];
      if (!b || a.text !== b.text || a.quoted !== b.quoted)
        problems.push(`cell ${i + 2}:${want[j]}`);
    })
  );
  if (problems.length > 0) {
    throw new Error(`analysis-csv: verification failed:\n  ${problems.slice(0, 10).join('\n  ')}`);
  }

  /* Debug sessions, from the debug_mode column (and the reveal flag), one entry per subject. */
  const dm = index.get('debug_mode');
  const rv = index.get('debug_reveal_seen');
  const sj = index.get('subject');
  const debugSubjects = new Set();
  for (const r of body) {
    if (r[dm]?.text === 'TRUE' || r[rv]?.text === 'TRUE') debugSubjects.add(r[sj]?.text ?? 'NA');
  }
  const debugRuns = [...debugSubjects].map((s) => ({ subject: s === 'NA' ? null : Number(s) }));

  const kept = new Set(want);
  const informationless = (k) => new Set(body.map((r) => r[k].text)).size <= 1;
  const dropped = header.filter((h) => !kept.has(h));
  const droppedUninformative = dropped.filter((h) => informationless(index.get(h)));
  const keptUninformative = want.filter((h) => informationless(index.get(h)));
  const manifest = {
    generator: { name: 'analysis-csv.js', version: ANALYSIS_CSV_VERSION },
    generated_at_iso: new Date().toISOString(),
    options: {
      keep: opts.keep ?? [],
      keep_timing: opts.keepTiming === true,
      main_trials_only: opts.mainTrialsOnly === true,
    },
    input: { n_trials: records.length - 1, n_columns: header.length, sha256: sha256(text) },
    output: { n_trials: body.length, n_columns: want.length, sha256: sha256(csv) },
    debug_runs: debugRuns,
    kept_columns: want,
    dropped_columns: dropped,
    dropped_columns_without_information: droppedUninformative.length,
    kept_columns_empty_or_constant_in_this_file: keptUninformative,
    checks: { csv_round_trip_ok: true },
  };
  return { csv, manifest };
}

export function parseAnalysisArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const opts = { keep: [], keepTiming: false, mainTrialsOnly: false, inPath: null, outPath: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => {
      if (i + 1 >= args.length) throw new Error(`${a} needs a value`);
      return args[++i];
    };
    if (a === '--in') opts.inPath = value();
    else if (a === '--out') opts.outPath = value();
    else if (a === '--keep') opts.keep.push(...value().split(',').filter(Boolean));
    else if (a === '--keep-timing') opts.keepTiming = true;
    else if (a === '--main-trials-only') opts.mainTrialsOnly = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!opts.inPath) throw new Error('--in <ALL_TRIALS.csv> is required');
  if (!opts.outPath) throw new Error('--out <file.csv> is required');
  if (opts.inPath === opts.outPath) throw new Error('--out must differ from --in');
  return opts;
}

const fail = (code, msg) => {
  console.error(`analysis-csv: ${msg}`);
  process.exit(code);
};

function main(argv) {
  let opts;
  try {
    opts = parseAnalysisArgs(argv);
  } catch (err) {
    return fail(2, err.message);
  }
  let text;
  try {
    text = readFileSync(opts.inPath, 'utf-8');
  } catch (err) {
    return fail(3, `cannot read ${opts.inPath}: ${err.message}`);
  }
  let composed;
  try {
    composed = composeAnalysisCsv(text, opts);
  } catch (err) {
    return fail(3, err.message);
  }
  writeFileSync(opts.outPath, composed.csv, 'utf-8');
  const manifestPath = `${opts.outPath}.manifest.json`;
  writeFileSync(manifestPath, JSON.stringify(composed.manifest, null, 2), 'utf-8');
  const m = composed.manifest;
  console.error(
    `analysis-csv: ${m.output.n_trials} trials, ${m.input.n_columns} -> ${m.output.n_columns} columns ` +
      `(${m.dropped_columns.length} dropped)\n  every cell re-read and matched\n` +
      `  file:     ${opts.outPath}\n  manifest: ${manifestPath}`
  );
  if (m.debug_runs.length > 0) console.error(debugRunsWarning(m.debug_runs.length));
  process.exit(0);
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) main(process.argv);
