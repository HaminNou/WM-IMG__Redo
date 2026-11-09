#!/usr/bin/env node
/**
 * All trials of all tasks and subjects in ONE CSV: ONE LINE PER TRIAL.
 *
 * `raw-to-csv.js` writes the raw event log (a trial spans about seven lines there: start, cue,
 * encoding, retention, three tests, ...). This tool writes the trial-level file: every trial of
 * every participant, practice included and marked, with everything that belongs to the trial on its
 * line. The values are those of the validated tidy tables (tidy-tables.js: trials, encoding events,
 * probes, stars), laid out side by side:
 *
 *   1. who and which run   subject, participant_id, run_id, run_status, is_analysed_run, ...
 *   2. the trial           every column of the tidy `trials` table: condition (task), block,
 *                          shade, rotation, sequence of the six stimuli, outcome counts, guard
 *                          flags, timing of the phases, ...
 *   3. the six stimulus    `slot1_` ... `slot6_`: the stimulus at each serial position (1-6 among
 *      slots               all stimuli of the trial): modality, cell, serial position, on/off
 *                          pattern, position, onset, offset, duration, the silence before and
 *                          after, and what became of the item (tested? response, RT) or of the star
 *                          (response, RT, correct). Hidden placeholders of the single tasks are
 *                          rows like any other (`event_modality` = placeholder).
 *   4. the three memory    `probe1_` ... `probe3_`: the test in the order it was presented: type
 *      tests               (T_on/T_off/F_on/F_off), target or foil, cell, on/off, the position of
 *                          the item in the encoding stream (overall and within modality), response,
 *                          RT, correct, timing.
 *   5. the three stars     `star1_` ... `star3_`: the star judgements in the order of the stars:
 *                          slot, serial position, cell, on/off, response, RT, correct, timing.
 * A position a trial does not have (a star in a trial without stars, a test in the imagery-only task)
 * is `NA`.
 *
 * Nothing is recalculated here: the cell values are those of the tidy tables, and the tool checks
 * that the facts a table repeats for every row of a trial (task, block, shade, rotation, guard flags,
 * ...) agree with the trial's own line, that every probe, star and slot row finds its place, and that
 * the CSV text re-reads to exactly the table (the same independent verification as raw-to-csv.js).
 * Counts of anything unexpected go into the manifest (`<out>.manifest.json`).
 *
 * Subject numbers, privacy (codes unless --keep-pid), the leak scan and all options are shared with
 * raw-to-csv.js; see its header. Extra option:
 *   --main-trials-only   leave out the practice trials
 *
 * Usage: node scripts/trials-to-csv.js --out <file.csv> [options] <file-or-folder>...
 * Exit codes: 0 ok; 2 usage; 3 unreadable input or failed verification; 4 identifier leak.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  CliError,
  analysedRunByParticipant,
  describeColumns,
  orderEntries,
  parseRawArgs,
  prepareParticipants,
  runStatusOf,
  serializeCsv,
  verifyCsv,
} from './raw-to-csv.js';
import { UTF8_BOM } from './csv-export.js';
import {
  EVENTS_COLUMNS,
  PROBES_COLUMNS,
  STARS_COLUMNS,
  TIDY_VERSION,
  TRIALS_COLUMNS,
  composeTidyTables,
} from './tidy-tables.js';
import { findLeaks, writeKeyFile } from './pseudonymise.js';

export const TRIALS_CSV_VERSION = '1.0.0';

/** Positions per trial: six stimulus slots, three memory tests, three star judgements. */
export const N_SLOTS = 6;
export const N_PROBES = 3;
export const N_STARS = 3;

/** First columns of every line. */
export const LEAD_COLUMNS = Object.freeze([
  'subject',
  'participant_id',
  'run_id',
  'run_status',
  'is_analysed_run',
  'is_preview',
  'is_pilot_run',
  'study_id',
  'session_id',
  'row_key',
]);

/**
 * Columns of the slot, probe and star tables that repeat a fact of the trial itself. They appear
 * once, in the trial block; the tool checks that every child row agrees with it.
 */
export const TRIAL_CONTEXT_COLUMNS = Object.freeze([
  'participant_id',
  'trial_seq_session',
  'trial_uid',
  'attempt',
  'condition',
  'block_label',
  'is_practice',
  'presentation_index',
  'pool_index',
  'rotation_deg',
  'rotation_sign',
  'rotation_stratum',
  'background_shade',
  'sequence',
  'trial_star_excluded',
  'star_correct_all',
  'trial_guard_excluded',
  'guard_flags',
  'guard_n',
  'user_gain',
  'px_per_mm',
  'build_id',
]);

