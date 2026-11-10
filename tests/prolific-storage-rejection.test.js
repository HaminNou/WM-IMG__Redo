// @vitest-environment jsdom
/**
 * initSession starts storage in the background. A failure there is already shown by the
 * runner's fatal storage screen, so initSession must swallow (and log) it rather than leave an
 * unhandled rejection or raise a second screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/storage.js', () => ({
  initStorage: vi.fn(() => Promise.reject(new Error('idb blocked'))),
  setCompletionUrl: vi.fn(() => Promise.resolve()),
  setSessionId: vi.fn(() => Promise.resolve()),
  setSessionStartedAt: vi.fn(() => Promise.resolve()),
  setSessionObject: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/uploader.js', async (importOriginal) => ({
  ...(await importOriginal()),
  buildCompletionUrl: () => 'https://example.test/complete',
}));

import { _resetLocalSessionIdForTests, initSession } from '../src/prolific.js';

afterEach(() => {
  vi.restoreAllMocks();
  _resetLocalSessionIdForTests();
});

describe('initSession background storage start', () => {
  it('does not leave an unhandled rejection when storage fails, and renders nothing itself', async () => {
    const seen = [];
    const onRejection = (e) => seen.push(e);
    process.on('unhandledRejection', onRejection);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = '<div id="x"></div>';
    initSession(
      { prolific_pid: 'p', study_id: 's', session_id: 'abc', is_preview: false },
      { is_pilot_run: false, pilot_label: null, source: 'none' }
    );
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', onRejection);
    expect(seen).toEqual([]);
    expect(log).toHaveBeenCalled();
    expect(document.body.innerHTML).toBe('<div id="x"></div>');
  });
});
