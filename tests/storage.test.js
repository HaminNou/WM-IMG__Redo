/**
 * Tests for src/storage.js — the trial persistence layer.
 *
 * Scope: the memory backend (tests + private-mode fallback). The IndexedDB
 * backend is not testable under Vitest's jsdom environment because jsdom
 * doesn't ship an IndexedDB implementation; that path is exercised manually
 * in the browser during pilot runs.
 *
 * Why a dedicated file when uploader.test.js already exercises storage?
 * Because the uploader uses storage transitively — failures get reported as
 * upload-shape mismatches rather than storage bugs. These tests pin down
 * each storage method directly so a regression has a single, obvious
 * failure point.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initStorage,
  _resetStorageForTests,
  appendTrialRow,
  getRunId,
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
  clearAll,
  recordWriteFailure,
  getStorageFailureSummary,
} from '../src/storage.js';

beforeEach(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
});

describe('storage init', () => {
  it('reports the active backend kind', async () => {
    _resetStorageForTests();
    const info = await initStorage({ backend: 'memory' });
    expect(info.kind).toBe('memory');
  });

  it('is idempotent — second call returns the same backend', async () => {
    const info1 = await initStorage({ backend: 'memory' });
    const info2 = await initStorage({ backend: 'memory' });
    expect(info1.kind).toBe(info2.kind);
  });

  it('throws if a public method is called before init', async () => {
    _resetStorageForTests();
    await expect(appendTrialRow({ x: 1 })).rejects.toThrow(/initStorage/);
  });
});

describe('appendTrialRow + getAllTrialRows', () => {
  it('assigns monotonically increasing seq starting at 1', async () => {
    const s1 = await appendTrialRow({ phase: 'a' });
    const s2 = await appendTrialRow({ phase: 'b' });
    const s3 = await appendTrialRow({ phase: 'c' });
    expect([s1, s2, s3]).toEqual([1, 2, 3]);
  });

  it('returns rows with seq merged into the row payload', async () => {
    await appendTrialRow({ phase: 'a', value: 10 });
    await appendTrialRow({ phase: 'b', value: 20 });
    const rows = await getAllTrialRows();
    expect(rows).toEqual([
      { seq: 1, run_id: getRunId(), phase: 'a', value: 10 },
      { seq: 2, run_id: getRunId(), phase: 'b', value: 20 },
    ]);
  });

  it('stamps every row with the run id of this page load', async () => {
    await appendTrialRow({ phase: 'a' });
    await appendTrialRow({ phase: 'b' });
    const rows = await getAllTrialRows();
    expect(getRunId()).toMatch(/^.{8}$/);
    expect(new Set(rows.map((r) => r.run_id))).toEqual(new Set([getRunId()]));
  });

  it('keeps a run id the caller supplies', async () => {
    await appendTrialRow({ phase: 'a', run_id: 'other' });
    expect((await getAllTrialRows())[0].run_id).toBe('other');
  });

  it('returns an empty array when no rows have been appended', async () => {
    expect(await getAllTrialRows()).toEqual([]);
  });
});

describe('getTrialRowsAfter', () => {
  it('returns only rows with seq strictly greater than the cursor', async () => {
    for (let i = 0; i < 5; i++) await appendTrialRow({ i });
    const rows = await getTrialRowsAfter(2);
    expect(rows.map((r) => r.seq)).toEqual([3, 4, 5]);
  });

  it('returns all rows when cursor is 0', async () => {
    for (let i = 0; i < 3; i++) await appendTrialRow({ i });
    expect(await getTrialRowsAfter(0)).toHaveLength(3);
  });

  it('returns empty when cursor is at or past the highest seq', async () => {
    for (let i = 0; i < 3; i++) await appendTrialRow({ i });
    expect(await getTrialRowsAfter(3)).toEqual([]);
    expect(await getTrialRowsAfter(99)).toEqual([]);
  });
});

describe('upload cursor', () => {
  it('defaults to 0 when never set — guards the operator-precedence bug', async () => {
    /* Regression test for the original `?? 0` bug: `?? 0` was being applied
     * to the unresolved Promise (truthy), so the cursor leaked `undefined`
     * to the uploader and `getTrialRowsAfter(undefined)` matched no rows.
     * The whole chunked-upload path silently turned into a no-op. */
    expect(await getUploadCursor()).toBe(0);
  });

  it('round-trips a set value', async () => {
    await setUploadCursor(42);
    expect(await getUploadCursor()).toBe(42);
  });

  it('overwrites on subsequent sets', async () => {
    await setUploadCursor(10);
    await setUploadCursor(25);
    expect(await getUploadCursor()).toBe(25);
  });
});

describe('completion URL persistence', () => {
  it('round-trips the completion URL', async () => {
    const url = 'https://app.prolific.com/submissions/complete?cc=ABC123';
    await setCompletionUrl(url);
    expect(await getCompletionUrl()).toBe(url);
  });

  it('returns undefined when never set', async () => {
    expect(await getCompletionUrl()).toBeUndefined();
  });
});

describe('session metadata persistence', () => {
  it('round-trips session_id', async () => {
    await setSessionId('sess-xyz');
    expect(await getSessionId()).toBe('sess-xyz');
  });

  it('round-trips session_started_at_iso', async () => {
    const iso = '2000-01-01T10:00:00Z';
    await setSessionStartedAt(iso);
    expect(await getSessionStartedAt()).toBe(iso);
  });
});

describe('storage failure summary', () => {
  it('starts at zero failures with null last-error', () => {
    const s = getStorageFailureSummary();
    expect(s.writeFailures).toBe(0);
    expect(s.lastError).toBeNull();
    expect(s.lastFailureAtIso).toBeNull();
  });

  it('increments on each recorded failure and stamps the latest message', () => {
    recordWriteFailure(new Error('quota exceeded'));
    recordWriteFailure(new Error('aborted'));
    const s = getStorageFailureSummary();
    expect(s.writeFailures).toBe(2);
    expect(s.lastError).toBe('aborted');
    expect(s.lastFailureAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('coerces non-Error throws to a readable string', () => {
    recordWriteFailure('random string');
    recordWriteFailure(undefined);
    expect(getStorageFailureSummary().lastError).toBe('unknown');
  });

  it('resets via _resetStorageForTests', async () => {
    recordWriteFailure(new Error('boom'));
    expect(getStorageFailureSummary().writeFailures).toBe(1);
    _resetStorageForTests();
    await initStorage({ backend: 'memory' });
    expect(getStorageFailureSummary().writeFailures).toBe(0);
    expect(getStorageFailureSummary().lastError).toBeNull();
  });
});

describe('clearAll', () => {
  it('drops all trials and resets seq numbering', async () => {
    await appendTrialRow({ x: 1 });
    await appendTrialRow({ x: 2 });
    await clearAll();
    expect(await getAllTrialRows()).toEqual([]);
    /* Next seq should restart at 1 — important so a re-run of clearAll
     * doesn't produce out-of-order sequences. */
    const nextSeq = await appendTrialRow({ x: 3 });
    expect(nextSeq).toBe(1);
  });

  it('drops all meta values', async () => {
    await setUploadCursor(99);
    await setCompletionUrl('http://x');
    await setSessionId('s');
    await clearAll();
    expect(await getUploadCursor()).toBe(0);
    expect(await getCompletionUrl()).toBeUndefined();
    expect(await getSessionId()).toBeUndefined();
  });
});
