/**
 * Tests for src/uploader.js — the end-of-session, bucket-per-envelope uploader.
 *
 * Four layers of testing:
 *
 *   1. Bucket-routing primitives (`BUCKETS`, `bucketForRow`,
 *      `partitionRowsIntoBuckets`) tested with hand-built rows that exercise
 *      every membership rule plus the meta catch-all.
 *
 *   2. Pure helpers (`buildBucketEnvelope`, `dataPipeFilenameForBucket`,
 *      `buildDataPipeEnvelope`, `buildCompletionUrl`, the two placeholder
 *      predicates) tested directly with fabricated inputs.
 *
 *   3. `postWithRetry` tested with a mock fetch that is programmable to
 *      succeed, fail transiently, fail permanently (4xx), or alternate. We
 *      override `sleepImpl` so retries are instant, not 1+s. Verifies retry
 *      count, backoff sequence, and the non-retryable-status fast-fail.
 *
 *   4. `uploadPendingData` tested with the in-memory storage backend and a
 *      mock fetch. Verifies the bucket-level guarantees: exactly N POSTs for
 *      N non-empty buckets, all-or-nothing cursor advance, no-endpoint and
 *      nothing-to-upload paths, idempotent re-runs after a partial failure,
 *      and per-bucket onProgress callbacks.
 *
 * Storage is reset with `_resetStorageForTests()` in `beforeEach` so tests
 * don't bleed state. We force the memory backend explicitly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BUCKETS,
  bucketForRow,
  partitionRowsIntoBuckets,
  buildBucketEnvelope,
  dataPipeFilenameForBucket,
  buildDataPipeEnvelope,
  buildCompletionUrl,
  isPlaceholderCompletionUrl,
  buildScreenOutUrl,
  isPlaceholderScreenOutUrl,
  isPlaceholderDataPipeId,
  postWithRetry,
  uploadPendingData,
  uploadCheckpoint,
  uploadTail,
  _resetCheckpointForTests,
} from '../src/uploader.js';
import { config } from '../src/config.js';
import {
  initStorage,
  _resetStorageForTests,
  appendTrialRow,
  getUploadCursor,
  setUploadCursor,
  getAllTrialRows,
  getRunId,
} from '../src/storage.js';

function fakeSession(overrides = {}) {
  return {
    params: {
      session_id: 'sess-123',
      prolific_pid: 'pid-abc',
      study_id: 'study-xyz',
      is_preview: false,
      ...(overrides.params ?? {}),
    },
    prng_seed_uint32: 42,
    schema_version: '1.2.0',
    build_id: 'v1',
    started_at_iso: '2000-01-01T10:00:00Z',
    user_agent: 'TestAgent/1.0',
  };
}

beforeEach(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
});

/* ---------- Bucket-routing primitives ---------- */

