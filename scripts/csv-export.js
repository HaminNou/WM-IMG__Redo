#!/usr/bin/env node
/**
 * Long → wide CSV exporter for follow-up-experiment session dumps.
 *
 * Ingests one or more JSON dumps (download-fallback exports from
 * `uploader.downloadAsJson` or bucket envelopes from
 * `uploader.buildBucketEnvelope`) and emits a directory of analysis-ready
 * CSVs whose column conventions track the original experiment's data files as
 * closely as the new design allows.
 *
 * Each live session uploads up to 10 bucket envelopes to storage (one per
 * analysis-relevant slice: consent + demographics, practice, d_only, i_only
 * (= "star-only"), t_only, i_t, i_d, music questionnaire, strategy
 * questionnaire, meta), plus checkpoint and tail files that repeat rows.
 * `loadAndFlattenDumps` pools the files of a participant, drops rows repeated
 * on (run_id, seq) and splits the rows by run (a reload in the same browser
 * starts a new run), so the exporter is agnostic to whether its input is one
 * big dump or many files. A repeated main trial after this step makes the
 * exit code 3.
 *
 * Original-experiment conventions preserved:
 *   prefixes  Ast_ (star/imagery), Dot_ (encoded dot), Tone_ (encoded tone),
 *             Qmark_ (probe)
 *   suffixes  _Cell, _CellTY, _OrderN, _Type, _Res, _ResVA, _RecTI, _RecTI_1,
 *             _RecTY
 *   coding    ResVA: 1=correct, 0=incorrect, -1=skipped
 *             Cell: "[row, col]" string with one space after the comma
 *             Probe Type: 1=T_on, 2=T_off, 3=F_on, 4=F_off (from §6.2 taxonomy)
 *   filtering Criterion1: rt < 250 ms → NA
 *             Criterion2: rt < 250 ms OR ResVA ≠ 1 → NA
 *
 * Files emitted (per criterion):
 *   D_ONLY_Criterion{1,2}.csv   one row per D-only trial (3 probes wide)
 *   T_ONLY_Criterion{1,2}.csv   one row per T-only trial (3 probes wide)
 *   I_ONLY_Criterion{1,2}.csv   one row per I-only trial (3 stars wide)
 *   I_D_Criterion{1,2}.csv      one row per I+D trial (3 stars + 3 probes)
 *   I_T_Criterion{1,2}.csv      one row per I+T trial (3 stars + 3 probes)
 *
 * Auxiliary files (not criterion-filtered):
 *   trials.csv / stars.csv / probes.csv
 *                               tidy tables with unique keys, explicit condition,
 *                               presentation order and screen positions (see
 *                               scripts/tidy-tables.js and schemas/tidy-tables.schema.json)
 *   CALIBRATION_SUMMARY.csv     one row per participant (screen / volume +
 *                               session metadata + storage failures)
 *   STRATEGY_SCORES.csv         one row per participant: strategy composites
 *   MUSIC.csv                   one row per participant: music-experience items,
 *                               Gold-MSI MT composite, absolute-pitch item
 *   STRATEGY.csv                one row per (participant × strategy item)
 *                               in long format (19 items per participant,
 *                               spread across the five condition-specific
 *                               pages — see src/questionnaire/strategy.js)
 *   ATTENTION_CHECKS.csv        one row per (participant × instruction check)
 *   EXPORT_MANIFEST.json        provenance record (build_id, source files,
 *                               row counts, heterogeneity flags, generator
 *                               version)
 *
 * Rationale for diverging from the original experiment's per-block file split:
 *   Follow-up has 5 trial types interleaved within 2 main blocks (rather than
 *   one trial type per block, as the original experiment). Per-trial-type files keep each
 *   wide-format CSV rectangular and avoid carrying a forest of optional
 *   prefix groups in a single file.
 *
 * Usage:
 *   node scripts/csv-export.js --out out/ path/to/dumps/
 *   node scripts/csv-export.js --out out/ a.json b.json c.json
 *   node scripts/csv-export.js --out out/ --json-manifest dumps/   # also stdout the manifest
 *
 * Pure exports (unit-tested in `tests/csv-export.test.js`):
 *   parseExportArgs, cellToRowCol, formatCell, trialTypeFromPhase,
 *   probeTypeCode, applyCriterion1, applyCriterion2, formatCsvValue,
 *   serializeRowsToCsv, groupTrialRows, buildWideRowDOnly, buildWideRowTOnly,
 *   buildWideRowIOnly, buildWideRowID, buildWideRowIT, extractCalibrationRow,
 *   extractStrategyRows, extractAttentionRows, buildExportManifest.
 *
 * Pure Node (>=20) — no browser deps, no third-party packages.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

import {
  composeTidyTables,
  duplicateKeys,
  TIDY_KEYS,
  TIDY_VERSION,
  TRIALS_COLUMNS,
  STARS_COLUMNS,
  PROBES_COLUMNS,
} from './tidy-tables.js';

/* The questionnaire modules import jsPsych, which registers itself on
 * `window` when loaded. The scoring functions need no DOM, so Node gets a
 * stand-in for that one assignment. */
globalThis.window ??= globalThis;
const { MUSIC_EXPERIENCE_ITEMS, scoreMusicExperience } =
  await import('../src/questionnaire/music-experience.js');
const { STRATEGY_ITEMS, scoreStrategy } = await import('../src/questionnaire/strategy.js');

const GENERATOR_VERSION = '1.0.0';

/* ---------- Constants ---------- */

const TRIAL_TYPE_PREFIXES = Object.freeze({
  d_only: 'd_only_',
  t_only: 't_only_',
  i_only: 'i_only_',
  i_d: 'i_d_',
  i_t: 'i_t_',
});

const PROBE_TYPE_CODES = Object.freeze({
  T_on: 1,
  T_off: 2,
  F_on: 3,
  F_off: 4,
});

const RT_FLOOR_MS = 250;
const NA = 'NA';
const numOrNA = (v) => (Number.isFinite(v) ? v : NA);

/** Rotation of a trial: the imagined angle, or the display angle of a d_only trial. */
function rotationOf(enc) {
  return [enc?.rotation_deg, enc?.display_rotation_deg].find(Number.isFinite) ?? NA;
}
const KEYBOARD_RECTY = 1;

/* ---------- Pure helpers ---------- */

/**
 * Parse argv into a structured options bag for the exporter CLI.
 * Recognised flags:
 *   --out <dir>          Output directory (created if missing). Required.
 *   --json-manifest      Also print the manifest JSON to stdout when done.
 *
 * Anything that isn't a flag is treated as an input path (file or dir).
 */
export function parseExportArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const inputs = [];
  let outputDir = null;
  let jsonManifest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') {
      outputDir = args[++i] ?? null;
    } else if (a === '--json-manifest') {
      jsonManifest = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      inputs.push(a);
    }
  }
  return { inputs, outputDir, jsonManifest };
}

/**
 * Walk supplied paths, expanding directories into the .json files they contain.
 * Returns absolute paths sorted lexically.
 */
export function expandInputPaths(inputPaths, opts = {}) {
  const fs = opts.fs ?? { readdirSync, statSync };
  const out = [];
  for (const p of inputPaths) {
    const abs = resolve(p);
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(abs)) {
        if (entry.endsWith('.json')) out.push(join(abs, entry));
      }
    } else {
      out.push(abs);
    }
  }
  return out.sort();
}

/**
 * Cell index 0–24 → [row, col] pair on the 5×5 grid (row-major, 0-indexed).
 * the original experiment convention: row first, then col, both 0-indexed. Returns null
 * for invalid input (the caller decides whether to surface as NA).
 */
export function cellToRowCol(cellIndex) {
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > 24) return null;
  return [Math.floor(cellIndex / 5), cellIndex % 5];
}

/**
 * Format a [row, col] pair as "[row, col]" — exactly the original experiment's format.
 * Accepts the [row, col] pair OR the raw cell index. Returns NA for null.
 */
export function formatCell(input) {
  if (input === null || input === undefined) return NA;
  const pair = Array.isArray(input) ? input : cellToRowCol(input);
  if (!pair) return NA;
  return `[${pair[0]}, ${pair[1]}]`;
}

/**
 * Phase → trial-type tag (one of d_only / t_only / i_only / i_d / i_t),
 * or null if the phase doesn't belong to a trial-time emitter (calibration,
 * instructions, attention, strategy, etc.).
 */
export function trialTypeFromPhase(phase) {
  if (!phase || typeof phase !== 'string') return null;
  /* Order matters: i_d_* and i_t_* must be checked before i_only_* because
   * the i_d_ / i_t_ prefixes don't share a common stem with i_only_. */
  if (phase.startsWith(TRIAL_TYPE_PREFIXES.d_only)) return 'd_only';
  if (phase.startsWith(TRIAL_TYPE_PREFIXES.t_only)) return 't_only';
  if (phase.startsWith(TRIAL_TYPE_PREFIXES.i_d)) return 'i_d';
  if (phase.startsWith(TRIAL_TYPE_PREFIXES.i_t)) return 'i_t';
  if (phase.startsWith(TRIAL_TYPE_PREFIXES.i_only)) return 'i_only';
  return null;
}

/**
 * Probe-type code (1–4) for the design-§6.2 four-type taxonomy.
 * Returns NA for unknown / missing input.
 */
export function probeTypeCode(probeType) {
  if (!probeType) return NA;
  return PROBE_TYPE_CODES[probeType] ?? NA;
}

/**
 * Cell-type code: 1 if the cell sits on the 13-cell pattern (excluding
 * centre), 0 if off-pattern. Reads `pattern_label` ('on' / 'off') or falls
 * back to the boolean `is_on_pattern`. NA when neither is present.
 */
export function cellTypeCode({ pattern_label, is_on_pattern } = {}) {
  if (pattern_label === 'on' || is_on_pattern === true) return 1;
  if (pattern_label === 'off' || is_on_pattern === false) return 0;
  return NA;
}

/**
 * Reaction-time filter: Criterion1 — anticipatory floor only.
 * NA when the participant did not respond, or RT < 250 ms.
 */
export function applyCriterion1(rtMs) {
  if (rtMs === null || rtMs === undefined || !Number.isFinite(rtMs)) return NA;
  if (rtMs < RT_FLOOR_MS) return NA;
  return rtMs;
}

/**
 * Reaction-time filter: Criterion2 — anticipatory floor PLUS accuracy.
 * NA when no response, RT < 250 ms, or the response was not correct
 * (resVA must be exactly 1).
 */
