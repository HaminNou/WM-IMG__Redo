// @vitest-environment jsdom
/**
 * What the participant meets after the end-of-session upload FAILED.
 *
 * Before: the completion screen counted down and redirected to Prolific whatever
 * the upload outcome, and the only guidance was "email it if asked" with no
 * address. Now, when the upload did not succeed (status partial, timed_out or
 * no_endpoint):
 *   - there is no automatic redirect;
 *   - the screen says what happened and offers a new upload attempt and a second
 *     download of the data file;
 *   - Space cannot clear the screen;
 *   - "Continue to Prolific" is pressed by the participant, writes
 *     `redirect_after_failed_upload`, makes one last bounded upload attempt, and
 *     only then redirects, so nobody is denied the completion code because of a
 *     problem on our side.
 * When the upload succeeded (or nothing is known) the old countdown flow is
 * unchanged.
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
  completionUrl: 'https://app.prolific.com/submissions/complete?cc=REAL',
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

const session = { params: { session_id: 's' } };
const URL_REAL = 'https://app.prolific.com/submissions/complete?cc=REAL';

/** jsPsych's data store, reduced to what the completion node reads. */
function withUploadRow(row) {
  window.jsPsych = {
    finishTrial: vi.fn(),
    data: {
      get: () => ({
        filter: () => ({ values: () => (row ? [row] : []) }),
      }),
    },
  };
}

const spaceOn = (target) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
  );

let assign;
const docListeners = [];

beforeEach(() => {
  vi.useFakeTimers();
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
    docListeners.push([type, fn, opts]);
    add(type, fn, opts);
  });
  document.body.innerHTML = '<div id="completion-mount"></div>';
  mocks.completionUrl = URL_REAL;
  mocks.uploadPendingData.mockReset();
  mocks.uploadTail.mockClear();
  mocks.appendTrialRow.mockClear();
  mocks.downloadAsJson.mockClear();
  mocks.markUploadDone.mockClear();
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
  for (const [type, fn, opts] of docListeners.splice(0))
    document.removeEventListener(type, fn, opts);
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.jsPsych;
});

const mount = () => document.getElementById('completion-mount');

describe('after a successful upload (or an unknown outcome)', () => {
  it.each([['uploaded'], ['nothing_to_upload']])(
    '%s: the countdown and redirect are unchanged',
    async (status) => {
      withUploadRow({ phase: 'upload_session_end', status });
      const node = completionRedirectNode({ redirectDelayMs: 2000, session });
      await node.on_load();
      expect(mount().textContent).toContain('Redirecting to Prolific');
      expect(document.getElementById('upload-continue')).toBeNull();
      await vi.advanceTimersByTimeAsync(2100);
      expect(assign).toHaveBeenCalledWith(URL_REAL);
    }
  );

  it('no upload row at all: the old flow', async () => {
    withUploadRow(null);
    const node = completionRedirectNode({ redirectDelayMs: 1000, session });
    await node.on_load();
    expect(mount().textContent).toContain('Redirecting to Prolific');
  });
});

