/**
 * Pilot-mode runtime-flag tests.
 *
 * The flag is read from the URL (`?pilot=1`) or a Vite build-time env var
 * (`VITE_PILOT_RUN`). Resolution precedence: URL > env > none. Importantly,
 * neither source touches `config.js` — the pre-reg snapshot lock (Step 12)
 * remains valid regardless of whether the flag is set.
 *
 * What the tests lock:
 *   - URL truthy parsing (`1`, `true`, `yes`, `on`, case-insensitive).
 *   - Env truthy parsing (same set; `false` / empty / undefined → not pilot).
 *   - Pilot-label sanitisation (length cap, ASCII pattern, missing → null).
 *   - URL beats env when both are set.
 *   - Return value is frozen (callers can't mutate it).
 *   - The pilot fields propagate onto a bucket envelope alongside session metadata.
 */
import { describe, it, expect } from 'vitest';
import { readPilotMode } from '../src/pilot-mode.js';
import { buildBucketEnvelope, BUCKETS } from '../src/uploader.js';

function makeSession(overrides = {}) {
  return {
    params: {
      session_id: 'sess-1',
      prolific_pid: 'pid-1',
      study_id: 'study-1',
      is_preview: false,
    },
    prng_seed_uint32: 1,
    schema_version: '1.1.3',
    build_id: 'v1',
    started_at_iso: '2000-01-01T10:00:00Z',
    user_agent: 'TestAgent/1.0',
    is_pilot_run: false,
    pilot_label: null,
    ...overrides,
  };
}

describe('readPilotMode – URL source', () => {
  it('returns is_pilot_run=true on ?pilot=1', () => {
    const out = readPilotMode({ search: '?pilot=1', env: {} });
    expect(out.is_pilot_run).toBe(true);
    expect(out.source).toBe('url');
  });

  it('accepts the lenient truthy aliases: true, yes, on, 1 (case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON']) {
      const out = readPilotMode({ search: `?pilot=${v}`, env: {} });
      expect(out.is_pilot_run).toBe(true);
    }
  });

  it('returns is_pilot_run=false on falsy or missing values', () => {
    for (const v of ['', '0', 'false', 'no', 'off', 'maybe']) {
      const out = readPilotMode({ search: `?pilot=${v}`, env: {} });
      expect(out.is_pilot_run).toBe(false);
      expect(out.source).toBe('none');
    }
    expect(readPilotMode({ search: '', env: {} }).is_pilot_run).toBe(false);
    expect(readPilotMode({ search: '?other=1', env: {} }).is_pilot_run).toBe(false);
  });

  it('reads pilot_label from the URL when valid', () => {
    const out = readPilotMode({ search: '?pilot=1&pilot_label=pilot-test', env: {} });
    expect(out.pilot_label).toBe('pilot-test');
  });

  it('rejects pilot_labels with invalid characters', () => {
    /* Spaces, slashes, and unicode are all rejected so a malformed label can't
     * smuggle awkward characters into CSV exports or filename components. */
    for (const raw of ['has space', 'has/slash', 'unicodé', 'has;semi', '']) {
      const out = readPilotMode({
        search: `?pilot=1&pilot_label=${encodeURIComponent(raw)}`,
        env: {},
      });
      expect(out.pilot_label).toBeNull();
    }
  });

  it('rejects pilot_labels exceeding the length cap', () => {
    const tooLong = 'a'.repeat(65);
    const out = readPilotMode({ search: `?pilot=1&pilot_label=${tooLong}`, env: {} });
    expect(out.pilot_label).toBeNull();
  });

  it('accepts a label at the length cap and rejects characters outside the pattern', () => {
    const atCap = 'a'.repeat(64);
    expect(readPilotMode({ search: `?pilot=1&pilot_label=${atCap}`, env: {} }).pilot_label).toBe(
      atCap
    );
    expect(
      readPilotMode({ search: '?pilot=1&pilot_label=bad%20label', env: {} }).pilot_label
    ).toBeNull();
  });
});