export function applyCriterion2(rtMs, resVA) {
  if (rtMs === null || rtMs === undefined || !Number.isFinite(rtMs)) return NA;
  if (rtMs < RT_FLOOR_MS) return NA;
  if (resVA !== 1) return NA;
  return rtMs;
}

/**
 * Compute Res / ResVA codes for a memory-probe row.
 *   Res:    1 if said yes, 0 if said no, -1 if no response
 *   ResVA:  1 if correct, 0 if incorrect, -1 if no response
 * Mirrors the original experiment's response coding so analysis scripts can be reused.
 */
export function probeResCodes(row) {
  if (row.responded !== true) return { res: -1, resVA: -1 };
  return {
    res: row.said_yes === true ? 1 : 0,
    resVA: row.probe_correct === true ? 1 : 0,
  };
}

/**
 * Compute Res / ResVA codes for an imagery-star row.
 *   Res:    1 if said on, 0 if said off, -1 if no response
 *   ResVA:  1 if correct, 0 if incorrect, -1 if no response
 */
export function starResCodes(row) {
  if (row.responded !== true) return { res: -1, resVA: -1 };
  return {
    res: row.said_on === true ? 1 : 0,
    resVA: row.star_correct === true ? 1 : 0,
  };
}

/**
 * RT extractor — both probe and star rows. Probes carry RT in jsPsych's
 * built-in `rt` field; stars are written via `jsPsych.data.write` and carry
 * `response_rt_ms`. We accept either; if neither is present, returns null.
 */
export function extractRtMs(row) {
  if (Number.isFinite(row.response_rt_ms)) return row.response_rt_ms;
  if (Number.isFinite(row.rt)) return row.rt;
  return null;
}

/**
 * Raw response-key extractor — stars stamp `response_key` (via
 * `jsPsych.data.write`); probes carry the key in jsPsych's built-in
 * `response`. Returns NA when no response was made.
 */
export function extractResponseKey(row) {
  if (typeof row?.response_key === 'string' && row.response_key.length > 0) return row.response_key;
  if (typeof row?.response === 'string' && row.response.length > 0) return row.response;
  return NA;
}

/**
 * Onset of an event (probe / star / encoded slot) relative to the trial's
 * encoding-onset timestamp. Both inputs are absolute `performance.now()`
 * milliseconds; returns the integer delta or NA when either is missing.
 */
function relativeOnsetMs(absoluteTs, encodingOnsetTs) {
  if (!Number.isFinite(absoluteTs) || !Number.isFinite(encodingOnsetTs)) return NA;
  return Math.round(absoluteTs - encodingOnsetTs);
}

/**
 * Onset of an encoded item (M-slot dot / tone, or S-slot dummy / star) at
 * `slotIdx` in the encoding row's `slot_onsets_ts_ms` array, relative to
 * `encoding_onset_ts_ms`. Returns NA if either timing field is absent.
 */
function slotOnsetMs(encodingRow, slotIdx) {
  if (!encodingRow) return NA;
  const arr = encodingRow.slot_onsets_ts_ms;
  if (!Array.isArray(arr)) return NA;
  return relativeOnsetMs(arr[slotIdx], encodingRow.encoding_onset_ts_ms);
}

/* ---------- CSV serialisation ---------- */

/**
 * Format one cell value for CSV emission per the original experiment's quoting style:
 *   strings → double-quoted with embedded quotes doubled
 *   integers / finite numbers → bare digits
 *   booleans → unquoted `true` / `false`
 *   null / undefined → NA (unquoted)
 *   "NA" sentinel string → NA (unquoted) — for downstream R's read.csv default
 */
