#!/usr/bin/env node
/**
 * Pilot-data summariser and batch-decision tool.
 *
 * Ingests the JSON files of a study folder (the download-fallback exports from
 * `uploader.downloadAsJson` and the DataPipe bucket, checkpoint and tail
 * envelopes), POOLS EVERY FILE OF A PARTICIPANT (one Prolific PID), drops rows
 * repeated across files on (run_id, seq) and reports per-participant and
 * aggregate statistics. A real session uploads about eight files, so a file is
 * not a participant: the exclusion rows, the calibration outcome and the
 * `completion_redirect` row sit in different files.
 *
 * Usage:
 *   node scripts/pilot-summary.js path/to/dump.json
 *   node scripts/pilot-summary.js path/to/dir/                  # walks directory
 *   node scripts/pilot-summary.js --json path/to/dir/           # machine-readable
 *   node scripts/pilot-summary.js --keep-pid path/to/dir/       # show raw Prolific ids
 *
 * Privacy: by default the printout and --json show pseudonymous participant codes
 * ("P" + 12 hex), the same codes csv-export.js writes into the tables, and no file
 * names or Prolific ids (see pseudonymise.js; --salt-file or $CSV_EXPORT_SALT choose
 * the salt). csv-export.js must use the SAME salt, or its codes will not match
 * these. The codes map back to people only through the private PID_KEY.csv.
 * --keep-pid prints the raw ids (internal use, e.g. approving payments); never paste
 * that output anywhere shared.
 *
 * Definitions (shared with csv-export.js through participant-rules.js):
 *   completed  a run wrote `completion_redirect` and none of its rows carries
 *              `exit_reason`; data without that row is `incomplete`, a run that
 *              ended at a collection-time screen-out is `screened_out`
 *   retained   completed and not excluded by the three participant-level rules
 *              (calibration inconsistent, more than 1 of the 3 attention checks
 *              failed on first administration, single-task accuracy <= .55)
 *   runs       a reload starts a new run; the completed run is analysed
 *   class      real (a Prolific PID, no pilot flag), pilot (is_pilot_run) or preview
 *              (no Prolific PID at all: a researcher testing the link without the
 *              Prolific parameters, a LOCAL_ session id). A session without a PID is
 *              keyed by its session id, so all its files are ONE participant. The
 *              sampling decision counts real participants only (and pilot sessions
 *              only in a pilot batch); previews never count; the report says how many
 *              sessions were left out, and warns about a session that has a PID but is
 *              flagged preview (a URL parameter was missing), which IS counted.
 *
 * Aggregate report:
 *   - n_participants, n_completed, n_retained, and the exclusion rate among completed
 *     sessions (all three participant-level rules) vs the 25-35% pre-reg estimate
 *   - the sampling-plan decision (collect / recruit another batch / stop / stop at the
 *     maximum) computed from pre-reg.json -> sampling_plan; no p-values or Bayes factors
 *   - build_id, schema_version and pilot-flag homogeneity
 *   - reloaded participants, completed sessions with missing main trials
 *   - condition distribution: counts per (phase x probe_type) pair
 *   - median session duration (design estimate 110 min, pre-reg.json design_summary)
 *
 * Exit code: 0 on no flagged issues; 1 if any aggregate error is detected
 * (build-id heterogeneity, unreadable file, etc.).
 *
 * Pure Node (>=20) - no browser deps, no external packages, runs in CI.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadAndFlattenDumps, dedupeRows, splitByRun } from './dump-loader.js';
import { makeCoder, makeScrubber, resolveSalt } from './pseudonymise.js';
import {
  summariseParticipantRuns,
  sampleClass,
  summariseAttention,
  evaluateRun,
  SINGLE_TASK_FLOOR,
  MAIN_BLOCK_LABELS,
  EXPECTED_MAIN_TRIALS,
} from './participant-rules.js';

/* Sampling-plan numbers come from the pre-registration file so the rule has one source. */
const PRE_REG = JSON.parse(
  readFileSync(new URL('../pre-reg/pre-reg.json', import.meta.url), 'utf8')
);
export const SAMPLING_PLAN = Object.freeze({
  target: PRE_REG.sampling_plan.recruitment_target_n,
  retainedMinimum: PRE_REG.sampling_plan.retained_n_minimum,
  batchSize: PRE_REG.sampling_plan.batch_size,
  maximum: PRE_REG.sampling_plan.max_recruitment_n,
});

