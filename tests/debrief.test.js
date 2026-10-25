// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  uploadPendingData: vi.fn(),
  uploadTail: vi.fn(() => Promise.resolve({ status: 'ok', rows: 2 })),
  appendTrialRow: vi.fn(() => Promise.resolve(1)),
  downloadAsJson: vi.fn(() => ({ filename: 'data.json', sizeBytes: 2048 })),
  getAllTrialRows: vi.fn(() => Promise.resolve([{ seq: 1 }])),
  getCompletionUrl: vi.fn(() => Promise.resolve(null)),
  markUploadDone: vi.fn(),
  completionUrl: 'https://app.prolific.com/submissions/complete?cc=PLACEHOLDER_X',
}));

vi.mock('../src/uploader.js', () => ({
  uploadPendingData: mocks.uploadPendingData,
  uploadTail: mocks.uploadTail,
  downloadAsJson: mocks.downloadAsJson,
  buildCompletionUrl: () => mocks.completionUrl,
  isPlaceholderCompletionUrl: (u) => typeof u === 'string' && u.includes('PLACEHOLDER'),
}));
vi.mock('../src/storage.js', () => ({
  appendTrialRow: mocks.appendTrialRow,
  getAllTrialRows: mocks.getAllTrialRows,
  getCompletionUrl: mocks.getCompletionUrl,
  getStorageFailureSummary: () => ({ writeFailures: 0, lastError: null, lastFailureAtIso: null }),
}));
vi.mock('../src/session-guard.js', () => ({ markUploadDone: mocks.markUploadDone }));

import { completionRedirectNode, uploadProgressNode } from '../src/conditions/debrief.js';
import { config } from '../src/config.js';

const session = { params: { session_id: 's' } };
const MOUNT = 'upload-progress-mount';

function mountUploadScreen() {
  document.body.innerHTML = `<div id="${MOUNT}"></div>`;
}

const space = () =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));

const listeners = [];

beforeEach(() => {
  vi.useFakeTimers();
  /* Track document listeners so one test's Space handler cannot leak into the next. */
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
    listeners.push([type, fn, opts]);
    add(type, fn, opts);
  });
  mountUploadScreen();
  window.jsPsych = { finishTrial: vi.fn() };
  mocks.uploadPendingData.mockReset();
  mocks.downloadAsJson.mockClear();
  mocks.markUploadDone.mockClear();
});

afterEach(() => {
  for (const [type, fn, opts] of listeners.splice(0)) document.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.jsPsych;
});

describe('uploadProgressNode', () => {
  it('requires a session', () => {
    expect(() => uploadProgressNode()).toThrow(/session is required/);
  });

  it('holds the participant until the upload settles, then Space continues', async () => {
    let finish;
    mocks.uploadPendingData.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const node = uploadProgressNode({ session });
    node.on_load();
    space();
    expect(window.jsPsych.finishTrial).not.toHaveBeenCalled();

    finish({ status: 'uploaded', uploadedBuckets: 3, totalBuckets: 3, uploadedRows: 40 });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById(MOUNT).textContent).toContain('Saved (40 rows in 3 files)');
    space();
    expect(window.jsPsych.finishTrial).toHaveBeenCalledTimes(1);

    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({ status: 'uploaded', uploadedRows: 40, downloadFallback: false });
  });

  it('opens the gate after the time limit when the upload never settles, and offers the download', async () => {
    mocks.uploadPendingData.mockReturnValue(new Promise(() => {}));
    const node = uploadProgressNode({ session, maxWaitMs: 5000 });
    node.on_load();
    await vi.advanceTimersByTimeAsync(4999);
    space();
    expect(window.jsPsych.finishTrial).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(mocks.downloadAsJson).toHaveBeenCalledTimes(1);
    expect(document.getElementById(MOUNT).textContent).toContain('Upload incomplete');
    space();
    expect(window.jsPsych.finishTrial).toHaveBeenCalledTimes(1);

    const data = {};
    node.on_finish(data);
    expect(data.status).toBe('timed_out');
    expect(data.downloadFallback).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the configured limit by default', async () => {
    mocks.uploadPendingData.mockReturnValue(new Promise(() => {}));
    uploadProgressNode({ session }).on_load();
    await vi.advanceTimersByTimeAsync(config.uploader.session_end_max_wait_ms - 1);
    expect(mocks.downloadAsJson).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(mocks.downloadAsJson).toHaveBeenCalledTimes(1);
  });

  it('offers the download when the upload throws instead of resolving, and records why', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.uploadPendingData.mockRejectedValue(new Error('session_id is required'));
    const node = uploadProgressNode({ session });
    node.on_load();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.downloadAsJson).toHaveBeenCalledTimes(1);
    expect(document.getElementById(MOUNT).textContent).toContain('Upload incomplete');
    space();
    expect(window.jsPsych.finishTrial).toHaveBeenCalledTimes(1);
    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({ status: 'partial', downloadFallback: true });
    expect(data.last_error).toContain('session_id is required');
  });

  it('shows the download after a partial upload and still lets the participant continue', async () => {
    mocks.uploadPendingData.mockResolvedValue({
      status: 'partial',
      uploadedBuckets: 1,
      totalBuckets: 4,
      uploadedRows: 5,
      lastError: 'boom',
    });
    const node = uploadProgressNode({ session });
    node.on_load();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.downloadAsJson).toHaveBeenCalledTimes(1);
    space();
    expect(window.jsPsych.finishTrial).toHaveBeenCalledTimes(1);
  });

  it('still opens the gate when the upload throws, and saves a copy to the device instead of losing the data', async () => {
    mocks.uploadPendingData.mockRejectedValue(new Error('network down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    uploadProgressNode({ session }).on_load();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById(MOUNT).textContent).toContain('Upload incomplete');
    expect(mocks.downloadAsJson).toHaveBeenCalledTimes(1);
    space();
    expect(window.jsPsych.finishTrial).toHaveBeenCalledTimes(1);
  });

  it('keeps no summary on the window', async () => {
    mocks.uploadPendingData.mockResolvedValue({
      status: 'nothing_to_upload',
      uploadedBuckets: 0,
      totalBuckets: 0,
      uploadedRows: 0,
    });
    uploadProgressNode({ session }).on_load();
    await vi.advanceTimersByTimeAsync(0);
    expect(window.__lastUploadSummary).toBeUndefined();
    expect(window.__completionRedirectAt).toBeUndefined();
  });
});