describe.each([['partial'], ['timed_out'], ['no_endpoint']])(
  'after a failed upload (%s)',
  (status) => {
    const row = (extra = {}) => ({
      phase: 'upload_session_end',
      status,
      download_filename: 'wm-img-followup__ab12cd34__2026-10-25.json',
      ...extra,
    });

    it('does not count down or redirect by itself, and says what happened', async () => {
      withUploadRow(row());
      const node = completionRedirectNode({ redirectDelayMs: 1000, session });
      await node.on_load();
      expect(mount().textContent).not.toContain('Redirecting to Prolific');
      expect(mount().textContent).toContain('could not send your answers');
      expect(mount().textContent).toContain('wm-img-followup__ab12cd34__2026-10-25.json');
      expect(mount().textContent).toMatch(/Prolific messaging/);
      expect(mount().textContent).not.toMatch(/email/i);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(assign).not.toHaveBeenCalled();
      expect(mocks.appendTrialRow).not.toHaveBeenCalled();
      for (const id of ['upload-retry', 'upload-download-again', 'upload-continue']) {
        expect(document.getElementById(id)).not.toBeNull();
      }
    });

    it('puts the file name in as text, never as HTML', async () => {
      withUploadRow(row({ download_filename: '<img src=x onerror="window.__pwned=1">.json' }));
      await completionRedirectNode({ session }).on_load();
      expect(mount().querySelector('img')).toBeNull();
      expect(mount().textContent).toContain('<img src=x');
    });

    it('Space never reaches the engine, and buttons keep their native keyboard activation', async () => {
      withUploadRow(row());
      const node = completionRedirectNode({ session });
      await node.on_load();
      const reached = vi.fn();
      document.addEventListener('keydown', reached);
      /* anywhere else: stopped and cancelled */
      spaceOn(document.body);
      expect(reached).not.toHaveBeenCalled();
      /* on a button: stopped too (it would end the trial), but the default action
       * stays, so the browser still fires the click on keyup. The real-engine
       * version of this check is tests/debrief-space-real-jspsych.test.js. */
      const e = new KeyboardEvent('keydown', {
        key: ' ',
        code: 'Space',
        bubbles: true,
        cancelable: true,
      });
      document.getElementById('upload-continue').dispatchEvent(e);
      expect(reached).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(false);
    });

    it('"Continue to Prolific": writes the row, tries one last upload, sends the tail, then redirects', async () => {
      withUploadRow(row());
      const order = [];
      mocks.appendTrialRow.mockImplementationOnce(async (r) => order.push(['row', r]));
      mocks.uploadPendingData.mockImplementationOnce(async () => {
        order.push(['final-upload']);
        return { status: 'partial' };
      });
      mocks.uploadTail.mockImplementationOnce(async () => order.push(['tail']));
      mocks.markUploadDone.mockImplementationOnce(() => order.push(['release']));
      assign.mockImplementation(() => order.push(['redirect']));
      const node = completionRedirectNode({ session });
      await node.on_load();
      document.getElementById('upload-continue').click();
      await vi.advanceTimersByTimeAsync(50);
      expect(order.map((o) => o[0])).toEqual([
        'row',
        'final-upload',
        'tail',
        'release',
        'redirect',
      ]);
      expect(order[0][1]).toMatchObject({
        phase: 'completion_redirect',
        completion_redirect_url: URL_REAL,
        completion_was_placeholder: false,
        redirect_after_failed_upload: true,
      });
      expect(assign).toHaveBeenCalledWith(URL_REAL);
    });

    it('the last upload attempt is bounded: a request that never answers cannot hold the participant', async () => {
      withUploadRow(row());
      mocks.uploadPendingData.mockImplementation(() => new Promise(() => {}));
      mocks.uploadTail.mockImplementation(() => new Promise(() => {}));
      const node = completionRedirectNode({ session });
      await node.on_load();
      document.getElementById('upload-continue').click();
      await vi.advanceTimersByTimeAsync(5900);
      expect(assign).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2600 + 6000);
      expect(assign).toHaveBeenCalledWith(URL_REAL);
    });

    it('"Try sending my answers again": success switches to the normal countdown and redirect', async () => {
      withUploadRow(row());
      mocks.uploadPendingData.mockResolvedValueOnce({
        status: 'uploaded',
        uploadedBuckets: 8,
        totalBuckets: 8,
      });
      const node = completionRedirectNode({ redirectDelayMs: 2000, session });
      await node.on_load();
      document.getElementById('upload-retry').click();
      await vi.advanceTimersByTimeAsync(10);
      expect(mount().textContent).toContain('Redirecting to Prolific');
      expect(document.getElementById('upload-continue')).toBeNull();
      /* The countdown screen is guarded as well: Space must not blank the page. */
      const reached = vi.fn();
      document.addEventListener('keydown', reached);
      spaceOn(document.body);
      expect(reached).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2100);
      expect(assign).toHaveBeenCalledWith(URL_REAL);
      expect(mocks.appendTrialRow).toHaveBeenCalledWith(
        expect.objectContaining({ redirect_after_failed_upload: false })
      );
    });

    it('"Try sending my answers again": a second failure keeps the screen and re-enables the buttons', async () => {
      withUploadRow(row());
      mocks.uploadPendingData.mockResolvedValueOnce({ status: 'partial' });
      await completionRedirectNode({ session }).on_load();
      document.getElementById('upload-retry').click();
      await vi.advanceTimersByTimeAsync(10);
      expect(document.getElementById('upload-failure-status').textContent).toMatch(
        /still could not reach/
      );
      expect(document.getElementById('upload-continue').disabled).toBe(false);
      expect(document.getElementById('upload-retry').disabled).toBe(false);
      expect(assign).not.toHaveBeenCalled();
      /* A retry that throws is treated the same way. */
      mocks.uploadPendingData.mockRejectedValueOnce(new Error('net'));
      document.getElementById('upload-retry').click();
      await vi.advanceTimersByTimeAsync(10);
      expect(document.getElementById('upload-failure-status').textContent).toMatch(
        /still could not reach/
      );
    });

    it('"Download my data file again" saves another copy and names it', async () => {
      withUploadRow(row());
      mocks.downloadAsJson.mockReturnValueOnce({ filename: 'second.json', sizeBytes: 1 });
      await completionRedirectNode({ session }).on_load();
      document.getElementById('upload-download-again').click();
      await vi.advanceTimersByTimeAsync(10);
      expect(mocks.downloadAsJson).toHaveBeenCalledTimes(1);
      expect(document.getElementById('upload-failure-status').textContent).toContain('second.json');
    });

    it('records the policy in the trial row', async () => {
      withUploadRow(row());
      const node = completionRedirectNode({ session });
      await node.on_load();
      const data = {};
      node.on_finish(data);
      expect(data.redirect_after_failed_upload).toBe(true);
    });

    it('without a session there is no retry button, but the download and Continue stay', async () => {
      withUploadRow(row());
      await completionRedirectNode().on_load();
      expect(document.getElementById('upload-retry')).toBeNull();
      expect(document.getElementById('upload-download-again')).not.toBeNull();
      expect(document.getElementById('upload-continue')).not.toBeNull();
    });

    it('when the file could not be saved, the screen says so and offers the download button', async () => {
      withUploadRow(row({ download_filename: null }));
      await completionRedirectNode({ session }).on_load();
      expect(mount().textContent).toContain('save a copy of your answers to your device');
    });
  }
);

