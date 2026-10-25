/**
 * The batch-decision tool and the exporter on the file layout the live uploader
 * really produces.
 *
 * A session does not upload one file: it uploads about eight (one per bucket,
 * checkpoint files, a tail file). The exclusion rows, the calibration outcome and
 * the `completion_redirect` row end up in different files, and a reload gives a
 * second run under the same Prolific PID. `scripts/pilot-summary.js` once counted
 * every file as a participant, so on real data it reported 40 "participants" for 5
 * sessions and called all of them retained. These tests drive simulated sessions
 * through the real bucketing (and, for one participant, through the real
 * `uploadPendingData` + `uploadTail`) into a folder and check participants,
 * completed, retained and the batch decision against the known truth.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { simulateOne } from '../scripts/simulate-pilot.js';
import {
  partitionRowsIntoBuckets,
  buildBucketEnvelope,
  uploadPendingData,
  uploadTail,
  _resetCheckpointForTests,
} from '../src/uploader.js';
import { initStorage, _resetStorageForTests, appendTrialRow, getRunId } from '../src/storage.js';
import { loadParticipants, aggregate } from '../scripts/pilot-summary.js';
import { loadAndFlattenDumps } from '../scripts/dump-loader.js';
import { composeExport } from '../scripts/csv-export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CLI = join(REPO_ROOT, 'scripts/pilot-summary.js');

const IDS = ['ac1_colour', 'ac2_word', 'ac3_number'];

function sessionFor(pid, runLabel) {
  return {
    params: { session_id: `sess_${pid}`, prolific_pid: pid, study_id: 'STUDY', is_preview: false },
    prng_seed_uint32: 1,
    schema_version: '1.2.0',
    build_id: 'v1',
    is_pilot_run: true,
    pilot_label: 'bucket-test',
    started_at_iso: '2000-01-01T10:00:00Z',
    user_agent: `test/${runLabel}`,
  };
}

/**
 * Rows of one simulated session. `attention` is a list of administrations, each
 * a list of three booleans (passed), in presentation order: two entries model
 * the practice re-loop. The completion row is returned separately because the live
 * uploader writes it AFTER the final bucket upload, so it only ever reaches the
 * tail file.
 */
function simSession({ seed, pid, accuracy = 0.85, calibration, attention, until, exit }) {
  const sim = simulateOne({ seed, pid, accuracy, calibration, pilotLabel: 'bucket-test' });
  let rows = sim.rows.filter((r) => r.phase !== 'attention_check_summary');
  const at = rows.findIndex((r) => r.phase === 'demographics') + 1;
  const attRows = (attention ?? [[true, true, true]]).flatMap((pass) =>
    pass.map((ok, i) => ({
      phase: 'attention_check',
      attention_check_id: IDS[i],
      attention_check_raw: ok ? 'right' : 'wrong',
      attention_check_passed: ok,
    }))
  );
  rows = [...rows.slice(0, at), ...attRows, ...rows.slice(at)];
  const completion = rows.filter((r) => r.phase === 'completion_redirect');
  rows = rows.filter((r) => r.phase !== 'completion_redirect');
  if (until) rows = rows.slice(0, until);
  if (exit) rows = [...rows.slice(0, 12), { phase: 'timing_probe_fail', exit_reason: exit }];
  return { rows, completion: until || exit ? [] : completion };
}

function numbered(rows, runId) {
  return rows.map((r, i) => ({ ...r, seq: i + 1, run_id: runId }));
}

