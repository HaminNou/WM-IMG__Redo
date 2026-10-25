// @vitest-environment jsdom
/**
 * Small participant-text fixes from the final independent consistency check (verifier 3, C-11):
 *   - practice pass screen: "at or above the 70% criterion" (exactly 70% passes);
 *   - US spelling in the consent ("penalized");
 *   - the pre-consent device exit must not refer to a consent form the participant never saw;
 *   - the timing-check retry text must fit the cause (hidden tab vs slow computer);
 *   - the "Voice on/off" pill must not outlive the narrated screens that mounted it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ url: 'https://app.prolific.com/submissions/complete?cc=X' }));

vi.mock('../src/uploader.js', () => ({
  buildScreenOutUrl: () => mocks.url,
  isPlaceholderScreenOutUrl: () => false,
  uploadPendingData: vi.fn(() => Promise.resolve({ status: 'uploaded' })),
}));
vi.mock('../src/storage.js', () => ({
  getSessionObject: vi.fn(() => Promise.resolve({ params: {} })),
}));
vi.mock('../src/audio/context.js', () => ({ unlockAudio: vi.fn() }));

import { desktopGateExit } from '../src/calibration/desktop-gate.js';
import { screenOutExit } from '../src/screen-out.js';
import { formatPracticeFeedbackHtml } from '../src/scheduler/practice.js';
import { timingHintHtml } from '../src/calibration/device-probe.js';
import { consentGate, consentTrial } from '../src/calibration/consent.js';
import { endOfTaskIntroNode, mainAIntroNode } from '../src/runner-intros.js';
import { ensureToggleMounted } from '../src/visuals/voiceover-slide.js';

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('practice pass text', () => {
  it('says "at or above" the criterion, which is true when exactly 70% passes', () => {
    const html = formatPracticeFeedbackHtml({
      acc: { correct: 7, total: 10, accuracy: 0.7 },
      passed: true,
      willRetry: false,
      criterion: 0.7,
    });
    expect(text(html)).toContain('at or above the 70% criterion');
    expect(html).not.toMatch(/(?<!at or )above the 70%/);
  });
});

describe('consent spelling', () => {
  it('uses US spelling on the decline screen and in the consent', () => {
    const decline = consentGate().timeline[0].stimulus;
    expect(text(decline)).toContain('You will not be penalized for declining');
    for (const t of [decline, JSON.stringify(consentTrial())]) {
      expect(t).not.toMatch(/penalis/i);
    }
  });
});

describe('device exit before the consent form', () => {
  it('does not mention the consent form; other exits still do', () => {
    const early = desktopGateExit().timeline[0].stimulus();
    expect(text(early)).toContain('This session has ended.');
    expect(text(early)).not.toMatch(/consent form/i);
    expect(text(early)).toContain('Click the button below');

    const later = screenOutExit({
      phase: 'x_fail',
      exitReason: 'x',
      reasonHtml: '<h2>Sorry</h2>',
      condition: () => true,
    }).timeline[0].stimulus();
    expect(text(later)).toContain('described in the consent form');
  });
});

describe('timing-check retry text', () => {
  it('matches the cause of the failure', () => {
    expect(text(timingHintHtml(['tab_hidden_during_probe']))).toMatch(/keep this tab in front/i);
    expect(text(timingHintHtml(['tab_hidden_during_probe']))).not.toMatch(/running slowly/i);
    expect(text(timingHintHtml(['not_measured']))).toMatch(/could not finish/i);
    expect(text(timingHintHtml(['probe_error']))).toMatch(/could not finish/i);
    expect(text(timingHintHtml(['frame_p95_too_high']))).toMatch(/running slowly/i);
    expect(text(timingHintHtml())).toMatch(/running slowly/i);
  });
});

describe('Voice on/off pill', () => {
  const pill = () => document.getElementById('vo-toggle');

  it.each([
    ['end-of-task thank-you', endOfTaskIntroNode],
    ['practice-to-main intro', mainAIntroNode],
  ])('is mounted by the narrated %s and removed when the participant leaves it', (_name, make) => {
    const node = make();
    document.body.innerHTML = typeof node.stimulus === 'function' ? node.stimulus() : node.stimulus;
    expect(pill()).toBeNull(); /* a screen that has not been narrated yet has no pill */
    node.on_load();
    expect(pill()).not.toBeNull();
    expect(typeof node.on_finish).toBe('function');
    node.on_finish({});
    expect(pill()).toBeNull();
  });

  it('on_finish is harmless on a silent screen (no pill, nothing to cancel)', () => {
    const node = endOfTaskIntroNode();
    expect(() => node.on_finish({})).not.toThrow();
    ensureToggleMounted();
    expect(pill()).not.toBeNull();
    node.on_finish({});
    expect(pill()).toBeNull();
  });
});
