/**
 * Upload robustness (src/uploader.js, src/storage.js):
 *
 *   - file names built from a URL-supplied session id cannot contain a path
 *     separator, a dot sequence or any other special character, while normal
 *     ids keep the names earlier builds produced;
 *   - the last-chance flush on page hide sends the newest unsent rows in ONE
 *     small keepalive request, never twice for the same range, never moves the
 *     upload cursor, and never throws;
 *   - the page-hide listeners are installed once and removed cleanly.
 *
 * The flush file name carries its seq range, so it cannot collide with a
 * regular bucket file or with an earlier flush; the exporter pools files by
 * (run, seq) and drops duplicates (tests/pilot-summary-buckets.test.js and
 * tests/participant-rules.test.js cover that side; the last test here adds a
 * partial file with duplicate rows).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetCheckpointForTests,
  dataPipeFilenameForBucket,
  flushOnHide,
  installPageHideFlush,
  safeFilePart,
  uploadCheckpoint,
} from '../src/uploader.js';
import {
  _resetStorageForTests,
  appendTrialRow,
  flushPendingWrites,
  getRecentRows,
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

async function addRows(n, extra = {}) {
  for (let i = 0; i < n; i++) await appendTrialRow({ phase: 'meta_row', i, ...extra });
  await flushPendingWrites();
  /* The in-memory tail is filled when each write settles. */
  await Promise.resolve();
}

const okFetch = () => vi.fn(() => Promise.resolve({ ok: true, status: 200 }));