/** Write the files of one run the way the live uploader lays them out. */
function writeRun(dir, pid, runId, rows, completion) {
  const session = sessionFor(pid, runId);
  const body = numbered(rows, runId);
  const parts = partitionRowsIntoBuckets(body).filter((p) => p.rows.length > 0);
  const files = [];
  parts.forEach((p, i) => {
    const env = buildBucketEnvelope({
      session,
      bucket: p.bucket,
      bucketIndex: i,
      totalBuckets: parts.length,
      rows: p.rows,
    });
    env.run_id = runId;
    files.push([`${session.params.session_id}__${runId}__${p.bucket.label}.json`, env]);
  });
  /* A checkpoint file repeats rows that a bucket file also holds. */
  const ckpt = buildBucketEnvelope({
    session,
    bucket: { id: 'checkpoint', label: 'ckpt_1-60' },
    bucketIndex: 0,
    totalBuckets: 1,
    rows: body.slice(0, 60),
  });
  ckpt.run_id = runId;
  files.push([`${session.params.session_id}__${runId}__ckpt_1-60.json`, ckpt]);
  if (completion.length > 0) {
    const tailRows = completion.map((r, i) => ({ ...r, seq: body.length + i + 1, run_id: runId }));
    const tail = buildBucketEnvelope({
      session,
      bucket: { id: 'tail', label: `tail_${body.length + 1}` },
      bucketIndex: 0,
      totalBuckets: 1,
      rows: tailRows,
    });
    tail.run_id = runId;
    files.push([`${session.params.session_id}__${runId}__tail.json`, tail]);
  }
  for (const [name, env] of files) writeFileSync(join(dir, name), JSON.stringify(env));
  return files.length;
}

function csvRows(text) {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',').map((c) => c.replace(/"/g, ''));
  return lines.map((l) => {
    const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, ''));
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? '').replace(/^"|"$/g, '')]));
  });
}

let dir;
let nFiles = 0;

/* pid -> expected truth */
const TRUTH = {
  CLEAN_1: { status: 'retained' },
  CLEAN_2: { status: 'retained' },
  CAL_INCONSISTENT: { status: 'excluded', reasons: ['screen_calibration_inconsistent'] },
  LOW_ACCURACY: { status: 'excluded', reasons: ['single_task_floor'] },
  ATTENTION_2_FAILS: { status: 'excluded', reasons: ['instructional_attention_checks'] },
  /* the practice loop repeated all three checks and the SAME check was missed once
   * in each pass: one distinct failure, not two */
  LOOP_SAME_MISS_TWICE: { status: 'retained', failedFirst: 1, failedFinal: 1, administrations: 6 },
  /* two checks missed first time, both right the second time: excluded on first
   * administration, not on the final one */
  LOOP_FIRST_FAILS: {
    status: 'excluded',
    reasons: ['instructional_attention_checks'],
    failedFirst: 2,
    failedFinal: 0,
    administrations: 6,
  },
  RELOADED: { status: 'retained', runs: 2 },
  INCOMPLETE: { status: 'incomplete' },
  SCREENED_OUT: { status: 'screened_out' },
  REAL_UPLOADER: { status: 'retained' },
};

