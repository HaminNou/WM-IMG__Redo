/**
 * A retry after a partial upload must deliver the rows written in between.
 *
 * Bucket files are named from the session, the run and the bucket label, and
 * DataPipe refuses a second file with the same name (FILE_EXISTS), which the
 * uploader counts as "already delivered". That is correct for an identical
 * retry, but a bucket that GREW between two attempts (for example the meta
 * bucket gaining `upload_session_end` and `completion_redirect`) came back as
 * FILE_EXISTS although the server only held the shorter version: the cursor
 * advanced and the newest rows, including the one row that defines "completed",
 * never reached the server (found by the final independent review).
 *
 * The name of a regular bucket now carries the seq range of the rows it holds, so
 * a grown bucket is a new file while an identical retry is still the same file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetCheckpointForTests,
  buildDataPipeEnvelope,
  dataPipeFilenameForBucket,
  uploadPendingData,
  uploadTail,
} from '../src/uploader.js';
import {
  _resetStorageForTests,
  appendTrialRow,
  flushPendingWrites,
  initStorage,
} from '../src/storage.js';

const session = {
  params: { session_id: 'sess1', prolific_pid: 'pid-1', study_id: 'st', is_preview: false },
  prng_seed_uint32: 1,
  schema_version: '1.2.0',
  build_id: 'v1',
  started_at_iso: '2026-01-01T00:00:00.000Z',
  user_agent: 'test',
};

/** A DataPipe-like server: stores files by name, refuses a repeated name with FILE_EXISTS. */
function makeServer({ denyName } = {}) {
  const files = new Map();
  const state = { deny: denyName ?? null };
  const fetchImpl = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const name = body.filename;
    if (state.deny && name.includes(state.deny)) {
      return { ok: false, status: 403, statusText: 'Forbidden', text: async () => 'nope' };
    }
    if (files.has(name)) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => '{"error":"FILE_EXISTS"}',
      };
    }
    files.set(name, JSON.parse(body.data));
    return { ok: true, status: 200, text: async () => 'ok' };
  });
  const seqs = () => {
    const all = new Set();
    for (const f of files.values()) for (const r of f.rows) all.add(r.seq);
    return all;
  };
  const phases = () => {
    const all = new Set();
    for (const f of files.values()) for (const r of f.rows) all.add(r.phase);
    return all;
  };
  return { files, fetchImpl, seqs, phases, state };
}

const noSleep = () => Promise.resolve();

async function add(row) {
  const seq = await appendTrialRow(row);
  await flushPendingWrites();
  return seq;
}

beforeEach(async () => {
  _resetStorageForTests();
  _resetCheckpointForTests();
  await initStorage({ backend: 'memory' });
});

describe('file names of regular buckets', () => {
  it('carry the seq range, so a grown bucket is a different file', () => {
    const mk = (seq_min, seq_max) =>
      dataPipeFilenameForBucket({
        session_id: 'sess1',
        run_id: 'run1',
        bucket_label: `10_meta_s${seq_min}-${seq_max}`,
      });
    expect(mk(2, 9)).not.toBe(mk(2, 11));
    expect(mk(2, 9)).toBe(mk(2, 9));
  });

  it('buildDataPipeEnvelope adds the range to regular buckets, not to checkpoint, tail or partial files', () => {
    const base = {
      session_id: 'sess1',
      run_id: 'run1',
      seq_min: 4,
      seq_max: 9,
      n_rows: 3,
      rows: [],
    };
    const name = (b) =>
      buildDataPipeEnvelope({ bucketEnvelope: { ...base, ...b }, experimentId: 'epIpSzIi9r7O' })
        .filename;
    expect(name({ bucket_id: 'meta', bucket_label: '10_meta' })).toBe(
      'sess1__run1__10_meta_s4-9.json'
    );
    expect(name({ bucket_id: 'checkpoint', bucket_label: 'ckpt_4-9' })).toBe(
      'sess1__run1__ckpt_4-9.json'
    );
    expect(name({ bucket_id: 'tail', bucket_label: 'tail_4-9' })).toBe(
      'sess1__run1__tail_4-9.json'
    );
    expect(name({ bucket_id: 'partial', bucket_label: 'partial_4-9' })).toBe(
      'sess1__run1__partial_4-9.json'
    );
    /* a bucket with no seq values keeps its plain label */
    expect(name({ bucket_id: 'meta', bucket_label: '10_meta', seq_min: null, seq_max: null })).toBe(
      'sess1__run1__10_meta.json'
    );
  });
});

describe('retry after a partial upload', () => {
  it('delivers the rows that were written between the two attempts', async () => {
    const server = makeServer({ denyName: '03_d_only' });
    await add({ phase: 'consent' });
    await add({ phase: 'd_only_trial_start', block_label: 'main_a' });
    await add({ phase: 'screen_calibration_summary' });

    const first = await uploadPendingData({
      session,
      fetchImpl: server.fetchImpl,
      sleepImpl: noSleep,
    });
    expect(first.status).toBe('partial');

    /* the session ends: these two rows go to the meta bucket, which already
     * arrived once in a shorter form */
    await add({ phase: 'upload_session_end', status: 'partial' });
    await add({ phase: 'completion_redirect' });

    server.state.deny = null;
    const second = await uploadPendingData({
      session,
      fetchImpl: server.fetchImpl,
      sleepImpl: noSleep,
    });
    expect(second.status).toBe('uploaded');

    expect(server.phases().has('upload_session_end')).toBe(true);
    expect(server.phases().has('completion_redirect')).toBe(true);
    expect(server.phases().has('d_only_trial_start')).toBe(true);
    /* every stored row reached the server, and the tail has nothing left to send */
    expect(server.seqs().size).toBe(5);
    const tail = await uploadTail({ session, fetchImpl: server.fetchImpl, sleepImpl: noSleep });
    expect(['nothing', 'nothing_to_upload', 'ok']).toContain(tail.status);
    expect(server.seqs().size).toBe(5);
  });

  it('an identical retry is still the same file, so FILE_EXISTS still counts as delivered', async () => {
    const server = makeServer({ denyName: '03_d_only' });
    await add({ phase: 'consent' });
    await add({ phase: 'd_only_trial_start', block_label: 'main_a' });
    const first = await uploadPendingData({
      session,
      fetchImpl: server.fetchImpl,
      sleepImpl: noSleep,
    });
    expect(first.status).toBe('partial');
    server.state.deny = null;
    const second = await uploadPendingData({
      session,
      fetchImpl: server.fetchImpl,
      sleepImpl: noSleep,
    });
    expect(second.status).toBe('uploaded');
    /* the bucket that arrived the first time was not stored twice */
    const names = [...server.files.keys()].filter((n) => n.includes('01_consent'));
    expect(names).toHaveLength(1);
    expect(server.seqs().size).toBe(2);
  });
});