const CONTEXT = new Set(TRIAL_CONTEXT_COLUMNS);

/**
 * Of the repeated columns, these three are recorded on the trial's own line (the gate and encoding
 * rows) and usually NOT on the probe and star rows, whose copy is then empty. They are checked only
 * where a child row does carry a value; every other repeated column must agree exactly.
 */
const LENIENT_CONTEXT = new Set(['guard_flags', 'guard_n', 'user_gain']);
/* The key of each child row is its position, written into the column prefix. */
const BLOCKS = Object.freeze([
  {
    name: 'slot',
    table: 'events',
    n: N_SLOTS,
    positionColumn: 'slot_in_stream',
    columns: EVENTS_COLUMNS,
  },
  {
    name: 'probe',
    table: 'probes',
    n: N_PROBES,
    positionColumn: 'probe_position',
    columns: PROBES_COLUMNS,
  },
  {
    name: 'star',
    table: 'stars',
    n: N_STARS,
    positionColumn: 'star_serial_position',
    columns: STARS_COLUMNS,
  },
]);

/** Columns of one child block, without the repeated trial facts and the position itself. */
export function blockColumns(block) {
  return block.columns.filter((c) => !CONTEXT.has(c) && c !== block.positionColumn);
}

/** The full column list of the trial file. */
export function trialColumns() {
  const trialOwn = TRIALS_COLUMNS.filter((c) => c !== 'participant_id');
  const cols = [...LEAD_COLUMNS, ...trialOwn];
  for (const block of BLOCKS) {
    const own = blockColumns(block);
    for (let k = 1; k <= block.n; k++) for (const c of own) cols.push(`${block.name}${k}_${c}`);
  }
  return cols;
}

const same = (a, b) => (a ?? null) === (b ?? null);

/**
 * One line per trial.
 *
 * @param {object[]} perParticipant  loaded (and optionally pseudonymised) participants, one entry per run
 * @param {{analysedRunsOnly?: boolean, mainTrialsOnly?: boolean, tidy?: object}} [opts]  `tidy`: ready-made
 *        tidy tables (default: built from the participants); used by tests to inject faults
 * @returns {{rows: object[], columns: string[], summary: object}}
 */
