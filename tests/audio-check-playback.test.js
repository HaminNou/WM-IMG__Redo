// @vitest-environment jsdom
/**
 * Headphone check, end to end through the REAL audio code.
 *
 * Only the browser's AudioContext is faked. `audio-check.js`, `dsp.js` and
 * `equal-loudness.js` are all real, so the arguments the check passes to
 * `playStereoSine` are the arguments the oscillators actually receive. (An
 * earlier call passed the frequency twice, which shifted the options object
 * into the wrong parameter; the options were silently dropped and all three
 * sounds started together, in phase, at one level. Tests that mocked
 * `playStereoSine`, or called it with the right signature, could not see it.)
 *
 * The fake context records, for every oscillator, its frequency and its
 * scheduled start/stop; the envelope gain automation (peak level); and which
 * merger input each channel gain feeds, so "right channel inverted" is read
 * from the graph, not assumed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/screen-out.js', () => ({
  screenOutExit: vi.fn((opts) => ({ timeline: [], conditional_function: opts.condition, opts })),
}));

const rig = vi.hoisted(() => ({ ctx: null }));
vi.mock('../src/audio/context.js', () => ({
  getAudioContext: () => rig.ctx,
  ensureRunning: () => Promise.resolve(),
}));

import { AUDIO_CHECK, headphoneCheckBlock } from '../src/calibration/audio-check.js';
import { setUserPlaybackGain } from '../src/audio/dsp.js';

const CTX_NOW = 10;
const DEST = { name: 'destination' };

function makeFakeContext() {
  const oscs = [];
  const mergers = [];
  const param = (owner) => ({
    value: 1,
    setValueAtTime(v, t) {
      owner.events.push({ kind: 'set', v, t });
    },
    linearRampToValueAtTime(v, t) {
      owner.events.push({ kind: 'ramp', v, t });
    },
  });
  const gainNode = () => {
    const node = { events: [], edges: [], isGain: true };
    node.gain = param(node);
    node.connect = (target, out = 0, inp = 0) => {
      node.edges.push({ target, out, inp });
      return target;
    };
    return node;
  };
  return {
    currentTime: CTX_NOW,
    destination: DEST,
    oscs,
    mergers,
    createOscillator() {
      const o = {
        type: null,
        frequency: { value: null },
        started: [],
        stopped: [],
        target: null,
        connect(t) {
          o.target = t;
          return t;
        },
        start(when) {
          o.started.push(when);
        },
        stop(when) {
          o.stopped.push(when);
        },
      };
      oscs.push(o);
      return o;
    },
    createGain: gainNode,
    createChannelMerger() {
      const m = { edges: [], connect: (t) => m.edges.push(t) };
      m.connect = (t) => {
        m.edges.push(t);
        return t;
      };
      mergers.push(m);
      return m;
    },
  };
}

/** Read each scheduled sound back out of the recorded audio graph. */
function voices(ctx) {
  return ctx.oscs.map((o) => {
    const env = o.target;
    const [a, b] = env.edges.map((e) => e.target);
    const chan = (g) => ({
      gain: g.gain.value,
      input: g.edges.find((e) => ctx.mergers.includes(e.target)).inp,
    });
    const chans = [chan(a), chan(b)];
    const left = chans.find((c) => c.input === 0);
    const right = chans.find((c) => c.input === 1);
    const peak = Math.max(...env.events.map((e) => e.v));
    const merger = a.edges[0].target;
    return {
      freq: o.frequency.value,
      start: o.started[0],
      stop: o.stopped[0],
      peak,
      leftGain: left.gain,
      rightGain: right.gain,
      feedsDestination: merger.edges.includes(DEST),
      firstEnvelopeEvent: env.events[0],
    };
  });
}

const dB = (x) => 20 * Math.log10(x);

function setUp() {
  document.body.innerHTML =
    '<span id="hp-0" class="hp-box"></span><span id="hp-1" class="hp-box"></span>' +
    '<span id="hp-2" class="hp-box"></span><button class="jspsych-btn"></button>';
}

async function playAllTrials() {
  const block = headphoneCheckBlock();
  block.timeline.find((n) => n.data?.phase === 'headphone_check_plan').func();
  const trials = block.timeline.filter((n) => n.data?.phase === 'headphone_check_trial');
  const out = [];
  for (let i = 0; i < trials.length; i++) {
    rig.ctx = makeFakeContext();
    setUp();
    const loading = trials[i].on_load();
    await vi.advanceTimersByTimeAsync(0);
    const ctx = rig.ctx;
    const marks = [];
    /* Sample the visual "on" highlights against the audio schedule. */
    for (let ms = 0; ms <= 5200; ms += 50) {
      await vi.advanceTimersByTimeAsync(ms === 0 ? 0 : 50);
      marks.push({
        ms,
        on: [0, 1, 2].map((k) => document.getElementById(`hp-${k}`).classList.contains('on')),
      });
    }
    await loading;
    const data = { response: 0 };
    trials[i].on_finish(data);
    out.push({ i, ctx, v: voices(ctx), marks, data });
  }
  return out;
}

