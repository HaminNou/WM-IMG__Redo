// @vitest-environment jsdom
/**
 * Session id and seed derivation from the Prolific URL (src/prolific.js).
 *
 * Pre-registered seed rule: `PROLIFIC_PID|STUDY_ID|SESSION_ID` for real
 * sessions. A missing SESSION_ID must not leave the session without an id
 * (uploads are named `<session_id>__<run>__<bucket>.json`): it gets a locally
 * generated `LOCAL_…` id, recorded as such, stable across a reload of the same
 * tab and never equal to a Prolific id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/storage.js', () => ({
  initStorage: vi.fn(() => Promise.resolve()),
  setCompletionUrl: vi.fn(() => Promise.resolve()),
  setSessionId: vi.fn(() => Promise.resolve()),
  setSessionStartedAt: vi.fn(() => Promise.resolve()),
  setSessionObject: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/uploader.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildCompletionUrl: () => 'https://example.test/complete' };
});

import {
  LOCAL_SESSION_ID_PREFIX,
  _resetLocalSessionIdForTests,
  initSession,
  localFallbackSessionId,
} from '../src/prolific.js';
import { dataPipeFilenameForBucket } from '../src/uploader.js';
import { buildSessionInfo } from '../src/session-info.js';
import { config } from '../src/config.js';

const PILOT = { is_pilot_run: false, pilot_label: null, source: 'none' };
const REAL = {
  prolific_pid: '5f1e8a1c9b2d4e0012345678',
  study_id: '65a1b2c3d4e5f60718293a4b',
  session_id: '6a7b8c9d0e1f2a3b4c5d6e7f',
  is_preview: false,
};

beforeEach(() => {
  _resetLocalSessionIdForTests();
  /* the seed rule below only applies when no override is configured */
  expect(config.prng.deterministic_override ?? null).toBeNull();
});
afterEach(() => {
  vi.restoreAllMocks();
  _resetLocalSessionIdForTests();
});

describe('initSession: complete Prolific parameters', () => {
  it('keeps the Prolific ids, seeds from PID|STUDY|SESSION and marks the id as Prolific', () => {
    const s = initSession({ ...REAL }, PILOT);
    expect(s.params.session_id).toBe(REAL.session_id);
    expect(s.params.session_id_source).toBe('prolific');
    expect(s.params.is_preview).toBe(false);
    expect(s.seed_string).toBe(`${REAL.prolific_pid}|${REAL.study_id}|${REAL.session_id}`);
  });

  it('the same parameters give the same seed (a reload reproduces the schedule)', () => {
    const a = initSession({ ...REAL }, PILOT);
    const b = initSession({ ...REAL }, PILOT);
    expect(a.prng_seed_uint32).toBe(b.prng_seed_uint32);
  });
});

describe('initSession: SESSION_ID missing', () => {
  const noSid = { ...REAL, session_id: null, is_preview: true };

  it('gets a non-empty local id, flagged as a fallback, with the PID and study id untouched', () => {
    const s = initSession({ ...noSid }, PILOT);
    expect(typeof s.params.session_id).toBe('string');
    expect(s.params.session_id.startsWith(LOCAL_SESSION_ID_PREFIX)).toBe(true);
    expect(s.params.session_id_source).toBe('local_fallback');
    expect(s.params.prolific_pid).toBe(REAL.prolific_pid);
    expect(s.params.study_id).toBe(REAL.study_id);
    expect(s.params.is_preview).toBe(true);
  });

  it('never fabricates a PID: a URL with no parameters keeps null PID and study id', () => {
    const s = initSession(
      { prolific_pid: null, study_id: null, session_id: null, is_preview: true },
      PILOT
    );
    expect(s.params.prolific_pid).toBeNull();
    expect(s.params.study_id).toBeNull();
    expect(s.params.session_id).toMatch(/^LOCAL_/);
  });

  it('an empty-string SESSION_ID counts as missing', () => {
    const s = initSession({ ...noSid, session_id: '' }, PILOT);
    expect(s.params.session_id).toMatch(/^LOCAL_/);
    expect(s.params.session_id_source).toBe('local_fallback');
  });

  it('the id is stable across a reload of the same tab and reused for the seed', () => {
    const first = initSession({ ...noSid }, PILOT);
    const reload = initSession({ ...noSid }, PILOT);
    expect(reload.params.session_id).toBe(first.params.session_id);
    expect(reload.seed_string).toBe(first.seed_string);
    expect(reload.prng_seed_uint32).toBe(first.prng_seed_uint32);
    expect(first.seed_string).toBe(`preview-${first.params.session_id}`);
  });

  it('a different tab (fresh sessionStorage) gets a different id', () => {
    const a = localFallbackSessionId();
    _resetLocalSessionIdForTests();
    const b = localFallbackSessionId();
    expect(a).not.toBe(b);
  });

  it('keeps one id when sessionStorage is unavailable (held in memory)', () => {
    const spy = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    const a = localFallbackSessionId();
    const b = localFallbackSessionId();
    expect(a).toBe(b);
    expect(a).toMatch(/^LOCAL_/);
    spy.mockRestore();
  });

  it('can never equal a Prolific session id (24 hex digits)', () => {
    for (let i = 0; i < 50; i++) {
      _resetLocalSessionIdForTests();
      expect(localFallbackSessionId()).not.toMatch(/^[0-9a-f]{24}$/);
    }
  });

  it('the generated id builds a valid upload file name instead of throwing', () => {
    const s = initSession({ ...noSid }, PILOT);
    expect(
      dataPipeFilenameForBucket({
        session_id: s.params.session_id,
        run_id: 'abcd1234',
        bucket_label: '01_consent_demographics',
      })
    ).toBe(`${s.params.session_id}__abcd1234__01_consent_demographics.json`);
    /* the original failure: a null id made the file name throw */
    expect(() =>
      dataPipeFilenameForBucket({ session_id: null, run_id: 'r', bucket_label: 'b' })
    ).toThrow(/session_id is required/);
  });

  it('is recorded on the session_info row', () => {
    const s = initSession({ ...noSid }, PILOT);
    const row = buildSessionInfo(s, null, {});
    expect(row.session_id).toBe(s.params.session_id);
    expect(row.session_id_source).toBe('local_fallback');
    expect(row.is_preview).toBe(true);
    const real = buildSessionInfo(initSession({ ...REAL }, PILOT), null, {});
    expect(real.session_id_source).toBe('prolific');
  });
});