beforeAll(async () => {
  /* PILOT_BUCKETS_DIR keeps the generated folder, to inspect it or to run the CLIs by hand */
  dir = process.env.PILOT_BUCKETS_DIR ?? mkdtempSync(join(tmpdir(), 'pilot-buckets-'));
  if (process.env.PILOT_BUCKETS_DIR) mkdirSync(dir, { recursive: true });
  const w = (pid, seed, opts = {}, runId = `run_${pid}`) => {
    const { rows, completion } = simSession({ seed, pid, ...opts });
    nFiles += writeRun(dir, pid, runId, rows, completion);
  };
  w('CLEAN_1', 'b-clean-1');
  w('CLEAN_2', 'b-clean-2');
  w('CAL_INCONSISTENT', 'b-cal', { calibration: 'inconsistent_accepted' });
  w('LOW_ACCURACY', 'b-low', { accuracy: 0.3 });
  w('ATTENTION_2_FAILS', 'b-att', { attention: [[false, false, true]] });
  w('LOOP_SAME_MISS_TWICE', 'b-loop-1', {
    attention: [
      [true, false, true],
      [true, false, true],
    ],
  });
  w('LOOP_FIRST_FAILS', 'b-loop-2', {
    attention: [
      [false, false, true],
      [true, true, true],
    ],
  });
  w('INCOMPLETE', 'b-inc', { until: 300 });
  w('SCREENED_OUT', 'b-scr', { exit: 'timing_check_failed' });

  /* A reload: a partial first run with main-block rows, then a full second run. Both
   * runs number their rows from 1, so only (run_id, seq) tells them apart. */
  const first = simSession({ seed: 'b-reload', pid: 'RELOADED', until: 260 });
  nFiles += writeRun(dir, 'RELOADED', 'run_r1', first.rows, first.completion);
  const second = simSession({ seed: 'b-reload', pid: 'RELOADED' });
  nFiles += writeRun(dir, 'RELOADED', 'run_r2', second.rows, second.completion);

  /* One participant through the REAL storage + uploader + tail. */
  _resetStorageForTests();
  _resetCheckpointForTests();
  await initStorage({ backend: 'memory' });
  const real = simSession({ seed: 'b-real', pid: 'REAL_UPLOADER' });
  /* the real storage assigns seq and run_id itself */
  const asWritten = (r) => {
    const rest = { ...r };
    delete rest.seq;
    delete rest.run_id;
    return rest;
  };
  for (const r of real.rows) await appendTrialRow(asWritten(r));
  const posted = [];
  const fetchImpl = async (_url, init) => {
    posted.push(JSON.parse(init.body));
    return { ok: true, status: 200, statusText: 'OK', text: async () => '' };
  };
  const common = {
    session: sessionFor('REAL_UPLOADER', getRunId()),
    endpoint: 'http://stub.invalid/api/data/',
    datapipeExperimentId: 'TESTEXPERIMENT01',
    fetchImpl,
  };
  const up = await uploadPendingData({
    ...common,
    provider: 'datapipe',
    sleepImpl: async () => {},
  });
  expect(up.status).toBe('uploaded');
  for (const r of real.completion) await appendTrialRow(asWritten(r));
  const tail = await uploadTail(common);
  expect(tail.status).toBe('ok');
  for (const body of posted) {
    writeFileSync(join(dir, body.filename), body.data);
    nFiles += 1;
  }
});

afterAll(() => {
  if (dir && !process.env.PILOT_BUCKETS_DIR) rmSync(dir, { recursive: true, force: true });
});

const allPaths = () =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f))
    .sort();