describe('headphone check through the real audio code', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setUserPlaybackGain(1);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('plays three 200 Hz sounds per trial, one after another, as configured', async () => {
    const h = AUDIO_CHECK.headphone;
    const trials = await playAllTrials();
    expect(trials).toHaveLength(h.n_trials);
    for (const t of trials) {
      expect(t.v).toHaveLength(3);
      const gap = (h.dur_ms + h.gap_ms) / 1000;
      t.v.forEach((s, k) => {
        expect(s.freq).toBe(h.freq_hz);
        expect(s.start).toBeCloseTo(CTX_NOW + 0.15 + k * gap, 9);
        expect(s.stop - s.start).toBeCloseTo(h.dur_ms / 1000 + 0.05, 9);
        expect(s.feedsDestination).toBe(true);
        expect(s.leftGain).toBe(1);
      });
      /* strictly increasing, non-overlapping */
      expect(t.v[1].start).toBeGreaterThan(t.v[0].stop - 0.05);
      expect(t.v[2].start).toBeGreaterThan(t.v[1].stop - 0.05);
    }
  });

  it('makes exactly one sound anti-phase and exactly one 6 dB quieter, in the planned positions', async () => {
    const h = AUDIO_CHECK.headphone;
    const trials = await playAllTrials();
    for (const t of trials) {
      const order = t.data.order;
      const antiAt = order.indexOf('anti');
      const quietAt = order.indexOf('quiet');
      const refAt = order.indexOf('ref');
      expect(t.v.map((s) => s.rightGain)).toEqual(order.map((k) => (k === 'anti' ? -1 : 1)));
      expect(t.v.filter((s) => s.rightGain === -1)).toHaveLength(1);
      /* levels: ref and anti share one level, the quiet one is quiet_db lower */
      expect(dB(t.v[quietAt].peak) - dB(t.v[refAt].peak)).toBeCloseTo(h.quiet_db, 6);
      expect(t.v[antiAt].peak).toBeCloseTo(t.v[refAt].peak, 12);
      /* and the correct answer is the quiet one */
      expect(t.data.correct_pos).toBe(quietAt);
    }
  });

  it('plays the reference level at the 70-phon-compensated peak of the task tones at 200 Hz', async () => {
    const trials = await playAllTrials();
    for (const t of trials) {
      const ref = t.v[t.data.order.indexOf('ref')];
      /* 0.25 digital peak x ISO 226:2023 70-phon gain at 200 Hz (+7.83 dB), user gain 1 */
      expect(dB(ref.peak / 0.25)).toBeCloseTo(7.83, 1);
      expect(ref.peak).toBeLessThan(0.95);
    }
  });

  it('shapes each sound with the configured raised-cosine ramp (Woods et al.: 100 ms)', async () => {
    const h = AUDIO_CHECK.headphone;
    expect(h.ramp_ms).toBe(100);
    expect(h.gap_ms).toBe(500);
    const trials = await playAllTrials();
    for (const t of trials) {
      t.v.forEach((s, k) => {
        const env = t.ctx.oscs[k].target;
        const ramp = h.ramp_ms / 1000;
        const at = (when) => env.events.find((e) => Math.abs(e.t - when) < 1e-9);
        /* raised cosine: half the peak at mid-ramp, the full peak at the end of the ramp */
        expect(at(s.start + ramp / 2).v).toBeCloseTo(s.peak / 2, 9);
        expect(at(s.start + ramp).v).toBeCloseTo(s.peak, 9);
        /* and the same on the way down, ending at silence at the end of the sound */
        const end = s.start + h.dur_ms / 1000;
        expect(at(end - ramp / 2).v).toBeCloseTo(s.peak / 2, 9);
        expect(at(end).v).toBeCloseTo(0, 9);
      });
    }
  });

  it('starts every envelope at silence at its own scheduled start time', async () => {
    const trials = await playAllTrials();
    for (const t of trials) {
      for (const s of t.v) {
        expect(s.firstEnvelopeEvent).toEqual({ kind: 'set', v: 0, t: s.start });
      }
    }
  });

  it('highlights each box while its sound plays, and only then', async () => {
    const h = AUDIO_CHECK.headphone;
    const trials = await playAllTrials();
    const gapMs = h.dur_ms + h.gap_ms;
    for (const t of trials) {
      const at = (ms) => t.marks.find((m) => m.ms === ms).on;
      for (let k = 0; k < 3; k++) {
        const onset = 150 + k * gapMs;
        const mid = onset + 500;
        const after = onset + h.dur_ms + 100;
        const expectOnly = (arr, idx) => arr.forEach((v, j) => expect(v).toBe(j === idx));
        expectOnly(at(mid), k);
        expect(at(after).every((v) => v === false)).toBe(true);
      }
    }
  });

  it('records the planned order, the answer key and whether playback worked', async () => {
    const trials = await playAllTrials();
    for (const t of trials) {
      expect(t.data.check).toBe('headphone');
      expect(t.data.playback_ok).toBe(true);
      expect(t.data.order).toHaveLength(3);
      expect(t.data.order[t.data.correct_pos]).toBe('quiet');
      expect(t.data.chosen).toBe(0);
      expect(t.data.correct).toBe(t.data.correct_pos === 0);
    }
  });

  it('releases the trial as failed (never unhandled) when a sound cannot be scheduled', async () => {
    const block = headphoneCheckBlock();
    block.timeline.find((n) => n.data?.phase === 'headphone_check_plan').func();
    const trial = block.timeline.find((n) => n.data?.phase === 'headphone_check_trial');
    rig.ctx = makeFakeContext();
    rig.ctx.createOscillator = () => {
      throw new Error('no oscillator');
    };
    setUp();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const loading = trial.on_load();
    await vi.advanceTimersByTimeAsync(6000);
    await loading;
    const data = { response: 1 };
    trial.on_finish(data);
    expect(data.playback_ok).toBe(false);
    expect(document.querySelector('button.jspsych-btn').disabled).toBe(false);
  });
});