describe('the placeholder URL still wins', () => {
  it('a test build shows the notice, even after a failed upload', async () => {
    mocks.completionUrl = 'https://app.prolific.com/submissions/complete?cc=PLACEHOLDER_X';
    withUploadRow({ phase: 'upload_session_end', status: 'partial' });
    await completionRedirectNode({ session }).on_load();
    expect(mount().textContent).toContain('development build');
    expect(document.getElementById('upload-continue')).toBeNull();
  });
});

describe('what the upload screen records for the next screen', () => {
  it('stamps the name of the saved file and the failed buckets into its data row', async () => {
    document.body.innerHTML = '<div id="upload-progress-mount"></div>';
    window.jsPsych = { finishTrial: vi.fn() };
    mocks.uploadPendingData.mockResolvedValueOnce({
      status: 'partial',
      uploadedBuckets: 7,
      totalBuckets: 8,
      uploadedRows: 100,
      failedBuckets: ['t_only'],
      lastError: 'gave up',
    });
    const node = uploadProgressNode({ session });
    node.on_load();
    await vi.advanceTimersByTimeAsync(10);
    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({
      status: 'partial',
      download_filename: 'data.json',
      failed_buckets: ['t_only'],
      downloadFallback: true,
    });
    /* The screen no longer promises an e-mail. */
    expect(document.getElementById('upload-progress-mount').textContent).not.toMatch(/email/i);
    expect(document.getElementById('upload-progress-mount').textContent).toContain('next screen');
  });
});