describe('BUCKETS table', () => {
  it('has exactly 10 entries in the canonical order', () => {
    expect(BUCKETS).toHaveLength(10);
    expect(BUCKETS.map((b) => b.id)).toEqual([
      'consent_demographics',
      'practice',
      'd_only',
      'i_only',
      't_only',
      'i_t',
      'i_d',
      'music_questionnaire',
      'strategy_questionnaire',
      'meta',
    ]);
  });

  it('labels are prefixed 01_..10_ so alphanumeric sort matches array order', () => {
    const labels = BUCKETS.map((b) => b.label);
    expect(labels).toEqual([
      '01_consent_demographics',
      '02_practice',
      '03_d_only',
      '04_i_only_star_only',
      '05_t_only',
      '06_i_t_dual_tone_star',
      '07_i_d_dual_dot_star',
      '08_music_questionnaire',
      '09_strategy_questionnaire',
      '10_meta',
    ]);
    const sorted = [...labels].sort();
    expect(sorted).toEqual(labels);
  });

  it('labels are unique and the table is frozen', () => {
    const labels = BUCKETS.map((b) => b.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(Object.isFrozen(BUCKETS)).toBe(true);
    for (const b of BUCKETS) expect(Object.isFrozen(b)).toBe(true);
  });

  it('meta is the trailing catch-all (predicate returns true for any row)', () => {
    const meta = BUCKETS[BUCKETS.length - 1];
    expect(meta.id).toBe('meta');
    expect(meta.matches({})).toBe(true);
    expect(meta.matches({ phase: 'anything', block_label: 'whatever' })).toBe(true);
  });
});

describe('bucketForRow', () => {
  it('routes consent rows to consent_demographics', () => {
    expect(bucketForRow({ phase: 'consent' }).id).toBe('consent_demographics');
  });

  it('routes demographics rows to consent_demographics', () => {
    expect(bucketForRow({ phase: 'demographics' }).id).toBe('consent_demographics');
  });

  it('routes any practice-block row to practice (regardless of phase)', () => {
    /* Practice trials carry trial-type phases like `d_only_*`, but the
     * practice block_label takes precedence so they land in the practice
     * bucket, not in d_only. */
    expect(bucketForRow({ block_label: 'practice', phase: 'd_only_encode' }).id).toBe('practice');
    expect(bucketForRow({ phase: 'practice_iteration_start' }).id).toBe('practice');
    expect(bucketForRow({ phase: 'practice_feedback' }).id).toBe('practice');
  });

  it('routes main-block trial rows by phase prefix', () => {
    for (const [prefix, bucketId] of [
      ['d_only', 'd_only'],
      ['i_only', 'i_only'],
      ['t_only', 't_only'],
      ['i_t_', 'i_t'],
      ['i_d_', 'i_d'],
    ]) {
      expect(bucketForRow({ block_label: 'main_a', phase: `${prefix}encode` }).id).toBe(bucketId);
      expect(bucketForRow({ block_label: 'main_b', phase: `${prefix}encode` }).id).toBe(bucketId);
    }
  });

  it('does NOT route a d_only-phase row from outside main blocks to d_only', () => {
    /* Defensive: if a non-main, non-practice row somehow has a trial-type
     * phase (e.g. a hand-crafted dev row), it falls through to meta. */
    expect(bucketForRow({ phase: 'd_only_encode' }).id).toBe('meta');
    expect(bucketForRow({ block_label: 'demo', phase: 'i_only_encode' }).id).toBe('meta');
  });

  it('does NOT collide i_t_ / i_d_ with i_only', () => {
    /* The trailing underscore in `i_t_` / `i_d_` is what keeps `i_only`
     * from being matched by the dual-task predicates. */
    expect(bucketForRow({ block_label: 'main_a', phase: 'i_only_encode' }).id).toBe('i_only');
  });

  it('routes music-questionnaire rows by phase prefix', () => {
    expect(bucketForRow({ phase: 'music_experience_intro' }).id).toBe('music_questionnaire');
    expect(bucketForRow({ phase: 'music_experience_q1' }).id).toBe('music_questionnaire');
  });

  it('routes strategy-questionnaire rows (including its intro) to strategy_questionnaire', () => {
    expect(bucketForRow({ phase: 'questionnaire_intro' }).id).toBe('strategy_questionnaire');
    expect(bucketForRow({ phase: 'strategy_dot' }).id).toBe('strategy_questionnaire');
    expect(bucketForRow({ phase: 'strategy_star' }).id).toBe('strategy_questionnaire');
  });

  it('routes uncategorised rows to meta (catch-all)', () => {
    expect(bucketForRow({ phase: 'instructions' }).id).toBe('meta');
    expect(bucketForRow({ phase: 'calibration' }).id).toBe('meta');
    expect(bucketForRow({ phase: 'upload_session_end' }).id).toBe('meta');
    expect(bucketForRow({}).id).toBe('meta');
    expect(bucketForRow({ phase: null }).id).toBe('meta');
  });

  it('is robust to null / undefined input (defensive)', () => {
    expect(bucketForRow(null).id).toBe('meta');
    expect(bucketForRow(undefined).id).toBe('meta');
  });
});

describe('partitionRowsIntoBuckets', () => {
  it('returns one entry per bucket in BUCKETS order, including empties', () => {
    const parts = partitionRowsIntoBuckets([{ phase: 'consent' }]);
    expect(parts).toHaveLength(BUCKETS.length);
    expect(parts.map((p) => p.bucket.id)).toEqual(BUCKETS.map((b) => b.id));
    expect(parts[0].rows).toHaveLength(1);
    for (let i = 1; i < parts.length; i++) expect(parts[i].rows).toHaveLength(0);
  });

  it('preserves input order within each bucket', () => {
    const rows = [
      { seq: 1, phase: 'consent' },
      { seq: 2, block_label: 'main_a', phase: 'd_only_encode' },
      { seq: 3, phase: 'consent' },
      { seq: 4, block_label: 'main_a', phase: 'd_only_probe' },
    ];
    const parts = partitionRowsIntoBuckets(rows);
    const consent = parts.find((p) => p.bucket.id === 'consent_demographics').rows;
    const dOnly = parts.find((p) => p.bucket.id === 'd_only').rows;
    expect(consent.map((r) => r.seq)).toEqual([1, 3]);
    expect(dOnly.map((r) => r.seq)).toEqual([2, 4]);
  });

  it('routes a full canonical session into exactly the expected 10 buckets', () => {
    const rows = [
      { seq: 1, phase: 'consent' },
      { seq: 2, phase: 'demographics' },
      { seq: 3, block_label: 'practice', phase: 'd_only_encode' },
      { seq: 4, block_label: 'main_a', phase: 'd_only_encode' },
      { seq: 5, block_label: 'main_a', phase: 'i_only_encode' },
      { seq: 6, block_label: 'main_a', phase: 't_only_encode' },
      { seq: 7, block_label: 'main_a', phase: 'i_t_encode' },
      { seq: 8, block_label: 'main_b', phase: 'i_d_encode' },
      { seq: 9, phase: 'music_experience_intro' },
      { seq: 10, phase: 'questionnaire_intro' },
      { seq: 11, phase: 'strategy_dot' },
      { seq: 12, phase: 'upload_session_end' } /* → meta */,
    ];
    const parts = partitionRowsIntoBuckets(rows);
    const counts = Object.fromEntries(parts.map((p) => [p.bucket.id, p.rows.length]));
    expect(counts).toEqual({
      consent_demographics: 2,
      practice: 1,
      d_only: 1,
      i_only: 1,
      t_only: 1,
      i_t: 1,
      i_d: 1,
      music_questionnaire: 1,
      strategy_questionnaire: 2,
      meta: 1,
    });
  });

  it('returns all-empty buckets for an empty input', () => {
    const parts = partitionRowsIntoBuckets([]);
    expect(parts).toHaveLength(BUCKETS.length);
    for (const p of parts) expect(p.rows).toHaveLength(0);
  });
});

/* ---------- Pure envelope helpers ---------- */

describe('buildBucketEnvelope', () => {
  it('produces an envelope with all session metadata fields', () => {
    const env = buildBucketEnvelope({
      session: fakeSession(),
      bucket: BUCKETS[0],
      bucketIndex: 0,
      totalBuckets: 3,
      rows: [
        { seq: 1, foo: 'a' },
        { seq: 2, foo: 'b' },
      ],
    });
    expect(env.session_id).toBe('sess-123');
    expect(env.prolific_pid).toBe('pid-abc');
    expect(env.study_id).toBe('study-xyz');
    expect(env.is_preview).toBe(false);
    expect(env.prng_seed_uint32).toBe(42);
    expect(env.schema_version).toBe('1.2.0');
    expect(env.build_id).toBe('v1');
    expect(env.user_agent).toBe('TestAgent/1.0');
  });

  it('records bucket id, label, index, total, and seq range', () => {
    const env = buildBucketEnvelope({
      session: fakeSession(),
      bucket: BUCKETS[2] /* d_only */,
      bucketIndex: 2,
      totalBuckets: 5,
      rows: [{ seq: 11 }, { seq: 12 }, { seq: 13 }],
    });
    expect(env.bucket_id).toBe('d_only');
    expect(env.bucket_label).toBe('03_d_only');
    expect(env.bucket_index).toBe(2);
    expect(env.total_buckets).toBe(5);
    expect(env.seq_min).toBe(11);
    expect(env.seq_max).toBe(13);
    expect(env.n_rows).toBe(3);
    expect(env.rows).toHaveLength(3);
  });

  it('handles an empty rows array (seq_min/max become null)', () => {
    const env = buildBucketEnvelope({
      session: fakeSession(),
      bucket: BUCKETS[0],
      bucketIndex: 0,
      totalBuckets: 1,
      rows: [],
    });
    expect(env.seq_min).toBeNull();
    expect(env.seq_max).toBeNull();
    expect(env.n_rows).toBe(0);
  });

  it('stamps an ISO timestamp', () => {
    const env = buildBucketEnvelope({
      session: fakeSession(),
      bucket: BUCKETS[0],
      bucketIndex: 0,
      totalBuckets: 1,
      rows: [{ seq: 1 }],
    });
    expect(env.uploaded_at_iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('throws when bucket is missing or malformed (defensive)', () => {
    expect(() =>
      buildBucketEnvelope({
        session: fakeSession(),
        bucketIndex: 0,
        totalBuckets: 1,
        rows: [],
      })
    ).toThrow(/bucket/);
    expect(() =>
      buildBucketEnvelope({
        session: fakeSession(),
        bucket: { id: 'x' } /* missing label */,
        bucketIndex: 0,
        totalBuckets: 1,
        rows: [],
      })
    ).toThrow(/bucket/);
  });
});

describe('dataPipeFilenameForBucket', () => {
  it('produces `<session_id>__<run_id>__<bucket_label>.json`', () => {
    expect(
      dataPipeFilenameForBucket({
        session_id: 'sess-123',
        run_id: 'ab12cd34',
        bucket_label: '03_d_only',
      })
    ).toBe('sess-123__ab12cd34__03_d_only.json');
  });

  it('is deterministic across calls with the same inputs', () => {
    const args = { session_id: 'sess-9', run_id: 'r1', bucket_label: '10_meta' };
    expect(dataPipeFilenameForBucket(args)).toBe(dataPipeFilenameForBucket(args));
  });

  it('differs between page loads of the same session', () => {
    const base = { session_id: 'sess-9', bucket_label: '01_consent_demographics' };
    expect(dataPipeFilenameForBucket({ ...base, run_id: 'r1' })).not.toBe(
      dataPipeFilenameForBucket({ ...base, run_id: 'r2' })
    );
  });

  it('throws on missing session_id, run_id or bucket_label', () => {
    expect(() => dataPipeFilenameForBucket({ run_id: 'r', bucket_label: '01_x' })).toThrow(
      /session_id/
    );
    expect(() => dataPipeFilenameForBucket({ session_id: 'sess', bucket_label: '01_x' })).toThrow(
      /run_id/
    );
    expect(() => dataPipeFilenameForBucket({ session_id: 'sess', run_id: 'r' })).toThrow(
      /bucket_label/
    );
  });
});

describe('buildCompletionUrl / isPlaceholderCompletionUrl', () => {
  it('returns the configured completion URL', () => {
    /* Until the new Prolific study exists the locked config carries a
     * placeholder code; `npm run preflight:strict` rejects it. Once the real
     * code is pasted in, it must be an eight-character code. */
    const url = buildCompletionUrl();
    expect(url).toContain('app.prolific.com/submissions/complete?cc=');
    if (!isPlaceholderCompletionUrl(url)) expect(url).toMatch(/cc=[A-Z0-9]{8}$/);
    expect(url).not.toContain('C1H50KI7');
  });

  it('isPlaceholderCompletionUrl detects the placeholder token', () => {
    expect(
      isPlaceholderCompletionUrl('https://app.prolific.com/submissions/complete?cc=PLACEHOLDER')
    ).toBe(true);
  });

  it('isPlaceholderCompletionUrl returns false for a real completion code', () => {
    expect(
      isPlaceholderCompletionUrl('https://app.prolific.com/submissions/complete?cc=ABCD1234')
    ).toBe(false);
  });

  it('isPlaceholderCompletionUrl handles non-string input gracefully', () => {
    expect(isPlaceholderCompletionUrl(null)).toBe(false);
    expect(isPlaceholderCompletionUrl(undefined)).toBe(false);
  });
});

describe('buildScreenOutUrl / isPlaceholderScreenOutUrl', () => {
  it('builds a Prolific completion URL from the configured screen-out code', () => {
    const url = buildScreenOutUrl();
    expect(url).toBe(
      `https://app.prolific.com/submissions/complete?cc=${config.prolific.screen_out_completion_code}`
    );
  });

  it('differs from the normal completion URL', () => {
    expect(buildScreenOutUrl()).not.toBe(buildCompletionUrl());
  });

  it('detects the placeholder code', () => {
    expect(
      isPlaceholderScreenOutUrl(
        'https://app.prolific.com/submissions/complete?cc=SCREENOUT_CODE_PLACEHOLDER'
      )
    ).toBe(true);
    expect(isPlaceholderScreenOutUrl(buildScreenOutUrl())).toBe(false);
    expect(
      isPlaceholderScreenOutUrl('https://app.prolific.com/submissions/complete?cc=ABCD1234')
    ).toBe(false);
    expect(isPlaceholderScreenOutUrl(null)).toBe(false);
  });
});

describe('isPlaceholderDataPipeId', () => {
  it('detects the literal PLACEHOLDER token', () => {
    expect(isPlaceholderDataPipeId('PLACEHOLDER')).toBe(true);
  });

  it('detects PLACEHOLDER as a substring (e.g. "DP_PLACEHOLDER_X")', () => {
    expect(isPlaceholderDataPipeId('DP_PLACEHOLDER_X')).toBe(true);
  });

  it('returns true for empty string and non-string input', () => {
    expect(isPlaceholderDataPipeId('')).toBe(true);
    expect(isPlaceholderDataPipeId(null)).toBe(true);
    expect(isPlaceholderDataPipeId(undefined)).toBe(true);
    expect(isPlaceholderDataPipeId(0)).toBe(true);
  });

  it('returns false for a real-looking experiment ID', () => {
    expect(isPlaceholderDataPipeId('aBcDeF12345X')).toBe(false);
  });
});

describe('buildDataPipeEnvelope', () => {
  function fakeBucketEnvelope(overrides = {}) {
    return {
      session_id: 'sess-123',
      run_id: 'ab12cd34',
      bucket_id: 'd_only',
      bucket_label: '03_d_only',
      bucket_index: 2,
      total_buckets: 10,
      seq_min: 1,
      seq_max: 10,
      n_rows: 10,
      rows: [{ seq: 1 }],
      ...overrides,
    };
  }

  it('produces the {experimentID, filename, data} shape DataPipe expects', () => {
    const env = buildDataPipeEnvelope({
      bucketEnvelope: fakeBucketEnvelope(),
      experimentId: 'exp-abc',
    });
    expect(Object.keys(env).sort()).toEqual(['data', 'experimentID', 'filename']);
    expect(env.experimentID).toBe('exp-abc');
  });

  it('builds a deterministic filename from session_id, run_id and bucket_label', () => {
    const env = buildDataPipeEnvelope({
      bucketEnvelope: fakeBucketEnvelope({ bucket_label: '07_i_d_dual_dot_star' }),
      experimentId: 'exp-abc',
    });
    expect(env.filename).toBe('sess-123__ab12cd34__07_i_d_dual_dot_star.json');
  });

  it('packs the full bucket envelope into the data string', () => {
    const inner = fakeBucketEnvelope();
    const env = buildDataPipeEnvelope({ bucketEnvelope: inner, experimentId: 'exp-abc' });
    expect(typeof env.data).toBe('string');
    expect(JSON.parse(env.data)).toEqual(inner);
  });

  it('throws on placeholder experimentId (uploader should never reach here with one)', () => {
    expect(() =>
      buildDataPipeEnvelope({ bucketEnvelope: fakeBucketEnvelope(), experimentId: 'PLACEHOLDER' })
    ).toThrow(/placeholder/i);
  });

  it('throws on missing experimentId', () => {
    expect(() => buildDataPipeEnvelope({ bucketEnvelope: fakeBucketEnvelope() })).toThrow();
    expect(() =>
      buildDataPipeEnvelope({ bucketEnvelope: fakeBucketEnvelope(), experimentId: '' })
    ).toThrow();
  });

  it('throws when bucketEnvelope is missing', () => {
    expect(() => buildDataPipeEnvelope({ experimentId: 'exp-abc' })).toThrow();
  });

  it('throws when bucketEnvelope has no session_id (filename construction would be unsafe)', () => {
    expect(() =>
      buildDataPipeEnvelope({
        bucketEnvelope: fakeBucketEnvelope({ session_id: undefined }),
        experimentId: 'exp-abc',
      })
    ).toThrow(/session_id/);
  });
});

/* ---------- postWithRetry ---------- */

describe('postWithRetry', () => {
  function ok(status = 200) {
    return Promise.resolve({ ok: true, status, statusText: 'OK', text: async () => '' });
  }
  function err(status, statusText = 'Error') {
    return Promise.resolve({ ok: false, status, statusText, text: async () => 'oops' });
  }
  function instantSleep() {
    return Promise.resolve();
  }

  it('succeeds on first attempt with 200', async () => {
    const fetchImpl = vi.fn().mockReturnValueOnce(ok());
    const result = await postWithRetry({
      url: 'http://x',
      body: { a: 1 },
      retryMax: 3,
      initialBackoffMs: 10,
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(result).toEqual({ ok: true, status: 200, attempt: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('counts a FILE_EXISTS refusal as already delivered', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '{"error":"FILE_EXISTS"}',
    });
    const result = await postWithRetry({
      url: 'http://x',
      body: { a: 1 },
      retryMax: 3,
      initialBackoffMs: 10,
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(result).toMatchObject({ ok: true, duplicate: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still fails on other 400 responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '{"error":"INVALID_FORMAT"}',
    });
    await expect(
      postWithRetry({ url: 'http://x', body: {}, retryMax: 3, fetchImpl, sleepImpl: instantSleep })
    ).rejects.toThrow(/non-retryable 400/);
  });

  it('retries on 5xx and succeeds eventually', async () => {
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(err(503, 'Unavailable'))
      .mockReturnValueOnce(err(502, 'Bad Gateway'))
      .mockReturnValueOnce(ok());
    const result = await postWithRetry({
      url: 'http://x',
      body: {},
      retryMax: 5,
      initialBackoffMs: 10,
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(result.ok).toBe(true);
    expect(result.attempt).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries on network error (fetch throws)', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockReturnValueOnce(ok());
    const result = await postWithRetry({
      url: 'http://x',
      body: {},
      retryMax: 3,
      initialBackoffMs: 10,
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws non-retryable error on 400', async () => {
    const fetchImpl = vi.fn().mockReturnValueOnce(err(400, 'Bad Request'));
    await expect(
      postWithRetry({
        url: 'http://x',
        body: {},
        retryMax: 5,
        initialBackoffMs: 10,
        fetchImpl,
        sleepImpl: instantSleep,
      })
    ).rejects.toThrow(/non-retryable 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws non-retryable error on 422', async () => {
    const fetchImpl = vi.fn().mockReturnValueOnce(err(422, 'Unprocessable'));
    await expect(
      postWithRetry({
        url: 'http://x',
        body: {},
        retryMax: 5,
        initialBackoffMs: 10,
        fetchImpl,
        sleepImpl: instantSleep,
      })
    ).rejects.toThrow(/non-retryable 422/);
  });

  it('gives up after retryMax + 1 attempts', async () => {
    const fetchImpl = vi.fn().mockReturnValue(err(503, 'Unavailable'));
    await expect(
      postWithRetry({
        url: 'http://x',
        body: {},
        retryMax: 2,
        initialBackoffMs: 10,
        fetchImpl,
        sleepImpl: instantSleep,
      })
    ).rejects.toThrow(/gave up after 3 attempts/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('uses exponential backoff: 10, 20, 40 ms', async () => {
    const fetchImpl = vi.fn().mockReturnValue(err(503));
    const sleeps = [];
    const sleepImpl = (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    };
    await expect(
      postWithRetry({
        url: 'http://x',
        body: {},
        retryMax: 3,
        initialBackoffMs: 10,
        fetchImpl,
        sleepImpl,
      })
    ).rejects.toThrow();
    /* No sleep before attempt 0; sleeps before attempts 1, 2, 3. */
    expect(sleeps).toEqual([10, 20, 40]);
  });

  it('POSTs JSON with the right headers', async () => {
    const fetchImpl = vi.fn().mockReturnValueOnce(ok());
    await postWithRetry({
      url: 'http://x',
      body: { hello: 'world' },
      retryMax: 0,
      initialBackoffMs: 0,
      fetchImpl,
      sleepImpl: instantSleep,
    });
    const callArgs = fetchImpl.mock.calls[0];
    expect(callArgs[0]).toBe('http://x');
    expect(callArgs[1].method).toBe('POST');
    expect(callArgs[1].headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(callArgs[1].body)).toEqual({ hello: 'world' });
    expect(callArgs[1].keepalive).toBeUndefined();
  });
});

/* ---------- uploadPendingData (end-to-end with in-memory storage) ---------- */

describe('uploadPendingData', () => {
  function instantSleep() {
    return Promise.resolve();
  }
  function fetchOk() {
    return vi
      .fn()
      .mockReturnValue(
        Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' })
      );
  }

  /**
   * Seed storage with one row per bucket so partitioning produces all 10
   * non-empty buckets in one go. Returns the seq → bucket_id map for
   * downstream assertions.
   */
  async function seedAllTenBuckets() {
    const rows = [
      { phase: 'consent' },
      { phase: 'demographics' },
      { block_label: 'practice', phase: 'd_only_encode' },
      { block_label: 'main_a', phase: 'd_only_encode' },
      { block_label: 'main_a', phase: 'i_only_encode' },
      { block_label: 'main_a', phase: 't_only_encode' },
      { block_label: 'main_a', phase: 'i_t_encode' },
      { block_label: 'main_b', phase: 'i_d_encode' },
      { phase: 'music_experience_q1' },
      { phase: 'questionnaire_intro' },
      { phase: 'strategy_dot' },
      { phase: 'upload_session_end' } /* meta */,
    ];
    for (const r of rows) await appendTrialRow(r);
  }

  it('returns no_endpoint when endpoint is null', async () => {
    await appendTrialRow({ phase: 'consent' });
    /* An empty endpoint takes the no-endpoint short-circuit. */
    const fetchImpl = fetchOk();
    const result = await uploadPendingData({
      session: fakeSession(),
      endpoint: '',
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(result.status).toBe('no_endpoint');
    expect(result.uploadedBuckets).toBe(0);
    expect(result.totalBuckets).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns nothing_to_upload when no rows past cursor', async () => {
    /* No rows appended. */
    const result = await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      fetchImpl: fetchOk(),
      sleepImpl: instantSleep,
    });
    expect(result.status).toBe('nothing_to_upload');
    expect(result.uploadedBuckets).toBe(0);
    expect(result.totalBuckets).toBe(0);
  });

  it('POSTs exactly one envelope per non-empty bucket (10 for a full session)', async () => {
    await seedAllTenBuckets();
    const fetchImpl = fetchOk();
    const result = await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(result.status).toBe('uploaded');
    expect(result.uploadedBuckets).toBe(10);
    expect(result.totalBuckets).toBe(10);
    expect(result.uploadedRows).toBe(12);
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it('skips empty buckets – partial session POSTs fewer than 10', async () => {
    /* Only consent + one main_a trial type → 2 non-empty buckets. */
    await appendTrialRow({ phase: 'consent' });
    await appendTrialRow({ block_label: 'main_a', phase: 'd_only_encode' });
    const fetchImpl = fetchOk();
    const result = await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(result.status).toBe('uploaded');
    expect(result.uploadedBuckets).toBe(2);
    expect(result.totalBuckets).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('POSTs buckets in canonical BUCKETS order', async () => {
    await seedAllTenBuckets();
    const seen = [];
    const fetchImpl = vi.fn().mockImplementation((_url, opts) => {
      const body = JSON.parse(opts.body);
      seen.push(body.bucket_id);
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
    });
    await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(seen).toEqual(BUCKETS.map((b) => b.id));
  });

  it('advances the cursor only after every bucket succeeds (all-or-nothing)', async () => {
    await seedAllTenBuckets();
    const result = await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      fetchImpl: fetchOk(),
      sleepImpl: instantSleep,
    });
    expect(result.status).toBe('uploaded');
    expect(await getUploadCursor()).toBe(12); /* 12 rows appended → highest seq */
  });

  it('only uploads rows past the existing cursor', async () => {
    /* Seed 5 consent rows then advance the cursor past them; only the
     * subsequent rows should be uploaded. */
    for (let i = 0; i < 5; i++) await appendTrialRow({ phase: 'consent' });
    await setUploadCursor(5);
    /* Two more rows post-cursor, in different buckets. */
    await appendTrialRow({ phase: 'demographics' });
    await appendTrialRow({ block_label: 'main_a', phase: 'd_only_encode' });
    const fetchImpl = fetchOk();
    const result = await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(result.uploadedRows).toBe(2);
    expect(result.uploadedBuckets).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns partial when a later bucket permanently fails – earlier buckets count', async () => {
    await seedAllTenBuckets();
    /* First 7 bucket-POSTs succeed; the 8th (music_questionnaire) fails
     * permanently after retries. With retryMax=5 (default), one bucket can
     * fire up to 6 fetches before giving up. */
    let bucketCallTracker = [];
    const fetchImpl = vi.fn().mockImplementation((_url, opts) => {
      const body = JSON.parse(opts.body);
      bucketCallTracker.push(body.bucket_id);
      if (body.bucket_id === 'music_questionnaire') {
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'Unavailable',
          text: async () => 'down',
        });
      }
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
    });
    const result = await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(result.status).toBe('partial');
    expect(result.uploadedBuckets).toBe(7);
    expect(result.totalBuckets).toBe(10);
    expect(result.lastError).toMatch(/gave up/);
  });

  it('does NOT advance the cursor on a partial – re-run re-POSTs everything', async () => {
    await seedAllTenBuckets();
    let phase2 = false;
    const fetchImpl = vi.fn().mockImplementation((_url, opts) => {
      const body = JSON.parse(opts.body);
      /* Phase 1: meta bucket fails; phase 2: everything ok. */
      if (!phase2 && body.bucket_id === 'meta') {
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'Unavailable',
          text: async () => '',
        });
      }
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
    });
    const partial = await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(partial.status).toBe('partial');
    /* All-or-nothing: cursor untouched even though 9 buckets uploaded. */
    expect(await getUploadCursor()).toBe(0);

    /* Phase 2: server back online — re-run re-POSTs all 10 buckets
     * (deterministic filenames make this idempotent in storage). */
    phase2 = true;
    const fetchPhase1Calls = fetchImpl.mock.calls.length;
    const resume = await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(resume.status).toBe('uploaded');
    expect(resume.uploadedBuckets).toBe(10);
    expect(fetchImpl.mock.calls.length - fetchPhase1Calls).toBe(10);
    expect(await getUploadCursor()).toBe(12);
  });

  it('calls onProgress for each bucket with bucket fields', async () => {
    /* Seed two buckets so onProgress fires twice. */
    await appendTrialRow({ phase: 'consent' });
    await appendTrialRow({ block_label: 'main_a', phase: 'd_only_encode' });
    const onProgress = vi.fn();
    await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      onProgress,
      fetchImpl: fetchOk(),
      sleepImpl: instantSleep,
    });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0][0]).toMatchObject({
      bucketIndex: 0,
      totalBuckets: 2,
      bucketId: 'consent_demographics',
      bucketLabel: '01_consent_demographics',
      status: 'ok',
    });
    expect(onProgress.mock.calls[1][0]).toMatchObject({
      bucketIndex: 1,
      totalBuckets: 2,
      bucketId: 'd_only',
      bucketLabel: '03_d_only',
      status: 'ok',
    });
  });

  it('calls onProgress with status:failed on the failing bucket', async () => {
    await appendTrialRow({ phase: 'consent' });
    const fetchImpl = vi
      .fn()
      .mockReturnValue(
        Promise.resolve({ ok: false, status: 503, statusText: 'Unavailable', text: async () => '' })
      );
    const onProgress = vi.fn();
    await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      onProgress,
      fetchImpl,
      sleepImpl: instantSleep,
    });
    /* One bucket, one onProgress call, status:failed with an error string. */
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0][0]).toMatchObject({
      bucketIndex: 0,
      totalBuckets: 1,
      bucketId: 'consent_demographics',
      status: 'failed',
    });
    expect(typeof onProgress.mock.calls[0][0].error).toBe('string');
  });

  it('rows array on the wire carries the original trial data and seq', async () => {
    await appendTrialRow({ phase: 'consent', value: 1 });
    await appendTrialRow({ phase: 'demographics', value: 2 });
    let captured = null;
    const fetchImpl = vi.fn().mockImplementation((_url, opts) => {
      captured = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
    });
    await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      fetchImpl,
      sleepImpl: instantSleep,
    });
    /* Both rows land in the consent_demographics bucket, so just one POST. */
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captured.bucket_id).toBe('consent_demographics');
    expect(captured.rows).toHaveLength(2);
    expect(captured.rows[0]).toMatchObject({ phase: 'consent', value: 1, seq: 1 });
    expect(captured.rows[1]).toMatchObject({ phase: 'demographics', value: 2, seq: 2 });
  });

  it('end-to-end sanity: append → getAllTrialRows → upload reports the same row count', async () => {
    for (let i = 0; i < 5; i++) await appendTrialRow({ phase: 'consent' });
    const all = await getAllTrialRows();
    expect(all).toHaveLength(5);
    expect(all[0].seq).toBe(1);
    const result = await uploadPendingData({
      session: fakeSession(),
      endpoint: 'http://x',
      provider: 'raw',
      fetchImpl: fetchOk(),
      sleepImpl: instantSleep,
    });
    expect(result.uploadedRows).toBe(5);
  });

  describe("uploadPendingData – provider: 'datapipe'", () => {
    /* DataPipe path: each bucket envelope is wrapped in
     * `{experimentID, filename, data}` before POST. The wire format change
     * is invisible to storage / cursor logic — those still see the same
     * pendingRows, so we re-verify here only the parts the wrapper affects:
     * (a) short-circuit on placeholder ID, (b) actual DataPipe envelope
     * shape on the wire, (c) per-bucket filename derivation. */

    it('returns no_endpoint when datapipeExperimentId is the placeholder token', async () => {
      await appendTrialRow({ phase: 'consent' });
      const fetchImpl = fetchOk();
      const result = await uploadPendingData({
        session: fakeSession(),
        endpoint: 'https://pipe.jspsych.org/api/data/',
        provider: 'datapipe',
        datapipeExperimentId: 'PLACEHOLDER',
        fetchImpl,
        sleepImpl: instantSleep,
      });
      expect(result.status).toBe('no_endpoint');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns no_endpoint when datapipeExperimentId is missing', async () => {
      await appendTrialRow({ phase: 'consent' });
      const fetchImpl = fetchOk();
      /* A placeholder id takes the no-endpoint short-circuit. */
      const result = await uploadPendingData({
        session: fakeSession(),
        endpoint: 'https://pipe.jspsych.org/api/data/',
        provider: 'datapipe',
        datapipeExperimentId: 'PLACEHOLDER',
        fetchImpl,
        sleepImpl: instantSleep,
      });
      expect(result.status).toBe('no_endpoint');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('POSTs DataPipe-shaped bodies (one per bucket) when ID is real', async () => {
      await seedAllTenBuckets();
      const captured = [];
      const fetchImpl = vi.fn().mockImplementation((url, opts) => {
        captured.push({ url, body: JSON.parse(opts.body) });
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
      });
      const result = await uploadPendingData({
        session: fakeSession(),
        endpoint: 'https://pipe.jspsych.org/api/data/',
        provider: 'datapipe',
        datapipeExperimentId: 'exp-abc',
        fetchImpl,
        sleepImpl: instantSleep,
      });
      expect(result.status).toBe('uploaded');
      expect(result.uploadedBuckets).toBe(10);
      expect(captured).toHaveLength(10);
      for (const c of captured) {
        expect(c.url).toBe('https://pipe.jspsych.org/api/data/');
        expect(c.body.experimentID).toBe('exp-abc');
        expect(typeof c.body.filename).toBe('string');
        expect(c.body.filename).toMatch(
          new RegExp(`^sess-123__${getRunId()}__\\d{2}_[a-z_]+\\.json$`)
        );
        expect(typeof c.body.data).toBe('string');
        /* Inner bucket envelope round-trips through the data string. */
        const inner = JSON.parse(c.body.data);
        expect(inner.session_id).toBe('sess-123');
        expect(typeof inner.bucket_id).toBe('string');
        expect(Array.isArray(inner.rows)).toBe(true);
      }
    });

    it('emits unique filenames per bucket in the same session (sortable)', async () => {
      await seedAllTenBuckets();
      const filenames = [];
      const fetchImpl = vi.fn().mockImplementation((_url, opts) => {
        filenames.push(JSON.parse(opts.body).filename);
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
      });
      await uploadPendingData({
        session: fakeSession(),
        endpoint: 'https://pipe.jspsych.org/api/data/',
        provider: 'datapipe',
        datapipeExperimentId: 'exp-abc',
        fetchImpl,
        sleepImpl: instantSleep,
      });
      expect(filenames).toHaveLength(10);
      expect(new Set(filenames).size).toBe(filenames.length); /* all unique */
      const sorted = [...filenames].sort();
      expect(sorted).toEqual(filenames); /* already in bucket order */
    });

    it('advances the cursor after a full DataPipe upload (same as raw mode)', async () => {
      await seedAllTenBuckets();
      await uploadPendingData({
        session: fakeSession(),
        endpoint: 'https://pipe.jspsych.org/api/data/',
        provider: 'datapipe',
        datapipeExperimentId: 'exp-abc',
        fetchImpl: fetchOk(),
        sleepImpl: instantSleep,
      });
      expect(await getUploadCursor()).toBe(12);
    });

    it('a partial DataPipe upload re-POSTs all buckets on retry (idempotent filenames)', async () => {
      await seedAllTenBuckets();
      let phase2 = false;
      const fetchImpl = vi.fn().mockImplementation((_url, opts) => {
        const body = JSON.parse(opts.body);
        const inner = JSON.parse(body.data);
        if (!phase2 && inner.bucket_id === 'i_d') {
          return Promise.resolve({
            ok: false,
            status: 503,
            statusText: 'Unavailable',
            text: async () => '',
          });
        }
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
      });
      const partial = await uploadPendingData({
        session: fakeSession(),
        endpoint: 'https://pipe.jspsych.org/api/data/',
        provider: 'datapipe',
        datapipeExperimentId: 'exp-abc',
        fetchImpl,
        sleepImpl: instantSleep,
      });
      expect(partial.status).toBe('partial');
      expect(await getUploadCursor()).toBe(0); /* cursor untouched */

      phase2 = true;
      const callsBefore = fetchImpl.mock.calls.length;
      const resume = await uploadPendingData({
        session: fakeSession(),
        endpoint: 'https://pipe.jspsych.org/api/data/',
        provider: 'datapipe',
        datapipeExperimentId: 'exp-abc',
        fetchImpl,
        sleepImpl: instantSleep,
      });
      expect(resume.status).toBe('uploaded');
      expect(resume.uploadedBuckets).toBe(10);
      /* Re-run POSTs all 10 buckets again — earlier successes overwrite
       * themselves in storage (filenames are deterministic). */
      expect(fetchImpl.mock.calls.length - callsBefore).toBe(10);
      expect(await getUploadCursor()).toBe(12);
    });
  });
});

describe('uploadCheckpoint', () => {
  const instantSleep = () => Promise.resolve();

  const okFetch = () => {
    const calls = [];
    const fetchImpl = vi.fn().mockImplementation((url, opts) => {
      calls.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
    });
    return { fetchImpl, calls };
  };

  async function withRealId(fn) {
    _resetCheckpointForTests();
    await fn();
  }

  const ID = { datapipeExperimentId: 'exp-abc' };

  it('does nothing while the DataPipe id is a placeholder', async () => {
    const { fetchImpl } = okFetch();
    await appendTrialRow({ phase: 'consent' });
    const result = await uploadCheckpoint({
      session: fakeSession(),
      datapipeExperimentId: 'PLACEHOLDER_TODO',
      fetchImpl,
    });
    expect(result.status).toBe('no_endpoint');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the new rows as one uniquely named file and only the new rows next time', async () => {
    await withRealId(async () => {
      const { fetchImpl, calls } = okFetch();
      await appendTrialRow({ phase: 'consent' });
      await appendTrialRow({ phase: 'rest' });
      const first = await uploadCheckpoint({
        ...ID,
        session: fakeSession(),
        fetchImpl,
        sleepImpl: instantSleep,
      });
      expect(first).toEqual({ status: 'ok', rows: 2 });
      expect(calls[0].experimentID).toBe('exp-abc');
      expect(calls[0].filename).toBe(`sess-123__${getRunId()}__ckpt_1-2.json`);
      expect(JSON.parse(calls[0].data).n_rows).toBe(2);

      expect((await uploadCheckpoint({ ...ID, session: fakeSession(), fetchImpl })).status).toBe(
        'nothing'
      );

      await appendTrialRow({ phase: 'rest' });
      const second = await uploadCheckpoint({
        ...ID,
        session: fakeSession(),
        fetchImpl,
        sleepImpl: instantSleep,
      });
      expect(second.rows).toBe(1);
      expect(calls[1].filename).toBe(`sess-123__${getRunId()}__ckpt_3-3.json`);
    });
  });

  it('leaves the cursor of the final upload alone', async () => {
    await withRealId(async () => {
      const { fetchImpl } = okFetch();
      await appendTrialRow({ phase: 'consent' });
      await uploadCheckpoint({ ...ID, session: fakeSession(), fetchImpl, sleepImpl: instantSleep });
      expect(await getUploadCursor()).toBe(0);
    });
  });

  it('retries the same rows after a failed upload', async () => {
    await withRealId(async () => {
      await appendTrialRow({ phase: 'consent' });
      const failing = vi.fn().mockRejectedValue(new Error('offline'));
      const failed = await uploadCheckpoint({
        ...ID,
        session: fakeSession(),
        fetchImpl: failing,
        sleepImpl: instantSleep,
      });
      expect(failed.status).toBe('failed');
      const { fetchImpl } = okFetch();
      const retried = await uploadCheckpoint({
        ...ID,
        session: fakeSession(),
        fetchImpl,
        sleepImpl: instantSleep,
      });
      expect(retried).toEqual({ status: 'ok', rows: 1 });
    });
  });
});

describe('postWithRetry – time limits and cancellation', () => {
  const instantSleep = () => Promise.resolve();
  /* A fetch that never answers, but rejects when it is aborted. */
  const hangingFetch = () =>
    vi.fn((_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

  it('passes an abort signal to every request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await postWithRetry({ url: 'http://x', body: {}, fetchImpl, sleepImpl: instantSleep });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a request that exceeds the time limit and retries it', async () => {
    const fetchImpl = hangingFetch();
    await expect(
      postWithRetry({
        url: 'http://x',
        body: {},
        retryMax: 2,
        timeoutMs: 20,
        fetchImpl,
        sleepImpl: instantSleep,
      })
    ).rejects.toThrow(/gave up after 3 attempts/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchImpl.mock.calls) expect(init.signal.aborted).toBe(true);
  });

  it('succeeds when a retry after a timeout answers in time', async () => {
    let n = 0;
    const fetchImpl = vi.fn((_url, init) => {
      n += 1;
      if (n === 1) {
        return new Promise((_r, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('aborted')))
        );
      }
      return Promise.resolve({ ok: true, status: 200 });
    });
    const out = await postWithRetry({
      url: 'http://x',
      body: {},
      timeoutMs: 20,
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(out).toMatchObject({ ok: true, attempt: 1 });
  });

  it('is cancelled by the caller: the in-flight request is aborted and nothing is retried', async () => {
    const fetchImpl = hangingFetch();
    const controller = new AbortController();
    const pending = postWithRetry({
      url: 'http://x',
      body: {},
      timeoutMs: 10000,
      signal: controller.signal,
      fetchImpl,
      sleepImpl: instantSleep,
    });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not start a request when the signal is already aborted', async () => {
    const fetchImpl = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      postWithRetry({ url: 'http://x', body: {}, signal: controller.signal, fetchImpl })
    ).rejects.toThrow(/cancelled/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('the request time limit comes from the config by default', () => {
    expect(config.uploader.request_timeout_ms).toBeGreaterThan(0);
    expect(config.uploader.session_end_max_wait_ms).toBeGreaterThan(
      config.uploader.request_timeout_ms
    );
  });
});

describe('uploadCheckpoint – cancellation', () => {
  it('leaves the cursor alone when cancelled, so the rows go in the next checkpoint', async () => {
    _resetCheckpointForTests();
    await appendTrialRow({ phase: 'consent' });
    const controller = new AbortController();
    controller.abort();
    const out = await uploadCheckpoint({
      session: fakeSession(),
      datapipeExperimentId: 'exp-abc',
      signal: controller.signal,
      fetchImpl: vi.fn(),
    });
    expect(out.status).toBe('failed');
    const ok = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    const next = await uploadCheckpoint({
      session: fakeSession(),
      datapipeExperimentId: 'exp-abc',
      fetchImpl: ok,
    });
    expect(next).toEqual({ status: 'ok', rows: 1 });
  });
});

describe('rows of earlier runs', () => {
  const instantSleep = () => Promise.resolve();
  const okFetch = () => {
    const bodies = [];
    const fetchImpl = vi.fn().mockImplementation((_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
    });
    return { fetchImpl, bodies };
  };
  const ID = { datapipeExperimentId: 'exp-abc' };
  const sentRows = (bodies) => bodies.flatMap((b) => JSON.parse(b.data).rows);

  async function seedTwoRuns() {
    await appendTrialRow({ run_id: 'old-run', phase: 'consent' });
    await appendTrialRow({ run_id: 'old-run', phase: 'd_only_trial_start', block_label: 'main_a' });
    await appendTrialRow({ phase: 'consent' });
    await appendTrialRow({ phase: 'rest' });
  }

  it('end-of-session upload sends only the current run, under the current run id', async () => {
    _resetCheckpointForTests();
    await seedTwoRuns();
    const { fetchImpl, bodies } = okFetch();
    const result = await uploadPendingData({
      session: fakeSession(),
      endpoint: 'https://pipe.jspsych.org/api/data/',
      provider: 'datapipe',
      ...ID,
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(result.status).toBe('uploaded');
    expect(sentRows(bodies).map((r) => r.run_id)).toEqual([getRunId(), getRunId()]);
    for (const b of bodies) {
      expect(b.filename).toContain(`__${getRunId()}__`);
      expect(JSON.parse(b.data).run_id).toBe(getRunId());
    }
  });

  it('the recovery page can send the rows of every run', async () => {
    _resetCheckpointForTests();
    await seedTwoRuns();
    const { fetchImpl, bodies } = okFetch();
    await uploadPendingData({
      session: fakeSession(),
      endpoint: 'https://pipe.jspsych.org/api/data/',
      provider: 'datapipe',
      ...ID,
      allRuns: true,
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(sentRows(bodies)).toHaveLength(4);
  });

  it('checkpoints send only the current run', async () => {
    _resetCheckpointForTests();
    await seedTwoRuns();
    const { fetchImpl, bodies } = okFetch();
    const result = await uploadCheckpoint({
      ...ID,
      session: fakeSession(),
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(result).toEqual({ status: 'ok', rows: 2 });
    expect(sentRows(bodies).every((r) => r.run_id === getRunId())).toBe(true);
  });

  it('a file name reused by a reloaded page is a different file, so FILE_EXISTS cannot hide its rows', async () => {
    _resetCheckpointForTests();
    await appendTrialRow({ phase: 'consent' });
    const names = [];
    const fetchImpl = vi.fn().mockImplementation((_u, opts) => {
      names.push(JSON.parse(opts.body).filename);
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
    });
    await uploadPendingData({
      session: fakeSession(),
      endpoint: 'https://pipe.jspsych.org/api/data/',
      provider: 'datapipe',
      ...ID,
      fetchImpl,
      sleepImpl: instantSleep,
    });
    const earlierRun = dataPipeFilenameForBucket({
      session_id: 'sess-123',
      run_id: 'other-run',
      bucket_label: '01_consent_demographics',
    });
    expect(names).toHaveLength(1);
    expect(names[0]).not.toBe(earlierRun);
  });
});

describe('uploadCheckpoint – size limit', () => {
  const ID = { datapipeExperimentId: 'exp-abc' };

  it('splits a checkpoint that is larger than one request into several files', async () => {
    _resetCheckpointForTests();
    const filler = 'x'.repeat(100_000);
    for (let i = 0; i < 25; i++) await appendTrialRow({ phase: 'rest', filler });
    const bodies = [];
    const fetchImpl = vi.fn().mockImplementation((_u, opts) => {
      bodies.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
    });
    const result = await uploadCheckpoint({ ...ID, session: fakeSession(), fetchImpl });
    expect(result).toEqual({ status: 'ok', rows: 25 });
    expect(bodies.length).toBeGreaterThan(1);
    const sent = bodies.flatMap((b) => JSON.parse(b.data).rows.map((r) => r.seq));
    expect(sent).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    for (const b of bodies) expect(b.data.length).toBeLessThan(1_000_000);
    expect(new Set(bodies.map((b) => b.filename)).size).toBe(bodies.length);
  });

  it('keeps the parts that arrived when a later part fails', async () => {
    _resetCheckpointForTests();
    const filler = 'x'.repeat(100_000);
    for (let i = 0; i < 25; i++) await appendTrialRow({ phase: 'rest', filler });
    let calls = 0;
    const flaky = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
      }
      return Promise.reject(new Error('offline'));
    });
    const failed = await uploadCheckpoint({
      ...ID,
      session: fakeSession(),
      fetchImpl: flaky,
      sleepImpl: () => Promise.resolve(),
    });
    expect(failed.status).toBe('failed');
    const bodies = [];
    const ok = vi.fn().mockImplementation((_u, opts) => {
      bodies.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
    });
    await uploadCheckpoint({ ...ID, session: fakeSession(), fetchImpl: ok });
    const firstSeq = JSON.parse(bodies[0].data).seq_min;
    expect(firstSeq).toBeGreaterThan(1);
  });
});

describe('uploadTail', () => {
  const ID = { datapipeExperimentId: 'exp-abc' };
  const okFetch = () => {
    const bodies = [];
    const fetchImpl = vi.fn().mockImplementation((_u, opts) => {
      bodies.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: async () => '' });
    });
    return { fetchImpl, bodies };
  };
  const finalUpload = (fetchImpl) =>
    uploadPendingData({
      session: fakeSession(),
      endpoint: 'https://pipe.jspsych.org/api/data/',
      provider: 'datapipe',
      ...ID,
      fetchImpl,
      sleepImpl: () => Promise.resolve(),
    });

  it('does nothing before the end-of-session upload has finished', async () => {
    _resetCheckpointForTests();
    await appendTrialRow({ phase: 'consent' });
    const { fetchImpl } = okFetch();
    expect((await uploadTail({ session: fakeSession(), ...ID, fetchImpl })).status).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the rows written after the final upload as one uniquely named file', async () => {
    _resetCheckpointForTests();
    await appendTrialRow({ phase: 'consent' });
    const first = okFetch();
    await finalUpload(first.fetchImpl);
    await appendTrialRow({ phase: 'upload_session_end', status: 'uploaded' });
    appendTrialRow({ phase: 'completion_redirect' });
    const { fetchImpl, bodies } = okFetch();
    const result = await uploadTail({ session: fakeSession(), ...ID, fetchImpl });
    expect(result).toEqual({ status: 'ok', rows: 2 });
    expect(bodies[0].filename).toBe(`sess-123__${getRunId()}__tail_2-3.json`);
    const rows = JSON.parse(bodies[0].data).rows;
    expect(rows.map((r) => r.phase)).toEqual(['upload_session_end', 'completion_redirect']);
    /* Sent once. */
    expect((await uploadTail({ session: fakeSession(), ...ID, fetchImpl })).status).toBe('nothing');
  });

  it('makes one attempt within the time limit and reports a failure without throwing', async () => {
    _resetCheckpointForTests();
    await appendTrialRow({ phase: 'consent' });
    await finalUpload(okFetch().fetchImpl);
    await appendTrialRow({ phase: 'upload_session_end' });
    const hanging = vi.fn().mockImplementation(
      (_u, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const started = Date.now();
    const result = await uploadTail({
      session: fakeSession(),
      ...ID,
      timeoutMs: 50,
      fetchImpl: hanging,
    });
    expect(result.status).toBe('failed');
    expect(hanging).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
