/**
 * The last-chance flush must fit a keepalive request in BYTES.
 *
 * A keepalive fetch may carry about 64 KiB (65,536 bytes) in all; a larger body
 * makes `fetch` reject with a TypeError, which the flush swallows, so the safety net
 * would silently do nothing on the busiest backlog. The old flush counted the length
 * of each row's JSON (56,000) but the rows are stringified AGAIN inside the DataPipe
 * envelope's `data` string, so quotes and backslashes are escaped twice, and
 * non-ASCII characters take 2-4 bytes in UTF-8: a realistic backlog reached 96 % of
 * the limit and quote-dense or non-ASCII rows went over it (final independent
 * review). The budget is now measured on the final request body in UTF-8 bytes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetCheckpointForTests, flushOnHide } from '../src/uploader.js';
import {
  _resetStorageForTests,
  appendTrialRow,
  flushPendingWrites,
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

const KEEPALIVE_LIMIT = 65_536;
const utf8 = (s) => new TextEncoder().encode(s).length;

beforeEach(async () => {
  _resetStorageForTests();
  _resetCheckpointForTests();
  await initStorage({ backend: 'memory' });
});

async function addDense(n, note) {
  for (let i = 0; i < n; i++) await appendTrialRow({ phase: 'meta_row', i, note });
  await flushPendingWrites();
  await Promise.resolve();
}

const okFetch = () => vi.fn(() => Promise.resolve({ ok: true, status: 200 }));

describe('flushOnHide body size', () => {
  it.each([
    ['quotes and backslashes (escaped twice)', '"\\'.repeat(200)],
    ['non-ASCII text (2-3 bytes per character)', 'ηπ日本語—'.repeat(80)],
    ['emoji (4 bytes in UTF-8, a surrogate pair in JSON)', '😀'.repeat(150)],
  ])('stays under the keepalive limit for %s', async (_label, note) => {
    await addDense(300, note);
    const fetchImpl = okFetch();
    const r = flushOnHide({ session, fetchImpl, nowMs: 100_000 });
    expect(r.status).toBe('sent');
    const body = fetchImpl.mock.calls[0][1].body;
    expect(utf8(body)).toBeLessThanOrEqual(48_000);
    expect(utf8(body)).toBeLessThan(KEEPALIVE_LIMIT);
    /* the NEWEST rows are the ones sent */
    const env = JSON.parse(JSON.parse(body).data);
    expect(env.rows[env.rows.length - 1].i).toBe(299);
    expect(env.rows.length).toBeGreaterThan(0);
  });

  it('a realistic backlog is sent with room to spare', async () => {
    await addDense(400, 'x'.repeat(40));
    const fetchImpl = okFetch();
    expect(flushOnHide({ session, fetchImpl, nowMs: 100_000 }).status).toBe('sent');
    expect(utf8(fetchImpl.mock.calls[0][1].body)).toBeLessThanOrEqual(48_000);
  });

  it('a single row larger than the budget is not sent (it cannot fit), and nothing throws', async () => {
    await addDense(1, 'q"'.repeat(60_000));
    const fetchImpl = okFetch();
    const r = flushOnHide({ session, fetchImpl, nowMs: 100_000 });
    expect(['nothing', 'error']).toContain(r.status);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
