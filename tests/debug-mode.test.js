// @vitest-environment jsdom
/**
 * Debug-mode gating: `debug=1` only counts on an experimenter session (pilot, dev build, localhost).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isDebugMode,
  debugSessionStamp,
  _resetDebugModeForTests,
} from '../src/debug/debug-mode.js';

const PROLIFIC = '?PROLIFIC_PID=a&STUDY_ID=b&SESSION_ID=c';
const base = { hostname: 'user.github.io', isPilot: false, isDev: false, buildEnabled: true };

beforeEach(() => _resetDebugModeForTests());

describe('isDebugMode gating matrix', () => {
  it('debug=1 alone on a Prolific-style URL is OFF', () => {
    expect(isDebugMode({ ...base, search: `${PROLIFIC}&debug=1` })).toBe(false);
  });
  it('debug=1 with pilot=1 is ON (pilot read from the URL)', () => {
    expect(
      isDebugMode({ hostname: 'x.io', isDev: false, search: `${PROLIFIC}&pilot=1&debug=1` })
    ).toBe(true);
    expect(isDebugMode({ ...base, isPilot: true, search: '?debug=1' })).toBe(true);
  });
  it('debug=1 on a dev build or localhost is ON', () => {
    expect(isDebugMode({ ...base, isDev: true, search: '?debug=1' })).toBe(true);
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      expect(isDebugMode({ ...base, hostname, search: '?debug=1' })).toBe(true);
    }
  });
  it('no debug param is OFF everywhere', () => {
    expect(
      isDebugMode({ hostname: 'localhost', isDev: true, isPilot: true, search: '?pilot=1' })
    ).toBe(false);
    expect(isDebugMode({ ...base, search: '' })).toBe(false);
  });
  it('only truthy values of debug count', () => {
    for (const v of ['0', '', 'false', 'no', 'off']) {
      expect(isDebugMode({ hostname: 'localhost', search: `?debug=${v}` })).toBe(false);
    }
    expect(isDebugMode({ hostname: 'localhost', search: '?debug=true' })).toBe(true);
  });
  it('is false on malformed input instead of throwing', () => {
    expect(isDebugMode({ search: null, hostname: undefined, isPilot: false, isDev: false })).toBe(
      false
    );
    expect(isDebugMode({ search: 42 })).toBe(false);
  });
  it('debugSessionStamp is the boolean under debug_mode', () => {
    expect(debugSessionStamp({ ...base, search: '?debug=1' })).toEqual({ debug_mode: false });
    expect(debugSessionStamp({ ...base, isDev: true, search: '?debug=1' })).toEqual({
      debug_mode: true,
    });
  });
  it('is memoised when called without arguments (the URL is read once)', () => {
    const first = isDebugMode();
    window.history.replaceState({}, '', '/?debug=1&pilot=1');
    expect(isDebugMode()).toBe(first);
    _resetDebugModeForTests();
    expect(isDebugMode()).toBe(true);
    window.history.replaceState({}, '', '/');
  });
});

describe('session stamp', () => {
  it('session_info carries debug_mode next to is_pilot_run (false by default)', async () => {
    const { buildSessionInfo } = await import('../src/session-info.js');
    const row = buildSessionInfo({ params: {}, is_pilot_run: false }, null);
    expect(row.debug_mode).toBe(false);
    expect(buildSessionInfo({ params: {}, debug_mode: true }, null).debug_mode).toBe(true);
  });
  it('initSession stamps the flag from the URL gate and the bucket envelope forwards it', async () => {
    const { initSession } = await import('../src/prolific.js');
    const { buildBucketEnvelope, BUCKETS } = await import('../src/uploader.js');
    const s = initSession(
      { session_id: 's', is_preview: true },
      { is_pilot_run: false, pilot_label: null, source: 'none' }
    );
    expect(s.debug_mode).toBe(false);
    expect(
      buildBucketEnvelope({
        session: { ...s, debug_mode: true },
        bucket: BUCKETS[0],
        bucketIndex: 0,
        totalBuckets: 1,
        rows: [],
      }).debug_mode
    ).toBe(true);
  });
});

describe('the build decides first: a production build has debug compiled OFF', () => {
  it('buildEnabled false: every URL / host / dev combination is OFF', () => {
    const off = { buildEnabled: false };
    expect(
      isDebugMode({ ...base, ...off, isPilot: true, search: `${PROLIFIC}&pilot=1&debug=1` })
    ).toBe(false);
    expect(isDebugMode({ ...base, ...off, isDev: true, search: '?debug=1' })).toBe(false);
    expect(isDebugMode({ ...base, ...off, hostname: 'localhost', search: '?debug=1' })).toBe(false);
    expect(
      isDebugMode({
        ...base,
        ...off,
        hostname: '127.0.0.1',
        isPilot: true,
        search: '?pilot=1&debug=1',
      })
    ).toBe(false);
    expect(
      debugSessionStamp({ ...base, ...off, isPilot: true, search: '?pilot=1&debug=1' })
    ).toEqual({
      debug_mode: false,
    });
  });
  it('buildEnabled true keeps the experimenter matrix (pilot, dev, localhost)', () => {
    expect(isDebugMode({ ...base, isPilot: true, search: '?pilot=1&debug=1' })).toBe(true);
    expect(isDebugMode({ ...base, search: `${PROLIFIC}&debug=1` })).toBe(false);
  });
  it('package.json has a normal build without the flag and a build:debug with it', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.scripts.build).not.toContain('VITE_ENABLE_DEBUG');
    expect(pkg.scripts['build:debug']).toContain('VITE_ENABLE_DEBUG=1');
  });
});
