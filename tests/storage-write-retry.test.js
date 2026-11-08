/**
 * A single failed IndexedDB write must not remove a row from the data. Uploads
 * and the recovery page read storage only, so a row whose write failed once
 * would otherwise be missing from every file (star rows are written from a
 * timer, outside jsPsych, and are not re-created anywhere else).
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initStorage,
  _resetStorageForTests,
  appendTrialRow,
  getAllTrialRows,
  getStorageFailureSummary,
} from '../src/storage.js';

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  _resetStorageForTests();
  await initStorage({ backend: 'indexeddb' });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('appendTrialRow retries a failed write', () => {
  it('keeps the row when the first attempt throws', async () => {
    const add = IDBObjectStore.prototype.add;
    let calls = 0;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (...a) {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return add.apply(this, a);
    });
    const seq = await appendTrialRow({ phase: 'x_star', slot_index_in_seq: 5 });
    expect(Number.isFinite(seq)).toBe(true);
    const rows = await getAllTrialRows();
    expect(rows.filter((r) => r.phase === 'x_star')).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('still rejects (so the caller can count it) when every attempt fails', async () => {
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => {
      throw new Error('quota');
    });
    await expect(appendTrialRow({ phase: 'x' })).rejects.toThrow('quota');
    expect(await getAllTrialRows()).toHaveLength(0);
    expect(getStorageFailureSummary().writeFailures).toBe(0); /* counted by the caller */
  });

  it('keeps rows in production order when none fails', async () => {
    const writes = [1, 2, 3, 4].map((i) => appendTrialRow({ phase: 'x', i }));
    await Promise.all(writes);
    expect((await getAllTrialRows()).map((r) => r.i)).toEqual([1, 2, 3, 4]);
  });
});

describe('uploads wait for rows that are still being written', () => {
  it('the end-of-session upload and the checkpoint include a row whose write is retrying', async () => {
    const { uploadPendingData, uploadCheckpoint, _resetCheckpointForTests } =
      await import('../src/uploader.js');
    const add = IDBObjectStore.prototype.add;
    let calls = 0;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (...a) {
      calls += 1;
      if (calls === 1) throw new Error('transient'); /* the last row's first attempt */
      return add.apply(this, a);
    });
    const session = {
      params: { session_id: 'S', prolific_pid: 'P', study_id: 'ST' },
      seed_string: 'x',
      started_at_iso: '2000-01-01T00:00:00Z',
    };
    const sent = [];
    const fetchImpl = vi.fn(async (_u, opts) => {
      sent.push(JSON.parse(opts.body));
      return { ok: true, status: 200, statusText: 'OK', text: async () => '{"ok":true}' };
    });
    for (const which of ['checkpoint', 'final']) {
      sent.length = 0;
      calls = 0;
      _resetCheckpointForTests();
      globalThis.indexedDB = new IDBFactory();
      _resetStorageForTests();
      await initStorage({ backend: 'indexeddb' });
      void appendTrialRow({
        phase: 'i_t_probe',
        probe_position: 2,
      }); /* not awaited, like on_data_update */
      const args = {
        session,
        endpoint: 'https://script.google.com/macros/s/TEST/exec',
        uploadKey: 'k',
        fetchImpl,
        sleepImpl: () => Promise.resolve(),
      };
      if (which === 'checkpoint') await uploadCheckpoint(args);
      else await uploadPendingData({ ...args, provider: 'gdrive' });
      const text = JSON.stringify(sent);
      expect(text, which).toContain('i_t_probe');
    }
  });
});
