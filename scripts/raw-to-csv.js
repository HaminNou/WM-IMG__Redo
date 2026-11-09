#!/usr/bin/env node
/**
 * Raw data to ONE CSV.
 *
 * Reads the JSON files that the study uploads to Google Drive (end-of-session buckets,
 * checkpoints, tail and partial files, in any folder layout, including one subfolder per
 * participant) and writes a single long-format CSV: ONE LINE PER RAW ROW of the study, for
 * every participant, every run and every task, with every raw column.
 *
 * What "raw" means here. Nothing is aggregated, recoded, rescaled or dropped:
 *   - every row the study recorded appears exactly once (rows that are present in several files,
 *     for example in a checkpoint and in a bucket, are de-duplicated on (run, seq) by the same
 *     loader the other exporters use; the number removed is reported);
 *   - every raw column appears with its recorded value; a value that is a list or an object
 *     (trial specification, key log, slot arrays, ...) is written as compact JSON in its cell;
 *   - a value that was not recorded for a row is `NA`; booleans are `TRUE` / `FALSE`.
 * Rows of different kinds (calibration, instructions, practice, the five tasks, rests,
 * questionnaires, upload and redirect rows) have different columns; the file has the UNION of
 * all of them, so a column is `NA` on the rows that never carried it.
 *
 * Column layout (stable and documented in the manifest):
 *   0. subject    the subject number (1, 2, 3, ...) of the participant: the first column of every
 *                 line. Numbers come from a private registry file (see --subject-file): a
 *                 Prolific id gets the next number the first time it is seen and keeps it
 *                 forever, so adding participants later never renumbers anyone. Sessions
 *                 without a Prolific id (previews) have no subject number (NA).
 *   1. identity   participant_id, prolific_pid, study_id, session_id, is_preview, is_pilot_run,
 *                 pilot_label, build_id, schema_version. Filled on EVERY row from the file
 *                 envelope; where a raw row carries its own value (the `session_info` row does)
 *                 that value is kept and a disagreement is counted in the manifest.
 *   2. derived    row_key (participant|run|seq, unique), run_status, is_analysed_run, task,
 *                 session_stage, wall_time_utc, n_source_files, source_buckets. Added by this script.
 *   3. core raw   seq, run_id, wall_ms, phase, trial_uid, condition, block_label, is_practice,
 *                 presentation_index, block_position, pool_index, ... (the columns most
 *                 analyses start from).
 *   4. all other raw columns, alphabetically.
 * A raw column whose name equals a derived column is kept as `raw_<name>` (reported; none exist
 * in the current schema, and a test pins that).
 *
 * Derived columns:
 *   run_status      completed | screened_out | incomplete, per run, by the rules of
 *                   participant-rules.js (a run is completed if it has a completion row and no
 *                   screen-out exit; screened_out if an exit row carries `exit_reason`).
 *   is_analysed_run TRUE for the run the other exporters analyse (the completed run with the
 *                   most rows); FALSE for every other run, and for every run of a participant who
 *                   never completed. Abandoned attempts are therefore kept but marked; use
 *                   --analysed-runs-only to drop them.
 *   task            d_only | t_only | i_only | i_d | i_t for the rows that belong to one of the
 *                   five tasks (from `condition`, else from the phase name); NA otherwise.
 *   session_stage   setup | instructions | practice | main | questionnaire | end | session_event
 *                   (see `stageOf`; the manifest lists which phases fell into which stage).
 *   wall_time_utc   `wall_ms` as an ISO 8601 UTC time.
 *   n_source_files  in how many input files the row was found (redundancy of the uploads).
 *   source_buckets  which kinds of file held it, e.g. `checkpoint+d_only` (bucket ids only; no
 *                   file names, so nothing identifying leaks).
 *
 * Privacy. By default Prolific ids and session ids are replaced by codes with the SAME salted
 * coding as csv-export.js, a private key file is written outside the output folder, and the
 * output is scanned for any raw identifier before anything is written. `--keep-pid` writes raw
 * ids (internal payment reconciliation only; never share the file).
 *
 * Integrity. Before writing, the script parses its own CSV text back with an independent
 * RFC 4180 reader and compares EVERY cell with the source value; any difference aborts the run.
 * The manifest (`<out>.manifest.json`) records input file hashes, counts, per-run sequence
 * ranges and gaps, the column dictionary, and the output hash.
 *
 * Usage:
 *   node scripts/raw-to-csv.js --out <file.csv> [options] <file-or-folder>...
 * Options:
 *   --analysed-runs-only        keep only the analysed run of each participant
 *   --keep-pid                  raw Prolific ids instead of codes (internal use)
 *   --share                     the file will be shared: refuses --keep-pid
 *   --subject-file <path>       the subject-number registry (default: $WM_IMG_SUBJECT_FILE, then
 *                               ~/.wm-img-subjects.csv). It lists raw Prolific ids: keep it private.
 *   --salt-file <path>          salt for the codes (default: $CSV_EXPORT_SALT, then
 *                               ~/.wm-img-pseudonym-salt)
 *   --private-dir <dir>         where PID_KEY.csv goes (never next to the output; default
 *                               <out folder>_PRIVATE)
 *   --excel-bom                 prepend a UTF-8 byte-order mark so Excel reads the file as UTF-8
 *   --no-neutralise-formulas    do not prefix text cells that start with = + - @ with an
 *                               apostrophe (default: they are protected)
 * Exit codes: 0 ok; 2 usage; 3 unreadable input or failed verification; 4 identifier leak.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAndFlattenDumps } from './dump-loader.js';
import { expandInputPaths, formatCsvValue, trialTypeFromPhase, UTF8_BOM } from './csv-export.js';
import { evaluateRun, summariseParticipantRuns } from './participant-rules.js';
import {
  defaultPrivateDir,
  findLeaks,
  isInside,
  makeCoder,
  pseudonymisePerParticipant,
  resolveSalt,
  writeKeyFile,
} from './pseudonymise.js';

export const RAW_CSV_VERSION = '1.0.0';

const NA = 'NA';

/** The subject number comes first in every line. */
export const LEAD_COLUMNS = Object.freeze(['subject']);