export function buildTrialTable(
  perParticipant,
  { analysedRunsOnly = false, mainTrialsOnly = false, tidy: tidyTables = null } = {}
) {
  const tidy = tidyTables ?? composeTidyTables(perParticipant);
  const analysedOf = analysedRunByParticipant(perParticipant);
  const entries = orderEntries(perParticipant);
  const order = new Map(entries.map((e, i) => [e.participant_id, i]));
  const meta = new Map();
  for (const e of perParticipant) {
    const pid = e.source_pid ?? e.participant_id;
    const analysed = analysedOf.get(pid);
    const params = e.session?.params ?? {};
    meta.set(e.participant_id, {
      subject: e.subject ?? null,
      participant_id: pid,
      run_id: e.run_id ?? null,
      run_status: runStatusOf(e.rows),
      is_analysed_run: analysed !== null && analysed !== undefined && analysed === e.run_id,
      is_preview: params.is_preview ?? null,
      is_pilot_run: e.session?.is_pilot_run ?? null,
      study_id: params.study_id ?? null,
      session_id: params.session_id ?? null,
    });
  }

  /* Child rows by (participant entry, trial). */
  const key = (r) => `${r.participant_id}\u0000${r.trial_seq_session}`;
  const children = { events: new Map(), probes: new Map(), stars: new Map() };
  for (const block of BLOCKS) {
    for (const r of tidy[block.table]) {
      const k = key(r);
      if (!children[block.table].has(k)) children[block.table].set(k, []);
      children[block.table].get(k).push(r);
    }
  }

  const columns = trialColumns();
  const out = [];
  const counts = { contextMismatches: 0, unplacedChildRows: 0, duplicatePositions: 0 };
  const sorted = [...tidy.trials].sort(
    (a, b) =>
      (order.get(a.participant_id) ?? 0) - (order.get(b.participant_id) ?? 0) ||
      a.trial_seq_session - b.trial_seq_session
  );
  for (const t of sorted) {
    const m = meta.get(t.participant_id);
    if (!m) continue;
    if (analysedRunsOnly && !m.is_analysed_run) continue;
    if (mainTrialsOnly && t.is_practice === true) continue;
    const row = { ...m };
    row.row_key = `${m.participant_id}|${m.run_id ?? 'none'}|${t.trial_seq_session}`;
    for (const c of TRIALS_COLUMNS) if (c !== 'participant_id') row[c] = t[c];
    for (const block of BLOCKS) {
      const list = children[block.table].get(key(t)) ?? [];
      const placed = new Set();
      for (const child of list) {
        const pos = child[block.positionColumn];
        if (!Number.isInteger(pos) || pos < 1 || pos > block.n) {
          counts.unplacedChildRows += 1;
          continue;
        }
        if (placed.has(pos)) {
          counts.duplicatePositions += 1;
          continue;
        }
        placed.add(pos);
        for (const c of Object.keys(child)) {
          if (!CONTEXT.has(c) || !(c in t)) continue;
          if (LENIENT_CONTEXT.has(c) && (child[c] === null || child[c] === undefined)) continue;
          if (!same(child[c], t[c])) counts.contextMismatches += 1;
        }
        for (const c of blockColumns(block)) row[`${block.name}${pos}_${c}`] = child[c];
      }
    }
    out.push(row);
  }
  /* A child row whose trial does not exist cannot be placed. (Rows of trials that are only
   * filtered out by an option are fine and not counted.) */
  const trialKeys = new Set(tidy.trials.map(key));
  let orphans = 0;
  for (const block of BLOCKS) {
    for (const [k, list] of children[block.table]) if (!trialKeys.has(k)) orphans += list.length;
  }
  counts.unplacedChildRows += orphans;
  const byTask = {};
  const byBlock = {};
  const perRunTrials = new Map();
  for (const r of out) {
    byTask[r.condition] = (byTask[r.condition] ?? 0) + 1;
    byBlock[r.block_label] = (byBlock[r.block_label] ?? 0) + 1;
    const k = `${r.subject}|${r.participant_id}|${r.run_id}`;
    perRunTrials.set(k, (perRunTrials.get(k) ?? 0) + 1);
  }
  return {
    rows: out,
    columns,
    summary: {
      trials_by_task: byTask,
      trials_by_block: byBlock,
      trials_per_run: [...perRunTrials.entries()].map(([k, n]) => {
        const [subject, participant_id, run_id] = k.split('|');
        return {
          subject: subject === 'null' ? null : Number(subject),
          participant_id,
          run_id,
          n_trials: n,
        };
      }),
      context_mismatches: counts.contextMismatches,
      unplaced_child_rows: counts.unplacedChildRows,
      duplicate_positions: counts.duplicatePositions,
      tidy_issues: tidy.issues,
      n_child_rows: Object.fromEntries(
        BLOCKS.map((b) => [
          b.table,
          [...children[b.table].values()].reduce((n, l) => n + l.length, 0),
        ])
      ),
    },
  };
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Assemble the CSV and its manifest. Throws if the verification pass finds any difference between
 * the CSV text and the table, or if the trial and child tables do not fit together.
 *
 * @param {object[]} perParticipant
 * @param {object} [opts]  analysedRunsOnly, mainTrialsOnly, neutralise (default true), excelBom,
 *        pseudonymised, inputPaths, fileSha256ByPath, loadReport
 * @returns {{csv: string, manifest: object, table: object}}
 */
export function composeTrialCsv(perParticipant, opts = {}) {
  const neutralise = opts.neutralise !== false;
  const table = buildTrialTable(perParticipant, {
    analysedRunsOnly: opts.analysedRunsOnly === true,
    mainTrialsOnly: opts.mainTrialsOnly === true,
    tidy: opts.tidy ?? null,
  });
  const s = table.summary;
  if (s.context_mismatches > 0 || s.unplaced_child_rows > 0 || s.duplicate_positions > 0) {
    throw new Error(
      `trials-to-csv: the tables do not fit together: ${s.context_mismatches} mismatching context value(s), ` +
        `${s.unplaced_child_rows} unplaced and ${s.duplicate_positions} duplicated child row(s)`
    );
  }
  const body = serializeCsv(table.rows, table.columns, { neutralise });
  const problems = verifyCsv(body, table.columns, table.rows, { neutralise });
  if (problems.length > 0) {
    throw new Error(`trials-to-csv: verification failed:\n  ${problems.join('\n  ')}`);
  }
  const csv = opts.excelBom ? UTF8_BOM + body : body;
  const dictionary = describeColumns(table.rows, table.columns);
  const paths = opts.inputPaths ?? [];
  const hashes = opts.fileSha256ByPath ?? {};
  const manifest = {
    generator: {
      name: 'trials-to-csv.js',
      version: TRIALS_CSV_VERSION,
      tidy_tables_version: TIDY_VERSION,
    },
    generated_at_iso: new Date().toISOString(),
    options: {
      analysed_runs_only: opts.analysedRunsOnly === true,
      main_trials_only: opts.mainTrialsOnly === true,
      pseudonymised: opts.pseudonymised === true,
      neutralise_formulas: neutralise,
      excel_bom: opts.excelBom === true,
    },
    input: {
      n_files: paths.length,
      file_sha256: paths.map((p) => hashes[p] ?? null).sort(),
      rows_read: opts.loadReport?.rows_read ?? null,
      duplicate_rows_dropped: opts.loadReport?.duplicates_dropped ?? null,
    },
    output: {
      n_trials: table.rows.length,
      n_columns: table.columns.length,
      sha256: sha256(csv),
    },
    layout: {
      slots_per_trial: N_SLOTS,
      probes_per_trial: N_PROBES,
      stars_per_trial: N_STARS,
      columns_per_slot: blockColumns(BLOCKS[0]).length,
      columns_per_probe: blockColumns(BLOCKS[1]).length,
      columns_per_star: blockColumns(BLOCKS[2]).length,
    },
    trials_by_task: s.trials_by_task,
    trials_by_block: s.trials_by_block,
    trials_per_run: s.trials_per_run,
    columns: dictionary,
    checks: {
      csv_round_trip_ok: true,
      row_keys_unique: true,
      context_mismatches: s.context_mismatches,
      unplaced_child_rows: s.unplaced_child_rows,
      duplicate_positions: s.duplicate_positions,
      child_rows_in_tidy_tables: s.n_child_rows,
      tidy_issues: s.tidy_issues,
    },
  };
  return { csv, manifest, table };
}

/* ---------- CLI ---------- */

/** Same options as raw-to-csv.js, plus --main-trials-only. */
export function parseTrialArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const mainTrialsOnly = args.includes('--main-trials-only');
  const opts = parseRawArgs([
    'node',
    'trials-to-csv.js',
    ...args.filter((a) => a !== '--main-trials-only'),
  ]);
  return { ...opts, mainTrialsOnly };
}

