/**
 * Participant-level rules, one implementation for the batch-decision tool
 * (`pilot-summary.js`) and the exporter (`csv-export.js`).
 *
 * Everything here is a pure function of the raw rows of a participant, so the
 * sample-size decision and the analysis tables cannot disagree about who is
 * completed, excluded or retained. The definitions follow
 * `pre-reg/pre-reg.json` (sampling_plan and exclusion_rules):
 *
 *   completed  a run that wrote the `completion_redirect` row (the row written
 *              when the Prolific completion link is opened) and did not end at a
 *              collection-time screen-out (no row carries `exit_reason`).
 *              Sessions with data but no completion row are `incomplete`; a
 *              participant whose only runs ended at a screen-out is `screened_out`.
 *              Neither counts towards the sample size.
 *   retained   completed and not excluded by any of the three participant-level
 *              rules: `screen_calibration_inconsistent`,
 *              `instructional_attention_checks`, `single_task_floor`.
 *
 * Runs. A page reload starts a new run (new `run_id`) under the same Prolific
 * PID, with an identical schedule. One participant is one PID. The analysed run
 * is the completed run (if several completed, the one with the most rows, then
 * the smallest run_id). The three rules are evaluated on the analysed run only,
 * so an earlier, partial run cannot change them. A participant who reloaded
 * after main-block trials had begun is flagged (`reload_after_main`); the
 * pre-registration has no rule for it, so the flag changes nothing in `retained`.
 *
 * Attention checks. The practice loop repeats all three checks whenever practice
 * accuracy is below criterion, so a check can be administered more than once.
 * A check counts as failed if it was failed the FIRST time it was shown (the
 * pre-registered threshold is "more than 1 of the 3 checks"). The count on the
 * final administration is reported next to it, so the analyst can see both.
 */
import { config } from '../src/config.js';
import { scoreAttentionChecks } from '../src/attention-scoring.js';

/** pre-reg.json -> exclusion_rules -> single_task_floor: accuracy <= .55 in D_only or T_only. */
export const SINGLE_TASK_FLOOR = 0.55;

/** The two main blocks; practice rows carry a different `block_label`. */
export const MAIN_BLOCK_LABELS = Object.freeze(['main_a', 'main_b']);

/** pre-reg.json -> exclusion_rules -> instructional_attention_checks: fails > 1 of 3. */
export const ATTENTION_MAX_FAILURES = config.attention_checks.instruction_max_failures;

/** Five trial types, `main_trials_per_type` each. */
export const EXPECTED_MAIN_TRIALS = 5 * config.blocks.main_trials_per_type;

/**
 * Screen-calibration consistency tolerance used only when a row carries
 * neither `status` nor `consistent`. Real rows always carry `status`; this
 * value is pinned against `screen.js` in tests/participant-rules.test.js.
 */
export const CALIBRATION_FALLBACK_TOLERANCE = 0.05;

const MAIN_PHASE_ENCODING = /^(d_only|t_only|i_only|i_d|i_t)_encoding$/;

/* ---------- Attention checks ---------- */

/**
 * Score the typed-instruction attention checks over DISTINCT checks, with the
 * same function the runtime uses for the `attention_check_summary` row.
 *
 * @param {object[]} rows  rows in chronological order (any phase)
 * @param {{maxFailures?: number}} [opts]
 */
export function summariseAttention(rows, { maxFailures = ATTENTION_MAX_FAILURES } = {}) {
  return scoreAttentionChecks(rows, maxFailures);
}

/* ---------- Screen calibration ---------- */

/**
 * Outcome of the LAST calibration attempt. The runtime writes the outcome with the
 * call-function plugin, which nests the returned object under `value`; the
 * download fallback and older fixtures carry the fields at the top level, so
 * both shapes are read.
 *
 * @returns {{status: string|null, accepted: boolean|null, consistent: boolean|null,
 *            rel_diff: number|null}}
 */
export function calibrationOutcome(rows, { tolerance = CALIBRATION_FALLBACK_TOLERANCE } = {}) {
  const outcomes = (rows ?? [])
    .filter((r) => r?.phase === 'screen_calibration_outcome')
    .map((r) => r.value ?? r);
  const o = outcomes[outcomes.length - 1];
  if (!o) return { status: null, accepted: null, consistent: null, rel_diff: null };
  const relDiff = Number.isFinite(o.rel_diff) ? o.rel_diff : null;
  const accepted = typeof o.accepted === 'boolean' ? o.accepted : null;
  const consistent =
    typeof o.consistent === 'boolean'
      ? o.consistent
      : relDiff !== null
        ? relDiff <= tolerance
        : null;
  let status = typeof o.status === 'string' ? o.status : null;
  if (status === null && accepted !== null && consistent !== null) {
    status = !accepted ? 'retry' : consistent ? 'ok' : 'inconsistent_accepted';
  }
  return { status, accepted, consistent, rel_diff: relDiff };
}

