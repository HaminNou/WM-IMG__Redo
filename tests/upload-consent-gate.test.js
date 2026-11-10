/**
 * The page-hide flush must not post anything before consent, or after a decline. Before this
 * fix `flushOnHide` was installed unconditionally and sent the session_start / desktop_gate rows
 * (participant id, session id, user agent) the moment the tab was hidden.
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', async (orig) =>
  (await import('./helpers/live-uploader-config.js')).withLiveUploader(await orig())
);
vi.mock('../src/audio/context.js', () => ({
  unlockAudio: vi.fn(() => new Promise(() => {})) /* never settles */,
}));
vi.mock('../src/hidden-nav.js', () => ({
  registerHiddenNavStep: vi.fn(),
  trackHiddenNavNode: (node) => node,
}));

import { _resetCheckpointForTests, flushOnHide } from '../src/uploader.js';
import {
  _resetStorageForTests,
  appendTrialRow,
  flushPendingWrites,
  initStorage,
} from '../src/storage.js';
import { consentTrial } from '../src/calibration/consent.js';

const session = {
  params: { session_id: 'abc123', prolific_pid: 'pid-1', study_id: 'st', is_preview: false },
  prng_seed_uint32: 1,
  schema_version: '1.2.0',
  build_id: 'v1',
  started_at_iso: '2026-01-01T00:00:00.000Z',
  user_agent: 'test',
};
const okFetch = () => vi.fn(() => Promise.resolve({ ok: true, status: 200 }));

beforeEach(async () => {
  _resetStorageForTests();
  _resetCheckpointForTests();
  await initStorage({ backend: 'memory' });
  await appendTrialRow({ phase: 'session_start', session_id: 'abc123' });
  await flushPendingWrites();
  await Promise.resolve();
});

describe('page-hide flush and consent', () => {
  it('posts nothing before consent', () => {
    const fetchImpl = okFetch();
    const r = flushOnHide({ session, fetchImpl, nowMs: 100_000, bypassThrottle: true });
    expect(r.status).toBe('no_consent');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts after the consent button is pressed, even if the audio unlock never settles', () => {
    const node = consentTrial();
    const data = { response: 0 };
    expect(() => node.on_finish(data)).not.toThrow();
    expect(data.consented).toBe(true);
    const fetchImpl = okFetch();
    expect(flushOnHide({ session, fetchImpl, nowMs: 100_000 }).status).toBe('sent');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('posts nothing after a decline, even if consent had been on', () => {
    const node = consentTrial();
    node.on_finish({ response: 0 });
    node.on_finish({ response: 1 });
    const fetchImpl = okFetch();
    expect(flushOnHide({ session, fetchImpl, nowMs: 100_000 }).status).toBe('no_consent');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
