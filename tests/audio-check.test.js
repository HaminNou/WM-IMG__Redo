// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/screen-out.js', () => ({
  screenOutExit: vi.fn((opts) => ({ timeline: [], conditional_function: opts.condition, opts })),
}));

import {
  AUDIO_CHECK,
  headphoneCheckBlock,
  pitchCheckChain,
  planHeadphoneTrials,
  planPitchTrials,
  scoreBlock,
} from '../src/calibration/audio-check.js';

describe('planHeadphoneTrials', () => {
  it('has one trial per ordering, so each position holds the quiet tone equally often', () => {
    const plan = planHeadphoneTrials();
    expect(plan).toHaveLength(AUDIO_CHECK.headphone.n_trials);
    const orders = new Set(plan.map((p) => p.order.join('-')));
    expect(orders.size).toBe(6);
    const counts = [0, 0, 0];
    for (const p of plan) {
      expect([...p.order].sort()).toEqual(['anti', 'quiet', 'ref']);
      expect(p.order[p.correct]).toBe('quiet');
      counts[p.correct] += 1;
    }
    expect(counts).toEqual([2, 2, 2]);
  });
});

describe('planPitchTrials', () => {
  it('uses adjacent bank tones with the correct answer matching the direction', () => {
    for (let rep = 0; rep < 20; rep++) {
      const plan = planPitchTrials();
      expect(plan).toHaveLength(AUDIO_CHECK.pitch.n_trials);
      for (const p of plan) {
        expect(Math.abs(p.second - p.first)).toBe(1);
        expect(p.first).toBeGreaterThanOrEqual(0);
        expect(p.first).toBeLessThanOrEqual(23);
        expect(p.second).toBeGreaterThanOrEqual(0);
        expect(p.second).toBeLessThanOrEqual(23);
        expect(p.correct).toBe(p.second > p.first ? 1 : 0);
      }
    }
  });

  it('spreads the pairs over the whole bank', () => {
    let top = 0;
    for (let rep = 0; rep < 50; rep++) {
      for (const p of planPitchTrials()) top = Math.max(top, p.first, p.second);
    }
    expect(top).toBeGreaterThanOrEqual(20);
  });
});

describe('scoreBlock', () => {
  const rows = (flags) => flags.map((correct) => ({ correct }));

  it('passes at the criterion and fails below it', () => {
    expect(scoreBlock(rows([true, true, true, true, true, false]), 5)).toEqual({
      n_trials: 6,
      n_correct: 5,
      passed: true,
    });
    expect(scoreBlock(rows([true, true, true, true, false, false]), 5).passed).toBe(false);
  });
});

describe('check timelines', () => {
  it('headphone block is intro, plan, six trials, summary', () => {
    const block = headphoneCheckBlock();
    expect(block.timeline).toHaveLength(2 + AUDIO_CHECK.headphone.n_trials + 1);
    expect(block.timeline.at(-1).data.phase).toBe('headphone_check_summary');
  });

  it('pitch chain ends the session through the screen-out path when the check was not passed', () => {
    const chain = pitchCheckChain();
    const [main, exit] = chain.timeline;
    expect(exit.opts.phase).toBe('audio_check_fail');
    expect(exit.opts.exitReason).toBe('audio_check_failed');
    expect(exit.opts.flush).toBe(true);
    /* Nothing has been scored yet: the loop must run and the exit must fire. */
    expect(exit.conditional_function()).toBe(true);
    expect(main.loop_function()).toBe(true);
  });

  it('allows one retry', () => {
    expect(AUDIO_CHECK.pitch.max_attempts).toBe(2);
  });
});

describe('playStereoSine', () => {
  let nodes;

  beforeEach(() => {
    nodes = { gains: [], merger: null };
    const param = () => ({
      value: 1,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
    });
    const gainNode = () => {
      const g = { gain: param(), connect: vi.fn((target) => target) };
      nodes.gains.push(g);
      return g;
    };
    const ctx = {
      currentTime: 0,
      destination: {},
      createOscillator: () => ({
        frequency: {},
        connect: vi.fn((t) => t),
        start: vi.fn(),
        stop: vi.fn(),
      }),
      createGain: gainNode,
      createChannelMerger: () => {
        nodes.merger = { connect: vi.fn() };
        return nodes.merger;
      },
    };
    vi.resetModules();
    vi.doMock('../src/audio/context.js', () => ({
      getAudioContext: () => ctx,
      ensureRunning: () => Promise.resolve(),
    }));
  });

  it('inverts the right channel only for the anti-phase tone', async () => {
    const { playStereoSine } = await import('../src/audio/dsp.js');
    void playStereoSine(200, { antiphase: true });
    await Promise.resolve();
    await Promise.resolve();
    /* gains: envelope, left, right */
    expect(nodes.gains[2].gain.value).toBe(-1);
    expect(nodes.gains[1].gain.value).toBe(1);

    nodes.gains.length = 0;
    void playStereoSine(200, { antiphase: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(nodes.gains[2].gain.value).toBe(1);
  });
});
