// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/storage.js', async (orig) => ({
  ...(await orig()),
  discardAbandonedEarlierRuns: vi.fn().mockRejectedValue(new Error('IDB delete failed')),
}));

import { _resetSessionGuardForTests, startSessionGuard } from '../src/session-guard.js';
import {
  _resetStorageForTests,
  appendTrialRow,
  getAllTrialRows,
  initStorage,
} from '../src/storage.js';

const session = { params: { session_id: 's1' }, started_at_iso: '2000-01-01T00:00:00Z' };

beforeEach(async () => {
  _resetStorageForTests();
  _resetSessionGuardForTests();
  await initStorage({ backend: 'memory' });
});

describe('session guard when clearing the earlier attempt fails', () => {
  it('still starts the session and records the error on the session_start row', async () => {
    await appendTrialRow({ phase: 'consent', run_id: 'oldrun01' });
    await startSessionGuard(session);
    const start = (await getAllTrialRows()).find((r) => r.phase === 'session_start');
    expect(start).toBeDefined();
    expect(start.prior_rows).toBe(1);
    expect(start.prior_rows_discarded).toBe(0);
    expect(start.prior_discard_error).toBe('IDB delete failed');
  });
});