describe('readPilotMode – env source', () => {
  it('returns is_pilot_run=true on VITE_PILOT_RUN=1', () => {
    const out = readPilotMode({ search: '', env: { VITE_PILOT_RUN: '1' } });
    expect(out.is_pilot_run).toBe(true);
    expect(out.source).toBe('env');
  });

  it('reads VITE_PILOT_LABEL from env when valid', () => {
    const out = readPilotMode({
      search: '',
      env: { VITE_PILOT_RUN: 'true', VITE_PILOT_LABEL: 'pilot.wave1' },
    });
    expect(out.pilot_label).toBe('pilot.wave1');
  });

  it('returns is_pilot_run=false when env is empty / null / not an object', () => {
    expect(readPilotMode({ search: '', env: {} }).is_pilot_run).toBe(false);
    expect(readPilotMode({ search: '', env: null }).is_pilot_run).toBe(false);
    /* A defensive call — a future caller might pass a non-object accidentally. */
    expect(readPilotMode({ search: '', env: 'oops' }).is_pilot_run).toBe(false);
  });
});

describe('readPilotMode – precedence + frozenness', () => {
  it('URL beats env when both flip pilot mode', () => {
    const out = readPilotMode({
      search: '?pilot=1&pilot_label=from-url',
      env: { VITE_PILOT_RUN: '1', VITE_PILOT_LABEL: 'from-env' },
    });
    expect(out.source).toBe('url');
    expect(out.pilot_label).toBe('from-url');
  });

  it('env wins when URL is absent', () => {
    const out = readPilotMode({
      search: '',
      env: { VITE_PILOT_RUN: '1', VITE_PILOT_LABEL: 'from-env' },
    });
    expect(out.source).toBe('env');
    expect(out.pilot_label).toBe('from-env');
  });

  it('returns frozen objects so consumers cannot mutate the resolved flag', () => {
    const out = readPilotMode({ search: '?pilot=1', env: {} });
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('handles missing search/env arguments gracefully (no throw)', () => {
    /* Under jsdom `window.location.search` is `''`, so this resolves to a
     * non-pilot session — exactly the behavior we want for unit tests that
     * don't rely on URL params. */
    const out = readPilotMode();
    expect(out.is_pilot_run).toBe(false);
    expect(out.source).toBe('none');
  });
});

describe('bucket envelope wires pilot fields through', () => {
  it('stamps is_pilot_run=false / pilot_label=null on a non-pilot session', () => {
    const env = buildBucketEnvelope({
      session: makeSession(),
      bucket: BUCKETS[0],
      bucketIndex: 0,
      totalBuckets: 1,
      rows: [{ seq: 1 }],
    });
    expect(env.is_pilot_run).toBe(false);
    expect(env.pilot_label).toBeNull();
  });

  it('stamps is_pilot_run=true / pilot_label=<...> on a pilot session', () => {
    const env = buildBucketEnvelope({
      session: makeSession({ is_pilot_run: true, pilot_label: 'pilot-test' }),
      bucket: BUCKETS[0],
      bucketIndex: 0,
      totalBuckets: 1,
      rows: [{ seq: 1 }],
    });
    expect(env.is_pilot_run).toBe(true);
    expect(env.pilot_label).toBe('pilot-test');
  });

  it('defaults pilot fields to false/null when missing from the session object', () => {
    /* Defensive — older fixture sessions (Step 10/11) don't carry pilot fields.
     * The envelope should still include them, defaulted, rather than leaking
     * undefined into the JSON payload. */
    const session = makeSession();
    delete session.is_pilot_run;
    delete session.pilot_label;
    const env = buildBucketEnvelope({
      session,
      bucket: BUCKETS[0],
      bucketIndex: 0,
      totalBuckets: 1,
      rows: [{ seq: 1 }],
    });
    expect(env.is_pilot_run).toBe(false);
    expect(env.pilot_label).toBeNull();
  });
});