describe('pilot-summary on bucket / checkpoint / tail files', () => {
  it('writes many files per session (the layout that broke the per-file tool)', () => {
    expect(nFiles).toBeGreaterThan(Object.keys(TRUTH).length * 5);
    expect(allPaths().length).toBe(nFiles);
  });

  it('counts one participant per Prolific PID, not one per file', () => {
    const { participants, errors } = loadParticipants(allPaths());
    expect(errors).toEqual([]);
    expect(participants).toHaveLength(Object.keys(TRUTH).length);
    expect(new Set(participants.map((p) => p.prolific_pid))).toEqual(new Set(Object.keys(TRUTH)));
  });

  it('classifies every participant correctly', () => {
    const { participants } = loadParticipants(allPaths());
    for (const p of participants) {
      const t = TRUTH[p.prolific_pid];
      expect(p.status, p.prolific_pid).toBe(t.status);
      if (t.reasons) expect(p.exclusions.reasons, p.prolific_pid).toEqual(t.reasons);
      if (t.failedFirst !== undefined) {
        expect(p.attention.failed_first, p.prolific_pid).toBe(t.failedFirst);
        expect(p.attention.failed_final, p.prolific_pid).toBe(t.failedFinal);
        expect(p.attention.administrations, p.prolific_pid).toBe(t.administrations);
        expect(p.attention.total, p.prolific_pid).toBe(3);
      }
      if (t.runs) expect(p.n_runs, p.prolific_pid).toBe(t.runs);
    }
  });

  it('the reloaded participant is counted once, from the completed run, and flagged', () => {
    const { participants } = loadParticipants(allPaths());
    const p = participants.find((x) => x.prolific_pid === 'RELOADED');
    expect(p.analysed_run_id).toBe('run_r2');
    expect(p.reload_after_main).toBe(true);
    expect(p.completed).toBe(true);
    /* rows of the partial first run must not leak into the analysed run */
    expect(p.main_trials_present).toBe(120);
    expect(p.data_incomplete).toBe(false);
  });

  it('reports 11 participants, 9 completed, 5 retained, and the batch decision', () => {
    const { participants } = loadParticipants(allPaths());
    const agg = aggregate(participants, { expectPilot: true });
    expect(agg.n_participants).toBe(11);
    expect(agg.n_completed).toBe(9);
    expect(agg.n_retained).toBe(5);
    expect(agg.n_excluded_any).toBe(4);
    expect(agg.n_incomplete).toBe(1);
    expect(agg.n_screened_out).toBe(1);
    expect(agg.n_reloaded_after_main).toBe(1);
    expect(agg.sampling_decision).toEqual({ action: 'collect', recruit: 51 });
    expect(agg.issues.map((i) => i.code)).toContain('RELOAD_AFTER_MAIN_TRIALS');
  });

  it('a completed session with a missing bucket is flagged DATA_INCOMPLETE, not silently retained as full', () => {
    const missing = allPaths().filter((p) => !p.includes('sess_CLEAN_1__run_CLEAN_1__05_t_only'));
    expect(missing.length).toBe(allPaths().length - 1);
    const { participants } = loadParticipants(missing);
    const p = participants.find((x) => x.prolific_pid === 'CLEAN_1');
    /* the 24 T-only trials are gone, except the two a checkpoint file repeats */
    expect(p.main_trials_present).toBeLessThan(120);
    expect(p.main_trials_present).toBeGreaterThanOrEqual(96);
    expect(p.data_incomplete).toBe(true);
    const agg = aggregate(participants, { expectPilot: true });
    expect(agg.n_data_incomplete).toBe(1);
    expect(agg.issues.map((i) => i.code)).toContain('DATA_INCOMPLETE');
  });

  it('the CLI reads the folder by participant', () => {
    const r = spawnSync('node', [CLI, '--json', dir], {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
      /* An explicit salt keeps the run off the per-user default salt file. */
      env: { ...process.env, CSV_EXPORT_SALT: 'pilot-summary-buckets-test-salt-0123456789' },
    });
    const out = JSON.parse(r.stdout);
    expect(out.aggregate.n_participants).toBe(11);
    expect(out.aggregate.n_completed).toBe(9);
    expect(out.aggregate.n_retained).toBe(5);
    expect(out.aggregate.sampling_decision.action).toBe('collect');
    expect(out.perParticipant.every((p) => p.shown_rows === undefined)).toBe(true);
  });
});