/* ---------- Single-task accuracy ---------- */

/**
 * Recognition accuracy of one single-task condition over the main blocks:
 * correct probes divided by recorded probes (an unanswered probe is a miss).
 * `n` is the number of recorded probes; `accuracy` is null without any.
 */
export function mainAccuracy(rows, phase) {
  const probes = (rows ?? []).filter(
    (r) => r?.phase === phase && MAIN_BLOCK_LABELS.includes(r.block_label)
  );
  if (probes.length === 0) return { n: 0, accuracy: null };
  return {
    n: probes.length,
    accuracy: probes.filter((r) => r.probe_correct === true).length / probes.length,
  };
}

const belowFloor = (a) => a !== null && a <= SINGLE_TASK_FLOOR;

/* ---------- Upload status ---------- */

const UPLOAD_PHASES = Object.freeze(['upload_session_end', 'upload_retry_result']);

/**
 * Upload outcome of one run.
 *   first   status of the end-of-session upload (`upload_session_end`);
 *   final   status of the LATEST upload row of either kind, so a retry that
 *           delivered everything reads 'uploaded' although the first attempt
 *           was 'partial' (the end-of-session row is never rewritten);
 *   retries number of `upload_retry_result` rows.
 * Rows are taken in `seq` order (input order when `seq` is missing).
 */
export function uploadStatuses(rows) {
  const ups = (rows ?? [])
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => UPLOAD_PHASES.includes(r?.phase))
    .sort((a, b) =>
      Number.isFinite(a.r.seq) && Number.isFinite(b.r.seq)
        ? a.r.seq - b.r.seq || a.i - b.i
        : a.i - b.i
    )
    .map(({ r }) => r);
  const first = ups.find((r) => r.phase === 'upload_session_end');
  const last = ups[ups.length - 1];
  return {
    first: first?.status ?? null,
    final: last?.status ?? null,
    retries: ups.filter((r) => r.phase === 'upload_retry_result').length,
  };
}

/** Number of distinct main-block trials that wrote an encoding row. */
export function countMainTrials(rows) {
  const seen = new Set();
  for (const r of rows ?? []) {
    if (!MAIN_PHASE_ENCODING.test(r?.phase ?? '')) continue;
    if (!MAIN_BLOCK_LABELS.includes(r.block_label)) continue;
    seen.add(`${r.phase}|${r.block_label}|${r.trial_index_in_block}|${r.trial_uid ?? ''}`);
  }
  return seen.size;
}

/* ---------- One run ---------- */

/**
 * Rules for the rows of ONE run (or of a download-fallback export).
 *
 * @returns the exclusion status as `{ calibration_status, d_only_accuracy,
 *   t_only_accuracy, reasons, excluded, completed, screened_out, retained }`
 *   plus the `attention` summary and the accuracy counts.
 */
export function evaluateRun(rows, opts = {}) {
  const attention = opts.attention ?? summariseAttention(rows, opts);
  const cal = calibrationOutcome(rows, opts);
  const d = mainAccuracy(rows, 'd_only_probe');
  const t = mainAccuracy(rows, 't_only_probe');
  const reasons = [];
  if (cal.status === 'inconsistent_accepted') reasons.push('screen_calibration_inconsistent');
  if (attention.excluded) reasons.push('instructional_attention_checks');
  if (belowFloor(d.accuracy) || belowFloor(t.accuracy)) reasons.push('single_task_floor');
  const screenedOut = (rows ?? []).some((r) => r?.exit_reason);
  const hasCompletionRow = (rows ?? []).some((r) => r?.phase === 'completion_redirect');
  const completed = !screenedOut && hasCompletionRow;
  return {
    calibration_status: cal.status,
    calibration: cal,
    d_only_accuracy: d.accuracy,
    t_only_accuracy: t.accuracy,
    d_only_n: d.n,
    t_only_n: t.n,
    d_only_floor: belowFloor(d.accuracy),
    t_only_floor: belowFloor(t.accuracy),
    reasons,
    excluded: reasons.length > 0,
    completed,
    screened_out: screenedOut,
    has_completion_row: hasCompletionRow,
    retained: completed && reasons.length === 0,
    attention,
    upload: uploadStatuses(rows),
  };
}

