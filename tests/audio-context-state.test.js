// @vitest-environment jsdom
/**
 * AudioContext state monitoring (src/audio/context.js).
 *
 * The browser can take the context out of `running` on its own: Safari sets
 * `interrupted` after a call, a headset change or a tab switch, and Chrome
 * suspends an idle context. Each change becomes one `audio_state_change` row
 * (so silent stretches can be found in the data afterwards) and a suspended or
 * interrupted context is resumed straight away. Nothing here touches timing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.sampleRate = 48000;
    this.baseLatency = 0.005;
    this.outputLatency = 0.02;
    this.listeners = {};
    this.resume = vi.fn(async () => {
      this.state = 'running';
    });
    FakeAudioContext.last = this;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  setState(state) {
    this.state = state;
    (this.listeners.statechange ?? []).forEach((fn) => fn());
  }
}

let ctxMod;

beforeEach(async () => {
  vi.resetModules();
  window.AudioContext = FakeAudioContext;
  ctxMod = await import('../src/audio/context.js');
});

afterEach(() => {
  delete window.AudioContext;
  FakeAudioContext.last = undefined;
});

describe('state changes', () => {
  it('logs each change as one audio_state_change row with the new state', () => {
    const rows = [];
    ctxMod.setAudioStateLogger((r) => rows.push(r));
    ctxMod.getAudioContext();
    FakeAudioContext.last.setState('suspended');
    FakeAudioContext.last.setState('interrupted');
    FakeAudioContext.last.setState('running');
    expect(rows.map((r) => [r.phase, r.audio_state])).toEqual([
      ['audio_state_change', 'suspended'],
      ['audio_state_change', 'interrupted'],
      ['audio_state_change', 'running'],
    ]);
    expect(rows.every((r) => Number.isFinite(r.ts))).toBe(true);
  });

  it('tries to resume a suspended or interrupted context at once, but not a running one', () => {
    ctxMod.setAudioStateLogger(() => {});
    ctxMod.getAudioContext();
    const c = FakeAudioContext.last;
    c.resume.mockClear();
    c.setState('suspended');
    expect(c.resume).toHaveBeenCalledTimes(1);
    c.resume.mockClear();
    c.setState('interrupted');
    expect(c.resume).toHaveBeenCalledTimes(1);
    c.resume.mockClear();
    c.setState('running');
    expect(c.resume).not.toHaveBeenCalled();
  });

  it('a refused resume (no user gesture) is swallowed, not thrown', async () => {
    ctxMod.setAudioStateLogger(() => {});
    ctxMod.getAudioContext();
    const c = FakeAudioContext.last;
    c.resume = vi.fn(() => Promise.reject(new DOMException('needs a gesture', 'NotAllowedError')));
    expect(() => c.setState('interrupted')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('does not throw when the writer throws or rejects', () => {
    ctxMod.getAudioContext();
    const c = FakeAudioContext.last;
    ctxMod.setAudioStateLogger(() => {
      throw new Error('storage dead');
    });
    expect(() => c.setState('suspended')).not.toThrow();
    ctxMod.setAudioStateLogger(() => Promise.reject(new Error('async')));
    expect(() => c.setState('suspended')).not.toThrow();
  });

  it('logs nothing without a writer, and stops after a cap so flapping cannot flood storage', () => {
    ctxMod.getAudioContext();
    const c = FakeAudioContext.last;
    expect(() => c.setState('suspended')).not.toThrow();
    const rows = [];
    ctxMod.setAudioStateLogger((r) => rows.push(r));
    for (let i = 0; i < 200; i++) c.setState(i % 2 ? 'running' : 'suspended');
    expect(rows.length).toBeLessThanOrEqual(50);
    expect(rows.length).toBeGreaterThan(0);
    ctxMod.setAudioStateLogger(null);
    const n = rows.length;
    c.setState('suspended');
    expect(rows).toHaveLength(n);
  });

  it('registers exactly one listener per context', () => {
    ctxMod.getAudioContext();
    ctxMod.getAudioContext();
    ctxMod.getAudioContext();
    expect(FakeAudioContext.last.listeners.statechange).toHaveLength(1);
  });
});

describe('ensureRunning and unlockAudio', () => {
  it('ensureRunning resumes a suspended or interrupted context and leaves a running one alone', async () => {
    ctxMod.getAudioContext();
    const c = FakeAudioContext.last;
    c.resume.mockClear();
    await ctxMod.ensureRunning();
    expect(c.resume).not.toHaveBeenCalled();
    c.state = 'suspended';
    await ctxMod.ensureRunning();
    expect(c.resume).toHaveBeenCalledTimes(1);
    c.state = 'interrupted';
    await ctxMod.ensureRunning();
    expect(c.resume).toHaveBeenCalledTimes(2);
  });

  it('ensureRunning does nothing before the context exists', async () => {
    await expect(ctxMod.ensureRunning()).resolves.toBeUndefined();
    expect(FakeAudioContext.last).toBeUndefined();
  });
});
