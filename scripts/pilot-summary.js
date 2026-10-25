#!/usr/bin/env node
/**
 * Pilot-data summariser.
 *
 * Ingests one or more JSON files (or a directory of them) — either the
 * download-fallback exports from `uploader.downloadAsJson` or server-side
 * dumps in the same shape — and reports per-participant + aggregate stats.
 *
 * Usage:
 *   node scripts/pilot-summary.js path/to/dump.json
 *   node scripts/pilot-summary.js path/to/dump1.json path/to/dump2.json ...
 *   node scripts/pilot-summary.js path/to/dir/                  # walks directory
 *   node scripts/pilot-summary.js --json path/to/dir/           # machine-readable
 *
 * Per-participant report:
 *   - prolific_pid, build_id, schema_version, is_pilot_run, pilot_label
 *   - session_started_at_iso, session_duration_min (computed from rt sums)
 *   - n_total_rows, n_main_rows, n_practice_rows
 *   - attention check: n typed checks, passed, failed, excluded flag
 *   - participant-level exclusions (screen calibration, attention checks, single-task
 *     floor), `completed` and `retained` flags
 *   - upload_summary status (uploaded / partial / no_endpoint / nothing_to_upload)
 *   - completion redirect: was_placeholder boolean, redirect_url
 *
 * Aggregate report:
 *   - n_participants, n_completed, n_retained, and the exclusion rate among completed
 *     sessions (all three participant-level rules) vs the 25-35% pre-reg estimate
 *   - the sampling-plan decision (collect / recruit another batch / stop / stop at the
 *     maximum) computed from pre-reg.json -> sampling_plan; no p-values or Bayes factors
 *   - build_id homogeneity (all sessions must share the same build_id, else flagged)
 *   - schema_version homogeneity
 *   - pilot-flag homogeneity (pilot dumps should all carry is_pilot_run=true)
 *   - condition distribution: counts per (phase × probe_type) pair to spot-check
 *     counterbalance integrity. Aggregate counts should approach 24/type for the
 *     full main batch; per-participant we expect 24/type/participant per design.
 *   - median session duration (design estimate 110 min, pre-reg.json design_summary)
 *   - schema-drift detection: any row whose top-level keys diverge from the
 *     locked vocabulary in `schemas/trial.schema.json`
 *
 * Exit code: 0 on no flagged issues; 1 if any aggregate issue is detected
 * (build-id heterogeneity, missing pilot flag in pilot mode, etc.).
 *
 * Pure Node (>=20) — no browser deps, no external packages, runs in CI.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

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

/* pre-reg.json -> exclusion_rules -> single_task_floor: accuracy <= .55 in D_only or T_only. */
export const SINGLE_TASK_FLOOR = 0.55;

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
  for (const a of args) {
    if (a === '--json') jsonOutput = true;
    else if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      paths.push(a);
    }
  }
  return { paths, jsonOutput };
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
 * Compute a per-participant summary from a parsed JSON dump.
 *
 * Accepts either a download-fallback export ({ session, n_rows, rows, ... })
 * or a chunk envelope ({ session_id, prolific_pid, ..., rows, ... }). Both
 * carry session-level fields and a `rows` array.
 */
