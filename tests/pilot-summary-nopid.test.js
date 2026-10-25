/**
 * Sessions without a Prolific PID must not become phantom participants.
 *
 * `loadAndFlattenDumps` once keyed such a session as `unknown_<file name>`, so each
 * of its ~9 files (checkpoint, buckets, tail) became its own participant, and the
 * tail file alone (it holds the completion row) counted as one completed and
 * retained participant with no data. A researcher testing the live link without
 * Prolific parameters would add one phantom retained participant per test run to the
 * input of the 60 / 40 / 100 sampling rule (found by the final independent review).
 *
 * Now a session without a PID is keyed by its session id (all its files are ONE
 * participant), and `sample_class` separates real participants from previews (no
 * PID) and pilot sessions. The sampling decision counts real participants only
 * (plus pilot sessions when the batch is a pilot batch), and says how many it left out.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { simulateOne } from '../scripts/simulate-pilot.js';
import { partitionRowsIntoBuckets, buildBucketEnvelope } from '../src/uploader.js';
import { loadParticipants, aggregate } from '../scripts/pilot-summary.js';
import { loadAndFlattenDumps } from '../scripts/dump-loader.js';
import { composeExport } from '../scripts/csv-export.js';
import { sampleClass } from '../scripts/participant-rules.js';

const IDS = ['ac1_colour', 'ac2_word', 'ac3_number'];

function session({ pid, sid, preview = false, pilot = false }) {
  return {
    params: { session_id: sid, prolific_pid: pid, study_id: 'STUDY', is_preview: preview },
    prng_seed_uint32: 1,
    schema_version: '1.2.0',
    build_id: 'v1',
    is_pilot_run: pilot,
    pilot_label: pilot ? 'pilot' : null,
    started_at_iso: '2000-01-01T10:00:00Z',
    user_agent: 'test',
  };
}

function simRows({ seed, pid, accuracy = 0.85, calibration, until, exit }) {
  const sim = simulateOne({ seed, pid, accuracy, calibration, pilotLabel: 'x' });
  let rows = sim.rows.filter((r) => r.phase !== 'attention_check_summary');
  const at = rows.findIndex((r) => r.phase === 'demographics') + 1;
  const att = IDS.map((id) => ({
    phase: 'attention_check',
    attention_check_id: id,
    attention_check_raw: 'right',
    attention_check_passed: true,
  }));
  rows = [...rows.slice(0, at), ...att, ...rows.slice(at)];
  const completion = rows.filter((r) => r.phase === 'completion_redirect');
  rows = rows.filter((r) => r.phase !== 'completion_redirect');
  if (until) rows = rows.slice(0, until);
  if (exit) rows = [...rows.slice(0, 12), { phase: 'timing_probe_fail', exit_reason: exit }];
  return { rows, completion: until || exit ? [] : completion };
}

/** Writes the files of one run as the live uploader lays them out; returns the count. */
function writeRun(dir, sess, runId, { rows, completion }) {
  const body = rows.map((r, i) => ({ ...r, seq: i + 1, run_id: runId }));
  const parts = partitionRowsIntoBuckets(body).filter((p) => p.rows.length > 0);
  const files = parts.map((p, i) => {
    const env = buildBucketEnvelope({
      session: sess,
      bucket: p.bucket,
      bucketIndex: i,
      totalBuckets: parts.length,
      rows: p.rows,
    });
    env.run_id = runId;
    return [`${sess.params.session_id}__${runId}__${p.bucket.label}.json`, env];
  });
  const ckpt = buildBucketEnvelope({
    session: sess,
    bucket: { id: 'checkpoint', label: 'ckpt_1-60' },
    bucketIndex: 0,
    totalBuckets: 1,
    rows: body.slice(0, 60),
  });
  ckpt.run_id = runId;
  files.push([`${sess.params.session_id}__${runId}__ckpt_1-60.json`, ckpt]);
  if (completion.length > 0) {
    const tailRows = completion.map((r, i) => ({ ...r, seq: body.length + i + 1, run_id: runId }));
    const tail = buildBucketEnvelope({
      session: sess,
      bucket: { id: 'tail', label: `tail_${body.length + 1}` },
      bucketIndex: 0,
      totalBuckets: 1,
      rows: tailRows,
    });
    tail.run_id = runId;
    files.push([`${sess.params.session_id}__${runId}__tail.json`, tail]);
  }
  for (const [name, env] of files) writeFileSync(join(dir, name), JSON.stringify(env));
  return files.length;
}

