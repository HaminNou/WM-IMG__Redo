// @vitest-environment jsdom
/**
 * V4-04: after a failed end-of-session upload and a successful retry, the data
 * kept `upload_session_end` = 'partial' although every file had arrived, and
 * pilot-summary printed "upload: partial". Now every retry attempt made on the
 * failure screen (the 'Try sending my answers again' button, and the one last
 * attempt made when 'Continue to Prolific' is pressed) writes its own
 * `upload_retry_result` row BEFORE the next tail upload, so it travels with
 * the data and the LATEST row is the final upload status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  uploadPendingData: vi.fn(),
  uploadTail: vi.fn(() => Promise.resolve({ status: 'ok', rows: 2 })),
  appendTrialRow: vi.fn(() => Promise.resolve(1)),
  downloadAsJson: vi.fn(() => ({ filename: 'data.json', sizeBytes: 2048 })),
  getAllTrialRows: vi.fn(() => Promise.resolve([{ seq: 1 }])),
  getCompletionUrl: vi.fn(() => Promise.resolve(null)),
  markUploadDone: vi.fn(),
}));

vi.mock('../src/uploader.js', () => ({
  uploadPendingData: mocks.uploadPendingData,
  uploadTail: mocks.uploadTail,
  downloadAsJson: mocks.downloadAsJson,
  buildCompletionUrl: () => 'https://app.prolific.com/submissions/complete?cc=REAL',
  isPlaceholderCompletionUrl: () => false,
}));
vi.mock('../src/storage.js', () => ({
  appendTrialRow: mocks.appendTrialRow,
  getAllTrialRows: mocks.getAllTrialRows,
  getCompletionUrl: mocks.getCompletionUrl,
  getStorageFailureSummary: () => ({ writeFailures: 0, lastError: null, lastFailureAtIso: null }),
}));
vi.mock('../src/session-guard.js', () => ({ markUploadDone: mocks.markUploadDone }));

import { completionRedirectNode } from '../src/conditions/debrief.js';

const session = { params: { session_id: 's' } };

function withUploadRow(row) {
  window.jsPsych = {
    finishTrial: vi.fn(),
    data: { get: () => ({ filter: () => ({ values: () => (row ? [row] : []) }) }) },
  };
}
const retryRows = () =>
  mocks.appendTrialRow.mock.calls.map((c) => c[0]).filter((r) => r.phase === 'upload_retry_result');

let assign;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="completion-mount"></div>';
  for (const m of Object.values(mocks)) if (typeof m.mockClear === 'function') m.mockClear();
  mocks.uploadPendingData.mockReset();
  mocks.uploadTail.mockImplementation(() => Promise.resolve({ status: 'ok', rows: 2 }));
  mocks.appendTrialRow.mockImplementation(() => Promise.resolve(1));
  assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      set href(v) {
        assign(v);
      },
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.jsPsych;
});

const FAILED = { phase: 'upload_session_end', status: 'partial', download_filename: 'f.json' };

describe('retry button writes one upload_retry_result row per attempt', () => {
  it('a failed then a successful retry: two rows, attempt 1 partial, attempt 2 uploaded', async () => {
    withUploadRow(FAILED);
    mocks.uploadPendingData
      .mockResolvedValueOnce({ status: 'partial' })
      .mockResolvedValueOnce({ status: 'uploaded', uploadedBuckets: 8, totalBuckets: 8 });
    await completionRedirectNode({ redirectDelayMs: 2000, session }).on_load();

    document.getElementById('upload-retry').click();
    await vi.advanceTimersByTimeAsync(20);
    expect(retryRows()).toHaveLength(1);
    expect(retryRows()[0]).toMatchObject({
      phase: 'upload_retry_result',
      status: 'partial',
      upload_attempt: 1,
      after_failure: true,
      retry_trigger: 'retry_button',
      previous_status: 'partial',
    });
    expect(document.getElementById('upload-continue')).not.toBeNull(); /* screen kept */

    document.getElementById('upload-retry').click();
    await vi.advanceTimersByTimeAsync(20);
    expect(retryRows()).toHaveLength(2);
    expect(retryRows()[1]).toMatchObject({
      status: 'uploaded',
      upload_attempt: 2,
      retry_trigger: 'retry_button',
    });
  });

  it('the success row is written BEFORE the tail upload, so the tail carries it', async () => {
    withUploadRow(FAILED);
    const order = [];
    mocks.appendTrialRow.mockImplementation(async (r) => {
      order.push(r.phase);
      return 1;
    });
    mocks.uploadPendingData.mockResolvedValueOnce({ status: 'uploaded' });
    mocks.uploadTail.mockImplementation(async () => {
      order.push('tail');
      return { status: 'ok' };
    });
    await completionRedirectNode({ redirectDelayMs: 1000, session }).on_load();
    document.getElementById('upload-retry').click();
    await vi.advanceTimersByTimeAsync(1500);
    expect(order.indexOf('upload_retry_result')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('upload_retry_result')).toBeLessThan(order.indexOf('tail'));
    expect(assign).toHaveBeenCalled();
  });

  it('the row carries no Prolific id, file content or free text', async () => {
    withUploadRow(FAILED);
    mocks.uploadPendingData.mockResolvedValueOnce({ status: 'uploaded' });
    await completionRedirectNode({ redirectDelayMs: 1000, session }).on_load();
    document.getElementById('upload-retry').click();
    await vi.advanceTimersByTimeAsync(20);
    const keys = Object.keys(retryRows()[0]).filter((k) => !/^(clock|wall|perf|iso|time)/i.test(k));
    for (const k of keys) expect(k).not.toMatch(/pid|prolific|session_id/i);
  });
});

