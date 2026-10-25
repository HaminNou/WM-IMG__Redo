/**
 * Files written by the last-chance flush on page hide (`partial_<min>-<max>`)
 * overlap the regular bucket and checkpoint files: the rows are the newest
 * ones, sent before the end-of-session upload could run. The loader shared by
 * the exporter and the batch-decision tool must count each row once and still
 * see ONE participant.
 *
 * The partial file here is produced by the real `flushOnHide`, so it has the
 * real envelope shape; the regular files come from the real bucketing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  _resetCheckpointForTests,
  buildBucketEnvelope,
  flushOnHide,
  partitionRowsIntoBuckets,
} from '../src/uploader.js';
import {
  _resetStorageForTests,
  appendTrialRow,
  flushPendingWrites,
  getAllTrialRows,
  initStorage,
} from '../src/storage.js';
import { loadAndFlattenDumps } from '../scripts/dump-loader.js';

const session = {
  params: { session_id: 'sess-1', prolific_pid: 'PID_ONE', study_id: 'st', is_preview: false },
  prng_seed_uint32: 1,
  schema_version: '1.2.0',
  build_id: 'v1',
  started_at_iso: '2026-01-01T00:00:00.000Z',
  user_agent: 'test',
};

let dir;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'partial-dedupe-'));
  _resetStorageForTests();
  _resetCheckpointForTests();
  await initStorage({ backend: 'memory' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a partial file that repeats rows of the regular files', () => {
  it('is pooled with them: one participant, every row once, duplicates reported', async () => {
    for (let i = 0; i < 12; i++) await appendTrialRow({ phase: 'meta_row', i });
    await flushPendingWrites();
    await Promise.resolve();
    const all = await getAllTrialRows();
    expect(all).toHaveLength(12);

    /* Regular files: rows 1-10, as the end-of-session upload would have sent them. */
    const regular = all.filter((r) => r.seq <= 10);
    const parts = partitionRowsIntoBuckets(regular).filter((p) => p.rows.length > 0);
    const paths = [];
    parts.forEach((p, i) => {
      const env = buildBucketEnvelope({
        session,
        bucket: p.bucket,
        bucketIndex: i,
        totalBuckets: parts.length,
        rows: p.rows,
      });
      const path = join(dir, `regular_${i}.json`);
      writeFileSync(path, JSON.stringify(env));
      paths.push(path);
    });

    /* Partial file: the newest rows (here 8-12, so 8-10 are repeated). */
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true }));
    const sent = flushOnHide({ session, fetchImpl, nowMs: 100_000, maxBytes: 1_000_000 });
    expect(sent.status).toBe('sent');
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const partialEnvelope = JSON.parse(body.data);
    /* Keep only rows 8-12 in the partial file, as a flush after a checkpoint would. */
    partialEnvelope.rows = partialEnvelope.rows.filter((r) => r.seq >= 8);
    const partialPath = join(dir, 'partial.json');
    writeFileSync(partialPath, JSON.stringify(partialEnvelope));
    paths.push(partialPath);

    const { perParticipant, errors, report } = loadAndFlattenDumps(paths);
    expect(errors).toEqual([]);
    expect(perParticipant).toHaveLength(1);
    expect(perParticipant[0].participant_id).toBe('PID_ONE');
    const seqs = perParticipant[0].rows.map((r) => r.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(report.duplicates_dropped).toBe(3);
  });

  it('keeps a partial file alone as one participant with the rows it holds', async () => {
    for (let i = 0; i < 3; i++) await appendTrialRow({ phase: 'meta_row', i });
    await flushPendingWrites();
    await Promise.resolve();
    const fetchImpl = vi.fn(() => Promise.resolve({ ok: true }));
    flushOnHide({ session, fetchImpl, nowMs: 100_000 });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const path = join(dir, 'only-partial.json');
    writeFileSync(path, body.data);
    const { perParticipant } = loadAndFlattenDumps([path]);
    expect(perParticipant).toHaveLength(1);
    expect(perParticipant[0].participant_id).toBe('PID_ONE');
    expect(perParticipant[0].rows).toHaveLength(3);
  });
});