export function formatCsvValue(v) {
  if (v === null || v === undefined) return NA;
  if (v === NA) return NA;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return NA;
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  /* Everything else gets stringified + quoted. Embedded quotes double up. */
  const s = String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Serialise an array of row objects to a CSV string with the given column
 * order. Header row is always emitted (matching the original experiment). Line ending is
 * LF (the original experiment's actual files use LF; CRLF is also valid CSV but R / pandas
 * read both transparently).
 */
export function serializeRowsToCsv(rows, columns) {
  const lines = [];
  lines.push(columns.map((c) => `"${c}"`).join(','));
  for (const r of rows) {
    lines.push(columns.map((c) => formatCsvValue(r[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

/* ---------- Trial-row grouping ---------- */

/**
 * Build a participant-keyed grouping of trial rows. The output is a Map keyed
 * by `(participantId, trialType, blockLabel, trialIndex)` whose values bundle
 * the encoding row + per-probe rows + per-star rows for that one trial.
 *
 * Rows lacking `block_label` are skipped (calibration, instructions, strategy,
 * attention checks all live outside the trial timeline). Rows whose phase
 * doesn't map to a trial-type — e.g. `iti`, `pattern_phase`, `rest`,
 * `*_rotation_cue`, `*_retention`, `*_feedback` — also have no useful
 * per-trial fields beyond the timing / phase tag, so we ignore them for
 * the wide-format table (they're still preserved in the raw dumps).
 */
export function groupTrialRows(rowsByParticipant) {
  const groups = new Map();
  const passes = new Map();
  for (const [pid, rows] of rowsByParticipant.entries()) {
    for (const r of rows) {
      const trialType = trialTypeFromPhase(r.phase);
      if (!trialType) continue;
      if (!r.block_label) continue;
      if (!Number.isInteger(r.trial_index_in_block)) continue;
      /* A trial-start gate opens a new pass through the trial. Practice can
       * run twice with the same (block, index), so the pass number is part of
       * the key and the first pass is not overwritten by the second. */
      const baseKey = `${pid}::${trialType}::${r.block_label}::${r.trial_index_in_block}`;
      if (r.phase.endsWith('_trial_start')) passes.set(baseKey, (passes.get(baseKey) ?? 0) + 1);
      const key = `${baseKey}::${passes.get(baseKey) ?? 1}`;
      if (!groups.has(key)) {
        groups.set(key, {
          participant_id: pid,
          trial_type: trialType,
          block_label: r.block_label,
          trial_index_in_block: r.trial_index_in_block,
          attempt: passes.get(baseKey) ?? 1,
          encoding: null,
          probes: [],
          stars: [],
        });
      }
      const g = groups.get(key);
      const phase = r.phase;
      if (phase.endsWith('_encoding')) g.encoding = r;
      else if (phase.endsWith('_probe')) g.probes.push(r);
      else if (phase.endsWith('_star')) g.stars.push(r);
      /* Other intra-trial rows (rotation_cue, retention, feedback) are
       * dropped — they don't contribute to wide-format columns. */
    }
  }
  return groups;
}

/* ---------- Per-probe / per-star column helpers ---------- */

/* Suffix order matches the wide-format column order the analyst sees. `Key`
 * sits next to `Res`/`ResVA` because it's the raw side of the same response
 * (decoded → coded). `OnsetMs` trails the timing block because it pins each
 * event's absolute placement within the trial (relative to encoding onset),
 * separate from `RecTI` which is response latency. */
const PROBE_FIELD_SUFFIXES = Object.freeze([
  'Cell',
  'Type',
  'Res',
  'ResVA',
  'Key',
  'RecTI',
  'RecTI_1',
  'RecTY',
  'OnsetMs',
]);

const STAR_FIELD_SUFFIXES = Object.freeze([
  'Cell',
  'CellTY',
  'Res',
  'ResVA',
  'Key',
  'RecTI',
  'RecTI_1',
  'RecTY',
  'OnsetMs',
]);

const SESSION_META_COLUMNS = Object.freeze([
  'Build_ID',
  'Schema_Version',
  'Pilot_Run',
  'Pilot_Label',
]);

function addProbeColumnNames(cols, prefix) {
  for (const suf of PROBE_FIELD_SUFFIXES) cols.push(`${prefix}_${suf}`);
}

function addStarColumnNames(cols, prefix) {
  for (const suf of STAR_FIELD_SUFFIXES) cols.push(`${prefix}_${suf}`);
}

function addProbeColumns(out, prefix, probeRow, criterion, encodingRow) {
  if (!probeRow) {
    for (const suf of PROBE_FIELD_SUFFIXES) out[`${prefix}_${suf}`] = NA;
    return;
  }
  const { res, resVA } = probeResCodes(probeRow);
  const rt = extractRtMs(probeRow);
  out[`${prefix}_Cell`] = formatCell(probeRow.probed_cell);
  out[`${prefix}_Type`] = probeTypeCode(probeRow.probe_type);
  out[`${prefix}_Res`] = res;
  out[`${prefix}_ResVA`] = resVA;
  out[`${prefix}_Key`] = extractResponseKey(probeRow);
  out[`${prefix}_RecTI`] = Number.isFinite(rt) ? rt : NA;
  out[`${prefix}_RecTI_1`] = criterion === 2 ? applyCriterion2(rt, resVA) : applyCriterion1(rt);
  out[`${prefix}_RecTY`] = probeRow.responded === true ? KEYBOARD_RECTY : NA;
  out[`${prefix}_OnsetMs`] = relativeOnsetMs(
    probeRow.probe_onset_ts_ms,
    encodingRow?.encoding_onset_ts_ms
  );
}

function addStarColumns(out, prefix, starRow, criterion, encodingRow) {
  if (!starRow) {
    for (const suf of STAR_FIELD_SUFFIXES) out[`${prefix}_${suf}`] = NA;
    return;
  }
  const { res, resVA } = starResCodes(starRow);
  const rt = extractRtMs(starRow);
  out[`${prefix}_Cell`] = formatCell(starRow.probed_cell);
  out[`${prefix}_CellTY`] = cellTypeCode(starRow);
  out[`${prefix}_Res`] = res;
  out[`${prefix}_ResVA`] = resVA;
  out[`${prefix}_Key`] = extractResponseKey(starRow);
  out[`${prefix}_RecTI`] = Number.isFinite(rt) ? rt : NA;
  out[`${prefix}_RecTI_1`] = criterion === 2 ? applyCriterion2(rt, resVA) : applyCriterion1(rt);
  out[`${prefix}_RecTY`] = starRow.responded === true ? KEYBOARD_RECTY : NA;
  out[`${prefix}_OnsetMs`] = relativeOnsetMs(
    starRow.star_onset_ts_ms,
    encodingRow?.encoding_onset_ts_ms
  );
}

function addSessionMeta(out, meta) {
  out.Build_ID = meta.build_id ?? NA;
  out.Schema_Version = meta.schema_version ?? NA;
  out.Pilot_Run = meta.is_pilot_run === true ? 1 : 0;
  out.Pilot_Label = meta.pilot_label ?? NA;
}

/* ---------- Per-trial wide-row builders ---------- */

/* Helper: pick the encoding row's per-slot M-items, sorted by slot ascending.
 * Returns up to `n` items padded with `null` so callers can iterate by index
 * without bounds checks. */
function sortedEncodedItems(encodingRow, n = 3) {
  if (!encodingRow || !Array.isArray(encodingRow.memory_items)) {
    return Array.from({ length: n }, () => null);
  }
  const items = [...encodingRow.memory_items].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  while (items.length < n) items.push(null);
  return items.slice(0, n);
}

function sortedEncodedStars(encodingRow, n = 3) {
  if (!encodingRow || !Array.isArray(encodingRow.stars)) {
    return Array.from({ length: n }, () => null);
  }
  const items = [...encodingRow.stars].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  while (items.length < n) items.push(null);
  return items.slice(0, n);
}

/* Helper: pick the trial's probe rows, sorted by probe_position ascending.
 * Probe_position is 0-indexed at the runtime layer (`memory-block.js` and
 * `dual-block.js` stamp 0..2 onto each probe). Wide-format columns are
 * 1-indexed (Qmark_1..Qmark_3) — the +1 conversion happens at column-name
 * generation time, not on the data itself. */
function sortedProbes(probeRows, n = 3) {
  const out = Array.from({ length: n }, () => null);
  for (const r of probeRows) {
    const p = r.probe_position;
    if (Number.isInteger(p) && p >= 0 && p < n) out[p] = r;
  }
  return out;
}

/* Helper: pick the trial's star rows, sorted by probe_position ascending.
 * Same 0-indexed convention as probes. */
function sortedStars(starRows, n = 3) {
  const out = Array.from({ length: n }, () => null);
  for (const r of starRows) {
    const p = r.probe_position;
    if (Number.isInteger(p) && p >= 0 && p < n) out[p] = r;
  }
  return out;
}

/**
 * Build one D-only wide row from a trial group + criterion (1 or 2).
 */
export function buildWideRowDOnly(group, criterion, sessionMeta = {}) {
  const out = {
    Participant_ID: group.participant_id,
    Block: group.block_label,
    Trial_Type: group.trial_type,
    Trial: group.trial_index_in_block + 1,
    Background_Shade: group.encoding?.background_shade ?? NA,
    Rotation_Deg: rotationOf(group.encoding),
  };
  const items = sortedEncodedItems(group.encoding);
  for (let i = 0; i < 3; i++) {
    const m = items[i];
    out[`Dot_${i + 1}_OrderN`] = m ? i + 1 : NA;
    out[`Dot_${i + 1}_Cell`] = m ? formatCell(m.cell) : NA;
    out[`Dot_${i + 1}_CellTY`] = m ? cellTypeCode(m) : NA;
    out[`Dot_${i + 1}_OnsetMs`] = m ? slotOnsetMs(group.encoding, m.slot) : NA;
  }
  const probes = sortedProbes(group.probes);
  for (let i = 0; i < 3; i++) {
    addProbeColumns(out, `Qmark_${i + 1}`, probes[i], criterion, group.encoding);
    out[`Qmark_${i + 1}_EncPos`] =
      probes[i] && Number.isInteger(probes[i].encoding_position) ? probes[i].encoding_position : NA;
  }
  addSessionMeta(out, sessionMeta);
  return out;
}

export const COLUMNS_D_ONLY = Object.freeze(buildColumnsForDOnly());
function buildColumnsForDOnly() {
  const cols = [
    'Participant_ID',
    'Block',
    'Trial_Type',
    'Trial',
    'Background_Shade',
    'Rotation_Deg',
  ];
  for (let i = 1; i <= 3; i++) {
    cols.push(`Dot_${i}_OrderN`, `Dot_${i}_Cell`, `Dot_${i}_CellTY`, `Dot_${i}_OnsetMs`);
  }
  for (let i = 1; i <= 3; i++) {
    addProbeColumnNames(cols, `Qmark_${i}`);
    cols.push(`Qmark_${i}_EncPos`);
  }
  cols.push(...SESSION_META_COLUMNS);
  return cols;
}

/**
 * Build one T-only wide row.
 */
export function buildWideRowTOnly(group, criterion, sessionMeta = {}) {
  const out = {
    Participant_ID: group.participant_id,
    Block: group.block_label,
    Trial_Type: group.trial_type,
    Trial: group.trial_index_in_block + 1,
    Background_Shade: group.encoding?.background_shade ?? NA,
  };
  const items = sortedEncodedItems(group.encoding);
  for (let i = 0; i < 3; i++) {
    const m = items[i];
    out[`Tone_${i + 1}_OrderN`] = m ? i + 1 : NA;
    out[`Tone_${i + 1}_Cell`] = m ? formatCell(m.cell) : NA;
    out[`Tone_${i + 1}_CellTY`] = m ? cellTypeCode(m) : NA;
    out[`Tone_${i + 1}_ToneIdx`] = m && Number.isInteger(m.tone_index) ? m.tone_index : NA;
    out[`Tone_${i + 1}_ToneFreqHz`] = m && Number.isFinite(m.tone_freq_hz) ? m.tone_freq_hz : NA;
    out[`Tone_${i + 1}_OnsetMs`] = m ? slotOnsetMs(group.encoding, m.slot) : NA;
  }
  const probes = sortedProbes(group.probes);
  for (let i = 0; i < 3; i++) {
    const p = probes[i];
    addProbeColumns(out, `Qmark_${i + 1}`, p, criterion, group.encoding);
    out[`Qmark_${i + 1}_ToneIdx`] =
      p && Number.isInteger(p.probed_tone_index) ? p.probed_tone_index : NA;
    out[`Qmark_${i + 1}_ToneFreqHz`] =
      p && Number.isFinite(p.probed_tone_freq_hz) ? p.probed_tone_freq_hz : NA;
    out[`Qmark_${i + 1}_EncPos`] =
      p && Number.isInteger(p.encoding_position) ? p.encoding_position : NA;
  }
  addSessionMeta(out, sessionMeta);
  return out;
}

export const COLUMNS_T_ONLY = Object.freeze(buildColumnsForTOnly());
function buildColumnsForTOnly() {
  const cols = ['Participant_ID', 'Block', 'Trial_Type', 'Trial', 'Background_Shade'];
  for (let i = 1; i <= 3; i++) {
    cols.push(
      `Tone_${i}_OrderN`,
      `Tone_${i}_Cell`,
      `Tone_${i}_CellTY`,
      `Tone_${i}_ToneIdx`,
      `Tone_${i}_ToneFreqHz`,
      `Tone_${i}_OnsetMs`
    );
  }
  for (let i = 1; i <= 3; i++) {
    addProbeColumnNames(cols, `Qmark_${i}`);
    cols.push(`Qmark_${i}_ToneIdx`, `Qmark_${i}_ToneFreqHz`, `Qmark_${i}_EncPos`);
  }
  cols.push(...SESSION_META_COLUMNS);
  return cols;
}

/**
 * Build one I-only wide row (3 stars per trial; no probe).
 */
export function buildWideRowIOnly(group, criterion, sessionMeta = {}) {
  const out = {
    Participant_ID: group.participant_id,
    Block: group.block_label,
    Trial_Type: group.trial_type,
    Trial: group.trial_index_in_block + 1,
    Background_Shade: group.encoding?.background_shade ?? NA,
    Rotation_Deg: rotationOf(group.encoding),
  };
  /* On I-only there's no probe — stars carry the response. The encoding
   * row's `stars` array gives presentation order; on-screen ordering matches
   * `probe_position` 1-3. Dummies are uniform open-circle fillers (Step
   * 13.16) so there is no per-trial dummy-mode column to emit. */
  const stars = sortedStars(group.stars);
  for (let i = 0; i < 3; i++) {
    addStarColumns(out, `Ast_${i + 1}`, stars[i], criterion, group.encoding);
  }
  addSessionMeta(out, sessionMeta);
  return out;
}

export const COLUMNS_I_ONLY = Object.freeze(buildColumnsForIOnly());
function buildColumnsForIOnly() {
  const cols = [
    'Participant_ID',
    'Block',
    'Trial_Type',
    'Trial',
    'Background_Shade',
    'Rotation_Deg',
  ];
  for (let i = 1; i <= 3; i++) addStarColumnNames(cols, `Ast_${i}`);
  cols.push(...SESSION_META_COLUMNS);
  return cols;
}

/**
 * Build one I+D dual-task wide row (3 dots + 3 stars + 3 probes per trial).
 */
export function buildWideRowID(group, criterion, sessionMeta = {}) {
  const out = {
    Participant_ID: group.participant_id,
    Block: group.block_label,
    Trial_Type: group.trial_type,
    Trial: group.trial_index_in_block + 1,
    Background_Shade: group.encoding?.background_shade ?? NA,
    Rotation_Deg: rotationOf(group.encoding),
  };
  const items = sortedEncodedItems(group.encoding);
  for (let i = 0; i < 3; i++) {
    const m = items[i];
    out[`Dot_${i + 1}_OrderN`] = m ? i + 1 : NA;
    out[`Dot_${i + 1}_Cell`] = m ? formatCell(m.cell) : NA;
    out[`Dot_${i + 1}_CellTY`] = m ? cellTypeCode(m) : NA;
    out[`Dot_${i + 1}_OnsetMs`] = m ? slotOnsetMs(group.encoding, m.slot) : NA;
  }
  const encStars = sortedEncodedStars(group.encoding);
  const stars = sortedStars(group.stars);
  for (let i = 0; i < 3; i++) {
    /* Encoding-time star slot gives the cell at trial-design time; the
     * runtime `stars` array carries the participant's response. the original experiment
     * recorded both, so we keep the parallel here. */
    const e = encStars[i];
    out[`Ast_${i + 1}_SlotN`] = e ? i + 1 : NA;
    addStarColumns(out, `Ast_${i + 1}`, stars[i], criterion, group.encoding);
  }
  const probes = sortedProbes(group.probes);
  for (let i = 0; i < 3; i++) {
    const p = probes[i];
    addProbeColumns(out, `Qmark_${i + 1}`, p, criterion, group.encoding);
    out[`Qmark_${i + 1}_EncPos`] =
      p && Number.isInteger(p.encoding_position) ? p.encoding_position : NA;
  }
  addSessionMeta(out, sessionMeta);
  return out;
}

export const COLUMNS_I_D = Object.freeze(buildColumnsForID());
function buildColumnsForID() {
  const cols = [
    'Participant_ID',
    'Block',
    'Trial_Type',
    'Trial',
    'Background_Shade',
    'Rotation_Deg',
  ];
  for (let i = 1; i <= 3; i++) {
    cols.push(`Dot_${i}_OrderN`, `Dot_${i}_Cell`, `Dot_${i}_CellTY`, `Dot_${i}_OnsetMs`);
  }
  for (let i = 1; i <= 3; i++) {
    cols.push(`Ast_${i}_SlotN`);
    addStarColumnNames(cols, `Ast_${i}`);
  }
  for (let i = 1; i <= 3; i++) {
    addProbeColumnNames(cols, `Qmark_${i}`);
    cols.push(`Qmark_${i}_EncPos`);
  }
  cols.push(...SESSION_META_COLUMNS);
  return cols;
}

/**
 * Build one I+T dual-task wide row (3 tones + 3 stars + 3 probes per trial).
 */
export function buildWideRowIT(group, criterion, sessionMeta = {}) {
  const out = {
    Participant_ID: group.participant_id,
    Block: group.block_label,
    Trial_Type: group.trial_type,
    Trial: group.trial_index_in_block + 1,
    Background_Shade: group.encoding?.background_shade ?? NA,
    Rotation_Deg: rotationOf(group.encoding),
  };
  const items = sortedEncodedItems(group.encoding);
  for (let i = 0; i < 3; i++) {
    const m = items[i];
    out[`Tone_${i + 1}_OrderN`] = m ? i + 1 : NA;
    out[`Tone_${i + 1}_Cell`] = m ? formatCell(m.cell) : NA;
    out[`Tone_${i + 1}_CellTY`] = m ? cellTypeCode(m) : NA;
    out[`Tone_${i + 1}_ToneIdx`] = m && Number.isInteger(m.tone_index) ? m.tone_index : NA;
    out[`Tone_${i + 1}_ToneFreqHz`] = m && Number.isFinite(m.tone_freq_hz) ? m.tone_freq_hz : NA;
    out[`Tone_${i + 1}_OnsetMs`] = m ? slotOnsetMs(group.encoding, m.slot) : NA;
  }
  const encStars = sortedEncodedStars(group.encoding);
  const stars = sortedStars(group.stars);
  for (let i = 0; i < 3; i++) {
    const e = encStars[i];
    out[`Ast_${i + 1}_SlotN`] = e ? i + 1 : NA;
    addStarColumns(out, `Ast_${i + 1}`, stars[i], criterion, group.encoding);
  }
  const probes = sortedProbes(group.probes);
  for (let i = 0; i < 3; i++) {
    const p = probes[i];
    addProbeColumns(out, `Qmark_${i + 1}`, p, criterion, group.encoding);
    out[`Qmark_${i + 1}_ToneIdx`] =
      p && Number.isInteger(p.probed_tone_index) ? p.probed_tone_index : NA;
    out[`Qmark_${i + 1}_ToneFreqHz`] =
      p && Number.isFinite(p.probed_tone_freq_hz) ? p.probed_tone_freq_hz : NA;
    out[`Qmark_${i + 1}_EncPos`] =
      p && Number.isInteger(p.encoding_position) ? p.encoding_position : NA;
  }
  addSessionMeta(out, sessionMeta);
  return out;
}

export const COLUMNS_I_T = Object.freeze(buildColumnsForIT());
function buildColumnsForIT() {
  const cols = [
    'Participant_ID',
    'Block',
    'Trial_Type',
    'Trial',
    'Background_Shade',
    'Rotation_Deg',
  ];
  for (let i = 1; i <= 3; i++) {
    cols.push(
      `Tone_${i}_OrderN`,
      `Tone_${i}_Cell`,
      `Tone_${i}_CellTY`,
      `Tone_${i}_ToneIdx`,
      `Tone_${i}_ToneFreqHz`,
      `Tone_${i}_OnsetMs`
    );
  }
  for (let i = 1; i <= 3; i++) {
    cols.push(`Ast_${i}_SlotN`);
    addStarColumnNames(cols, `Ast_${i}`);
  }
  for (let i = 1; i <= 3; i++) {
    addProbeColumnNames(cols, `Qmark_${i}`);
    cols.push(`Qmark_${i}_ToneIdx`, `Qmark_${i}_ToneFreqHz`, `Qmark_${i}_EncPos`);
  }
  cols.push(...SESSION_META_COLUMNS);
  return cols;
}

/* ---------- Long-form events CSV ----------
 *
 * EVENTS.csv complements the wide trial-type files with a tidy long-format
 * frame: one row per stimulus event (6 encoding events + 3 recognition probes
 * for d_only/t_only/i_d/i_t; 3 encoding star events for i_only). Rotation_Deg
 * is constant within a trial — repeated to keep each row self-contained for
 * downstream filtering. `Pattern_Label` carries the on/off pattern membership
 * of the cell where applicable; `Probe_Type` is set only on recognition rows.
 */

const EVENTS_COLUMNS = Object.freeze([
  'Participant_ID',
  'Block',
  'Trial_Type',
  'Trial',
  'Phase',
  'Event_Index',
  'Event_Kind',
  'Cell',
  'Pattern_Label',
  'Tone_Idx',
  'Tone_Freq_Hz',
  'Rotation_Deg',
  'Probe_Type',
  'Encoding_Position',
  'Onset_Ms',
  'Response_Key',
  'Res',
  'ResVA',
  'RT_Ms',
  'X_Mm',
  'Y_Mm',
  'Tone_Late_Ms',
  'Tone_Error',
  'Early_Keypresses',
  'Late_Keypresses',
  'Extra_Keypresses',
  'Onset_Lag_Ms',
  'Displayed',
  'Truncated',
  'Guard_Flags',
  'Build_ID',
  'Schema_Version',
  'Pilot_Run',
  'Pilot_Label',
]);

/* Trial-type → kind tags for the M-slot (memory item) and S-slot (probe).
 * The encoding-side dummy is the same kind ('dummy_S') across all conditions
 * that include dummies (d_only / t_only). i_only / i_d / i_t use 'star' at
 * S-slots instead of dummies. */
const EVENT_KIND_BY_TRIAL_TYPE = Object.freeze({
  d_only: { encodedM: 'dot', probe: 'probe_dot' },
  t_only: { encodedM: 'tone', probe: 'probe_tone' },
  i_only: { encodedM: null, probe: null },
  i_d: { encodedM: 'dot', probe: 'probe_dot' },
  i_t: { encodedM: 'tone', probe: 'probe_tone' },
});

const boolOrNA = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : NA);

function slotPositionFields(enc, slot) {
  const pos = Array.isArray(enc.slot_positions_mm)
    ? enc.slot_positions_mm.find((p) => p.slot === slot)
    : null;
  return { X_Mm: numOrNA(pos?.x_mm), Y_Mm: numOrNA(pos?.y_mm) };
}

function toneEventFields(enc, slot) {
  const ev = Array.isArray(enc.slot_tone_events)
    ? enc.slot_tone_events.find((e) => e.slot === slot)
    : null;
  return { Tone_Late_Ms: numOrNA(ev?.late_ms), Tone_Error: boolOrNA(ev?.tone_error) };
}

function keypressFields(row) {
  return {
    Early_Keypresses: numOrNA(row?.early_keypresses),
    Late_Keypresses: numOrNA(row?.late_keypresses),
    Extra_Keypresses: numOrNA(row?.extra_keypresses),
  };
}

/**
 * Compose long-form event rows for one trial group. Returns up to 9 rows
 * (6 encoding + 3 recognition); 3 rows for i_only (stars only).
 */
function composeEventsRows(group, sessionMeta = {}) {
  const enc = group.encoding;
  if (!enc) return [];
  const kinds = EVENT_KIND_BY_TRIAL_TYPE[group.trial_type] ?? { encodedM: null, probe: null };
  const rotation = rotationOf(enc);
  const trialBase = {
    Participant_ID: group.participant_id,
    Block: group.block_label,
    Trial_Type: group.trial_type,
    Trial: group.trial_index_in_block + 1,
    Rotation_Deg: rotation,
    Build_ID: sessionMeta.build_id ?? NA,
    Schema_Version: sessionMeta.schema_version ?? NA,
    Pilot_Run: sessionMeta.is_pilot_run === true ? 1 : 0,
    Pilot_Label: sessionMeta.pilot_label ?? NA,
  };

  /* Build the encoding-event list. Sources: M-slot memory_items (dot/tone),
   * S-slot dummies (d_only/t_only), S-slot stars (i_only/i_d/i_t). Each entry
   * is keyed by `slot` so we can sort the trial's events into the order the
   * participant actually saw them. */
  const encEvents = [];
  if (Array.isArray(enc.memory_items) && kinds.encodedM) {
    for (const m of enc.memory_items) {
      encEvents.push({ slot: m.slot, kind: kinds.encodedM, item: m, runtime: null });
    }
  }
  if (Array.isArray(enc.dummies)) {
    for (const d of enc.dummies) {
      encEvents.push({ slot: d.slot, kind: 'dummy_S', item: d, runtime: null });
    }
  }
  if (Array.isArray(enc.stars)) {
    /* Match each encoded star to its runtime row by slot so we can fold the
     * response (key / Res / ResVA / RT) into the same long-form row. */
    const runtimeStarBySlot = new Map();
    for (const s of group.stars) {
      if (Number.isInteger(s.slot_index_in_seq)) runtimeStarBySlot.set(s.slot_index_in_seq, s);
    }
    for (const s of enc.stars) {
      encEvents.push({
        slot: s.slot,
        kind: 'star',
        item: s,
        runtime: runtimeStarBySlot.get(s.slot) ?? null,
      });
    }
  }
  encEvents.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));

  const out = [];
  for (let i = 0; i < encEvents.length; i++) {
    const ev = encEvents[i];
    const row = {
      ...trialBase,
      Phase: 'encoding',
      Event_Index: i + 1,
      Event_Kind: ev.kind,
      Cell: ev.item?.cell !== undefined ? formatCell(ev.item.cell) : NA,
      Pattern_Label: ev.item?.pattern_label ?? NA,
      Tone_Idx: Number.isInteger(ev.item?.tone_index) ? ev.item.tone_index : NA,
      Tone_Freq_Hz: Number.isFinite(ev.item?.tone_freq_hz) ? ev.item.tone_freq_hz : NA,
      Probe_Type: NA,
      Encoding_Position: Number.isInteger(ev.item?.encoding_position)
        ? ev.item.encoding_position
        : NA,
      Onset_Ms: slotOnsetMs(enc, ev.slot),
      Response_Key: NA,
      Res: NA,
      ResVA: NA,
      RT_Ms: NA,
      ...slotPositionFields(enc, ev.slot),
      ...toneEventFields(enc, ev.slot),
      ...keypressFields(null),
      Onset_Lag_Ms: NA,
      Displayed: NA,
      Truncated: NA,
      Guard_Flags: NA,
    };
    if (ev.kind === 'star' && ev.runtime) {
      Object.assign(row, keypressFields(ev.runtime), {
        Onset_Lag_Ms: numOrNA(ev.runtime.star_onset_lag_ms),
        Displayed: boolOrNA(ev.runtime.displayed),
        Truncated: boolOrNA(ev.runtime.truncated),
        Guard_Flags: ev.runtime.guard_flags ?? NA,
      });
      const rt = extractRtMs(ev.runtime);
      const { res, resVA } = starResCodes(ev.runtime);
      row.Response_Key = extractResponseKey(ev.runtime);
      row.Res = res;
      row.ResVA = resVA;
      row.RT_Ms = Number.isFinite(rt) ? rt : NA;
      const starOnset = relativeOnsetMs(ev.runtime.star_onset_ts_ms, enc.encoding_onset_ts_ms);
      if (starOnset !== NA) row.Onset_Ms = starOnset;
    }
    out.push(row);
  }

  /* Recognition events. Probes are sorted by `probe_position` (0-indexed at
   * the runtime layer). Event_Index is 1-indexed for the CSV. */
  if (kinds.probe && Array.isArray(group.probes) && group.probes.length > 0) {
    const probesSorted = [...group.probes].sort(
      (a, b) => (a.probe_position ?? 0) - (b.probe_position ?? 0)
    );
    for (let i = 0; i < probesSorted.length; i++) {
      const p = probesSorted[i];
      const rt = extractRtMs(p);
      const { res, resVA } = probeResCodes(p);
      out.push({
        ...trialBase,
        Phase: 'recognition',
        Event_Index: Number.isInteger(p.probe_position) ? p.probe_position + 1 : i + 1,
        Event_Kind: kinds.probe,
        Cell: p.probed_cell !== undefined ? formatCell(p.probed_cell) : NA,
        Pattern_Label: p.probe_pattern_label ?? NA,
        Tone_Idx: Number.isInteger(p.probed_tone_index) ? p.probed_tone_index : NA,
        Tone_Freq_Hz: Number.isFinite(p.probed_tone_freq_hz) ? p.probed_tone_freq_hz : NA,
        Probe_Type: probeTypeCode(p.probe_type),
        Encoding_Position: Number.isInteger(p.encoding_position) ? p.encoding_position : NA,
        Onset_Ms: relativeOnsetMs(p.probe_onset_ts_ms, enc.encoding_onset_ts_ms),
        Response_Key: extractResponseKey(p),
        Res: res,
        ResVA: resVA,
        RT_Ms: Number.isFinite(rt) ? rt : NA,
        X_Mm: numOrNA(p.probe_x_mm),
        Y_Mm: numOrNA(p.probe_y_mm),
        Tone_Late_Ms: NA,
        Tone_Error: boolOrNA(p.tone_error),
        ...keypressFields(p),
        Onset_Lag_Ms: NA,
        Displayed: NA,
        Truncated: NA,
        Guard_Flags: p.guard_flags ?? NA,
      });
    }
  }

  return out;
}

/* ---------- Auxiliary CSVs ---------- */

const DECK_IDS = Object.freeze([
  'overview',
  'practice_readiness',
  'd_only',
  't_only',
  'i_only',
  'i_d',
  'i_t',
  'demo_narration',
]);

const CALIBRATION_COLUMNS = Object.freeze([
  'Participant_ID',
  'Build_ID',
  'Schema_Version',
  'Pilot_Run',
  'Pilot_Label',
  'Started_At_ISO',
  'Session_Duration_Min',
  'Consented',
  'Cc_Px_Width',
  'Px_Per_Mm',
  'Px_Per_Mm_In_Bounds',
  'Screen_Cal_Attempts',
  'Screen_Cal_Retried',
  'Display_Colour_Locked',
  'Tones_Audible',
  'User_Playback_Pct',
  'User_Playback_Gain',
  'Sweeps_Completed',
  'Storage_Failures',
  'Attention_Total',
  'Attention_Passed',
  'Attention_Failed',
  'Attention_Excluded',
  'Upload_Status',
  'Completion_Was_Placeholder',
  'User_Agent',
  'Exit_Reason',
  'Build_Commit',
  'Build_Time',
  'Consent_Text_Sha256',
  ...DECK_IDS.map((d) => `Instruction_Deck_Sha256_${d}`),
  'Strategy_Items_Sha256',
  'Music_Items_Sha256',
  'Clock_Perf_Now_Ms',
  'Clock_Time_Origin_Ms',
  'Clock_Date_Now_Ms',
  'Clock_Iso',
  'Clock_Jspsych_Start_Ms',
  'Screen_Width_Px',
  'Screen_Height_Px',
  'Inner_Width_Px',
  'Inner_Height_Px',
  'Device_Pixel_Ratio',
  'Hardware_Concurrency',
  'Device_Memory_Gb',
  'Audio_Sample_Rate_Hz',
  'Audio_State',
  'Audio_Base_Latency_Ms',
  'Audio_Output_Latency_Ms',
  'Headphone_Pass',
  'Headphone_N_Correct',
  'Headphone_N_Trials',
  'Pitch_Attempts',
  'Pitch_Pass',
  'Pitch_N_Correct',
  'Pitch_N_Trials',
  'Pitch_Margin_Pass',
  'Pitch_Margin_N_Correct',
  'Timing_Attempts',
  'Timing_Ok',
  'Timing_Fail_Reasons',
  'Timing_Frame_Median_Ms',
  'Timing_Refresh_Hz_Est',
  'Timing_Frame_P95_Ms',
  'Timing_Overshoot_P95_Ms',
  'Viewing_Posture_Acknowledged',
  'Hand_Placement_Acknowledged',
  'Visibility_Change_Events',
  'Visibility_Hidden_Events',
  'Visibility_Hidden_Ms_Total',
  'Fullscreen_Change_Events',
  'Guard_Events',
  'Guard_Hidden_Ms_Total',
]);

export { CALIBRATION_COLUMNS };

/**
 * Compute one calibration / session-summary row for a participant.
 */
export function extractCalibrationRow(participantId, sessionMeta, rows) {
  const consentRow = rows.find((r) => r.phase === 'consent');
  /* The accepted calibration is the LAST outcome row: each attempt writes
   * one outcome row (two settings of the slider averaged), and the final
   * attempt is what feeds downstream sizing. The display-colour flag comes
   * from the last slider row. Same for the audibility/comfort row — if a
   * hidden-nav re-entry stamped two, take the latest. */
  const screenCals = rows.filter((r) => r.phase === 'screen_calibration');
  const screenCal = screenCals[screenCals.length - 1];
  const screenOutcomes = rows.filter((r) => r.phase === 'screen_calibration_outcome');
  const screenOutcome = screenOutcomes[screenOutcomes.length - 1];
  const audibilityRows = rows.filter((r) => r.phase === 'tone_audibility_and_comfort');
  const audibility = audibilityRows[audibilityRows.length - 1];
  const attentionSummary = rows.find((r) => r.phase === 'attention_check_summary');
  const uploadSummary = rows.find((r) => r.phase === 'upload_session_end');
  const completion = rows.find((r) => r.phase === 'completion_redirect');

  /* Outcome-row fields are nested inside `value` because they came back from
   * a callFunction node (jsPsych stores its return as `data.value`). Fall
   * back to top-level fields in case future code stamps them directly. */
  const outcomeValue = screenOutcome?.value ?? screenOutcome ?? {};
  const screenAttempts = Number.isInteger(outcomeValue.attempts_used)
    ? outcomeValue.attempts_used
    : NA;
  const screenRetried =
    typeof outcomeValue.retried === 'boolean' ? (outcomeValue.retried ? 1 : 0) : NA;
  const inBounds =
    typeof outcomeValue.px_per_mm_in_bounds === 'boolean'
      ? outcomeValue.px_per_mm_in_bounds
        ? 1
        : 0
      : NA;

  return {
    Participant_ID: participantId,
    Build_ID: sessionMeta.build_id ?? NA,
    Schema_Version: sessionMeta.schema_version ?? NA,
    Pilot_Run: sessionMeta.is_pilot_run === true ? 1 : 0,
    Pilot_Label: sessionMeta.pilot_label ?? NA,
    Started_At_ISO: sessionMeta.started_at_iso ?? NA,
    Session_Duration_Min: estimateSessionDurationMin(rows),
    Consented: consentRow?.consented === true ? 1 : consentRow ? 0 : NA,
    Cc_Px_Width: Number.isFinite(outcomeValue.cc_px_width) ? outcomeValue.cc_px_width : NA,
    Px_Per_Mm: Number.isFinite(outcomeValue.px_per_mm) ? outcomeValue.px_per_mm : NA,
    Px_Per_Mm_In_Bounds: inBounds,
    Screen_Cal_Attempts: screenAttempts,
    Screen_Cal_Retried: screenRetried,
    Display_Colour_Locked:
      screenCal?.display_colour_locked === true
        ? 1
        : screenCal?.display_colour_locked === false
          ? 0
          : NA,
    Tones_Audible:
      audibility?.tones_audible === true ? 1 : audibility?.tones_audible === false ? 0 : NA,
    User_Playback_Pct: Number.isInteger(audibility?.user_playback_pct)
      ? audibility.user_playback_pct
      : NA,
    User_Playback_Gain: Number.isFinite(audibility?.user_playback_gain)
      ? audibility.user_playback_gain
      : NA,
    Sweeps_Completed: Number.isInteger(audibility?.sweeps_completed)
      ? audibility.sweeps_completed
      : NA,
    Storage_Failures: Number.isInteger(uploadSummary?.storage_write_failures)
      ? uploadSummary.storage_write_failures
      : NA,
    Attention_Total: Number.isInteger(attentionSummary?.attention_total)
      ? attentionSummary.attention_total
      : NA,
    Attention_Passed: Number.isInteger(attentionSummary?.attention_passed)
      ? attentionSummary.attention_passed
      : NA,
    Attention_Failed: Number.isInteger(attentionSummary?.attention_failed)
      ? attentionSummary.attention_failed
      : NA,
    Attention_Excluded:
      typeof attentionSummary?.attention_excluded === 'boolean'
        ? attentionSummary.attention_excluded
          ? 1
          : 0
        : NA,
    Upload_Status: uploadSummary?.status ?? NA,
    Completion_Was_Placeholder:
      typeof completion?.completion_was_placeholder === 'boolean'
        ? completion.completion_was_placeholder
          ? 1
          : 0
        : NA,
    User_Agent: sessionMeta.user_agent ?? NA,
    ...extractSessionEnvironment(rows),
  };
}

const flagOrNA = (v) => (v === true ? 1 : v === false ? 0 : NA);
const lastRow = (rows, phase) => rows.filter((r) => r.phase === phase).pop();

/**
 * Columns of CALIBRATION_SUMMARY that come from the session_info row, the
 * check summaries, the visibility and display-guard events and the exit row.
 */
function extractSessionEnvironment(rows) {
  const info = rows.find((r) => r.phase === 'session_info') ?? {};
  const anchor = info.clock_anchor ?? rows.find((r) => r.phase === 'session_start')?.clock_anchor;
  const audio = info.audio_context ?? {};
  const decks = info.instruction_deck_sha256 ?? {};
  const exitRow = rows.filter((r) => typeof r.exit_reason === 'string').pop();

  const headphone = lastRow(rows, 'headphone_check_summary')?.value;
  const pitchRows = rows
    .filter((r) => r.phase === 'pitch_check_summary')
    .map((r) => r.value)
    .filter(Boolean);
  const pitchUser = pitchRows.filter((v) => v.label === 'pitch_user_level');
  const pitchUserLast = pitchUser[pitchUser.length - 1];
  const pitchMargin = pitchRows.filter((v) => v.label === 'pitch_margin_minus12').pop();
  const timingRows = rows.filter((r) => r.phase === 'timing_probe');
  const timing = timingRows[timingRows.length - 1];
  const snapshot = [...timingRows, ...rows.filter((r) => r.phase === 'display_guard_event')].find(
    (r) => Number.isFinite(r.hardware_concurrency)
  );

  const visibility = rows.filter(
    (r) => r.phase === 'visibility_event' && r.kind === 'visibilitychange'
  );
  let hiddenMs = 0;
  let hiddenAt = null;
  for (const e of visibility) {
    if (e.hidden === true) hiddenAt = e.ts;
    else if (e.hidden === false && hiddenAt !== null) {
      hiddenMs += e.ts - hiddenAt;
      hiddenAt = null;
    }
  }
  const guard = rows.filter((r) => r.phase === 'display_guard_event');
  const guardHidden = guard
    .filter((r) => r.kind === 'visible' && Number.isFinite(r.hidden_ms))
    .reduce((a, r) => a + r.hidden_ms, 0);

  const out = {
    Exit_Reason: exitRow?.exit_reason ?? NA,
    Build_Commit: info.build_commit ?? NA,
    Build_Time: info.build_time ?? NA,
    Consent_Text_Sha256: info.consent_text_sha256 ?? NA,
    Strategy_Items_Sha256: info.strategy_items_sha256 ?? NA,
    Music_Items_Sha256: info.music_items_sha256 ?? NA,
    Clock_Perf_Now_Ms: numOrNA(anchor?.perf_now_ms),
    Clock_Time_Origin_Ms: numOrNA(anchor?.time_origin_ms),
    Clock_Date_Now_Ms: numOrNA(anchor?.date_now_ms),
    Clock_Iso: anchor?.iso ?? NA,
    Clock_Jspsych_Start_Ms: numOrNA(anchor?.jspsych_start_ms),
    Screen_Width_Px: numOrNA(info.screen_width_px),
    Screen_Height_Px: numOrNA(info.screen_height_px),
    Inner_Width_Px: numOrNA(info.inner_width_px),
    Inner_Height_Px: numOrNA(info.inner_height_px),
    Device_Pixel_Ratio: numOrNA(info.device_pixel_ratio),
    Hardware_Concurrency: numOrNA(snapshot?.hardware_concurrency),
    Device_Memory_Gb: numOrNA(snapshot?.device_memory_gb),
    Audio_Sample_Rate_Hz: numOrNA(audio.sample_rate_hz),
    Audio_State: audio.state ?? NA,
    Audio_Base_Latency_Ms: numOrNA(audio.base_latency_ms),
    Audio_Output_Latency_Ms: numOrNA(audio.output_latency_ms),
    Headphone_Pass: flagOrNA(headphone?.headphones_pass),
    Headphone_N_Correct: numOrNA(headphone?.n_correct),
    Headphone_N_Trials: numOrNA(headphone?.n_trials),
    Pitch_Attempts: pitchUser.length > 0 ? pitchUser.length : NA,
    Pitch_Pass: flagOrNA(pitchUserLast?.passed),
    Pitch_N_Correct: numOrNA(pitchUserLast?.n_correct),
    Pitch_N_Trials: numOrNA(pitchUserLast?.n_trials),
    Pitch_Margin_Pass: flagOrNA(pitchMargin?.passed),
    Pitch_Margin_N_Correct: numOrNA(pitchMargin?.n_correct),
    Timing_Attempts: timingRows.length > 0 ? timingRows.length : NA,
    Timing_Ok: flagOrNA(timing?.timing_ok),
    Timing_Fail_Reasons: Array.isArray(timing?.timing_fail_reasons)
      ? timing.timing_fail_reasons.join(';')
      : NA,
    Timing_Frame_Median_Ms: numOrNA(timing?.frame_median_ms),
    Timing_Refresh_Hz_Est: numOrNA(timing?.refresh_hz_est),
    Timing_Frame_P95_Ms: numOrNA(timing?.frame_p95_ms),
    Timing_Overshoot_P95_Ms: numOrNA(timing?.timeout_overshoot_p95_ms),
    Viewing_Posture_Acknowledged: rows.some((r) => r.phase === 'viewing_distance') ? 1 : NA,
    Hand_Placement_Acknowledged: rows.some((r) => r.phase === 'hand_placement') ? 1 : NA,
    Visibility_Change_Events: visibility.length,
    Visibility_Hidden_Events: visibility.filter((e) => e.hidden === true).length,
    Visibility_Hidden_Ms_Total: Math.round(hiddenMs),
    Fullscreen_Change_Events: rows.filter(
      (r) => r.phase === 'visibility_event' && r.kind === 'fullscreenchange'
    ).length,
    Guard_Events: guard.length,
    Guard_Hidden_Ms_Total: Math.round(guardHidden),
  };
  for (const d of DECK_IDS) out[`Instruction_Deck_Sha256_${d}`] = decks[d] ?? NA;
  return out;
}

/**
 * Coarse session-duration estimate (minutes) — last `time_elapsed` is most
 * accurate; falls back to summing `rt`. Returns NA when nothing usable.
 */
export function estimateSessionDurationMin(rows) {
  const lastTimeElapsed = rows
    .map((r) => r.time_elapsed)
    .filter((v) => Number.isFinite(v))
    .pop();
  if (Number.isFinite(lastTimeElapsed)) {
    return Number((lastTimeElapsed / 60_000).toFixed(2));
  }
  const rtSum = rows
    .map((r) => r.rt)
    .filter((v) => Number.isFinite(v))
    .reduce((a, b) => a + b, 0);
  if (rtSum === 0) return NA;
  return Number((rtSum / 60_000).toFixed(2));
}

const STRATEGY_COLUMNS = Object.freeze([
  'Participant_ID',
  'Section',
  'Item_Id',
  'Response_Raw',
  'Response_Score',
]);

export { STRATEGY_COLUMNS };

/* The five strategy-questionnaire phase tags. Mirrors the section ids in
 * `src/questionnaire/strategy.js::STRATEGY_SECTIONS`; kept here as a
 * literal Set so the CSV exporter has no runtime import from the
 * questionnaire module. */
const STRATEGY_PHASES = new Set([
  'strategy_memory_only',
  'strategy_tone_only',
  'strategy_imagery_only',
  'strategy_i_d',
  'strategy_i_t',
]);

/**
 * Produce one row per (participant × strategy item × section). Each of
 * the five `strategy_*` rows carries an object `strategy_responses`
 * mapping the section's `strategy_q??` keys → '1'..'5' (5-point
 * agreement Likert; 1 = Strongly disagree, 5 = Strongly agree).
 * `Response_Raw` is the raw string code; `Response_Score` is the
 * integer 1..5 for analyst convenience (NA when blank).
 */
export function extractStrategyRows(participantId, rows) {
  const out = [];
  for (const r of rows) {
    if (!STRATEGY_PHASES.has(r.phase)) continue;
    const section = r.strategy_section ?? NA;
    const responses = r.strategy_responses ?? {};
    for (const [itemId, raw] of Object.entries(responses)) {
      const score = typeof raw === 'string' && /^[1-5]$/.test(raw) ? Number.parseInt(raw, 10) : NA;
      out.push({
        Participant_ID: participantId,
        Section: section,
        Item_Id: itemId,
        Response_Raw: typeof raw === 'string' && raw.length > 0 ? raw : NA,
        Response_Score: score,
      });
    }
  }
  return out;
}

const MUSIC_COLUMNS = Object.freeze([
  'Participant_ID',
  ...MUSIC_EXPERIENCE_ITEMS.flatMap((it) => {
    const id = it.id.replace('me_q', 'Me_Q');
    return it.options.some((o) => typeof o.score === 'number')
      ? [`${id}_Raw`, `${id}_Score`]
      : [`${id}_Raw`];
  }),
  'Items_Answered',
  'Items_Total',
  'Complete',
  'Gold_MSI_MT_Composite',
  'Gold_MSI_MT_Complete',
  'Absolute_Pitch',
]);

export { MUSIC_COLUMNS };

/**
 * One row per participant from the music-experience questionnaire: the raw
 * option code and the item score (1-7) of each Gold-MSI MT item, the
 * absolute-pitch self-report, and the MT composite (sum of the seven items,
 * NA unless all seven are answered).
 */
export function extractMusicRow(participantId, rows) {
  const scored = scoreMusicExperience(rows);
  const out = { Participant_ID: participantId };
  for (const item of MUSIC_EXPERIENCE_ITEMS) {
    const id = item.id.replace('me_q', 'Me_Q');
    const raw = scored.itemResponses[item.id];
    out[`${id}_Raw`] = raw ?? NA;
    const score = item.options.find((o) => o.value === raw)?.score;
    if (MUSIC_COLUMNS.includes(`${id}_Score`)) out[`${id}_Score`] = numOrNA(score);
  }
  out.Items_Answered = scored.answered;
  out.Items_Total = scored.total;
  out.Complete = scored.complete ? 1 : 0;
  out.Gold_MSI_MT_Composite = numOrNA(scored.gold_msi_mt_composite);
  out.Gold_MSI_MT_Complete = scored.gold_msi_mt_complete ? 1 : 0;
  out.Absolute_Pitch = scored.absolute_pitch ?? NA;
  return out;
}

const STRATEGY_SCORE_COLUMNS = Object.freeze([
  'Participant_ID',
  'Items_Answered',
  'Items_Total',
  'Complete',
  'Structural_Chunking_Composite',
  'Imagery_Maintenance_ID_Composite',
  'Imagery_Maintenance_IT_Composite',
  ...STRATEGY_ITEMS.map((it) => `${it.id.replace('strategy_q', 'Strategy_Q')}_Score`),
]);

export { STRATEGY_SCORE_COLUMNS };

/**
 * One row per participant with the strategy composites (each NA unless every
 * constituent item is answered) and the 1-5 score of each item.
 */
export function extractStrategyScoreRow(participantId, rows) {
  const s = scoreStrategy(rows);
  const out = {
    Participant_ID: participantId,
    Items_Answered: s.answered,
    Items_Total: s.total,
    Complete: s.complete ? 1 : 0,
    Structural_Chunking_Composite: numOrNA(s.structural_chunking_composite),
    Imagery_Maintenance_ID_Composite: numOrNA(s.imagery_maintenance_id),
    Imagery_Maintenance_IT_Composite: numOrNA(s.imagery_maintenance_it),
  };
  for (const it of STRATEGY_ITEMS) {
    out[`${it.id.replace('strategy_q', 'Strategy_Q')}_Score`] = numOrNA(s.itemScores[it.id]);
  }
  return out;
}

const ATTENTION_COLUMNS = Object.freeze(['Participant_ID', 'Check_Id', 'Raw_Input', 'Passed']);

export { ATTENTION_COLUMNS };

/**
 * One row per (participant × instruction-attention check). Mirrors the
 * runtime contract from §11.4 (frozen-text checks; strict-`>` threshold).
 */
export function extractAttentionRows(participantId, rows) {
  return rows
    .filter((r) => r.phase === 'attention_check')
    .map((r) => ({
      Participant_ID: participantId,
      Check_Id: r.attention_check_id ?? NA,
      Raw_Input: r.attention_check_raw ?? NA,
      Passed: r.attention_check_passed === true ? 1 : r.attention_check_passed === false ? 0 : NA,
    }));
}

const DEMOGRAPHICS_COLUMNS = Object.freeze([
  'Participant_ID',
  'Build_ID',
  'Schema_Version',
  'Pilot_Run',
  'Pilot_Label',
  'Handedness',
  'Education',
  'English_Fluency',
  'Glasses_Contacts',
  'Glasses_Contacts_Note',
]);

export { DEMOGRAPHICS_COLUMNS };

/**
 * One row per participant from the demographics survey-html-form node.
 *
 * surveyHtmlForm stores all submitted form fields as `data.response` (a flat
 * object keyed by `name=` attribute). Field set is fixed by
 * `src/calibration/demographics.js` — handedness, education, English
 * fluency and glasses/contacts, plus an optional glasses/contacts note. Age,
 * sex, and primary language are obtained from Prolific's demographic export.
 * Returns NA for any participant with no demographics row (e.g. a session
 * that aborted before consent → demographics).
 */
export function extractDemographicsRow(participantId, sessionMeta, rows) {
  const r = rows.find((row) => row.phase === 'demographics');
  const resp = r?.response ?? {};
  return {
    Participant_ID: participantId,
    Build_ID: sessionMeta.build_id ?? NA,
    Schema_Version: sessionMeta.schema_version ?? NA,
    Pilot_Run: sessionMeta.is_pilot_run === true ? 1 : 0,
    Pilot_Label: sessionMeta.pilot_label ?? NA,
    Handedness: resp.handedness ?? NA,
    Education: resp.education ?? NA,
    English_Fluency: resp.english_fluency ?? NA,
    Glasses_Contacts: resp.glasses_contacts ?? NA,
    Glasses_Contacts_Note: resp.glasses_contacts_note ?? NA,
  };
}

/* ---------- Manifest ---------- */

/**
 * Build the manifest JSON describing this export run. Includes per-source-
 * file SHA-256 hashes so a downstream consumer can verify the dump set is
 * unmodified, plus build_id / schema_version heterogeneity flags so the
 * analyst notices if a batch is mixed.
 */
export function buildExportManifest({
  inputPaths,
  perParticipant,
  fileList,
  generatedAtIso,
  generatorVersion,
  fileSha256ByPath = {},
  loadReport = null,
}) {
  const buildIds = [...new Set(perParticipant.map((p) => p.session.build_id).filter(Boolean))];
  const schemaVersions = [
    ...new Set(perParticipant.map((p) => p.session.schema_version).filter(Boolean)),
  ];
  const pilotFlags = [...new Set(perParticipant.map((p) => Boolean(p.session.is_pilot_run)))];
  return {
    generated_at_iso: generatedAtIso,
    generator: {
      name: 'csv-export.js',
      version: generatorVersion,
    },
    n_participants: perParticipant.length,
    participant_ids: perParticipant.map((p) => p.participant_id),
    build_ids: buildIds,
    schema_versions: schemaVersions,
    is_pilot_run_flags: pilotFlags,
    heterogeneity_flags: {
      build_id_heterogeneous: buildIds.length > 1,
      schema_version_heterogeneous: schemaVersions.length > 1,
      pilot_flag_heterogeneous: pilotFlags.length > 1,
    },
    rows_read: loadReport?.rows_read ?? null,
    duplicate_rows_dropped: loadReport?.duplicates_dropped ?? null,
    runs: perParticipant.map((p) => ({
      participant_id: p.participant_id,
      prolific_pid: p.source_pid ?? p.participant_id,
      run_id: p.run_id ?? null,
      n_rows: p.rows.length,
    })),
    reloaded_participants: reloadedParticipants(perParticipant),
    source_files: inputPaths.map((p) => ({
      path: p,
      sha256: fileSha256ByPath[p] ?? null,
    })),
    output_files: fileList,
  };
}

/** Participants whose rows come from more than one run, with the run ids and row counts. */
function reloadedParticipants(perParticipant) {
  const byPid = new Map();
  for (const p of perParticipant) {
    const pid = p.source_pid ?? p.participant_id;
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push({ run_id: p.run_id ?? null, n_rows: p.rows.length });
  }
  return [...byPid.entries()]
    .filter(([, runs]) => runs.length > 1)
    .map(([prolific_pid, runs]) => ({ prolific_pid, runs }));
}

/* ---------- Dump loading & flattening ---------- */

/**
 * Load + flatten a list of dump JSON paths into a per-participant rows map
 * and a per-participant session-meta map. Handles both download-fallback and
 * bucket-envelope shapes (matching pilot-summary.js).
 *
 * Bucket, checkpoint and tail files of one session overlap, so the rows of
 * all files of a participant are pooled and duplicates are dropped on
 * (run_id, seq). The remaining rows are ordered by seq within each run. A
 * participant whose rows come from more than one run (a reload in the same
 * browser) is split into one entry per run, named `<pid>__run_<run_id>`.
 */
export function loadAndFlattenDumps(paths, opts = {}) {
  const fs = opts.fs ?? { readFileSync };
  const perParticipant = [];
  const errors = [];
  const byPid = new Map();
  const fileSha256ByPath = {};
  for (const p of paths) {
    let parsed;
    try {
      const contents = fs.readFileSync(p, 'utf-8');
      fileSha256ByPath[p] = sha256(contents);
      parsed = JSON.parse(contents);
    } catch (err) {
      errors.push({ path: p, error: err.message });
      continue;
    }
    const session = parsed.session ?? extractSessionFromEnvelope(parsed);
    const pid = session?.params?.prolific_pid ?? parsed.prolific_pid ?? `unknown_${basename(p)}`;
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    if (!byPid.has(pid))
      byPid.set(pid, { participant_id: pid, session, rows: [], source_paths: [] });
    const slot = byPid.get(pid);
    slot.rows.push(...rows);
    slot.source_paths.push(p);
    slot.session = mergeSessionMeta(slot.session, session);
  }
  const report = { rows_read: 0, duplicates_dropped: 0 };
  for (const slot of byPid.values()) {
    const { rows, duplicates } = dedupeRows(slot.rows);
    report.rows_read += slot.rows.length;
    report.duplicates_dropped += duplicates;
    const runs = splitByRun(rows);
    for (const [runId, runRows] of runs) {
      perParticipant.push({
        participant_id:
          runs.size > 1 ? `${slot.participant_id}__run_${runId}` : slot.participant_id,
        source_pid: slot.participant_id,
        run_id: runId,
        session: slot.session,
        rows: runRows,
        source_paths: slot.source_paths,
      });
    }
  }
  return { perParticipant, errors, fileSha256ByPath, report };
}

const NO_RUN = 'none';

/** Drop rows repeated across files; rows without a seq cannot be matched and are kept. */
function dedupeRows(rows) {
  const seen = new Set();
  const kept = [];
  for (const r of rows) {
    if (Number.isFinite(r?.seq)) {
      const key = `${r.run_id ?? NO_RUN}:${r.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(r);
  }
  return { rows: kept, duplicates: rows.length - kept.length };
}

/** Rows by run, runs in order of first appearance, rows in seq order when every row has one. */
function splitByRun(rows) {
  const runs = new Map([[NO_RUN, []]]);
  for (const r of rows) {
    const id = r?.run_id ?? NO_RUN;
    if (!runs.has(id)) runs.set(id, []);
    runs.get(id).push(r);
  }
  if (runs.get(NO_RUN).length === 0 && runs.size > 1) runs.delete(NO_RUN);
  for (const list of runs.values()) {
    if (list.every((r) => Number.isFinite(r.seq))) list.sort((a, b) => a.seq - b.seq);
  }
  return runs;
}

function mergeSessionMeta(a, b) {
  if (!a) return b;
  if (!b) return a;
  const merged = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (merged[k] === undefined || merged[k] === null) merged[k] = v;
  }
  if (a.params || b.params) {
    merged.params = { ...(b.params ?? {}), ...(a.params ?? {}) };
  }
  return merged;
}

function extractSessionFromEnvelope(env) {
  if (!env || env.session) return env?.session ?? null;
  return {
    params: {
      session_id: env.session_id,
      prolific_pid: env.prolific_pid,
      study_id: env.study_id,
      is_preview: env.is_preview,
    },
    build_id: env.build_id,
    schema_version: env.schema_version,
    prng_seed_uint32: env.prng_seed_uint32,
    is_pilot_run: env.is_pilot_run,
    pilot_label: env.pilot_label,
    started_at_iso: env.started_at_iso,
    user_agent: env.user_agent,
  };
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

/* ---------- Export driver ---------- */

const TRIAL_TYPE_BUILDERS = Object.freeze({
  d_only: { build: buildWideRowDOnly, columns: COLUMNS_D_ONLY, label: 'D_ONLY' },
  t_only: { build: buildWideRowTOnly, columns: COLUMNS_T_ONLY, label: 'T_ONLY' },
  i_only: { build: buildWideRowIOnly, columns: COLUMNS_I_ONLY, label: 'I_ONLY' },
  i_d: { build: buildWideRowID, columns: COLUMNS_I_D, label: 'I_D' },
  i_t: { build: buildWideRowIT, columns: COLUMNS_I_T, label: 'I_T' },
});

/**
 * Compose the full file list from per-participant rows. Returns a map of
 * `{ relativePath: csvText }` for the trial / aux CSVs, plus the manifest
 * object (the caller decides whether to write it as JSON or print to stdout).
 *
 * `criteria` is an array of integers to emit (default: [1, 2]).
 */
export function composeExport(perParticipant, opts = {}) {
  const criteria = opts.criteria ?? [1, 2];
  const generatedAtIso = opts.generatedAtIso ?? new Date().toISOString();
  const generatorVersion = opts.generatorVersion ?? GENERATOR_VERSION;

  /* Build per-participant rows-by-pid map for groupTrialRows. */
  const rowsByParticipant = new Map();
  for (const p of perParticipant) rowsByParticipant.set(p.participant_id, p.rows);
  const groups = groupTrialRows(rowsByParticipant);

  const sessionMetaByPid = new Map();
  for (const p of perParticipant) sessionMetaByPid.set(p.participant_id, p.session ?? {});

  const files = {};
  const fileList = [];

  /* Sort the trial groups for deterministic output: by participant, then
   * trial-type, then block, then trial index. */
  const sortedGroups = [...groups.values()].sort((a, b) => {
    return (
      a.participant_id.localeCompare(b.participant_id) ||
      a.trial_type.localeCompare(b.trial_type) ||
      a.block_label.localeCompare(b.block_label) ||
      a.trial_index_in_block - b.trial_index_in_block ||
      (a.attempt ?? 1) - (b.attempt ?? 1)
    );
  });

  for (const trialType of Object.keys(TRIAL_TYPE_BUILDERS)) {
    const { build, columns, label } = TRIAL_TYPE_BUILDERS[trialType];
    const typeGroups = sortedGroups.filter((g) => g.trial_type === trialType);
    for (const criterion of criteria) {
      const rows = typeGroups.map((g) => {
        const meta = sessionMetaByPid.get(g.participant_id) ?? {};
        return build(g, criterion, meta);
      });
      const path = `${label}_Criterion${criterion}.csv`;
      files[path] = serializeRowsToCsv(rows, columns);
      fileList.push({ path, n_rows: rows.length, columns: columns.length });
    }
  }

  /* Long-form events file — one row per stimulus event across all trials,
   * complementing the wide trial-type CSVs. Useful for analyses that walk
   * encoding events in stimulus-onset order or join recognition probes back
   * to the events that preceded them. */
  const eventsRows = sortedGroups.flatMap((g) =>
    composeEventsRows(g, sessionMetaByPid.get(g.participant_id) ?? {})
  );
  files['EVENTS.csv'] = serializeRowsToCsv(eventsRows, EVENTS_COLUMNS);
  fileList.push({ path: 'EVENTS.csv', n_rows: eventsRows.length, columns: EVENTS_COLUMNS.length });

  /* Tidy tables: trials.csv, stars.csv, probes.csv (see tidy-tables.js). */
  const tidy = composeTidyTables(perParticipant);
  for (const [name, columns] of [
    ['trials', TRIALS_COLUMNS],
    ['stars', STARS_COLUMNS],
    ['probes', PROBES_COLUMNS],
  ]) {
    files[`${name}.csv`] = serializeRowsToCsv(tidy[name], columns);
    fileList.push({ path: `${name}.csv`, n_rows: tidy[name].length, columns: columns.length });
  }

  /* Auxiliary files. */
  const calibRows = perParticipant.map((p) =>
    extractCalibrationRow(p.participant_id, p.session ?? {}, p.rows)
  );
  files['CALIBRATION_SUMMARY.csv'] = serializeRowsToCsv(calibRows, CALIBRATION_COLUMNS);
  fileList.push({
    path: 'CALIBRATION_SUMMARY.csv',
    n_rows: calibRows.length,
    columns: CALIBRATION_COLUMNS.length,
  });

  const strategyRows = perParticipant.flatMap((p) => extractStrategyRows(p.participant_id, p.rows));
  files['STRATEGY.csv'] = serializeRowsToCsv(strategyRows, STRATEGY_COLUMNS);
  fileList.push({
    path: 'STRATEGY.csv',
    n_rows: strategyRows.length,
    columns: STRATEGY_COLUMNS.length,
  });

  const strategyScoreRows = perParticipant.map((p) =>
    extractStrategyScoreRow(p.participant_id, p.rows)
  );
  files['STRATEGY_SCORES.csv'] = serializeRowsToCsv(strategyScoreRows, STRATEGY_SCORE_COLUMNS);
  fileList.push({
    path: 'STRATEGY_SCORES.csv',
    n_rows: strategyScoreRows.length,
    columns: STRATEGY_SCORE_COLUMNS.length,
  });

  const musicRows = perParticipant.map((p) => extractMusicRow(p.participant_id, p.rows));
  files['MUSIC.csv'] = serializeRowsToCsv(musicRows, MUSIC_COLUMNS);
  fileList.push({ path: 'MUSIC.csv', n_rows: musicRows.length, columns: MUSIC_COLUMNS.length });

  const attRows = perParticipant.flatMap((p) => extractAttentionRows(p.participant_id, p.rows));
  files['ATTENTION_CHECKS.csv'] = serializeRowsToCsv(attRows, ATTENTION_COLUMNS);
  fileList.push({
    path: 'ATTENTION_CHECKS.csv',
    n_rows: attRows.length,
    columns: ATTENTION_COLUMNS.length,
  });

  const demoRows = perParticipant.map((p) =>
    extractDemographicsRow(p.participant_id, p.session ?? {}, p.rows)
  );
  files['DEMOGRAPHICS.csv'] = serializeRowsToCsv(demoRows, DEMOGRAPHICS_COLUMNS);
  fileList.push({
    path: 'DEMOGRAPHICS.csv',
    n_rows: demoRows.length,
    columns: DEMOGRAPHICS_COLUMNS.length,
  });

  const manifest = buildExportManifest({
    inputPaths: opts.inputPaths ?? [],
    perParticipant,
    fileList,
    generatedAtIso,
    generatorVersion,
    fileSha256ByPath: opts.fileSha256ByPath ?? {},
    loadReport: opts.loadReport ?? null,
  });

  manifest.tidy_tables = {
    version: TIDY_VERSION,
    duplicate_keys: Object.fromEntries(
      Object.keys(TIDY_KEYS).map((name) => [name, duplicateKeys(tidy[name], TIDY_KEYS[name])])
    ),
    issues: tidy.issues,
  };

  return { files, manifest, fileList };
}

/**
 * Problems that make the tables unreliable: a main trial that occurs twice
 * for one participant, or a repeated key in a tidy table.
 */
export function dataProblems(manifest) {
  const out = [];
  const dup = manifest.tidy_tables.issues.filter((i) => i.issue === 'duplicate_main_trial_uid');
  if (dup.length > 0) {
    const who = [...new Set(dup.map((i) => i.participant_id))].join(', ');
    out.push(`duplicate_main_trial_uid for ${dup.length} trial(s): ${who}`);
  }
  for (const [name, keys] of Object.entries(manifest.tidy_tables.duplicate_keys)) {
    if (keys.length > 0) out.push(`${keys.length} duplicate key(s) in ${name}.csv`);
  }
  return out;
}

/* ---------- CLI ---------- */

async function main(argv) {
  const opts = parseExportArgs(argv);
  if (!opts.outputDir) {
    console.error('csv-export: missing --out <dir>');
    console.error(
      'usage: node scripts/csv-export.js --out <dir> [--json-manifest] <file-or-dir>...'
    );
    process.exit(2);
  }
  if (opts.inputs.length === 0) {
    console.error('csv-export: no input paths supplied');
    process.exit(2);
  }
  const expanded = expandInputPaths(opts.inputs);
  if (expanded.length === 0) {
    console.error('csv-export: no .json files found under supplied paths');
    process.exit(2);
  }
  const { perParticipant, errors, fileSha256ByPath, report } = loadAndFlattenDumps(expanded);
  if (errors.length > 0) {
    for (const e of errors) console.error(`csv-export: failed to read ${e.path}: ${e.error}`);
  }
  if (perParticipant.length === 0) {
    console.error('csv-export: no participants parsed from inputs');
    process.exit(2);
  }
  const { files, manifest } = composeExport(perParticipant, {
    inputPaths: expanded,
    fileSha256ByPath,
    loadReport: report,
  });
  const outDir = resolve(opts.outputDir);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    writeFileSync(join(outDir, rel), contents, 'utf-8');
  }
  writeFileSync(join(outDir, 'EXPORT_MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  if (opts.jsonManifest) console.log(JSON.stringify(manifest, null, 2));
  console.log(
    `csv-export: wrote ${Object.keys(files).length + 1} files to ${outDir} for ${perParticipant.length} participant(s)`
  );
  const problems = dataProblems(manifest);
  if (problems.length > 0) {
    for (const msg of problems) console.error(`csv-export: ${msg}`);
    process.exit(3);
  }
  process.exit(0);
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  main(process.argv).catch((err) => {
    console.error('csv-export: unexpected error', err);
    process.exit(1);
  });
}
