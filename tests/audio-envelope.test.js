/**
 * The tone envelope is a raised-cosine ramp (config `tones.cosine_ramp_ms`),
 * not a linear one, and no tone in the bank can clip at the default level.
 *
 * A recording AudioParam replays the scheduled events
 * (`setValueAtTime`, `linearRampToValueAtTime`) so the gain at any time can
 * be read back and compared with the exact raised cosine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let gainParams;

function makeParam() {
  const events = [];
  const p = {
    value: 0,
    events,
    setValueAtTime: (v, t) => events.push({ kind: 'set', v, t }),
    linearRampToValueAtTime: (v, t) => events.push({ kind: 'ramp', v, t }),
    at(t) {
      let prev = { v: 0, t: -Infinity };
      for (const e of events) {
        if (e.t > t) {
          if (e.kind === 'ramp') return prev.v + ((e.v - prev.v) * (t - prev.t)) / (e.t - prev.t);
          return prev.v;
        }
        prev = e;
      }
      return prev.v;
    },
  };
  return p;
}

vi.mock('../src/audio/context.js', () => {
  const ctx = {
    currentTime: 0,
    destination: {},
    createOscillator: () => ({
      frequency: {},
      connect: (t) => t,
      start: () => {},
      stop: () => {},
    }),
    createGain: () => {
      const gain = makeParam();
      gainParams.push(gain);
      return { gain, connect: (t) => t };
    },
  };
  return { getAudioContext: () => ctx, ensureRunning: async () => {} };
});

beforeEach(() => {
  gainParams = [];
  vi.resetModules();
});

const raisedCosine = (x) => 0.5 * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, x))));

describe('tone envelope', () => {
  it('rises and falls as a raised cosine (within 0.1 % of the peak), flat in between', async () => {
    const { playSineTone, setUserPlaybackGain } = await import('../src/audio/dsp.js');
    setUserPlaybackGain(1);
    const peak = 0.25;
    playSineTone(440, { durationMs: 350, rampMs: 10, peak, when: 1 });
    await vi.waitFor(() => expect(gainParams).toHaveLength(1));
    const g = gainParams[0];
    let worst = 0;
    for (let ms = 0; ms <= 350; ms += 0.1) {
      const exact =
        peak * (ms < 10 ? raisedCosine(ms / 10) : ms > 340 ? raisedCosine((350 - ms) / 10) : 1);
      worst = Math.max(worst, Math.abs(g.at(1 + ms / 1000) - exact));
    }
    expect(worst).toBeLessThan(peak * 1e-3);
    /* A linear ramp would give 0.25 * peak here; the cosine gives 0.146 * peak. */
    expect(g.at(1.0025) / peak).toBeCloseTo(0.1464, 2);
    expect(g.at(1.005) / peak).toBeCloseTo(0.5, 3);
    expect(g.at(1.01) / peak).toBeCloseTo(1, 6);
    expect(g.at(1.18)).toBeCloseTo(peak, 9);
    expect(g.at(1.35)).toBeCloseTo(0, 9);
  });

  it('never exceeds the peak and the gain starts and ends at zero', async () => {
    const { playSineTone, setUserPlaybackGain } = await import('../src/audio/dsp.js');
    setUserPlaybackGain(1);
    playSineTone(440, { durationMs: 350, rampMs: 10, peak: 0.25, when: 0 });
    await vi.waitFor(() => expect(gainParams).toHaveLength(1));
    const vals = gainParams[0].events.map((e) => e.v);
    expect(Math.max(...vals)).toBeCloseTo(0.25, 12);
    expect(Math.min(...vals)).toBe(0);
    expect(vals[0]).toBe(0);
    expect(vals.at(-1)).toBeCloseTo(0, 12);
  });

  it('no tone of the bank clips at full user gain (peak < 0.95)', async () => {
    const { getToneBank } = await import('../src/audio/tones.js');
    const { DEFAULT_PEAK } = await import('../src/audio/dsp.js');
    for (const t of getToneBank()) {
      expect(DEFAULT_PEAK * 10 ** (t.gain_compensation_db / 20)).toBeLessThan(0.95);
    }
  });
});
