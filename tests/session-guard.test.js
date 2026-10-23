// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetSessionGuardForTests,
  markUploadDone,
  startSessionGuard,
} from '../src/session-guard.js';
import {
  _resetStorageForTests,
  appendTrialRow,
  getAllTrialRows,
  initStorage,
} from '../src/storage.js';

const session = { params: { session_id: 's1' }, started_at_iso: '2000-01-01T00:00:00Z' };

afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  _resetStorageForTests();
  _resetSessionGuardForTests();
  await initStorage({ backend: 'memory' });
});

describe('session guard', () => {
  it('records rows left from an earlier run in a session_start row', async () => {
    await appendTrialRow({ phase: 'consent', run_id: 'oldrun01' });
    await appendTrialRow({ phase: 'demographics', run_id: 'oldrun01' });
    await startSessionGuard(session);
    const rows = await getAllTrialRows();
    const start = rows.find((r) => r.phase === 'session_start');
    expect(start.prior_rows).toBe(2);
    expect(start.prior_run_ids).toEqual(['oldrun01']);
    expect(start.run_id).toMatch(/^.{8}$/);
    expect(start.session_id).toBe('s1');
  });

  it('starts clean when storage is empty', async () => {
    await startSessionGuard(session);
    const start = (await getAllTrialRows()).find((r) => r.phase === 'session_start');
    expect(start.prior_rows).toBe(0);
    expect(start.prior_run_ids).toEqual([]);
  });

  it('asks for confirmation before leaving until the upload is done', async () => {
    await startSessionGuard(session);
    const before = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const rows = await getAllTrialRows();
    expect(rows.some((r) => r.phase === 'unload_attempt')).toBe(true);

    markUploadDone();
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('traps the back button: each press pushes the page back onto the history and is logged', async () => {
    await startSessionGuard(session);
    const push = vi.spyOn(history, 'pushState');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new PopStateEvent('popstate'));
    await new Promise((r) => setTimeout(r, 0));
    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenLastCalledWith(null, '', location.href);
    const rows = await getAllTrialRows();
    expect(rows.filter((r) => r.phase === 'back_pressed')).toHaveLength(2);
  });

  it('stops trapping and logging after the guard is removed', async () => {
    await startSessionGuard(session);
    _resetSessionGuardForTests();
    const push = vi.spyOn(history, 'pushState');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await new Promise((r) => setTimeout(r, 0));
    expect(push).not.toHaveBeenCalled();
    const rows = await getAllTrialRows();
    expect(rows.filter((r) => r.phase === 'back_pressed')).toHaveLength(0);
  });
});