export function summariseDump(parsed, { sourceLabel } = {}) {
  /* Some dumps may bundle multiple chunks — flatten if `chunks` is present. */
  const session = parsed.session ?? extractSessionFromChunkEnvelope(parsed);
  const rows = parsed.rows ?? [];

  const phaseCounts = countByKey(rows, 'phase');
  const attention = summariseAttentionChecks(rows);
  const exclusions = summariseExclusions(rows, attention);
  const uploadSummaryRow = rows.find((r) => r.phase === 'upload_session_end');
  const completionRow = rows.find((r) => r.phase === 'completion_redirect');
  const nMainRows = rows.filter((r) => MAIN_BLOCK_LABELS.includes(r.block_label)).length;
  const nPracticeRows = rows.filter((r) => r.block_label === 'practice').length;
  const probeMatrix = summariseProbeMatrix(rows);

  return {
    source: sourceLabel,
    prolific_pid: session?.params?.prolific_pid ?? parsed.prolific_pid ?? null,
    build_id: session?.build_id ?? parsed.build_id ?? null,
    schema_version: session?.schema_version ?? parsed.schema_version ?? null,
    is_pilot_run: session?.is_pilot_run ?? parsed.is_pilot_run ?? false,
    pilot_label: session?.pilot_label ?? parsed.pilot_label ?? null,
    is_preview: session?.params?.is_preview ?? parsed.is_preview ?? null,
    started_at_iso: session?.started_at_iso ?? parsed.started_at_iso ?? null,
    session_duration_min: estimateSessionDurationMin(rows),
    n_total_rows: rows.length,
    n_main_rows: nMainRows,
    n_practice_rows: nPracticeRows,
    phase_counts: phaseCounts,
    probe_matrix: probeMatrix,
    attention,
    exclusions,
    completed: exclusions.completed,
    retained: exclusions.retained,
    upload_status: uploadSummaryRow?.status ?? null,
    completion_was_placeholder: completionRow?.completion_was_placeholder ?? null,
    completion_redirect_url: completionRow?.completion_redirect_url ?? null,
  };
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

const MAIN_BLOCK_LABELS = Object.freeze(['main_a', 'main_b']);

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
 * Aggregate attention-check pass/fail. Reads from `attention_check` rows directly
 * (not from the `attention_check_summary` row, which may be missing on aborted
 * sessions). Strict `>` comparator matches `evaluateAttentionChecks` in the
 * runtime; threshold defaults to 1
 */
export function summariseAttentionChecks(rows, { maxFailures = 1 } = {}) {
  const checks = rows.filter((r) => r.phase === 'attention_check');
  const total = checks.length;
  const passed = checks.filter((r) => r.attention_check_passed === true).length;
  const failed = checks.filter((r) => r.attention_check_passed === false).length;
  return {
    total,
    passed,
    failed,
    threshold: maxFailures,
    excluded: failed > maxFailures,
  };
}

/**
 * Participant-level exclusion status, as in pre-reg.json -> exclusion_rules:
 * `screen_calibration_inconsistent` (accepted calibration with status
 * `inconsistent_accepted`), `instructional_attention_checks` (more than one failed)
 * and `single_task_floor` (main-block accuracy <= .55 in D_only or in T_only).
 * `completed` means the session reached the completion redirect and did not end at a
 * collection-time screen-out; only completed sessions count toward the sample size.
 * `retained` is completed and not excluded by any of the three rules.
 */
export function summariseExclusions(rows, attention = summariseAttentionChecks(rows)) {
  const outcomes = rows.filter((r) => r.phase === 'screen_calibration_outcome' && r.accepted);
  const calibrationStatus = outcomes.length > 0 ? outcomes[outcomes.length - 1].status : null;
  const accuracy = (phase) => {
    const probes = rows.filter(
      (r) => r.phase === phase && MAIN_BLOCK_LABELS.includes(r.block_label)
    );
    if (probes.length === 0) return null;
    return probes.filter((r) => r.probe_correct === true).length / probes.length;
  };
  const dOnly = accuracy('d_only_probe');
  const tOnly = accuracy('t_only_probe');
  const reasons = [];
  if (calibrationStatus === 'inconsistent_accepted')
    reasons.push('screen_calibration_inconsistent');
  if (attention.excluded) reasons.push('instructional_attention_checks');
  const belowFloor = (a) => a !== null && a <= SINGLE_TASK_FLOOR;
  if (belowFloor(dOnly) || belowFloor(tOnly)) reasons.push('single_task_floor');
  const screenedOut = rows.some((r) => r.exit_reason);
  const completed = !screenedOut && rows.some((r) => r.phase === 'completion_redirect');
  return {
    calibration_status: calibrationStatus,
    d_only_accuracy: dOnly,
    t_only_accuracy: tOnly,
    reasons,
    excluded: reasons.length > 0,
    completed,
    retained: completed && reasons.length === 0,
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
  const nExcluded = perParticipant.filter((s) => s.attention.excluded).length;
  const exclusionRate = perParticipant.length > 0 ? nExcluded / perParticipant.length : null;
  const completedSessions = perParticipant.filter((s) => s.completed);
  const nCompleted = completedSessions.length;
  const nRetained = completedSessions.filter((s) => s.retained).length;
  const nExcludedAny = nCompleted - nRetained;
  const decision = samplingDecision(nCompleted, nRetained);
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
  return {
    n_participants: perParticipant.length,
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
    ? YELLOW('not completed (not counted)')
    : s.retained
      ? GREEN('retained')
      : RED(`excluded: ${s.exclusions.reasons.join(', ')}`);
  lines.push(
    `  attention: ${s.attention.passed}/${s.attention.total} pass, ${s.attention.failed} fail (>${s.attention.threshold} ⇒ exclude) → ${excl}`
  );
  lines.push(`  sample status: ${status}`);
  if (s.upload_status) {
    const colour = s.upload_status === 'uploaded' ? GREEN : YELLOW;
    lines.push(`  upload: ${colour(s.upload_status)}`);
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
  lines.push(`  build_id:            ${agg.build_ids.join(', ')}`);
  lines.push(`  schema_version:      ${agg.schema_versions.join(', ')}`);
  lines.push(`  median duration:     ${formatMin(agg.median_duration_min)}`);
  lines.push(
    `  completed / retained: ${agg.n_completed} / ${agg.n_retained}  (excluded ${agg.n_excluded_any}, ${formatPct(agg.exclusion_rate_any)} of completed)  ${DIM('[pre-reg estimate: 25–35%]')}`
  );
  lines.push(
    `  attention-excluded:  ${agg.n_excluded}/${agg.n_participants} (${formatPct(agg.exclusion_rate)})`
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

  const perParticipant = expanded.map((p) => {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'));
    return summariseDump(parsed, { sourceLabel: p });
  });

  /* Auto-detect pilot vs main: if the majority of dumps carry is_pilot_run
   * we'll flag the minority as anomalous. */
  const pilotShare = perParticipant.filter((s) => s.is_pilot_run).length / perParticipant.length;
  const expectPilot = perParticipant.length === 0 ? null : pilotShare >= 0.5 ? true : false;
  const agg = aggregate(perParticipant, { expectPilot });

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