let dir;
let nFiles = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nopid-'));
  /* 8 participants with a PID */
  const plan = [
    ['p1', { seed: 'a1' }, {}],
    ['p2', { seed: 'a2' }, {}],
    ['p3', { seed: 'a3' }, {}],
    ['p4', { seed: 'a4', calibration: 'inconsistent_accepted' }, {}],
    ['p5', { seed: 'a5', accuracy: 0.4 }, {}],
    ['p6', { seed: 'a6', until: 300 }, {}],
    ['p7', { seed: 'a7', exit: 'timing_probe_failed' }, {}],
    /* a genuine participant whose URL lacked SESSION_ID: PID present, is_preview true */
    ['p8', { seed: 'a8' }, { preview: true }],
  ];
  for (const [pid, opts, meta] of plan) {
    nFiles += writeRun(
      dir,
      session({ pid, sid: `sess_${pid}`, ...meta }),
      `run${pid}`,
      simRows({ pid, ...opts })
    );
  }
  /* one session without a PID (a LOCAL_ id: the researcher testing the live link) */
  nFiles += writeRun(
    dir,
    session({ pid: null, sid: 'LOCAL_ab12cd34', preview: true }),
    'runlocal',
    simRows({ seed: 'loc', pid: null })
  );
  /* one pilot-flagged participant */
  nFiles += writeRun(
    dir,
    session({ pid: 'p9', sid: 'sess_p9', pilot: true }),
    'runp9',
    simRows({ seed: 'a9', pid: 'p9' })
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const paths = () => readdirSync(dir).map((f) => join(dir, f));

describe('a session without a PID', () => {
  it('is ONE participant, not one per file', () => {
    const { perParticipant } = loadAndFlattenDumps(paths());
    const local = perParticipant.filter((e) => String(e.source_pid).startsWith('nopid_'));
    expect(local).toHaveLength(1);
    expect(local[0].source_pid).toBe('nopid_LOCAL_ab12cd34');
    /* its rows come from all of its files */
    expect(local[0].source_paths.length).toBeGreaterThan(5);
  });

  it('the participant count equals the truth: 8 PIDs + the pilot one + the local session', () => {
    const { participants } = loadParticipants(paths());
    expect(participants).toHaveLength(10);
    expect(nFiles).toBeGreaterThan(60); /* many files, few participants */
  });
});

describe('sample classes', () => {
  it('sampleClass: no PID is a preview, the pilot flag is a pilot, the rest is real', () => {
    expect(sampleClass({ params: { prolific_pid: null }, is_pilot_run: false })).toBe('preview');
    expect(sampleClass({ params: { prolific_pid: '' } })).toBe('preview');
    expect(sampleClass(null)).toBe('preview');
    expect(sampleClass({ params: { prolific_pid: 'x' }, is_pilot_run: true })).toBe('pilot');
    expect(sampleClass({ params: { prolific_pid: 'x' }, is_pilot_run: false })).toBe('real');
    /* is_preview with a PID does not make a preview: the participant is not dropped */
    expect(
      sampleClass({ params: { prolific_pid: 'x', is_preview: true }, is_pilot_run: false })
    ).toBe('real');
  });

  it('totals of the main batch equal the truth and say what was left out', () => {
    const { participants } = loadParticipants(paths());
    const agg = aggregate(participants, { expectPilot: false });
    /* truth: real = p1..p8; completed = p1,p2,p3,p4,p5,p8; retained = p1,p2,p3,p8 */
    expect(agg.n_counted_participants).toBe(8);
    expect(agg.n_completed).toBe(6);
    expect(agg.n_retained).toBe(4);
    expect(agg.n_not_counted_pilot).toBe(1);
    expect(agg.n_not_counted_preview).toBe(1);
    const codes = agg.issues.map((i) => i.code);
    expect(codes).toContain('PILOT_SESSIONS_NOT_COUNTED');
    expect(codes).toContain('PREVIEW_SESSIONS_NOT_COUNTED');
    expect(codes).toContain('PREVIEW_FLAG_WITH_PID');
    /* the decision rests on 6 completions / 4 retained, not on 8 / 5 */
    expect(agg.sampling_decision.action).toBe('collect');
  });

  it('in a pilot batch the pilot sessions are the sample; previews still never count', () => {
    const { participants } = loadParticipants(paths());
    const pilotOnly = participants.filter((s) => s.sample_class !== 'real');
    const agg = aggregate(pilotOnly, { expectPilot: true });
    expect(agg.n_counted_participants).toBe(1);
    expect(agg.n_not_counted_preview).toBe(1);
  });

  it('PARTICIPANT_SUMMARY carries Sample_Class per participant', () => {
    const { perParticipant } = loadAndFlattenDumps(paths());
    const { files } = composeExport(perParticipant, {});
    const text = files['PARTICIPANT_SUMMARY.csv'];
    const [head, ...lines] = text.trim().split('\n');
    const cols = head.split(',').map((c) => c.replace(/"/g, ''));
    const k = cols.indexOf('Sample_Class');
    expect(k).toBeGreaterThan(-1);
    const classes = lines.map((l) => l.split(',')[k].replace(/"/g, ''));
    expect(classes.filter((c) => c === 'preview')).toHaveLength(1);
    expect(classes.filter((c) => c === 'pilot')).toHaveLength(1);
    expect(classes.filter((c) => c === 'real')).toHaveLength(8);
  });
});