/* ---------- One participant (all runs) ---------- */

/**
 * @param {{run_id: string|null, rows: object[], session?: object}[]} runs
 *        the runs of ONE Prolific PID, rows de-duplicated and in seq order
 *        (see dump-loader.js)
 * @returns {object} participant summary; see the file header for the definitions
 */
export function summariseParticipantRuns(runs, opts = {}) {
  const evaluated = runs.map((run) => {
    const rows = run.rows ?? [];
    return {
      run,
      rows,
      ev: evaluateRun(rows, opts),
      n_main_trials: countMainTrials(rows),
      has_main_rows: rows.some((r) => MAIN_BLOCK_LABELS.includes(r?.block_label)),
    };
  });
  const byRowsThenId = (a, b) =>
    b.rows.length - a.rows.length || String(a.run.run_id).localeCompare(String(b.run.run_id));
  const completedRuns = evaluated.filter((e) => e.ev.completed).sort(byRowsThenId);
  const analysed = completedRuns[0] ?? null;
  /* Without a completed run the participant is shown through the run with the
   * most rows, for information only; nothing below counts them. */
  const shown = analysed ?? [...evaluated].sort(byRowsThenId)[0] ?? null;
  const anyScreenedOut = evaluated.some((e) => e.ev.screened_out);
  const status = analysed
    ? analysed.ev.excluded
      ? 'excluded'
      : 'retained'
    : anyScreenedOut
      ? 'screened_out'
      : 'incomplete';
  const ev = shown?.ev ?? evaluateRun([], opts);
  const reloadAfterMain =
    analysed !== null && evaluated.some((e) => e !== analysed && e.has_main_rows);
  const mainTrials = shown?.n_main_trials ?? 0;
  return {
    status,
    completed: analysed !== null,
    screened_out: analysed === null && anyScreenedOut,
    retained: status === 'retained',
    excluded: status === 'excluded',
    reasons: analysed ? ev.reasons : [],
    /* The three rule inputs, from the analysed run (or the run shown). */
    attention: ev.attention,
    calibration_status: ev.calibration_status,
    d_only_accuracy: ev.d_only_accuracy,
    t_only_accuracy: ev.t_only_accuracy,
    d_only_n: ev.d_only_n,
    t_only_n: ev.t_only_n,
    d_only_floor: ev.d_only_floor,
    t_only_floor: ev.t_only_floor,
    n_runs: evaluated.length,
    run_ids: evaluated.map((e) => e.run.run_id ?? null),
    analysed_run_id: analysed ? (analysed.run.run_id ?? null) : null,
    multiple_completed_runs: completedRuns.length > 1,
    reload_after_main: reloadAfterMain,
    main_trials_present: mainTrials,
    data_incomplete: analysed !== null && mainTrials < EXPECTED_MAIN_TRIALS,
    upload_status_first: ev.upload?.first ?? null,
    upload_status_final: ev.upload?.final ?? null,
    upload_retries: ev.upload?.retries ?? 0,
    n_rows: shown?.rows.length ?? 0,
    /* The rows of the run the summary describes; callers derive their own
     * statistics from them and should not serialise them. */
    shown_rows: shown?.rows ?? [],
  };
}

/**
 * Which sample a session belongs to, for the sampling-plan counts:
 *   - 'preview': no Prolific PID at all (a researcher opening the link without the
 *     Prolific parameters, a LOCAL_ session id, an old dump). Never counted.
 *   - 'pilot': the session was run with the pilot flag (?pilot=1). Counted only
 *     when the batch being summarised is itself a pilot batch.
 *   - 'real': everything else.
 * `is_preview` alone does not make a session a preview: it is also set when only
 * SESSION_ID is missing from the URL of a genuine participant, who has a PID and
 * must not be dropped silently (pilot-summary warns about that combination).
 *
 * @param {object|null|undefined} session  the session meta (params.prolific_pid, is_pilot_run)
 * @returns {'real'|'pilot'|'preview'}
 */
export function sampleClass(session) {
  if (!session?.params?.prolific_pid) return 'preview';
  if (session?.is_pilot_run === true) return 'pilot';
  return 'real';
}