const fail = (code, msg) => {
  console.error(`trials-to-csv: ${msg}`);
  process.exit(code);
};

async function main(argv) {
  let opts;
  try {
    opts = parseTrialArgs(argv);
  } catch (err) {
    return fail(2, err.message);
  }
  let prepared;
  try {
    prepared = prepareParticipants(opts, 'trials-to-csv');
  } catch (err) {
    if (err instanceof CliError) return fail(err.code, err.message);
    throw err;
  }
  const { paths, loaded, perParticipant, keyRows, identifiers, outPath, outDir, pseudonymised } =
    prepared;
  let composed;
  try {
    composed = composeTrialCsv(perParticipant, {
      analysedRunsOnly: opts.analysedRunsOnly,
      mainTrialsOnly: opts.mainTrialsOnly,
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
    if (leaks.length > 0) {
      return fail(
        4,
        `a raw identifier survived in the output (${leaks.length} hit(s)); nothing was written`
      );
    }
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, csv, 'utf-8');
  const manifestPath = `${outPath}.manifest.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  if (pseudonymised) {
    const keyPath = writeKeyFile({ keyRows, outDir, privateDir: opts.privateDir });
    console.error(
      `trials-to-csv: Prolific ids replaced by codes. PRIVATE key file (never share): ${keyPath}`
    );
  }
  console.error(
    `trials-to-csv: wrote ${table.rows.length} trials x ${table.columns.length} columns\n` +
      `  trials by task:  ${JSON.stringify(manifest.trials_by_task)}\n` +
      `  trials by block: ${JSON.stringify(manifest.trials_by_block)}\n` +
      `  every cell re-read and matched; ${manifest.checks.context_mismatches} context mismatch(es), ${manifest.checks.unplaced_child_rows} unplaced child row(s)\n` +
      `  file:     ${outPath}\n  manifest: ${manifestPath}`
  );
  for (const r of table.summary.trials_per_run) {
    console.error(`  subject ${r.subject ?? 'NA'}, run ${r.run_id}: ${r.n_trials} trials`);
  }
  process.exit(0);
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  main(process.argv).catch((err) => {
    console.error('trials-to-csv: unexpected error', err);
    process.exit(1);
  });
}

/** For tests: the three child blocks (slot, probe, star) in column order. */
export const BLOCKS_FOR_TESTS = BLOCKS;