describe("'Continue to Prolific' records the one last attempt", () => {
  it.each([
    ['uploaded', () => Promise.resolve({ status: 'uploaded' }), 'uploaded'],
    ['still partial', () => Promise.resolve({ status: 'partial' }), 'partial'],
    ['throws', () => Promise.reject(new Error('net')), 'error'],
  ])(
    '%s: the attempt is recorded after the completion row and before the tail',
    async (_n, result, expected) => {
      withUploadRow(FAILED);
      const order = [];
      mocks.appendTrialRow.mockImplementation(async (r) => {
        order.push(r.phase);
        return 1;
      });
      mocks.uploadPendingData.mockImplementationOnce(result);
      mocks.uploadTail.mockImplementation(async () => {
        order.push('tail');
        return { status: 'ok' };
      });
      await completionRedirectNode({ session }).on_load();
      document.getElementById('upload-continue').click();
      await vi.advanceTimersByTimeAsync(100);
      expect(order).toEqual(['completion_redirect', 'upload_retry_result', 'tail']);
      expect(retryRows()[0]).toMatchObject({
        status: expected,
        upload_attempt: 1,
        retry_trigger: 'continue_button',
        after_failure: true,
      });
      expect(assign).toHaveBeenCalled();
    }
  );

  it('a final attempt that never answers is recorded as timed_out', async () => {
    withUploadRow(FAILED);
    mocks.uploadPendingData.mockImplementation(() => new Promise(() => {}));
    await completionRedirectNode({ session }).on_load();
    document.getElementById('upload-continue').click();
    await vi.advanceTimersByTimeAsync(9000);
    expect(retryRows()[0]).toMatchObject({ status: 'timed_out', retry_trigger: 'continue_button' });
  });

  it('attempts are numbered across both buttons', async () => {
    withUploadRow(FAILED);
    mocks.uploadPendingData
      .mockResolvedValueOnce({ status: 'partial' })
      .mockResolvedValueOnce({ status: 'uploaded' });
    await completionRedirectNode({ session }).on_load();
    document.getElementById('upload-retry').click();
    await vi.advanceTimersByTimeAsync(20);
    document.getElementById('upload-continue').click();
    await vi.advanceTimersByTimeAsync(100);
    expect(retryRows().map((r) => [r.upload_attempt, r.retry_trigger, r.status])).toEqual([
      [1, 'retry_button', 'partial'],
      [2, 'continue_button', 'uploaded'],
    ]);
  });
});

describe('no failure, no retry row', () => {
  it('a normal completion writes no upload_retry_result', async () => {
    withUploadRow({ phase: 'upload_session_end', status: 'uploaded' });
    await completionRedirectNode({ redirectDelayMs: 1000, session }).on_load();
    await vi.advanceTimersByTimeAsync(1200);
    expect(retryRows()).toHaveLength(0);
    expect(assign).toHaveBeenCalled();
  });
});
