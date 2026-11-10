// @vitest-environment jsdom
/**
 * An AudioContext whose resume() never settles and whose clock never starts used to hang the
 * sound check forever (the continue button opened only after sweep 0) and could freeze consent.
 * Now: resume() is time-limited, and after AUDIO_STALL_MS without the clock moving the sound
 * check opens the continue button, offers a retry, and offers "I cannot hear the tones", which
 * ends in tones_audible false (-> the existing tones_not_audible screen-out).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctxState = vi.hoisted(() => ({ ctx: null }));

vi.mock('../src/audio/tones.js', () => ({
  playToneByIndex: vi.fn(() => Promise.resolve()),
  getToneBank: vi.fn(() => [{ index: 0, freq_hz: 220, gain_compensation_db: 0 }]),
}));
vi.mock('../src/audio/dsp.js', () => ({
  setUserPlaybackGain: vi.fn(),
  stopAllScheduledAudio: vi.fn(),
  DEFAULT_PEAK: 0.25,
}));
vi.mock('../src/hidden-nav.js', () => ({
  registerHiddenNavStep: vi.fn(),
  trackHiddenNavNode: (node) => node,
}));
vi.mock('../src/visuals/voiceover.js', () => ({
  getVoiceover: () => ({ current: null }),
}));
vi.mock('../src/audio/context.js', () => ({
  getAudioContext: () => ctxState.ctx,
  audioContextInfo: () => ({ state: ctxState.ctx.state }),
}));

import {
  AUDIO_STALL_MS,
  toneAudibilityAndComfortTrial,
} from '../src/calibration/tone-familiarisation.js';

function stuckContext() {
  return {
    state: 'suspended',
    currentTime: 0,
    resume: vi.fn(() => new Promise(() => {})) /* pending forever */,
  };
}

function mount(node) {
  document.body.innerHTML = `${node.stimulus}\n${node.button_html("I'm comfortable – continue")}`;
}

beforeEach(() => {
  vi.useFakeTimers();
  ctxState.ctx = stuckContext();
  document.body.innerHTML = '';
});
afterEach(() => vi.useRealTimers());

describe('sound check with a stuck audio context', () => {
  it('keeps continue disabled before the watchdog, then opens it and offers the way out', async () => {
    const node = toneAudibilityAndComfortTrial();
    mount(node);
    const yes = document.getElementById('tac-yes-btn');
    void node.on_load();
    await vi.advanceTimersByTimeAsync(AUDIO_STALL_MS - 500);
    expect(yes.disabled).toBe(true);
    expect(document.getElementById('tac-not-audible-btn')).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);
    expect(yes.disabled).toBe(false);
    expect(document.getElementById('tac-not-audible-btn')).not.toBeNull();
    expect(document.getElementById('tac-retry-btn')).not.toBeNull();
  });

  it('retries resume() from the participant click', async () => {
    const node = toneAudibilityAndComfortTrial();
    mount(node);
    void node.on_load();
    await vi.advanceTimersByTimeAsync(AUDIO_STALL_MS + 100);
    const before = ctxState.ctx.resume.mock.calls.length;
    document.getElementById('tac-retry-btn').click();
    expect(ctxState.ctx.resume.mock.calls.length).toBe(before + 1);
  });

  it('"I cannot hear the tones" ends the step with tones_audible false', async () => {
    const node = toneAudibilityAndComfortTrial();
    mount(node);
    const yes = document.getElementById('tac-yes-btn');
    const data = {};
    /* stands in for htmlButtonResponse's own listener, which runs on_finish on click */
    yes.addEventListener('click', () => node.on_finish(data));
    void node.on_load();
    await vi.advanceTimersByTimeAsync(AUDIO_STALL_MS + 100);
    document.getElementById('tac-not-audible-btn').click();
    expect(data.tones_audible).toBe(false);
  });

  it('a healthy clock never shows the stall controls', async () => {
    const node = toneAudibilityAndComfortTrial();
    mount(node);
    ctxState.ctx.state = 'running';
    void node.on_load();
    await vi.advanceTimersByTimeAsync(100);
    ctxState.ctx.currentTime = 1;
    await vi.advanceTimersByTimeAsync(AUDIO_STALL_MS + 100);
    expect(document.getElementById('tac-not-audible-btn')).toBeNull();
  });
});

describe('unlockAudio with a resume() that never settles', () => {
  it('returns after the time limit instead of hanging', async () => {
    vi.resetModules();
    const resume = vi.fn(() => new Promise(() => {}));
    window.AudioContext = class {
      constructor() {
        this.state = 'suspended';
        this.sampleRate = 48000;
        this.destination = {};
        this.resume = resume;
      }
      addEventListener() {}
      createBuffer() {
        return {};
      }
      createBufferSource() {
        return { connect() {}, start() {} };
      }
    };
    vi.doUnmock('../src/audio/context.js');
    const mod = await vi.importActual('../src/audio/context.js');
    let done = false;
    const p = mod.unlockAudio().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(mod.RESUME_TIMEOUT_MS + 10);
    await p;
    expect(done).toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
