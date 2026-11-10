// @vitest-environment jsdom
/**
 * A second tab of the study must not delete the first tab's live data (the abandoned-run
 * cleanup used to remove any run without a finishing row, including one still running in
 * another tab). A live tab holds a Web Lock; without the Locks API only long-idle runs go.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLockManager } from './helpers/fake-locks.js';
import { STUDY_LOCK_NAME, StudyOpenElsewhereError } from '../src/study-lock.js';
import { _resetSessionGuardForTests, startSessionGuard } from '../src/session-guard.js';
import {
  _resetStorageForTests,
  appendTrialRow,
  getAllTrialRows,
  initStorage,
} from '../src/storage.js';
import { handleFatal } from '../src/fatal-handler.js';

const session = { params: { session_id: 's1' }, started_at_iso: '2000-01-01T00:00:00Z' };
const noWait = { retryDelaysMs: [] };

async function freshTab() {
  _resetStorageForTests();
  _resetSessionGuardForTests();
  await initStorage({ backend: 'memory' });
}
const setLocks = (locks) =>
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
const phases = async (run) =>
  (await getAllTrialRows()).filter((r) => r.run_id === run).map((r) => r.phase);

beforeEach(freshTab);
afterEach(() => {
  setLocks(undefined);
  _resetSessionGuardForTests();
});

describe('second tab', () => {
  it('does not start and does not delete the live first tab data', async () => {
    const locks = createLockManager();
    /* tab 1 holds the lock and has an unfinished run in the shared database */
    await startSessionGuard(session, { locks, ...noWait });
    await appendTrialRow({ phase: 'consent', run_id: 'liveTab1' });
    _resetSessionGuardForTests();

    /* tab 2: same lock table, same database */
    await expect(startSessionGuard(session, { locks, ...noWait })).rejects.toBeInstanceOf(
      StudyOpenElsewhereError
    );
    expect(await phases('liveTab1')).toEqual(['consent']);
    expect((await getAllTrialRows()).filter((r) => r.phase === 'session_start')).toHaveLength(1);
  });

  it('shows the already-open screen and writes no row', async () => {
    const calls = [];
    const err = new StudyOpenElsewhereError();
    handleFatal({
      stage: 'startup',
      error: err,
      session,
      deps: {
        renderFatalScreen: (o) => calls.push(o),
        appendTrialRow: () => calls.push('row'),
      },
    });
    expect(calls).toEqual([{ stage: 'duplicate_tab' }]);
    const { FATAL_TEXT } = await import('../src/fatal-screens.js');
    expect(FATAL_TEXT.duplicate_tab.paragraphs[0]).toBe(
      'The study is already open in another tab or window. Please close this tab and continue in the original one.'
    );
  });
});

describe('restart after the first tab is gone', () => {
  it('still clears the abandoned run once the lock is released', async () => {
    const locks = createLockManager();
    await startSessionGuard(session, { locks, ...noWait });
    await appendTrialRow({ phase: 'consent', run_id: 'deadTab1' });
    _resetSessionGuardForTests();
    locks.release(STUDY_LOCK_NAME); /* tab 1 closed */

    await startSessionGuard(session, { locks, ...noWait });
    expect(await phases('deadTab1')).toEqual([]);
    const start = (await getAllTrialRows()).filter((r) => r.phase === 'session_start').pop();
    expect(start.prior_run_ids_discarded).toContain('deadTab1');
  });
});

describe('without the Locks API', () => {
  it('keeps a recently written unfinished run (it may be live)', async () => {
    setLocks(undefined);
    await appendTrialRow({ phase: 'consent', run_id: 'recent01' });
    await startSessionGuard(session);
    expect(await phases('recent01')).toEqual(['consent']);
  });

  it('removes an unfinished run idle for more than 30 minutes', async () => {
    setLocks(undefined);
    await appendTrialRow({
      phase: 'consent',
      run_id: 'stale001',
      wall_ms: Date.now() - 31 * 60_000,
    });
    await startSessionGuard(session);
    expect(await phases('stale001')).toEqual([]);
  });
});