describe('safeFilePart and DataPipe file names', () => {
  it('leaves ids and labels from earlier builds unchanged', () => {
    for (const ok of [
      '5f1c2a9b8d7e6f0123456789',
      'LOCAL_ab12cd34',
      '08f4b9ae',
      '01_consent_demographics',
      'ckpt_12-340',
      'tail_1147-1148',
      'partial_5-9',
    ]) {
      expect(safeFilePart(ok)).toBe(ok);
    }
    expect(
      dataPipeFilenameForBucket({
        session_id: 'abc',
        run_id: '08f4b9ae',
        bucket_label: '03_d_only',
      })
    ).toBe('abc__08f4b9ae__03_d_only.json');
  });

  it('turns hostile session ids into the safe alphabet', () => {
    const hostile = [
      '../../etc/passwd',
      'a b',
      'x/y\\z',
      'ü ñ 日本',
      'id.with.dots',
      '%2e%2e%2f',
      'a\nb',
      '<x>',
    ];
    for (const h of hostile) {
      const out = safeFilePart(h);
      expect(out).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(out).not.toContain('..');
      const name = dataPipeFilenameForBucket({ session_id: h, run_id: 'r1', bucket_label: '01_x' });
      expect(name).toMatch(/^[A-Za-z0-9_-]+__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+\.json$/);
      expect(name.split('.').length).toBe(2);
    }
  });

  it('is deterministic, and different hostile ids do not collapse into one name', () => {
    expect(safeFilePart('../x')).toBe(safeFilePart('../x'));
    expect(safeFilePart('../x')).not.toBe(safeFilePart('..\\x'));
    expect(safeFilePart('a b')).not.toBe(safeFilePart('a_b'));
  });

  it('cuts a very long id and keeps it distinct', () => {
    const a = 'A'.repeat(500);
    const b = `${'A'.repeat(499)}B`;
    expect(safeFilePart(a).length).toBeLessThanOrEqual(64);
    expect(safeFilePart(a)).not.toBe(safeFilePart(b));
    expect(safeFilePart(a)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('flushOnHide', () => {
  it('sends the newest unsent rows once, as a small keepalive POST in the DataPipe envelope', async () => {
    await addRows(5);
    const fetchImpl = okFetch();
    const r = flushOnHide({ session, fetchImpl, nowMs: 100_000 });
    expect(r.status).toBe('sent');
    expect(r.rows).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/^https:\/\//);
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(['data', 'experimentID', 'filename']);
    expect(body.filename).toMatch(/^abc123__[0-9a-f]{8}__partial_\d+-\d+\.json$/);
    const env = JSON.parse(body.data);
    expect(env.bucket_id).toBe('partial');
    expect(env.n_rows).toBe(5);
    expect(env.rows.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(init.body.length).toBeLessThan(60_000);
  });

  it('stays under the keepalive size budget and keeps the NEWEST rows when there are too many', async () => {
    await addRows(40, { blob: 'x'.repeat(3000) });
    const fetchImpl = okFetch();
    const r = flushOnHide({ session, fetchImpl, nowMs: 100_000 });
    expect(r.status).toBe('sent');
    expect(r.rows).toBeGreaterThan(0);
    expect(r.rows).toBeLessThan(40);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.body.length).toBeLessThan(64 * 1024);
    const env = JSON.parse(JSON.parse(init.body).data);
    const seqs = env.rows.map((x) => x.seq);
    expect(Math.max(...seqs)).toBe(40);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(env.seq_max).toBe(40);
    expect(env.seq_min).toBe(40 - r.rows + 1);
  });

  it('never sends the same range twice, and sends only the new rows next time', async () => {
    await addRows(3);
    const fetchImpl = okFetch();
    expect(flushOnHide({ session, fetchImpl, nowMs: 100_000 }).status).toBe('sent');
    expect(flushOnHide({ session, fetchImpl, nowMs: 200_000 }).status).toBe('nothing');
    await addRows(2);
    const again = flushOnHide({ session, fetchImpl, nowMs: 300_000 });
    expect(again).toMatchObject({ status: 'sent', rows: 2 });
    const env = JSON.parse(JSON.parse(fetchImpl.mock.calls[1][1].body).data);
    expect(env.rows.map((x) => x.seq)).toEqual([4, 5]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('is throttled: a second hide event right after the first does not send again', async () => {
    await addRows(2);
    const fetchImpl = okFetch();
    expect(flushOnHide({ session, fetchImpl, nowMs: 100_000 }).status).toBe('sent');
    await addRows(1);
    expect(flushOnHide({ session, fetchImpl, nowMs: 101_000 }).status).toBe('throttled');
    expect(flushOnHide({ session, fetchImpl, nowMs: 116_000 }).status).toBe('sent');
  });

  it('does not resend rows a checkpoint already delivered', async () => {
    await addRows(4);
    const ckpt = okFetch();
    const sent = await uploadCheckpoint({
      session,
      fetchImpl: ckpt,
      sleepImpl: () => Promise.resolve(),
    });
    expect(sent.status).toBe('ok');
    expect(flushOnHide({ session, fetchImpl: okFetch(), nowMs: 100_000 }).status).toBe('nothing');
    await addRows(2);
    const fetchImpl = okFetch();
    const r = flushOnHide({ session, fetchImpl, nowMs: 100_000 });
    expect(r.rows).toBe(2);
    const env = JSON.parse(JSON.parse(fetchImpl.mock.calls[0][1].body).data);
    expect(env.rows.map((x) => x.seq)).toEqual([5, 6]);
  });

  it('does not move the upload cursor (a keepalive request cannot confirm delivery)', async () => {
    await addRows(3);
    const before = await getUploadCursor();
    flushOnHide({ session, fetchImpl: okFetch(), nowMs: 100_000 });
    /* Give any asynchronous cursor write time to land before looking. */
    await new Promise((r) => setTimeout(r, 10));
    expect(await getUploadCursor()).toBe(before);
  });

  it('never throws: a fetch that throws, rejects or is missing', async () => {
    await addRows(2);
    expect(() =>
      flushOnHide({
        session,
        fetchImpl: () => {
          throw new Error('sync');
        },
        nowMs: 100_000,
      })
    ).not.toThrow();
    await addRows(1);
    const rejecting = vi.fn(() => Promise.reject(new Error('offline')));
    expect(() => flushOnHide({ session, fetchImpl: rejecting, nowMs: 200_000 })).not.toThrow();
    await Promise.resolve();
    expect(flushOnHide({ session: null, fetchImpl: okFetch(), nowMs: 300_000 }).status).toBe(
      'no_endpoint'
    );
  });

  it('reads the in-memory tail, not storage, so it can run while the page unloads', async () => {
    await addRows(3);
    expect(getRecentRows().map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(getRecentRows().every((r) => typeof r.run_id === 'string')).toBe(true);
  });
});

describe('installPageHideFlush', () => {
  function fakeTargets() {
    const make = () => {
      const l = {};
      return {
        l,
        addEventListener: (t, f) => (l[t] ??= []).push(f),
        removeEventListener: (t, f) => {
          l[t] = (l[t] ?? []).filter((x) => x !== f);
        },
      };
    };
    const doc = Object.assign(make(), { visibilityState: 'visible' });
    return { doc, win: make() };
  }

  it('flushes on hidden and on pagehide, not while visible, and removes cleanly', async () => {
    await addRows(2);
    const fetchStub = okFetch();
    vi.stubGlobal('fetch', fetchStub);
    try {
      const { doc, win } = fakeTargets();
      const remove = installPageHideFlush({ session, doc, win });
      expect(doc.l.visibilitychange).toHaveLength(1);
      expect(win.l.pagehide).toHaveLength(1);
      /* idempotent */
      expect(installPageHideFlush({ session, doc, win })).toBe(remove);
      expect(doc.l.visibilitychange).toHaveLength(1);

      doc.l.visibilitychange[0]();
      expect(fetchStub).not.toHaveBeenCalled();
      doc.visibilityState = 'hidden';
      doc.l.visibilitychange[0]();
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(fetchStub.mock.calls[0][1].keepalive).toBe(true);

      await addRows(1);
      doc.l.visibilitychange[0]();
      /* a second visibilitychange inside the throttle window is throttled */
      expect(fetchStub).toHaveBeenCalledTimes(1);
      win.l.pagehide[0]();
      /* pagehide is the last chance: it bypasses the throttle and sends the newer row */
      expect(fetchStub).toHaveBeenCalledTimes(2);
      win.l.pagehide[0]();
      /* nothing newer than the range already sent: no third request */
      expect(fetchStub).toHaveBeenCalledTimes(2);

      remove();
      expect(doc.l.visibilitychange).toHaveLength(0);
      expect(win.l.pagehide).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
