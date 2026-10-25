/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registerHiddenNavStep, trackHiddenNavNode } = vi.hoisted(() => ({
  registerHiddenNavStep: vi.fn(),
  trackHiddenNavNode: vi.fn((node) => node),
}));

vi.mock('../src/audio/context.js', () => ({
  unlockAudio: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/hidden-nav.js', () => ({
  registerHiddenNavStep,
  trackHiddenNavNode,
}));

import { consentGate, consentTrial } from '../src/calibration/consent.js';
import { consentBodyHtml } from '../src/calibration/consent-text.js';
import { PROLIFIC_PRESCREEN_SUMMARY, config } from '../src/config.js';
import { AUDIO_CHECK } from '../src/calibration/audio-check.js';
import { TIMING_THRESHOLDS } from '../src/calibration/device-probe.js';

function mockConsentState(consented) {
  const abortExperiment = vi.fn();
  Object.defineProperty(window, 'jsPsych', {
    value: {
      abortExperiment,
      data: {
        get: () => ({
          filter: () => ({
            last: () => ({
              values: () => [{ phase: 'consent', consented }],
            }),
          }),
        }),
      },
    },
    configurable: true,
    writable: true,
  });
  return abortExperiment;
}

beforeEach(() => {
  registerHiddenNavStep.mockClear();
  trackHiddenNavNode.mockClear();
});

describe('consentGate', () => {
  it('only shows the decline exit after a declined consent row', () => {
    mockConsentState(false);
    expect(consentGate().conditional_function()).toBe(true);

    mockConsentState(true);
    expect(consentGate().conditional_function()).toBe(false);
  });

  it('aborts the experiment when the participant closes the decline screen', () => {
    const abortExperiment = mockConsentState(false);
    const node = consentGate();

    node.timeline[0].on_finish();

    expect(abortExperiment).toHaveBeenCalledWith('Consent declined.');
  });
});

describe('consentTrial disclosure', () => {
  const body = () => consentTrial().stimulus;

  it('lists every Prolific prescreener', () => {
    for (const item of PROLIFIC_PRESCREEN_SUMMARY) expect(body()).toContain(item);
  });

  it('discloses each check that can end the session', () => {
    const html = body();
    for (const label of [
      'Device check',
      'Screen-size calibration',
      'Sound check',
      'Pitch-discrimination check',
      'Timing check',
      'Practice-accuracy criterion',
      'Display lock',
      'Attention checks',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('screen-out completion code');
  });

  it('states the pitch-check threshold and attempts that the build uses', () => {
    const { n_trials, pass_min } = AUDIO_CHECK.pitch;
    expect(n_trials).toBe(8);
    expect(body()).toContain('eight pairs of tones');
    expect(body()).toContain(`at least ${pass_min} of ${n_trials} correct`);
    expect(body()).toContain('try once more');
    expect(AUDIO_CHECK.pitch.max_attempts).toBe(2);
  });

  it('states the timing refresh-rate limit that the build uses', () => {
    const hz = Math.round(1000 / TIMING_THRESHOLDS.max_median_frame_ms);
    expect(body()).toContain(`below about ${hz} Hz`);
  });

  it('states the practice criterion from the config', () => {
    expect(body()).toContain(
      `at least ${Math.round(config.practice.accuracy_criterion * 100)}% correct`
    );
  });

  it('says the headphone check is recorded only; headphones are recommended, speakers acceptable', () => {
    const html = body();
    expect(html).toMatch(/Headphone check:<\/strong>[^<]*recorded only and never ends the session/);
    expect(html).toContain(
      'Headphones are recommended, but built-in or external speakers are acceptable'
    );
    expect(html).not.toContain('strongly recommended');
  });

  it('says the device check happens at the very start', () => {
    expect(body()).toContain('Device check (very start)');
    expect(body()).toContain('happens at the very start, before this form appears');
  });

  it('says eligibility is by the Prolific prescreeners and not re-tested', () => {
    const html = body();
    expect(html).toContain('Eligibility is determined by the Prolific screening filters');
    expect(html).toContain('the study itself does not test your age, hearing, or vision');
    expect(html).toContain('task-capability checks');
    expect(html).not.toContain('We do not check your age, hearing, or vision again');
  });

  it('renders the payment text given by the config, not a literal placeholder', () => {
    expect(config.prolific.payment_policy_text).toBeTruthy();
    expect(consentTrial().stimulus).toContain(config.prolific.payment_policy_text);
    const custom = consentBodyHtml('a fixed screen-out payment of $9.99 through Prolific');
    expect(custom).toContain(
      'You will then be paid a fixed screen-out payment of $9.99 through Prolific.'
    );
    expect(custom).toContain('Payment in these cases is described under');
    expect(custom).not.toContain(config.prolific.payment_policy_text);
  });

  it('asks no health questions and says so truthfully', () => {
    const html = body();
    expect(html).toContain(
      'We do not ask about your health, hearing, vision, or medical conditions'
    );
    expect(html).not.toContain('any medical information');
    expect(html).not.toContain('hearing, and vision');
  });

  it('describes the data as pseudonymous, not anonymous', () => {
    const html = body();
    expect(html).toContain('pseudonymous');
    expect(html).toContain('identified only by your Prolific Participant ID');
    expect(html.toLowerCase()).not.toContain('anonymous');
    expect(html).not.toContain('No one, including the researchers');
  });

  it('uses "Stop without completing" for leaving and never the other button name', () => {
    const html = body();
    expect(html).toContain('Stop without completing');
    expect(html).not.toContain('Return submission');
  });
});
