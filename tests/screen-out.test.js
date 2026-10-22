/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  url: 'https://app.prolific.com/submissions/complete?cc=REALCODE',
  uploadPendingData: vi.fn(() => Promise.resolve({ status: 'uploaded' })),
  stopDisplayGuard: vi.fn(),
}));

vi.mock('../src/calibration/display-guard.js', async (importOriginal) => ({
  ...(await importOriginal()),
  stopDisplayGuard: mocks.stopDisplayGuard,
}));

vi.mock('../src/uploader.js', () => ({
  buildScreenOutUrl: () => mocks.url,
  isPlaceholderScreenOutUrl: (u) => typeof u === 'string' && u.includes('PLACEHOLDER'),
  uploadPendingData: mocks.uploadPendingData,
}));

vi.mock('../src/storage.js', () => ({
  getSessionObject: vi.fn(() => Promise.resolve({ params: {} })),
}));

vi.mock('../src/audio/context.js', () => ({ unlockAudio: vi.fn() }));

import { desktopGateExit } from '../src/calibration/desktop-gate.js';
import { toneAudibilityExit } from '../src/calibration/tone-familiarisation.js';
import { consentGate } from '../src/calibration/consent.js';
import { assembleInstructionsAndPractice } from '../src/instructions/index.js';
import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { screenOutExit, finishScreenOut } from '../src/screen-out.js';

function setRows(rows) {
  /* Like jsPsych, the abort call writes its message into the page. */
  const abortExperiment = vi.fn((message) => {
    document.body.innerHTML = message ?? '';
  });
  Object.defineProperty(window, 'jsPsych', {
    value: {
      abortExperiment,
      data: {
        get: () => ({
          filter: ({ phase }) => ({
            last: () => ({ values: () => rows.filter((r) => r.phase === phase).slice(-1) }),
          }),
        }),
      },
    },
    configurable: true,
    writable: true,
  });
  return abortExperiment;
}

function findPracticeExit() {
  setSessionPRNG('screen-out-test-seed');
  resetSequencePools();
  return assembleInstructionsAndPractice().find(
    (n) => n.timeline?.[0]?.data?.phase === 'practice_disqualification'
  );
}

const CASES = [
  {
    name: 'desktop gate',
    build: desktopGateExit,
    rows: [{ phase: 'desktop_gate', value: { isDesktop: false } }],
    phase: 'desktop_gate_fail',
    reason: 'desktop_required',
    flush: false,
  },
  {
    name: 'tone audibility',
    build: toneAudibilityExit,
    rows: [{ phase: 'tone_audibility_and_comfort', tones_audible: false }],
    phase: 'tone_audibility_fail',
    reason: 'tones_not_audible',
    flush: true,
  },
  {
    name: 'practice criterion',
    build: findPracticeExit,
    rows: [{ phase: 'practice_feedback', iteration_passed: false, iteration_accuracy: 0.5 }],
    phase: 'practice_disqualification',
    reason: 'practice_criterion_not_met',
    flush: true,
  },
];

beforeEach(() => {
  mocks.url = 'https://app.prolific.com/submissions/complete?cc=REALCODE';
  mocks.uploadPendingData.mockClear();
  mocks.stopDisplayGuard.mockClear();
  document.body.innerHTML = '';
});

describe.each(CASES)('$name exit', ({ build, rows, phase, reason, flush }) => {
  it('fires on failure only and records the exit reason', () => {
    setRows(rows);
    const node = build();
    expect(node.conditional_function()).toBe(true);
    expect(node.timeline[0].data).toEqual({ phase, exit_reason: reason });
    setRows([]);
    expect(build().conditional_function()).toBe(false);
  });

  it('offers a button that submits the code to Prolific and does not say to return the study', () => {
    setRows(rows);
    const trial = build().timeline[0];
    expect(trial.choices).toEqual(['Submit code to Prolific']);
    const html = trial.stimulus();
    expect(html).toContain('screen-out completion code');
    expect(html.toLowerCase()).not.toContain('return the study');
    expect(html.toLowerCase()).not.toContain('return this study');
  });

  it('aborts and flushes (post-consent exits only) when the button is pressed', async () => {
    mocks.url = 'https://app.prolific.com/submissions/complete?cc=SCREENOUT_CODE_PLACEHOLDER';
    const abort = setRows(rows);
    const node = build();
    node.timeline[0].on_finish({});
    expect(abort).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(mocks.uploadPendingData).toHaveBeenCalledTimes(flush ? 1 : 0);
  });
});