/** Identity columns: filled on every row from the file envelope (see the header). */
export const IDENTITY_COLUMNS = Object.freeze([
  'participant_id',
  'prolific_pid',
  'study_id',
  'session_id',
  'is_preview',
  'is_pilot_run',
  'pilot_label',
  'build_id',
  'schema_version',
]);

/** Columns this script adds to every row. */
export const DERIVED_COLUMNS = Object.freeze([
  'row_key',
  'run_status',
  'is_analysed_run',
  'task',
  'session_stage',
  'wall_time_utc',
  'n_source_files',
  'source_buckets',
]);

/** Raw columns that come first after the derived ones (the others follow alphabetically). */
export const CORE_RAW_COLUMNS = Object.freeze([
  'seq',
  'run_id',
  'wall_ms',
  'phase',
  'trial_uid',
  'condition',
  'block_label',
  'is_practice',
  'presentation_index',
  'block_position',
  'pool_index',
  'trial_index_in_block',
  'practice_iteration',
  'background_shade',
  'rotation_deg',
  'display_rotation_deg',
  'pattern_reminder',
]);

/** Private keys this script puts on rows between loading and table building; never output. */
const SOURCE_KEY = '__raw_to_csv_source';

/* ---------- Derivations ---------- */

export const STAGES = Object.freeze([
  'setup',
  'instructions',
  'practice',
  'main',
  'questionnaire',
  'end',
  'session_event',
]);

/** Phases that can occur at any moment of a session, not at one step of it. */
const SESSION_EVENT_PHASES = new Set([
  'display_guard_event',
  'display_guard_stop',
  'visibility_event',
  'visibility_recorder_start',
  'audio_state_change',
  'unload_attempt',
  'back_pressed',
  'runtime_error',
  'runtime_diagnostic',
]);

const END_PHASES = new Set(['end_of_task_intro', 'upload_session_end', 'completion_redirect']);

/**
 * The step of the session a row belongs to.
 *
 * Order of the rules: (1) a screen-out exit row; (2) events that can happen anywhere; (3) the end
 * of the session; (4) questionnaires; (5) instruction slides, demonstrations and attention
 * checks; (6) practice (by `is_practice`, `block_label` or the practice phases); (7) main-task
 * rows (by `block_label`, and the rests and block introductions); (8) everything else is setup
 * (consent, demographics, calibration, sound and timing checks, fullscreen).
 *
 * @param {object} row  a raw row
 * @returns {'setup'|'instructions'|'practice'|'main'|'questionnaire'|'end'|'session_event'}
 */