export { SINGLE_TASK_FLOOR };

const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const CYAN = (s) => `\x1b[36m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

const PROBE_PHASES = Object.freeze([
  'd_only_probe',
  't_only_probe',
  'i_only_star',
  'i_d_probe',
  'i_d_star',
  'i_t_probe',
  'i_t_star',
]);

/* ---------- Pure helpers (unit-tested in tests/pilot-summary.test.js) ---------- */

/**
 * Parse argv into a structured options bag.
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const paths = [];
  let jsonOutput = false;
  let keepPid = false;
  let saltFile = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') jsonOutput = true;
    else if (a === '--keep-pid') keepPid = true;
    else if (a === '--salt-file') saltFile = args[++i] ?? null;
    else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      paths.push(a);
    }
  }
  return { paths, jsonOutput, keepPid, saltFile };
}

/**
 * Walk the supplied paths, expanding directories into the .json files they
 * contain. Returns absolute paths.
 */
export function expandPaths(inputPaths, opts = {}) {
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
 * Per-participant summary from the runs of ONE Prolific PID.
 *
 * @param {{run_id: string|null, rows: object[]}[]} runs  rows de-duplicated, in seq order
 *        (see dump-loader.js)
 * @param {{session?: object, sourceLabel?: string, nFiles?: number}} [meta]
 */
export function summariseParticipant(runs, { session, sourceLabel, nFiles } = {}) {
  const rules = summariseParticipantRuns(runs);
  const rows = rules.shown_rows;

  const phaseCounts = countByKey(rows, 'phase');
  const uploadSummaryRow = rows.find((r) => r.phase === 'upload_session_end');
  const completionRow = rows.find((r) => r.phase === 'completion_redirect');
  const nMainRows = rows.filter((r) => MAIN_BLOCK_LABELS.includes(r.block_label)).length;
  const nPracticeRows = rows.filter((r) => r.block_label === 'practice').length;
  const probeMatrix = summariseProbeMatrix(rows);
  const exclusions = {
    calibration_status: rules.calibration_status,
    d_only_accuracy: rules.d_only_accuracy,
    t_only_accuracy: rules.t_only_accuracy,
    reasons: rules.reasons,
    excluded: rules.excluded,
    completed: rules.completed,
    retained: rules.retained,
  };

  return {
    source: sourceLabel,
    n_files: nFiles ?? null,
    prolific_pid: session?.params?.prolific_pid ?? null,
    session_id: session?.params?.session_id ?? null,
    build_id: session?.build_id ?? null,
    schema_version: session?.schema_version ?? null,
    is_pilot_run: session?.is_pilot_run ?? false,
    pilot_label: session?.pilot_label ?? null,
    is_preview: session?.params?.is_preview ?? null,
    sample_class: sampleClass(session),
    started_at_iso: session?.started_at_iso ?? null,
    session_duration_min: estimateSessionDurationMin(rows),
    n_total_rows: rows.length,
    n_main_rows: nMainRows,
    n_practice_rows: nPracticeRows,
    phase_counts: phaseCounts,
    probe_matrix: probeMatrix,
    attention: rules.attention,
    exclusions,
    status: rules.status,
    completed: rules.completed,
    retained: rules.retained,
    n_runs: rules.n_runs,
    run_ids: rules.run_ids,
    analysed_run_id: rules.analysed_run_id,
    multiple_completed_runs: rules.multiple_completed_runs,
    reload_after_main: rules.reload_after_main,
    main_trials_present: rules.main_trials_present,
    data_incomplete: rules.data_incomplete,
    /* The LATEST upload status (a retry that delivered everything reads
     * 'uploaded'); the end-of-session row keeps the first attempt's status. */
    upload_status: rules.upload_status_final ?? uploadSummaryRow?.status ?? null,
    upload_status_first: rules.upload_status_first ?? uploadSummaryRow?.status ?? null,
    upload_retries: rules.upload_retries ?? 0,
    completion_was_placeholder: completionRow?.completion_was_placeholder ?? null,
    completion_redirect_url: completionRow?.completion_redirect_url ?? null,
  };
}

/**
 * Summary of ONE parsed JSON dump treated as one participant (a download-fallback
 * export, or any single envelope). A folder of bucket files must be read with
 * `loadParticipants`, which pools the files of a participant first.
 *
 * Accepts either a download-fallback export ({ session, n_rows, rows, ... })
 * or a chunk envelope ({ session_id, prolific_pid, ..., rows, ... }).
 */
export function summariseDump(parsed, { sourceLabel } = {}) {
  const session = parsed.session ?? extractSessionFromChunkEnvelope(parsed);
  const { rows } = dedupeRows(Array.isArray(parsed.rows) ? parsed.rows : []);
  const runs = [...splitByRun(rows)].map(([runId, runRows]) => ({
    run_id: runId === 'none' ? null : runId,
    rows: runRows,
  }));
  return summariseParticipant(runs, { session, sourceLabel, nFiles: 1 });
}

/**
 * Read a list of JSON files, pool all files of each participant (one Prolific
 * PID) and summarise each participant once. Unreadable files are returned in
 * `errors`; they are never silently skipped.
 *
 * @param {string[]} paths  absolute .json paths
 * @returns {{participants: object[], errors: {path: string, error: string}[],
 *            report: {rows_read: number, duplicates_dropped: number}}}
 */
export function loadParticipants(paths, opts = {}) {
  const { perParticipant, errors, report } = loadAndFlattenDumps(paths, opts);
  const byPid = new Map();
  for (const entry of perParticipant) {
    const pid = entry.source_pid;
    if (!byPid.has(pid)) byPid.set(pid, { session: entry.session, runs: [], paths: [] });
    const slot = byPid.get(pid);
    slot.runs.push({ run_id: entry.run_id === 'none' ? null : entry.run_id, rows: entry.rows });
    for (const p of entry.source_paths ?? []) if (!slot.paths.includes(p)) slot.paths.push(p);
  }
  const participants = [...byPid.entries()].map(([pid, slot]) => {
    const summary = summariseParticipant(slot.runs, {
      session: slot.session,
      sourceLabel: slot.paths.length === 1 ? slot.paths[0] : `${pid} (${slot.paths.length} files)`,
      nFiles: slot.paths.length,
    });
    if (summary.prolific_pid === null) summary.prolific_pid = pid;
    return summary;
  });
  return { participants, errors, report };
}

function extractSessionFromChunkEnvelope(env) {
  if (!env || env.session) return env.session;
  /* Chunk envelopes flatten session metadata to the top level. */
  return {
    params: {
      session_id: env.session_id,
      prolific_pid: env.prolific_pid,
      study_id: env.study_id,
      is_preview: env.is_preview,
    },
    build_id: env.build_id,
    schema_version: env.schema_version,
    is_pilot_run: env.is_pilot_run,
    pilot_label: env.pilot_label,
    started_at_iso: env.started_at_iso,
    user_agent: env.user_agent,
  };
}

function countByKey(rows, key) {
  const out = {};
  for (const r of rows) {
    const v = r[key];
    if (v === undefined) continue;
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}

/**
 * Build a probe-type × phase matrix for spot-checking counterbalance integrity.
 *
 * Restricted to rows whose `block_label` is one of the locked main-block tags
 * (`main_a`, `main_b`) so practice trials don't pollute the count. Earlier
 * versions filtered on `phase.startsWith('main_')` which never matched any
 * real probe row — that bug is fixed by checking `block_label` directly,
 * which `assembleBlock` now stamps onto every emitted node.
 */
export function summariseProbeMatrix(rows) {
  const matrix = {};
  for (const r of rows) {
    if (!MAIN_BLOCK_LABELS.includes(r.block_label)) continue;
    if (!PROBE_PHASES.includes(r.phase)) continue;
    if (!r.probe_type) continue;
    matrix[r.phase] = matrix[r.phase] ?? { T_on: 0, T_off: 0, F_on: 0, F_off: 0 };
    if (matrix[r.phase][r.probe_type] !== undefined) {
      matrix[r.phase][r.probe_type] += 1;
    }
  }
  return matrix;
}

/**
 * Attention-check summary over DISTINCT checks (the practice loop can administer a
 * check more than once). A check counts as failed if it was failed the first time
 * it was shown; the count on the final administration is reported beside it.
 * Strict `>` comparator, as in the runtime (`evaluateAttentionChecks`); threshold
 * defaults to the pre-registered 1. Reads the `attention_check` rows directly (not
 * the `attention_check_summary` row, which may be missing on aborted sessions).
 */
export function summariseAttentionChecks(rows, { maxFailures } = {}) {
  return summariseAttention(rows, maxFailures === undefined ? {} : { maxFailures });
}

/**
 * Participant-level exclusion status for the rows of one run, as in
 * pre-reg.json -> exclusion_rules: `screen_calibration_inconsistent` (last
 * calibration outcome `inconsistent_accepted`), `instructional_attention_checks`
 * (more than 1 of the 3 checks failed) and `single_task_floor` (main-block accuracy
 * <= .55 in D_only or in T_only). `completed` means the run reached the completion
 * redirect and did not end at a collection-time screen-out; only completed
 * sessions count toward the sample size. `retained` is completed and not excluded
 * by any of the three rules. The definitions live in participant-rules.js.
 */
export function summariseExclusions(rows, attention = summariseAttentionChecks(rows)) {
  const ev = evaluateRun(rows, { attention });
  return {
    calibration_status: ev.calibration_status,
    d_only_accuracy: ev.d_only_accuracy,
    t_only_accuracy: ev.t_only_accuracy,
    reasons: ev.reasons,
    excluded: ev.excluded,
    completed: ev.completed,
    retained: ev.retained,
  };
}

/**
 * The pre-registered sampling decision (pre-reg.json -> sampling_plan.stopping_rule).
 * Uses only the completed and retained counts, never a p-value or Bayes factor.
 * Returns { action, recruit }: `collect` (fewer completions than the target),
 * `stop` (retained minimum reached), `recruit_batch` (another batch of `recruit`
 * completions) or `stop_at_maximum` (maximum reached with too few retained: underpowered).
 */
export function samplingDecision(nCompleted, nRetained, plan = SAMPLING_PLAN) {
  if (nCompleted < plan.target) return { action: 'collect', recruit: plan.target - nCompleted };
  if (nRetained >= plan.retainedMinimum) return { action: 'stop', recruit: 0 };
  if (nCompleted >= plan.maximum) return { action: 'stop_at_maximum', recruit: 0 };
  return { action: 'recruit_batch', recruit: Math.min(plan.batchSize, plan.maximum - nCompleted) };
}

/**
 * Estimate session duration in minutes from the sum of `rt` values in the
 * dump. Falls back to `time_elapsed` if rt isn't present. This is a coarse
 * estimate — the true wall-clock includes inter-trial gaps and visibility
 * losses (which we record but don't aggregate here). Returns null when no
 * usable timing column exists.
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
  if (rtSum === 0) return null;
  return Number((rtSum / 60_000).toFixed(2));
}

/**
 * Aggregate per-participant summaries into a batch-level report. Flags any
 * heterogeneity that should NOT exist (build_id, schema_version, pilot-flag).
 */
export function aggregate(perParticipant, opts = {}) {
  const expectPilot = opts.expectPilot ?? null; /* null means don't enforce */
  const buildIds = new Set(
    perParticipant.map((s) => s.build_id).filter((x) => x !== null && x !== undefined)
  );
  const schemaVersions = new Set(
    perParticipant.map((s) => s.schema_version).filter((x) => x !== null && x !== undefined)
  );
  const pilotFlags = new Set(perParticipant.map((s) => Boolean(s.is_pilot_run)));
  /* Which sessions count toward the sampling plan: real participants, plus pilot
   * sessions only when this batch is itself a pilot batch (expectPilot === true).
   * Previews (no Prolific PID: the researcher testing the live link, LOCAL_ ids)
   * never count. Everything left out is reported, never dropped silently. */
  const classOf = (s) => s.sample_class ?? 'real';
  const isCounted = (s) =>
    classOf(s) === 'real' || (expectPilot === true && classOf(s) === 'pilot');
  const sampled = perParticipant.filter(isCounted);
  const notCountedPilot = perParticipant.filter((s) => !isCounted(s) && classOf(s) === 'pilot');
  const notCountedPreview = perParticipant.filter((s) => !isCounted(s) && classOf(s) === 'preview');
  const nExcluded = sampled.filter((s) => s.attention.excluded).length;
  const exclusionRate = sampled.length > 0 ? nExcluded / sampled.length : null;
  const completedSessions = sampled.filter((s) => s.completed);
  const nCompleted = completedSessions.length;
  const nRetained = completedSessions.filter((s) => s.retained).length;
  const nExcludedAny = nCompleted - nRetained;
  const decision = samplingDecision(nCompleted, nRetained);
  const nIncomplete = sampled.filter((s) => s.status === 'incomplete').length;
  const nScreenedOut = sampled.filter((s) => s.status === 'screened_out').length;
  const reloaded = sampled.filter((s) => s.reload_after_main);
  const dataIncomplete = sampled.filter((s) => s.data_incomplete);
  const multiCompleted = sampled.filter((s) => s.multiple_completed_runs);
  const previewFlagWithPid = sampled.filter((s) => s.is_preview === true);
  const durations = perParticipant
    .map((s) => s.session_duration_min)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  const median =
    durations.length === 0
      ? null
      : durations.length % 2 === 1
        ? durations[(durations.length - 1) / 2]
        : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2;

  const issues = [];
  if (buildIds.size > 1) {
    issues.push({
      severity: 'error',
      code: 'BUILD_ID_HETEROGENEOUS',
      message: `multiple build_ids in batch: ${[...buildIds].join(', ')} — pilot or main batches should be homogeneous`,
    });
  }
  if (schemaVersions.size > 1) {
    issues.push({
      severity: 'error',
      code: 'SCHEMA_VERSION_HETEROGENEOUS',
      message: `multiple schema_versions in batch: ${[...schemaVersions].join(', ')}`,
    });
  }
  if (expectPilot === true && pilotFlags.has(false)) {
    issues.push({
      severity: 'warning',
      code: 'MISSING_PILOT_FLAG',
      message: 'expected pilot batch but some sessions have is_pilot_run=false',
    });
  }
  if (expectPilot === false && pilotFlags.has(true)) {
    issues.push({
      severity: 'warning',
      code: 'UNEXPECTED_PILOT_FLAG',
      message:
        'expected main batch but some sessions have is_pilot_run=true — exclude before analysis',
    });
  }
  if (notCountedPilot.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'PILOT_SESSIONS_NOT_COUNTED',
      message: `${notCountedPilot.length} pilot session(s) (is_pilot_run=true; ${notCountedPilot.filter((x) => x.completed).length} completed) are not counted toward the sampling plan of this main batch`,
    });
  }
  if (notCountedPreview.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'PREVIEW_SESSIONS_NOT_COUNTED',
      message: `${notCountedPreview.length} session(s) without a Prolific PID (previews, LOCAL_ ids, test visits; ${notCountedPreview.filter((x) => x.completed).length} reached the completion row) are not counted`,
    });
  }
  if (previewFlagWithPid.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'PREVIEW_FLAG_WITH_PID',
      message: `${previewFlagWithPid.length} session(s) carry a Prolific PID but is_preview=true (a Prolific URL parameter, usually SESSION_ID, was missing); they ARE counted: check the study URL template`,
    });
  }
  if (reloaded.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'RELOAD_AFTER_MAIN_TRIALS',
      message: `${reloaded.length} participant(s) reloaded after main trials had begun (an earlier run holds main-trial rows; the completed run is analysed). The pre-registration has no rule for this: ${reloaded.map((s) => s.prolific_pid).join(', ')}`,
    });
  }
  if (multiCompleted.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'MULTIPLE_COMPLETED_RUNS',
      message: `${multiCompleted.length} participant(s) have more than one completed run (the run with the most rows is analysed): ${multiCompleted.map((s) => s.prolific_pid).join(', ')}`,
    });
  }
  if (dataIncomplete.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'DATA_INCOMPLETE',
      message: `${dataIncomplete.length} completed session(s) have fewer main trials than the ${EXPECTED_MAIN_TRIALS} planned (a bucket file may be missing): ${dataIncomplete.map((s) => `${s.prolific_pid} (${s.main_trials_present})`).join(', ')}`,
    });
  }
  return {
    n_participants: perParticipant.length,
    n_counted_participants: sampled.length,
    n_not_counted_pilot: notCountedPilot.length,
    n_not_counted_preview: notCountedPreview.length,
    n_incomplete: nIncomplete,
    n_screened_out: nScreenedOut,
    n_reloaded_after_main: reloaded.length,
    n_data_incomplete: dataIncomplete.length,
    build_ids: [...buildIds],
    schema_versions: [...schemaVersions],
    n_excluded: nExcluded,
    exclusion_rate: exclusionRate,
    n_completed: nCompleted,
    n_retained: nRetained,
    n_excluded_any: nExcludedAny,
    exclusion_rate_any: nCompleted > 0 ? nExcludedAny / nCompleted : null,
    sampling_decision: decision,
    median_duration_min: median,
    issues,
  };
}

/* ---------- CLI ---------- */

function renderPerParticipant(s) {
  const lines = [];
  lines.push(BOLD(`\n${basename(s.source ?? '(stream)')}`));
  const flag = s.is_pilot_run ? CYAN('[PILOT]') : '';
  lines.push(`  pid=${s.prolific_pid ?? '(none)'}  build=${s.build_id ?? '(none)'}  ${flag}`);
  lines.push(
    `  rows=${s.n_total_rows} (main=${s.n_main_rows}, practice=${s.n_practice_rows})  duration≈${formatMin(s.session_duration_min)}`
  );
  const excl = s.attention.excluded ? RED('EXCLUDED') : GREEN('included');
  const status = !s.completed
    ? YELLOW(
        s.status === 'screened_out'
          ? 'screened out at collection (not counted)'
          : 'incomplete: no completion row (not counted)'
      )
    : s.retained
      ? GREEN('retained')
      : RED(`excluded: ${s.exclusions.reasons.join(', ')}`);
  lines.push(
    `  attention: ${s.attention.passed}/${s.attention.total} checks passed first time, ${s.attention.failed_first} failed first time (${s.attention.failed_final} on the final administration; >${s.attention.threshold} ⇒ exclude) → ${excl}`
  );
  if (s.n_runs > 1) {
    lines.push(
      `  runs: ${s.n_runs}${s.reload_after_main ? YELLOW('  [reloaded after main trials]') : ''}`
    );
  }
  if (s.data_incomplete) {
    lines.push(
      `  ${YELLOW('main trials present:')} ${s.main_trials_present} of ${EXPECTED_MAIN_TRIALS}`
    );
  }
  lines.push(`  sample status: ${status}`);
  if (s.upload_status) {
    const colour = s.upload_status === 'uploaded' ? GREEN : YELLOW;
    const retried =
      s.upload_retries > 0
        ? ` (after ${s.upload_retries} retr${s.upload_retries === 1 ? 'y' : 'ies'}; first attempt: ${s.upload_status_first ?? 'unknown'})`
        : '';
    lines.push(`  upload: ${colour(s.upload_status)}${retried}`);
  }
  if (s.completion_was_placeholder === true) {
    lines.push(`  completion: ${YELLOW('placeholder URL — no Prolific redirect')}`);
  }
  return lines.join('\n');
}

function renderAggregate(agg) {
  const lines = [];
  lines.push(BOLD('\n=== Batch summary ==='));
  lines.push(`  participants:        ${agg.n_participants}`);
  lines.push(
    `  counted in sample:   ${agg.n_counted_participants}  (not counted: ${agg.n_not_counted_pilot} pilot, ${agg.n_not_counted_preview} preview / no Prolific PID)`
  );
  lines.push(`  build_id:            ${agg.build_ids.join(', ')}`);
  lines.push(`  schema_version:      ${agg.schema_versions.join(', ')}`);
  lines.push(`  median duration:     ${formatMin(agg.median_duration_min)}`);
  lines.push(
    `  completed / retained: ${agg.n_completed} / ${agg.n_retained}  (excluded ${agg.n_excluded_any}, ${formatPct(agg.exclusion_rate_any)} of completed)  ${DIM('[pre-reg estimate: 25–35%]')}`
  );
  lines.push(
    `  attention-excluded:  ${agg.n_excluded}/${agg.n_participants} (${formatPct(agg.exclusion_rate)})`
  );
  lines.push(
    `  not counted:         ${agg.n_incomplete} incomplete (no completion row), ${agg.n_screened_out} screened out at collection`
  );
  const d = agg.sampling_decision;
  const plan = SAMPLING_PLAN;
  const next = {
    collect: `keep recruiting: ${d.recruit} more completions to reach ${plan.target}`,
    stop: `stop recruiting: retained N ≥ ${plan.retainedMinimum}`,
    recruit_batch: `recruit another batch of ${d.recruit} completions`,
    stop_at_maximum: `stop: ${plan.maximum} completions reached with retained N < ${plan.retainedMinimum} (underpowered)`,
  }[d.action];
  lines.push(`  sampling plan:       ${BOLD(next)}`);
  if (agg.issues.length === 0) {
    lines.push(`\n  ${GREEN('✓')} no aggregate issues flagged`);
  } else {
    lines.push('\n  flagged issues:');
    for (const i of agg.issues) {
      const tag = i.severity === 'error' ? RED('✗') : YELLOW('!');
      lines.push(`    ${tag} [${i.code}] ${i.message}`);
    }
  }
  return lines.join('\n');
}

function formatMin(min) {
  if (!Number.isFinite(min)) return '?';
  return `${min.toFixed(1)} min`;
}

function formatPct(p) {
  if (!Number.isFinite(p)) return '?';
  return `${(p * 100).toFixed(1)}%`;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.paths.length === 0) {
    console.error('pilot-summary: no input paths supplied');
    console.error('usage: node scripts/pilot-summary.js [--json] <file-or-dir> [<file-or-dir>...]');
    process.exit(2);
  }
  const expanded = expandPaths(opts.paths);
  if (expanded.length === 0) {
    console.error('pilot-summary: no .json files found under supplied paths');
    process.exit(2);
  }

  /* One summary per participant (Prolific PID): the files of a session are
   * pooled first. A file is not a participant. */
  const { participants: perParticipant, errors, report } = loadParticipants(expanded);
  for (const e of errors) console.error(`pilot-summary: cannot read ${e.path}: ${e.error}`);
  if (perParticipant.length === 0) {
    console.error('pilot-summary: no participant data could be read');
    process.exit(1);
  }

  /* Auto-detect pilot vs main: if the majority of dumps carry is_pilot_run
   * we'll flag the minority as anomalous. */
  const pilotShare = perParticipant.filter((s) => s.is_pilot_run).length / perParticipant.length;
  const expectPilot = perParticipant.length === 0 ? null : pilotShare >= 0.5 ? true : false;
  const agg = aggregate(perParticipant, { expectPilot });
  for (const e of errors) {
    agg.issues.push({
      severity: 'error',
      code: 'UNREADABLE_FILE',
      message: `${e.path}: ${e.error}`,
    });
  }
  agg.files_read = expanded.length - errors.length;
  agg.rows_read = report.rows_read;
  agg.duplicate_rows_dropped = report.duplicates_dropped;

  /* Show codes, not Prolific ids or file names (see the header). */
  if (!opts.keepPid) {
    const { salt } = resolveSalt({ saltFile: opts.saltFile });
    const coder = makeCoder(salt);
    const replacements = new Map();
    for (const s of perParticipant) {
      const pid = s.prolific_pid;
      if (pid) replacements.set(pid, coder.participant(pid));
      if (s.session_id) replacements.set(s.session_id, coder.session(s.session_id));
    }
    for (const [i, e] of errors.entries()) replacements.set(e.path, `input file ${i + 1}`);
    const scrub = makeScrubber(replacements);
    for (let i = 0; i < perParticipant.length; i++) {
      const s = perParticipant[i];
      const code = s.prolific_pid ? coder.participant(s.prolific_pid) : '(unknown)';
      perParticipant[i] = scrub({ ...s, source: `${code} (${s.n_files ?? '?'} file(s))` });
    }
    for (const [i, e] of errors.entries()) {
      errors[i] = { ...e, path: `input file ${i + 1}`, error: scrub(e.error) };
    }
    const scrubbed = scrub(agg);
    for (const k of Object.keys(agg)) delete agg[k];
    Object.assign(agg, scrubbed);
  }

  if (opts.jsonOutput) {
    console.log(JSON.stringify({ perParticipant, aggregate: agg }, null, 2));
    process.exit(agg.issues.some((i) => i.severity === 'error') ? 1 : 0);
  }

  for (const s of perParticipant) {
    console.log(renderPerParticipant(s));
  }
  console.log(renderAggregate(agg));
  process.exit(agg.issues.some((i) => i.severity === 'error') ? 1 : 0);
}

/* Only run main() when invoked as a CLI; importing the module for tests
 * (which we do in tests/pilot-summary.test.js) should not trigger anything. */
const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  main(process.argv).catch((err) => {
    console.error('pilot-summary: unexpected error', err);
    process.exit(1);
  });
}
