// @vitest-environment jsdom
/**
 * Space on the completion screen, with the REAL jsPsych engine.
 *
 * The completion node is a keyboard-response trial with `choices: [' ']`. jsPsych
 * listens for keydown on its display container, so a Space that is allowed to
 * bubble ends the trial: the screen is emptied and nothing redirects (verified
 * by the final independent review). The earlier tests used a fake
 * `window.jsPsych` and only asserted that the event bubbled, which is exactly the
 * defect. Here the whole engine runs.
 *
 *  - Failure screen: Space on a focused button must not end the trial (the button
 *    keeps its native keyboard activation), Space anywhere else must do nothing.
 *  - Countdown screen: Space must not blank the page either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initJsPsych } from 'jspsych';
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function space(target) {
  const e = new KeyboardEvent('keydown', {
    key: ' ',
    code: 'Space',
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(e);
  /* release the key, so that jsPsych does not treat the next press as a held key */
  target.dispatchEvent(
    new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
  );
  return e;
}

/** Runs [a trial carrying an upload row, the real completion node] in real jsPsych. */
async function startCompletion(uploadStatus, redirectDelayMs = 600000) {
  /* As in the app: no display_element, so jsPsych uses document.body and listens
   * for keys on it. */
  document.body.innerHTML = '';
  const display = document.body;
  const jsPsych = initJsPsych();
  window.jsPsych = jsPsych;
  const timeline = [
    {
      type: htmlKeyboardResponse,
      stimulus: 'uploading',
      choices: 'NO_KEYS',
      trial_duration: 1,
      data: { phase: 'upload_session_end', status: uploadStatus, download_filename: 'a.json' },
    },
    completionRedirectNode({ redirectDelayMs, session }),
  ];
  void jsPsych.run(timeline);
  await vi.waitFor(() => expect(display.querySelector('#completion-mount')).not.toBeNull(), {
    timeout: 3000,
  });
  return { jsPsych, display };
}

const docListeners = [];

beforeEach(() => {
  /* Remove, between tests, any listener the node put on document (the guard
   * stays installed on screens whose trial never finishes). */
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
    docListeners.push([type, fn, opts]);
    add(type, fn, opts);
  });
  let href = '';
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() {
        return href;
      },
      set href(v) {
        href = v;
      },
    },
  });
  mocks.uploadPendingData.mockReset();
  mocks.uploadTail.mockClear();
  mocks.appendTrialRow.mockClear();
});

afterEach(() => {
  for (const [type, fn, opts] of docListeners.splice(0))
    document.removeEventListener(type, fn, opts);
  try {
    window.jsPsych?.pluginAPI?.cancelAllKeyboardResponses?.();
  } catch {
    /* nothing to cancel */
  }
  document.body.innerHTML = '';
  delete window.jsPsych;
  vi.restoreAllMocks();
});

describe('failure screen, real jsPsych', () => {
  it('Space on the focused "Continue to Prolific" button does not end the trial', async () => {
    const { display } = await startCompletion('partial');
    await vi.waitFor(() => expect(display.querySelector('#upload-continue')).not.toBeNull());
    const btn = display.querySelector('#upload-continue');
    btn.focus();
    const e = space(btn);
    await sleep(50);
    /* the screen is still there */
    expect(display.querySelector('#upload-continue')).not.toBeNull();
    expect(display.querySelector('#upload-download-again')).not.toBeNull();
    /* native keyboard activation is left alone (the click fires on keyup) */
    expect(e.defaultPrevented).toBe(false);
    /* nothing redirected and no completion row was written */
    expect(window.location.href).toBe('');
    expect(mocks.appendTrialRow).not.toHaveBeenCalled();
  });

  it('Space on "Download my data file again" does not end the trial either', async () => {
    const { display } = await startCompletion('timed_out');
    await vi.waitFor(() => expect(display.querySelector('#upload-download-again')).not.toBeNull());
    const btn = display.querySelector('#upload-download-again');
    btn.focus();
    space(btn);
    await sleep(50);
    expect(display.querySelector('#upload-continue')).not.toBeNull();
  });

  it('Space anywhere else does nothing and is cancelled', async () => {
    const { display } = await startCompletion('partial');
    await vi.waitFor(() => expect(display.querySelector('#upload-continue')).not.toBeNull());
    const e1 = space(document.body);
    const e2 = space(display);
    await sleep(50);
    expect(e1.defaultPrevented).toBe(true);
    expect(e2.defaultPrevented).toBe(true);
    expect(display.querySelector('#upload-continue')).not.toBeNull();
    expect(window.location.href).toBe('');
  });
});

describe('countdown screen wording, real jsPsych', () => {
  it('says "1 second", not "1 seconds", and switches the unit as it counts down', async () => {
    const one = await startCompletion('uploaded', 1000);
    await vi.waitFor(() =>
      expect(one.display.querySelector('#completion-countdown')).not.toBeNull()
    );
    const line = one.display.querySelector('#completion-countdown').parentElement.textContent;
    expect(line).toMatch(/in 1 second…/);
    expect(line).not.toMatch(/1 seconds/);
  });

  it('starts at "2 seconds" and shows "1 second" after the first tick', async () => {
    const { display } = await startCompletion('uploaded', 2000);
    await vi.waitFor(() => expect(display.querySelector('#completion-countdown')).not.toBeNull());
    expect(display.querySelector('#completion-countdown').parentElement.textContent).toMatch(
      /in 2 seconds…/
    );
    await vi.waitFor(
      () => expect(display.querySelector('#completion-countdown-unit')?.textContent).toBe('second'),
      { timeout: 3000 }
    );
    expect(display.querySelector('#completion-countdown').textContent).toBe('1');
  });
});

describe('countdown screen, real jsPsych', () => {
  it('Space does not blank the page while the countdown runs', async () => {
    const { display } = await startCompletion('uploaded');
    await vi.waitFor(() => expect(display.querySelector('#completion-countdown')).not.toBeNull());
    space(document.body);
    await sleep(50);
    expect(display.querySelector('#completion-countdown')).not.toBeNull();
    expect(window.location.href).toBe('');
  });
});