export function stageOf(row) {
  const phase = String(row?.phase ?? '');
  if (row?.exit_reason !== undefined && row?.exit_reason !== null) return 'end';
  if (SESSION_EVENT_PHASES.has(phase)) return 'session_event';
  if (END_PHASES.has(phase)) return 'end';
  if (/^(strategy_|music_experience|questionnaire_intro)/.test(phase)) return 'questionnaire';
  if (/^(instructions_|demo_|attention_check)/.test(phase) || phase === 'practice_readiness') {
    return 'instructions';
  }
  if (row?.is_practice === true || row?.block_label === 'practice' || /^practice_/.test(phase)) {
    return 'practice';
  }
  if (
    row?.block_label === 'main_a' ||
    row?.block_label === 'main_b' ||
    /^main_[ab]_intro$/.test(phase) ||
    phase === 'rest' ||
    phase === 'rest_resume_gate'
  ) {
    return 'main';
  }
  return 'setup';
}

/**
 * The task a row belongs to: one of d_only, t_only, i_only, i_d, i_t, or null for rows that
 * belong to none of them (calibration, instructions, questionnaires, rests, ...).
 *
 * @param {object} row
 * @returns {string|null}
 */
export function taskOf(row) {
  const c = row?.condition;
  if (typeof c === 'string' && /^(d_only|t_only|i_only|i_d|i_t)$/.test(c)) return c;
  return trialTypeFromPhase(row?.phase);
}

/**
 * Run status by the study's own rules (participant-rules.js `evaluateRun`).
 *
 * @param {object[]} rows  the rows of one run
 * @returns {'completed'|'screened_out'|'incomplete'}
 */
export function runStatusOf(rows) {
  const ev = evaluateRun(rows);
  if (ev.completed) return 'completed';
  if (ev.screened_out) return 'screened_out';
  return 'incomplete';
}

/* ---------- Where did each row come from? ---------- */

/** The participant key the loader uses for a parsed file (dump-loader.js, same rule). */
function loaderPid(parsed, path) {
  const params = parsed?.session?.params ?? {
    session_id: parsed?.session_id,
    prolific_pid: parsed?.prolific_pid,
  };
  const sessionId = params.session_id ?? parsed?.session_id ?? null;
  return (
    params.prolific_pid ??
    parsed?.prolific_pid ??
    (sessionId ? `nopid_${sessionId}` : `unknown_${String(path).split(/[\\/]/).pop()}`)
  );
}

/**
 * Re-read the input files and note, for every pooled row, in how many files it was found and
 * which kinds of file held it (`bucket_id` of the envelope: a data bucket, `checkpoint`, `tail`,
 * `partial`, or `download` for a download-fallback export). The result is stored on the rows
 * under a private key that `buildRawTable` consumes. Rows without a `seq` cannot be matched
 * across files and get no source information.
 *
 * @param {{source_pid: string, run_id: string|null, rows: object[]}[]} perParticipant
 * @param {string[]} paths  the files that were loaded
 * @param {{readFile?: Function}} [opts]
 * @returns {{rowsWithoutSource: number}}
 */
export function annotateSources(perParticipant, paths, { readFile = readFileSync } = {}) {
  const found = new Map(); /* "pid\0run\0seq" -> {files:Set, buckets:Set} */
  for (const p of paths) {
    let parsed;
    try {
      parsed = JSON.parse(readFile(p, 'utf-8'));
    } catch {
      continue; /* the loader already reported it */
    }
    const pid = loaderPid(parsed, p);
    const bucket =
      parsed.bucket_id ?? (parsed.session && !parsed.bucket_id ? 'download' : 'unknown');
    for (const r of Array.isArray(parsed.rows) ? parsed.rows : []) {
      if (!Number.isFinite(r?.seq)) continue;
      const key = `${pid}\u0000${r.run_id ?? 'none'}\u0000${r.seq}`;
      if (!found.has(key)) found.set(key, { files: new Set(), buckets: new Set() });
      const slot = found.get(key);
      slot.files.add(p);
      slot.buckets.add(String(bucket));
    }
  }
  let rowsWithoutSource = 0;
  for (const entry of perParticipant) {
    for (const row of entry.rows) {
      if (!Number.isFinite(row?.seq)) continue;
      const slot = found.get(`${entry.source_pid}\u0000${row.run_id ?? 'none'}\u0000${row.seq}`);
      if (!slot) {
        rowsWithoutSource += 1;
        continue;
      }
      row[SOURCE_KEY] = { n: slot.files.size, buckets: [...slot.buckets].sort() };
    }
  }
  return { rowsWithoutSource };
}

/* ---------- Subject numbers ---------- */

export const DEFAULT_SUBJECT_FILE = join(homedir(), '.wm-img-subjects.csv');
export const SUBJECT_FILE_ENV = 'WM_IMG_SUBJECT_FILE';
const SUBJECT_HEADER = 'Subject,PROLIFIC_PID,First_Seen_UTC';