describe('the exporter agrees with the batch tool', () => {
  it('PARTICIPANT_SUMMARY.csv has the same completed / retained participants', () => {
    const loaded = loadAndFlattenDumps(allPaths());
    const { files, manifest } = composeExport(loaded.perParticipant, {
      generatedAtIso: '2000-01-01T00:00:00Z',
      loadReport: loaded.report,
    });
    const rows = csvRows(files['PARTICIPANT_SUMMARY.csv']);
    const tool = loadParticipants(allPaths()).participants;
    expect(rows).toHaveLength(tool.length);
    for (const t of tool) {
      const row = rows.find((r) => r.Participant_ID === t.prolific_pid);
      expect(row, t.prolific_pid).toBeDefined();
      expect(row.Status, t.prolific_pid).toBe(t.status);
      expect(row.Completed).toBe(t.completed ? '1' : '0');
      expect(row.Retained).toBe(t.retained ? '1' : '0');
      expect(Number(row.Attention_Checks_Failed_First)).toBe(t.attention.failed_first);
      expect(Number(row.Attention_Checks_Failed_Final)).toBe(t.attention.failed_final);
      expect(Number(row.Attention_Administrations)).toBe(t.attention.administrations);
      expect(Number(row.Run_Count)).toBe(t.n_runs);
      if (t.completed) {
        const rs = t.exclusions.reasons;
        expect(row.Exclusion_Reasons).toBe(rs.join(';'));
        /* each rule's own column, not only the joined string */
        const flag = (rule) => (rs.includes(rule) ? '1' : '0');
        expect(row.Exclude_Screen_Cal_Inconsistent, t.prolific_pid).toBe(
          flag('screen_calibration_inconsistent')
        );
        expect(row.Exclude_Attention_Checks, t.prolific_pid).toBe(
          flag('instructional_attention_checks')
        );
        expect(row.Exclude_Single_Task_Floor, t.prolific_pid).toBe(flag('single_task_floor'));
        expect(row.Excluded_Participant_Level, t.prolific_pid).toBe(rs.length > 0 ? '1' : '0');
      } else {
        expect(row.Exclusion_Reasons).toBe('NA');
        expect(row.Excluded_Participant_Level).toBe('NA');
      }
    }
    expect(manifest.participant_summary).toMatchObject({
      n_participants: 11,
      n_completed: 9,
      n_retained: 5,
      n_excluded: 4,
      n_incomplete: 1,
      n_screened_out: 1,
      n_reloaded_after_main_trials: 1,
    });
  });

  it('Table_Participant_ID is the id the trial-level tables use for the analysed run', () => {
    const loaded = loadAndFlattenDumps(allPaths());
    const { files } = composeExport(loaded.perParticipant, {
      generatedAtIso: '2000-01-01T00:00:00Z',
    });
    const summary = csvRows(files['PARTICIPANT_SUMMARY.csv']);
    const tableIds = new Set(csvRows(files['trials.csv']).map((r) => r.participant_id));
    const reloaded = summary.find((r) => r.Participant_ID === 'RELOADED');
    expect(reloaded.Table_Participant_ID).toBe('RELOADED__run_run_r2');
    for (const r of summary.filter((x) => x.Completed === '1')) {
      expect(tableIds.has(r.Table_Participant_ID), r.Participant_ID).toBe(true);
    }
    expect(summary.find((r) => r.Participant_ID === 'CLEAN_1').Table_Participant_ID).toBe(
      'CLEAN_1'
    );
    expect(summary.find((r) => r.Participant_ID === 'INCOMPLETE').Table_Participant_ID).toBe('NA');
    /* the partial first run is in the trial table but is not the analysed run */
    expect(tableIds.has('RELOADED__run_run_r1')).toBe(true);
  });

  it('the first-administration and final-administration attention exclusions differ for a re-loop', () => {
    const loaded = loadAndFlattenDumps(allPaths());
    const { files } = composeExport(loaded.perParticipant, {
      generatedAtIso: '2000-01-01T00:00:00Z',
    });
    const row = csvRows(files['PARTICIPANT_SUMMARY.csv']).find(
      (r) => r.Participant_ID === 'LOOP_FIRST_FAILS'
    );
    expect(row.Exclude_Attention_Checks).toBe('1');
    expect(row.Exclude_Attention_Checks_Final_Administration).toBe('0');
    const att = csvRows(files['ATTENTION_CHECKS.csv']).filter(
      (r) => r.Participant_ID === 'LOOP_FIRST_FAILS'
    );
    expect(att).toHaveLength(6);
    expect(att.filter((r) => r.Is_First_Administration === '1')).toHaveLength(3);
    expect(att.filter((r) => r.Is_Final_Administration === '1')).toHaveLength(3);
  });
});