describe('completionRedirectNode', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="completion-mount"></div>';
  });

  it('shows a test-build notice and records no redirect for the placeholder URL', async () => {
    mocks.completionUrl = 'https://app.prolific.com/submissions/complete?cc=PLACEHOLDER_X';
    const node = completionRedirectNode();
    await node.on_load();
    expect(document.getElementById('completion-mount').textContent).toContain('development build');
    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({ completion_redirect_url: null, completion_was_placeholder: true });
  });

  it('shows the countdown and a visible link for a real URL, and records the URL', async () => {
    mocks.completionUrl = 'https://app.prolific.com/submissions/complete?cc=REAL';
    const node = completionRedirectNode({ redirectDelayMs: 5000 });
    await node.on_load();
    const mount = document.getElementById('completion-mount');
    expect(mount.querySelector('a').getAttribute('href')).toBe(mocks.completionUrl);
    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({
      completion_redirect_url: mocks.completionUrl,
      completion_was_placeholder: false,
    });
  });

  describe('last upload before the redirect', () => {
    const session = { params: { session_id: 's' } };
    let assign;

    beforeEach(() => {
      vi.useFakeTimers();
      mocks.uploadTail.mockClear();
      mocks.appendTrialRow.mockClear();
      mocks.completionUrl = 'https://app.prolific.com/submissions/complete?cc=REAL';
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
    });

    it('writes the completion row, sends the tail, then redirects', async () => {
      const order = [];
      mocks.appendTrialRow.mockImplementationOnce(async () => order.push('row'));
      mocks.uploadTail.mockImplementationOnce(async () => order.push('tail'));
      assign.mockImplementation(() => order.push('redirect'));
      const node = completionRedirectNode({ redirectDelayMs: 1000, session });
      await node.on_load();
      await vi.advanceTimersByTimeAsync(1100);
      expect(order).toEqual(['row', 'tail', 'redirect']);
      expect(mocks.appendTrialRow).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'completion_redirect',
          completion_redirect_url: mocks.completionUrl,
          completion_was_placeholder: false,
        })
      );
      expect(assign).toHaveBeenCalledWith(mocks.completionUrl);
    });

    it('redirects even if the tail upload never answers', async () => {
      mocks.uploadTail.mockImplementationOnce(() => new Promise(() => {}));
      const node = completionRedirectNode({ redirectDelayMs: 1000, session });
      await node.on_load();
      await vi.advanceTimersByTimeAsync(1100);
      expect(assign).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      expect(assign).toHaveBeenCalledWith(mocks.completionUrl);
    });

    it('does not write a second completion row when the participant already ended the trial', async () => {
      const node = completionRedirectNode({ redirectDelayMs: 1000, session });
      await node.on_load();
      node.on_finish({});
      await vi.advanceTimersByTimeAsync(1100);
      expect(mocks.appendTrialRow).not.toHaveBeenCalled();
      expect(assign).toHaveBeenCalledWith(mocks.completionUrl);
    });

    it('sends the tail after the trial row of a test build (no redirect)', async () => {
      mocks.completionUrl = 'https://app.prolific.com/submissions/complete?cc=PLACEHOLDER_X';
      const node = completionRedirectNode({ session });
      await node.on_load();
      node.on_finish({});
      expect(mocks.uploadTail).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(mocks.uploadTail).toHaveBeenCalledWith({ session });
    });
  });

  it('still shows a notice when the stored completion URL cannot be read', async () => {
    mocks.getCompletionUrl.mockRejectedValueOnce(new Error('idb closed'));
    mocks.completionUrl = 'https://app.prolific.com/submissions/complete?cc=PLACEHOLDER_X';
    await completionRedirectNode().on_load();
    expect(document.getElementById('completion-mount').textContent).toContain('development build');
  });
});