/** Read the registry: Prolific id -> subject number. A missing file is an empty registry. */
export function readSubjectRegistry(path) {
  const map = new Map();
  if (!existsSync(path)) return map;
  const lines = readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  if (lines.length === 0) return map;
  if (lines[0].trim() !== SUBJECT_HEADER) {
    throw new Error(`subject registry ${path} does not start with "${SUBJECT_HEADER}"`);
  }
  const numbers = new Set();
  for (const line of lines.slice(1)) {
    const [n, pid] = line.split(',');
    const subject = Number(n);
    if (!Number.isInteger(subject) || subject < 1 || !pid || numbers.has(subject) || map.has(pid)) {
      throw new Error(`subject registry ${path} has an invalid or duplicated line: ${line}`);
    }
    numbers.add(subject);
    map.set(pid, subject);
  }
  return map;
}

/**
 * Give every participant with a Prolific id a subject number and store it on its entries
 * (`entry.subject`). Participants already in the registry keep their number; new ones get the next
 * numbers in the order of their first recorded row (ties by id), and are appended to the
 * registry file. Sessions without a Prolific id (previews) get none. Call it BEFORE the ids are
 * replaced by codes: the registry is keyed by the real id and stays private.
 *
 * @param {object[]} perParticipant  output of loadAndFlattenDumps
 * @param {string} registryPath
 * @param {{write?: boolean}} [opts]  write=false: compute only, never touch the file
 * @returns {{assigned: Map<string, number>, added: {subject: number, pid: string}[]}}
 */
