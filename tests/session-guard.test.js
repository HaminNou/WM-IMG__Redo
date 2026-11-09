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
  getRunId,
  getUploadCursor,
  initStorage,
  setUploadCursor,
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

  it('writes a reading of every clock on the session_start row', async () => {
    const before = Date.now();
    await startSessionGuard(session);
    const start = (await getAllTrialRows()).find((r) => r.phase === 'session_start');
    const c = start.clock_anchor;
    expect(c.date_now_ms).toBeGreaterThanOrEqual(before);
    expect(c.iso).toBe(new Date(c.date_now_ms).toISOString());
    expect(c.perf_now_ms).toBeGreaterThan(0);
    expect(c.time_origin_ms).toBe(performance.timeOrigin);
    /* The two clocks agree: time origin + performance.now() is the wall time. */
    expect(Math.abs(c.time_origin_ms + c.perf_now_ms - c.date_now_ms)).toBeLessThan(50);
    expect(c).toHaveProperty('jspsych_start_ms');
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

describe('a restart clears an abandoned earlier attempt', () => {
  const phasesOf = async (run) =>
    (await getAllTrialRows()).filter((r) => r.run_id === run).map((r) => r.phase);

  it('removes the rows and cursors of an unfinished earlier run and records what was removed', async () => {
    await appendTrialRow({ phase: 'consent', run_id: 'oldrun01' });
    await appendTrialRow({ phase: 'd_only_trial_start', run_id: 'oldrun01' });
    await appendTrialRow({ phase: 'd_only_probe', run_id: 'oldrun01' });
    await setUploadCursor(2, 'oldrun01');
    await startSessionGuard(session);
    const rows = await getAllTrialRows();
    expect(await phasesOf('oldrun01')).toEqual([]);
    expect(await getUploadCursor('oldrun01')).toBe(0);
    expect(rows.filter((r) => r.run_id === getRunId()).map((r) => r.phase)).toEqual([
      'session_start',
    ]);
    const start = rows.find((r) => r.phase === 'session_start');
    expect(start.prior_rows).toBe(3);
    expect(start.prior_run_ids).toEqual(['oldrun01']);
    expect(start.prior_rows_discarded).toBe(3);
    expect(start.prior_run_ids_discarded).toEqual(['oldrun01']);
    expect(start.prior_run_ids_kept).toEqual([]);
    expect(start.prior_discard_error).toBeNull();
  });

  it.each([
    ['reached the end of the task', 'end_of_task_intro', {}],
    ['ran the end-of-session upload', 'upload_session_end', {}],
    ['reached the redirect', 'completion_redirect', {}],
    [
      'was ended by a screen-out check',
      'timing_probe_fail',
      { exit_reason: 'timing_check_failed' },
    ],
  ])(
    'keeps an earlier run that %s (its rows may be a complete, unsent data set)',
    async (_n, phase, extra) => {
      await appendTrialRow({ phase: 'consent', run_id: 'doneRun1' });
      await appendTrialRow({ phase, run_id: 'doneRun1', ...extra });
      await appendTrialRow({ phase: 'consent', run_id: 'oldrun02' });
      await startSessionGuard(session);
      expect(await phasesOf('doneRun1')).toEqual(['consent', phase]);
      expect(await phasesOf('oldrun02')).toEqual([]);
      const start = (await getAllTrialRows()).find((r) => r.phase === 'session_start');
      expect(start.prior_run_ids_kept).toEqual(['doneRun1']);
      expect(start.prior_run_ids_discarded).toEqual(['oldrun02']);
      expect(start.prior_rows_discarded).toBe(1);
    }
  );

  it('treats a row with no run id as part of an abandoned run', async () => {
    await appendTrialRow({ phase: 'legacy', run_id: undefined });
    await startSessionGuard(session);
    const rows = await getAllTrialRows();
    expect(rows.some((r) => r.phase === 'legacy')).toBe(false);
  });

  it('does nothing when storage is empty', async () => {
    await startSessionGuard(session);
    const start = (await getAllTrialRows()).find((r) => r.phase === 'session_start');
    expect(start.prior_rows_discarded).toBe(0);
    expect(start.prior_run_ids_discarded).toEqual([]);
  });
});