describe('finishScreenOut', () => {
  const REAL = 'https://app.prolific.com/submissions/complete?cc=REALCODE';

  it('redirects to the screen-out URL after flushing', async () => {
    setRows([]);
    const navigate = vi.fn();
    await finishScreenOut({ reasonHtml: '<h2>Why</h2>', flush: true, url: REAL, navigate });
    expect(mocks.uploadPendingData).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(REAL);
  });

  it('switches the display guard off first', async () => {
    setRows([]);
    await finishScreenOut({ reasonHtml: 'r', flush: false, url: REAL, navigate: vi.fn() });
    expect(mocks.stopDisplayGuard).toHaveBeenCalledTimes(1);
  });

  it('keeps the explanation on screen during the flush, with a link to the screen-out URL', async () => {
    const abort = setRows([]);
    let pageDuringFlush = null;
    mocks.uploadPendingData.mockImplementationOnce(async () => {
      pageDuringFlush = document.body.innerHTML;
      return { status: 'uploaded' };
    });
    await finishScreenOut({
      reasonHtml: '<h2>Sorry, we cannot continue</h2>',
      flush: true,
      url: REAL,
      navigate: vi.fn(),
    });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(pageDuringFlush).toContain('Sorry, we cannot continue');
    const link = document.getElementById('screen-out-link');
    expect(link.getAttribute('href')).toBe(REAL);
    expect(link.textContent).toMatch(/Prolific/);
  });

  it('passes the explanation to the abort call, not a bare message', async () => {
    const abort = setRows([]);
    await finishScreenOut({
      reasonHtml: '<p>Explained</p>',
      flush: false,
      url: REAL,
      navigate: vi.fn(),
    });
    expect(abort.mock.calls[0][0]).toContain('<p>Explained</p>');
  });

  it('still redirects when the flush fails', async () => {
    setRows([]);
    mocks.uploadPendingData.mockRejectedValueOnce(new Error('offline'));
    const navigate = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await finishScreenOut({ reasonHtml: 'r', flush: true, url: 'https://x/?cc=A', navigate });
    expect(navigate).toHaveBeenCalledWith('https://x/?cc=A');
  });

  it('does not redirect and shows no link for the placeholder URL', async () => {
    setRows([]);
    const navigate = vi.fn();
    await finishScreenOut({
      reasonHtml: '<p>Test</p>',
      flush: false,
      url: 'https://x/?cc=SCREENOUT_CODE_PLACEHOLDER',
      navigate,
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(document.getElementById('screen-out-link')).toBeNull();
    expect(document.body.innerHTML).toContain('Test');
  });
});

describe('placeholder screen-out URL', () => {
  it('shows a test-build notice and a Close button', () => {
    mocks.url = 'https://app.prolific.com/submissions/complete?cc=SCREENOUT_CODE_PLACEHOLDER';
    setRows([{ phase: 'desktop_gate', value: { isDesktop: false } }]);
    const trial = desktopGateExit().timeline[0];
    expect(trial.choices).toEqual(['Close']);
    expect(trial.stimulus()).toContain('test build');
  });
});

describe('screenOutExit onFinish', () => {
  it('stamps extra data before ending', () => {
    setRows([]);
    const node = screenOutExit({
      phase: 'desktop_gate_fail',
      exitReason: 'desktop_required',
      reasonHtml: '<p>r</p>',
      condition: () => true,
      onFinish: (d) => {
        d.extra = 1;
      },
    });
    const d = {};
    node.timeline[0].on_finish(d);
    expect(d.extra).toBe(1);
  });
});

describe('consent declined exit', () => {
  it('tells the participant to withdraw on Prolific and records the reason', () => {
    const trial = consentGate().timeline[0];
    expect(trial.stimulus).toContain('Stop without completing');
    expect(trial.data).toEqual({ phase: 'consent_declined', exit_reason: 'consent_declined' });
    expect(mocks.uploadPendingData).not.toHaveBeenCalled();
  });
});