export function assignSubjects(perParticipant, registryPath, { write = true } = {}) {
  const registry = readSubjectRegistry(registryPath);
  const firstSeen = new Map();
  for (const e of perParticipant) {
    const pid = e.session?.params?.prolific_pid;
    if (!pid) continue;
    const t = Math.min(
      ...e.rows.map((r) => r?.wall_ms).filter(Number.isFinite),
      Number.POSITIVE_INFINITY
    );
    firstSeen.set(pid, Math.min(firstSeen.get(pid) ?? Number.POSITIVE_INFINITY, t));
  }
  const fresh = [...firstSeen.keys()]
    .filter((pid) => !registry.has(pid))
    .sort((a, b) => firstSeen.get(a) - firstSeen.get(b) || a.localeCompare(b));
  let next = Math.max(0, ...registry.values()) + 1;
  const added = [];
  for (const pid of fresh) {
    registry.set(pid, next);
    added.push({ subject: next, pid, first_seen: firstSeen.get(pid) });
    next += 1;
  }
  if (write && added.length > 0) {
    const lines = [...registry.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([pid, n]) => {
        const seen = added.find((x) => x.pid === pid)?.first_seen;
        const stamp = Number.isFinite(seen) ? new Date(seen).toISOString() : '';
        return `${n},${pid},${stamp}`;
      });
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, `${[SUBJECT_HEADER, ...lines].join('\n')}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    chmodSync(registryPath, 0o600);
  }
  for (const e of perParticipant) {
    const pid = e.session?.params?.prolific_pid;
    e.subject = pid ? registry.get(pid) : null;
  }
  return { assigned: registry, added };
}

/* ---------- Table ---------- */

const RESERVED = new Set([...LEAD_COLUMNS, ...DERIVED_COLUMNS]);
const isMissing = (v) =>
  v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));
const rawRunKey = (id) => id ?? 'none';

/** Ranges of seq numbers missing between the smallest and the largest seq of a run. */
export function seqGaps(rows) {
  const seqs = [...new Set(rows.map((r) => r?.seq).filter(Number.isFinite))].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < seqs.length; i++) {
    if (seqs[i] - seqs[i - 1] > 1) gaps.push([seqs[i - 1] + 1, seqs[i] - 1]);
  }
  return gaps;
}

/**
 * Turn the loaded participants into one flat table.
 *
 * @param {object[]} perParticipant  output of loadAndFlattenDumps (optionally pseudonymised and
 *        annotated by `annotateSources`); one entry per participant and run
 * @param {{analysedRunsOnly?: boolean}} [opts]
 * @returns {{rows: object[], columns: string[], summary: object}}
 */
export function buildRawTable(perParticipant, { analysedRunsOnly = false } = {}) {
  const bySource = new Map();
  for (const e of perParticipant) {
    const k = e.source_pid ?? e.participant_id;
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(e);
  }
  const analysedOf = new Map();
  for (const [k, entries] of bySource) {
    const s = summariseParticipantRuns(
      entries.map((e) => ({ run_id: e.run_id, rows: e.rows, session: e.session }))
    );
    analysedOf.set(k, s.analysed_run_id);
  }
  const firstWall = (e) =>
    Math.min(...e.rows.map((r) => r?.wall_ms).filter(Number.isFinite), Number.POSITIVE_INFINITY);
  const entries = [...perParticipant].sort(
    (a, b) =>
      String(a.source_pid ?? a.participant_id).localeCompare(
        String(b.source_pid ?? b.participant_id)
      ) ||
      firstWall(a) - firstWall(b) ||
      String(a.run_id).localeCompare(String(b.run_id))
  );

  const out = [];
  const rawNames = new Set();
  const renamed = new Set();
  const perRun = [];
  const stageCount = {};
  const taskCount = {};
  const phasesByStage = {};
  let identityConflicts = 0;
  let rowsWithoutSource = 0;
  for (const entry of entries) {
    const pid = entry.source_pid ?? entry.participant_id;
    const analysedId = analysedOf.get(pid);
    const isAnalysed =
      analysedId !== null && analysedId !== undefined && analysedId === entry.run_id;
    if (analysedRunsOnly && !isAnalysed) continue;
    const status = runStatusOf(entry.rows);
    const params = entry.session?.params ?? {};
    const identity = {
      participant_id: pid,
      prolific_pid: params.prolific_pid ?? null,
      study_id: params.study_id ?? null,
      session_id: params.session_id ?? null,
      is_preview: params.is_preview ?? null,
      is_pilot_run: entry.session?.is_pilot_run ?? null,
      pilot_label: entry.session?.pilot_label ?? null,
      build_id: entry.session?.build_id ?? null,
      schema_version: entry.session?.schema_version ?? null,
    };
    perRun.push({
      participant_id: pid,
      subject: entry.subject ?? null,
      run_id: entry.run_id ?? null,
      run_status: status,
      is_analysed_run: isAnalysed,
      n_rows: entry.rows.length,
      seq_min: Math.min(...entry.rows.map((r) => r?.seq).filter(Number.isFinite)),
      seq_max: Math.max(...entry.rows.map((r) => r?.seq).filter(Number.isFinite)),
      seq_gaps: seqGaps(entry.rows),
    });
    for (const row of entry.rows) {
      const flat = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === SOURCE_KEY) continue;
        const name = RESERVED.has(k) ? `raw_${k}` : k;
        if (name !== k) renamed.add(k);
        flat[name] = v;
      }
      for (const k of IDENTITY_COLUMNS) {
        const own = flat[k];
        if (isMissing(own)) flat[k] = identity[k];
        else if (!isMissing(identity[k]) && JSON.stringify(own) !== JSON.stringify(identity[k])) {
          identityConflicts += 1;
        }
      }
      const stage = stageOf(row);
      const src = row[SOURCE_KEY];
      if (Number.isFinite(row?.seq) && !src) rowsWithoutSource += 1;
      flat.subject = entry.subject ?? null;
      flat.row_key = `${pid}|${rawRunKey(row.run_id ?? entry.run_id)}|${row.seq ?? 'noseq'}`;
      flat.run_status = status;
      flat.is_analysed_run = isAnalysed;
      flat.task = taskOf(row);
      flat.session_stage = stage;
      flat.wall_time_utc = Number.isFinite(row?.wall_ms)
        ? new Date(row.wall_ms).toISOString()
        : null;
      flat.n_source_files = src ? src.n : null;
      flat.source_buckets = src ? src.buckets.join('+') : null;
      for (const k of Object.keys(flat)) rawNames.add(k);
      stageCount[stage] = (stageCount[stage] ?? 0) + 1;
      if (flat.task) taskCount[flat.task] = (taskCount[flat.task] ?? 0) + 1;
      (phasesByStage[stage] ??= new Set()).add(String(row.phase ?? 'NA'));
      out.push(flat);
    }
  }
  const fixed = new Set([...LEAD_COLUMNS, ...IDENTITY_COLUMNS, ...DERIVED_COLUMNS]);
  const core = CORE_RAW_COLUMNS.filter((c) => rawNames.has(c) && !fixed.has(c));
  const coreSet = new Set(core);
  const rest = [...rawNames].filter((c) => !fixed.has(c) && !coreSet.has(c)).sort();
  const columns = [...LEAD_COLUMNS, ...IDENTITY_COLUMNS, ...DERIVED_COLUMNS, ...core, ...rest];
  return {
    rows: out,
    columns,
    summary: {
      participants: new Set(perRun.map((r) => r.participant_id)).size,
      runs: perRun,
      rows_by_stage: stageCount,
      rows_by_task: taskCount,
      phases_by_stage: Object.fromEntries(
        Object.entries(phasesByStage).map(([s, set]) => [s, [...set].sort()])
      ),
      identity_conflicts: identityConflicts,
      rows_without_source: rowsWithoutSource,
      renamed_raw_columns: [...renamed].sort(),
    },
  };
}

/* ---------- CSV ---------- */

/** The value of a cell: lists and objects become compact JSON, scalars are unchanged. */
export function cellValue(v) {
  return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
}

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * One CSV text: a quoted header, then one line per row. Numbers are bare, booleans are
 * `TRUE`/`FALSE`, missing values are bare `NA`, text is quoted (see `formatCsvValue`). LF line
 * endings.
 */
export function serializeCsv(rows, columns, { neutralise = true } = {}) {
  const lines = [columns.map((c) => `"${c}"`).join(',')];
  for (const r of rows) {
    lines.push(
      columns
        .map((c) => formatCsvValue(cellValue(r[c]), { neutraliseFormulas: neutralise }))
        .join(',')
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Independent RFC 4180 reader (quoted fields, doubled quotes, line breaks inside quotes).
 * Returns the records as arrays of `{text, quoted}` so that bare `NA` and quoted text can be told
 * apart.
 */
export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;
  let started = false;
  const endField = () => {
    record.push({ text: field, quoted });
    field = '';
    quoted = false;
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && !started) {
      inQuotes = true;
      quoted = true;
      started = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endField();
      records.push(record);
      record = [];
    } else {
      field += ch;
      started = true;
    }
  }
  if (inQuotes) throw new Error('parseCsv: unterminated quoted field');
  if (started || record.length > 0) {
    endField();
    records.push(record);
  }
  return records;
}

/** What `serializeCsv` must have written for a value (an independent statement of the rules). */
function expectedCell(v, neutralise) {
  if (isMissing(v)) return { quoted: false, text: NA };
  if (typeof v === 'boolean') return { quoted: false, text: v ? 'TRUE' : 'FALSE' };
  if (typeof v === 'number') return { quoted: false, text: String(v) };
  if (v === NA) return { quoted: false, text: NA };
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return { quoted: true, text: neutralise && FORMULA_TRIGGER.test(s) ? `'${s}` : s };
}

/**
 * Parse the CSV text back and compare EVERY cell with the source value.
 *
 * @returns {string[]} the problems found (empty when the file is a faithful copy of the table)
 */
export function verifyCsv(text, columns, rows, { neutralise = true } = {}) {
  const problems = [];
  let records;
  try {
    records = parseCsv(text);
  } catch (err) {
    return [`unreadable CSV: ${err.message}`];
  }
  const [header, ...body] = records;
  if (
    !header ||
    header.length !== columns.length ||
    header.some((h, i) => !h.quoted || h.text !== columns[i])
  ) {
    problems.push('header does not match the column list');
  }
  if (body.length !== rows.length)
    problems.push(`${body.length} CSV lines for ${rows.length} rows`);
  const keys = new Set();
  for (let i = 0; i < Math.min(body.length, rows.length) && problems.length < 20; i++) {
    if (body[i].length !== columns.length) {
      problems.push(`line ${i + 2}: ${body[i].length} cells, expected ${columns.length}`);
      continue;
    }
    for (let j = 0; j < columns.length; j++) {
      const want = expectedCell(cellValue(rows[i][columns[j]]), neutralise);
      const got = body[i][j];
      if (got.quoted !== want.quoted || got.text !== want.text) {
        problems.push(
          `line ${i + 2}, column ${columns[j]}: written ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`
        );
        break;
      }
    }
    const k = rows[i].row_key;
    if (keys.has(k)) problems.push(`duplicate row_key ${k}`);
    keys.add(k);
  }
  return problems.slice(0, 20);
}

/* ---------- Column dictionary and manifest ---------- */

function columnGroup(name) {
  if (LEAD_COLUMNS.includes(name) || IDENTITY_COLUMNS.includes(name)) return 'identity';
  if (DERIVED_COLUMNS.includes(name)) return 'derived';
  return 'raw';
}

/** For every column: how many rows have a value, which kinds of value it holds, whether JSON. */
export function describeColumns(rows, columns) {
  return columns.map((name) => {
    const types = new Set();
    let n = 0;
    for (const r of rows) {
      const v = r[name];
      if (isMissing(v)) continue;
      n += 1;
      types.add(v !== null && typeof v === 'object' ? 'json' : typeof v);
    }
    return {
      name,
      group: columnGroup(name),
      n_non_missing: n,
      types: [...types].sort(),
      holds_json: types.has('json'),
    };
  });
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Assemble the CSV and its manifest. Throws if the verification pass finds any difference
 * between the CSV text and the table.
 *
 * @param {object[]} perParticipant
 * @param {object} [opts]
 * @param {boolean} [opts.analysedRunsOnly]
 * @param {boolean} [opts.neutralise=true]   protect text cells that start with = + - @
 * @param {boolean} [opts.excelBom]
 * @param {boolean} [opts.pseudonymised]
 * @param {string[]} [opts.inputPaths]
 * @param {Record<string,string>} [opts.fileSha256ByPath]
 * @param {{rows_read?: number, duplicates_dropped?: number}} [opts.loadReport]
 * @returns {{csv: string, manifest: object, table: object}}
 */
export function composeRawCsv(perParticipant, opts = {}) {
  const neutralise = opts.neutralise !== false;
  const table = buildRawTable(perParticipant, { analysedRunsOnly: opts.analysedRunsOnly === true });
  const body = serializeCsv(table.rows, table.columns, { neutralise });
  const problems = verifyCsv(body, table.columns, table.rows, { neutralise });
  if (problems.length > 0) {
    throw new Error(`raw-to-csv: verification failed:\n  ${problems.join('\n  ')}`);
  }
  const csv = opts.excelBom ? UTF8_BOM + body : body;
  const dictionary = describeColumns(table.rows, table.columns);
  const paths = opts.inputPaths ?? [];
  const hashes = opts.fileSha256ByPath ?? {};
  const manifest = {
    generator: { name: 'raw-to-csv.js', version: RAW_CSV_VERSION },
    generated_at_iso: new Date().toISOString(),
    options: {
      analysed_runs_only: opts.analysedRunsOnly === true,
      pseudonymised: opts.pseudonymised === true,
      neutralise_formulas: neutralise,
      excel_bom: opts.excelBom === true,
    },
    input: {
      n_files: paths.length,
      files: paths
        .map((p) => ({
          ...(opts.pseudonymised ? {} : { name: String(p).split(/[\\/]/).slice(-2).join('/') }),
          sha256: hashes[p] ?? null,
        }))
        .sort((a, b) => String(a.sha256).localeCompare(String(b.sha256))),
      rows_read: opts.loadReport?.rows_read ?? null,
      duplicate_rows_dropped: opts.loadReport?.duplicates_dropped ?? null,
    },
    output: {
      n_rows: table.rows.length,
      n_columns: table.columns.length,
      n_participants: table.summary.participants,
      n_runs: table.summary.runs.length,
      sha256: sha256(csv),
    },
    runs: table.summary.runs,
    rows_by_stage: table.summary.rows_by_stage,
    rows_by_task: table.summary.rows_by_task,
    phases_by_stage: table.summary.phases_by_stage,
    columns: dictionary,
    json_columns: dictionary.filter((c) => c.holds_json).map((c) => c.name),
    checks: {
      csv_round_trip_ok: true,
      row_keys_unique: true,
      identity_conflicts: table.summary.identity_conflicts,
      rows_without_source: table.summary.rows_without_source,
      renamed_raw_columns: table.summary.renamed_raw_columns,
    },
  };
  return { csv, manifest, table };
}

/* ---------- CLI ---------- */

/** @param {string[]} argv  process.argv */
export function parseRawArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const o = {
    inputs: [],
    out: null,
    analysedRunsOnly: false,
    keepPid: false,
    share: false,
    saltFile: null,
    subjectFile: null,
    privateDir: null,
    excelBom: false,
    neutralise: true,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') o.out = args[++i] ?? null;
    else if (a === '--analysed-runs-only') o.analysedRunsOnly = true;
    else if (a === '--keep-pid') o.keepPid = true;
    else if (a === '--share') o.share = true;
    else if (a === '--salt-file') o.saltFile = args[++i] ?? null;
    else if (a === '--subject-file') o.subjectFile = args[++i] ?? null;
    else if (a === '--private-dir') o.privateDir = args[++i] ?? null;
    else if (a === '--excel-bom') o.excelBom = true;
    else if (a === '--no-neutralise-formulas') o.neutralise = false;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else o.inputs.push(a);
  }
  if (o.keepPid && o.share) {
    throw new Error('--keep-pid writes raw Prolific ids and cannot be combined with --share');
  }
  return o;
}

const fail = (code, msg) => {
  console.error(`raw-to-csv: ${msg}`);
  process.exit(code);
};

async function main(argv) {
  let opts;
  try {
    opts = parseRawArgs(argv);
  } catch (err) {
    return fail(2, err.message);
  }
  if (!opts.out) {
    return fail(
      2,
      'missing --out <file.csv>\nusage: node scripts/raw-to-csv.js --out <file.csv> <file-or-folder>...'
    );
  }
  if (opts.inputs.length === 0) return fail(2, 'no input paths supplied');
  const paths = expandInputPaths(opts.inputs);
  if (paths.length === 0) return fail(2, 'no .json files found under the supplied paths');
  const loaded = loadAndFlattenDumps(paths);
  if (loaded.errors.length > 0) {
    for (const e of loaded.errors) console.error(`raw-to-csv: cannot read ${e.path}: ${e.error}`);
    return fail(3, 'some input files could not be read; nothing was written (fix or remove them)');
  }
  if (loaded.perParticipant.length === 0) return fail(2, 'no participants found in the inputs');
  annotateSources(loaded.perParticipant, paths);
  const subjectFile = resolve(
    opts.subjectFile ?? process.env[SUBJECT_FILE_ENV] ?? DEFAULT_SUBJECT_FILE
  );
  let subjects;
  try {
    subjects = assignSubjects(loaded.perParticipant, subjectFile);
  } catch (err) {
    return fail(2, err.message);
  }
  if (subjects.added.length > 0) {
    console.error(
      `raw-to-csv: new subject number(s) ${subjects.added.map((a) => a.subject).join(', ')} added to ${subjectFile}`
    );
  }

  const outPath = resolve(opts.out);
  const outDir = dirname(outPath);
  const pseudonymised = opts.keepPid !== true;
  let perParticipant = loaded.perParticipant;
  let keyRows = [];
  let identifiers = [];
  if (pseudonymised) {
    const privateDir = resolve(opts.privateDir ?? defaultPrivateDir(outDir));
    if (isInside(privateDir, outDir)) {
      return fail(
        2,
        `--private-dir ${privateDir} is inside the output folder; the key file must stay out of anything you share`
      );
    }
    try {
      const { salt } = resolveSalt({ saltFile: opts.saltFile });
      const result = pseudonymisePerParticipant(perParticipant, makeCoder(salt));
      perParticipant = result.perParticipant;
      keyRows = result.keyRows;
      identifiers = result.identifiers;
    } catch (err) {
      return fail(2, err.message);
    }
  } else {
    console.error(
      'raw-to-csv: WARNING --keep-pid: the output carries raw Prolific ids. Internal use only; never share this file.'
    );
  }

  let composed;
  try {
    composed = composeRawCsv(perParticipant, {
      analysedRunsOnly: opts.analysedRunsOnly,
      neutralise: opts.neutralise,
      excelBom: opts.excelBom,
      pseudonymised,
      inputPaths: paths,
      fileSha256ByPath: loaded.fileSha256ByPath,
      loadReport: loaded.report,
    });
  } catch (err) {
    return fail(3, err.message);
  }
  const { csv, manifest, table } = composed;
  if (pseudonymised) {
    const leaks = findLeaks({ [outPath]: csv, manifest: JSON.stringify(manifest) }, identifiers);
    if (leaks.length > 0)
      return fail(
        4,
        `a raw identifier survived in the output (${leaks.length} hit(s)); nothing was written`
      );
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, csv, 'utf-8');
  const manifestPath = `${outPath}.manifest.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  if (pseudonymised) {
    const keyPath = writeKeyFile({ keyRows, outDir, privateDir: opts.privateDir });
    console.error(
      `raw-to-csv: Prolific ids replaced by codes. PRIVATE key file (never share): ${keyPath}`
    );
  }
  const s = table.summary;
  console.error(
    `raw-to-csv: wrote ${table.rows.length} rows x ${table.columns.length} columns, ${s.participants} participant(s), ${s.runs.length} run(s)\n` +
      `  rows by stage: ${JSON.stringify(s.rows_by_stage)}\n` +
      `  rows by task:  ${JSON.stringify(s.rows_by_task)}\n` +
      `  duplicates removed: ${manifest.input.duplicate_rows_dropped}; verification: every cell re-read and matched\n` +
      `  file:     ${outPath}\n  manifest: ${manifestPath}`
  );
  for (const r of s.runs) {
    console.error(
      `  run ${r.run_id}: ${r.run_status}${r.is_analysed_run ? ' (analysed)' : ''}, ${r.n_rows} rows, seq ${r.seq_min}-${r.seq_max}, ${r.seq_gaps.length} gap(s)`
    );
  }
  if (!existsSync(outPath)) return fail(3, 'the output file was not written');
  process.exit(0);
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  main(process.argv).catch((err) => {
    console.error('raw-to-csv: unexpected error', err);
    process.exit(1);
  });
}
