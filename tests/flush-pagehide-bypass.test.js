/**
 * Tab-close flush: a `visibilitychange` (hidden) flush followed by `pagehide` within the 15 s
 * throttle used to drop the rows written in between, because pagehide was throttled too. The
 * browser is about to discard the page at pagehide, so that is the last chance: it must bypass
 * the throttle whenever there are rows newer than the range already sent, and still never resend
 * a range, never move the upload cursor, never throw, and stay inside the byte budget.
 * (Found by the independent infrastructure review.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetCheckpointForTests, flushOnHide, installPageHideFlush } from '../src/uploader.js';
import {
  _resetStorageForTests,
  appendTrialRow,
  flushPendingWrites,
  getUploadCursor,
  initStorage,
} from '../src/storage.js';

const session = {
  params: { session_id: 'abc123', prolific_pid: 'pid-1', study_id: 'st', is_preview: false },
  prng_seed_uint32: 1,
  schema_version: '1.2.0',
  build_id: 'v1',
  started_at_iso: '2026-01-01T00:00:00.000Z',
  user_agent: 'test',
};

beforeEach(async () => {
  _resetStorageForTests();
  _resetCheckpointForTests();
  await initStorage({ backend: 'memory' });
});

async function addRows(from, to) {
  for (let i = from; i <= to; i++) await appendTrialRow({ phase: 'meta_row', i });
  await flushPendingWrites();
  await Promise.resolve();
}
const okFetch = () => vi.fn(() => Promise.resolve({ ok: true, status: 200 }));
const rowsIn = (call) => JSON.parse(JSON.parse(call[1].body).data).rows.map((r) => r.i);

describe('pagehide after a visibilitychange flush', () => {
  it('visibilitychange -> new rows -> pagehide: the new rows are sent (throttle bypassed)', async () => {
    const fetchImpl = okFetch();
    await addRows(1, 5);
    expect(flushOnHide({ session, fetchImpl, nowMs: 100_000 }).status).toBe('sent');
    await addRows(6, 9); /* written in the next few seconds */
    /* a second visibility flush inside the window IS throttled ... */
    expect(flushOnHide({ session, fetchImpl, nowMs: 103_000 }).status).toBe('throttled');
    /* ... but pagehide must not be */
    const r = flushOnHide({ session, fetchImpl, nowMs: 104_000, bypassThrottle: true });
    expect(r.status).toBe('sent');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(rowsIn(fetchImpl.mock.calls[1])).toEqual([6, 7, 8, 9]);
  });

  it('never resends a range that was already sent, even when pagehide bypasses the throttle', async () => {
    const fetchImpl = okFetch();
    await addRows(1, 5);
    flushOnHide({ session, fetchImpl, nowMs: 100_000 });
    const r = flushOnHide({ session, fetchImpl, nowMs: 100_500, bypassThrottle: true });
    expect(r.status).toBe('nothing'); /* nothing newer than the range already sent */
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never moves the upload cursor and never throws', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('boom');
    });
    await addRows(1, 3);
    const before = await getUploadCursor();
    let r;
    expect(() => {
      r = flushOnHide({ session, fetchImpl, nowMs: 100_000, bypassThrottle: true });
    }).not.toThrow();
    expect(['sent', 'error']).toContain(r.status);
    expect(await getUploadCursor()).toBe(before);
  });

  it('stays inside the byte budget when bypassing', async () => {
    await addRows(1, 400);
    const fetchImpl = okFetch();
    flushOnHide({ session, fetchImpl, nowMs: 100_000 });
    await addRows(401, 800);
    const r = flushOnHide({ session, fetchImpl, nowMs: 100_100, bypassThrottle: true });
    expect(r.status).toBe('sent');
    const body = fetchImpl.mock.calls[1][1].body;
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(48_000);
  });

  it('the real listeners: visibilitychange(hidden), new rows, then pagehide sends them', async () => {
    const fetchImpl = okFetch();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    const doc = new EventTarget();
    doc.visibilityState = 'hidden';
    const win = new EventTarget();
    const uninstall = installPageHideFlush({ session, doc, win });
    try {
      await addRows(1, 4);
      doc.dispatchEvent(new Event('visibilitychange'));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await addRows(5, 8);
      /* the visibilitychange of a second tab switch is throttled; pagehide is not */
      doc.dispatchEvent(new Event('visibilitychange'));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      win.dispatchEvent(new Event('pagehide'));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(rowsIn(fetchImpl.mock.calls[1])).toEqual([5, 6, 7, 8]);
    } finally {
      uninstall();
      globalThis.fetch = realFetch;
    }
  });
});
