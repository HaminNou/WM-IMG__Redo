// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({ ensureRunning: vi.fn(() => Promise.resolve()) }));

vi.mock('../src/screen-out.js', () => ({
  screenOutExit: vi.fn((opts) => ({ timeline: [], conditional_function: opts.condition, opts })),
}));
vi.mock('../src/audio/context.js', () => ({
  getAudioContext: () => ({ currentTime: 0 }),
  ensureRunning: audio.ensureRunning,
}));
vi.mock('../src/audio/dsp.js', () => ({
  playStereoSine: vi.fn(),
  getUserPlaybackGain: () => 1,
  stopAllScheduledAudio: vi.fn(),
}));
vi.mock('../src/audio/tones.js', () => ({
  playToneByIndex: vi.fn(),
  getToneBank: () => Array.from({ length: 24 }, (_, i) => ({ freq_hz: 200 + i })),
}));

import {
  AUDIO_START_TIMEOUT_MS,
  headphoneCheckBlock,
  pitchCheckChain,
} from '../src/calibration/audio-check.js';

function answerButtons() {
  document.body.innerHTML = '<button class="jspsych-btn"></button><span id="pc-wait"></span>';
  return document.querySelector('button.jspsych-btn');
}

function firstHeadphoneTrial() {
  const block = headphoneCheckBlock();
  const trial = block.timeline.find((n) => n.data?.phase === 'headphone_check_trial');
  /* The plan is drawn by the plan node's function. */
  block.timeline.find((n) => n.data?.phase === 'headphone_check_plan').func();
  return trial;
}

function firstPitchTrial() {
  const chain = pitchCheckChain();
  const main = chain.timeline[0];
  const nodes = main.timeline.filter((n) => !n.conditional_function);
  nodes.find((n) => n.data?.phase === 'pitch_check_plan').func();
  return nodes.find((n) => n.data?.phase === 'pitch_check_trial');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  audio.ensureRunning.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each([
  ['headphone', firstHeadphoneTrial],
  ['pitch', firstPitchTrial],
])('%s trial when the audio system cannot be started', (_name, build) => {
  it('releases the answer buttons and records playback_ok false when resume rejects', async () => {
    audio.ensureRunning.mockRejectedValue(new Error('blocked'));
    const trial = build();
    const btn = answerButtons();
    await trial.on_load();
    expect(btn.disabled).toBe(false);
    const data = { response: 0 };
    trial.on_finish(data);
    expect(data.playback_ok).toBe(false);
  });

  it('releases the answer buttons after the time limit when resume never settles', async () => {
    audio.ensureRunning.mockReturnValue(new Promise(() => {}));
    const trial = build();
    const btn = answerButtons();
    const loading = trial.on_load();
    await vi.advanceTimersByTimeAsync(0);
    expect(btn.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(AUDIO_START_TIMEOUT_MS + 1);
    await loading;
    expect(btn.disabled).toBe(false);
    const data = { response: 1 };
    trial.on_finish(data);
    expect(data.playback_ok).toBe(false);
  });
});

describe('pitch trial when the audio system starts', () => {
  it('plays, then enables the answer buttons and records playback_ok true', async () => {
    audio.ensureRunning.mockResolvedValue(undefined);
    const trial = firstPitchTrial();
    const btn = answerButtons();
    const loading = trial.on_load();
    await vi.advanceTimersByTimeAsync(0);
    expect(btn.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1400);
    await loading;
    expect(btn.disabled).toBe(false);
    const data = { response: 1 };
    trial.on_finish(data);
    expect(data.playback_ok).toBe(true);
  });
});
