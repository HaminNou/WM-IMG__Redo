/**
 * Tests for src/storage.js IndexedDB backend, exercised under fake-indexeddb.
 *
 * Why a separate file from storage.test.js: the existing tests pin the memory
 * backend (the fallback), but the production path is IDB and is not
 * covered by the memory-backend tests. fake-indexeddb is a Dexie-grade
 * Node-side polyfill — it covers the same DOM API surface storage.js calls
 * (open, transaction, objectStore, getAll, put, get, clear, autoIncrement),
 * so a regression in the IDB path now fails CI rather than the pilot.
 *
 * Test isolation note: storage.js holds a long-lived IDB connection inside
 * `activeBackend`, so `indexedDB.deleteDatabase` would block waiting for that
 * connection to close. Each case instead swaps in a fresh IDBFactory and
 * re-initialises storage against it.
 *
 * What this file does NOT cover (intentional):
 *   - Browser-specific quota / partition-isolation behaviour. fake-indexeddb
 *     is a faithful API mock but doesn't simulate Safari's per-origin quota
 *     or private-mode IDB stub-throwing. Those remain manual checks in the
 *     PILOT_PLAYBOOK.
 *   - The auto-fallback from IDB → memory on `initStorage({backend: 'auto'})`
 *     in environments where IDB is missing — already covered by storage.test
 *     under the default Vitest `node` env where `indexedDB` is `undefined`.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initStorage,
  _resetStorageForTests,
  appendTrialRow,
  getAllTrialRows,
  getTrialRowsAfter,
  getUploadCursor,
  setUploadCursor,
  setCompletionUrl,
  getCompletionUrl,
  setSessionId,
  getSessionId,
  setSessionStartedAt,
  getSessionStartedAt,
} from '../src/storage.js';

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  _resetStorageForTests();
  await initStorage({ backend: 'indexeddb' });
});

describe('IndexedDB backend – kind reporting', () => {
  it('reports the active backend kind as "indexeddb"', async () => {
    /* The backend was initialised once in beforeAll; a second initStorage call
     * is idempotent and should report the same kind. */
    const info = await initStorage({ backend: 'indexeddb' });
    expect(info.kind).toBe('indexeddb');
  });
});

describe('IndexedDB backend – appendTrialRow + getAllTrialRows', () => {
  it('persists rows with autoIncrement seq', async () => {
    await appendTrialRow({ phase: 'a' });
    await appendTrialRow({ phase: 'b' });
    await appendTrialRow({ phase: 'c' });
    const rows = await getAllTrialRows();
    expect(rows).toHaveLength(3);
    expect(rows[0].seq).toBeLessThan(rows[1].seq);
    expect(rows[1].seq).toBeLessThan(rows[2].seq);
    expect(rows.map((r) => r.phase)).toEqual(['a', 'b', 'c']);
  });

  it('preserves nested row payloads byte-for-byte through round-trip', async () => {
    const payload = {
      phase: 'd_only_probe',
      probe: { type: 'T_on', cell: 7, is_target: true },
      rt: 812.34,
      meta: { tags: ['foo', 'bar'], nested: { a: 1, b: null } },
    };
    await appendTrialRow(payload);
    const [row] = await getAllTrialRows();
    expect(row.probe).toEqual(payload.probe);
    expect(row.meta).toEqual(payload.meta);
    expect(row.rt).toBe(payload.rt);
  });
});

describe('IndexedDB backend – getTrialRowsAfter (cursor semantics)', () => {
  it('returns only rows with seq > cursor', async () => {
    for (let i = 0; i < 5; i++) await appendTrialRow({ phase: 'p', i });
    const all = await getAllTrialRows();
    const seqs = all.map((r) => r.seq);
    const after2 = await getTrialRowsAfter(seqs[1]);
    expect(after2.map((r) => r.seq)).toEqual(seqs.slice(2));
    const afterAll = await getTrialRowsAfter(seqs[seqs.length - 1]);
    expect(afterAll).toEqual([]);
  });
});

describe('IndexedDB backend – meta store (cursor + completion URL + session)', () => {
  it('upload cursor defaults to 0 when unset', async () => {
    expect(await getUploadCursor()).toBe(0);
  });

  it('round-trips upload cursor', async () => {
    await setUploadCursor(7);
    expect(await getUploadCursor()).toBe(7);
    await setUploadCursor(42);
    expect(await getUploadCursor()).toBe(42);
  });

  it('round-trips completion URL', async () => {
    await setCompletionUrl('https://app.prolific.com/submissions/complete?cc=ABC123');
    expect(await getCompletionUrl()).toBe(
      'https://app.prolific.com/submissions/complete?cc=ABC123'
    );
  });

  it('round-trips session id and started-at iso', async () => {
    await setSessionId('session-xyz');
    await setSessionStartedAt('2000-01-01T17:30:00.000Z');
    expect(await getSessionId()).toBe('session-xyz');
    expect(await getSessionStartedAt()).toBe('2000-01-01T17:30:00.000Z');
  });
});
