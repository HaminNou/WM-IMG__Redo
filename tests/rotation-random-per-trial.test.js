// @vitest-environment jsdom
/**
 * One fresh random angle per imagery trial, within [-90, +90], used
 * consistently by the rotation cue, the grid and the recorded data.
 *
 * Two layers:
 *   1. SCHEDULER (many seeds, real generators): every imagery-bearing trial
 *      (I-only, I+D, I+T) carries an integer angle in the closed range
 *      config.grid.rotation_min_deg..rotation_max_deg (0 allowed), never missing,
 *      never repeated on consecutive trials, balanced clockwise / counter-
 *      clockwise, and unrelated to page shade or presentation position. The
 *      strata are built from the configured range and must span exactly it.
 *   2. CHAIN (real trial nodes, jsdom, fake clock): for each imagery condition
 *      and for angles from -90 to +90, the arrow cue (CSS rotate), the grid
 *      rotor at the end of the encoding animation, the retention / probe frames,
 *      and every recorded row all carry the SAME angle and sign.
 * Expected positions are computed here, from the SVG-spec rotation formula,
 * not by calling the helpers under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initJsPsych } from 'jspsych';

vi.mock('../src/audio/context.js', () => ({
  getAudioContext: () => ({ currentTime: performance.now() / 1000, state: 'running' }),
  audioContextInfo: () => ({
    sample_rate_hz: 48000,
    state: 'running',
    base_latency_ms: 10,
    output_latency_ms: 20,
  }),
  ensureRunning: async () => {},
  unlockAudio: async () => {},
}));
vi.mock('../src/audio/tones.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, playToneByCell: vi.fn(() => Promise.resolve()) };
});

import { setSessionPRNG, createPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';
import { generateImageryBlock } from '../src/scheduler/imagery-block.js';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { generateMemoryBlock } from '../src/scheduler/memory-block.js';
import {
  ROTATION_STRATA,
  orderViolations,
  trialAngleDeg,
  rotationSignClass,
  stratifiedRotationAngles,
} from '../src/scheduler/rotation-balance.js';
import { iOnlyTrial } from '../src/conditions/i_only.js';
import { iDTrial } from '../src/conditions/i_d.js';
import { iTTrial } from '../src/conditions/i_t.js';
import { _resetStorageForTests, initStorage } from '../src/storage.js';
import { config } from '../src/config.js';

const LO = config.grid.rotation_min_deg;
const HI = config.grid.rotation_max_deg;
const IMAGERY = ['i_only', 'i_d', 'i_t'];

/* ------------------------------------------------------------------ */
/* 1. Scheduler                                                        */
/* ------------------------------------------------------------------ */

const SEEDS = 100;
const plans = [];
function plan(seed) {
  setSessionPRNG(`rot-random-${seed}`);
  resetSequencePools();
  return generateMainPlan();
}

describe('scheduler: a fresh random angle in [-90, +90] for every imagery trial', () => {
  beforeEach(() => {
    if (plans.length === 0) for (let s = 0; s < SEEDS; s++) plans.push(plan(s));
  });

  it('the strata that generate the angles span exactly the configured range', () => {
    expect(LO).toBe(-90);
    expect(HI).toBe(90);
    const lows = ROTATION_STRATA.map((s) => s[0]);
    const highs = ROTATION_STRATA.map((s) => s[1]);
    expect(Math.min(...lows)).toBe(LO);
    expect(Math.max(...highs)).toBe(HI);
    for (let i = 1; i < ROTATION_STRATA.length; i++) {
      const [pl, ph] = ROTATION_STRATA[i - 1];
      const [cl] = ROTATION_STRATA[i];
      /* contiguous: every whole degree of the range belongs to exactly one stratum */
      expect(cl, `gap between strata ${i - 1} and ${i}`).toBe(ph + 1);
      void pl;
    }
  });

  it('every imagery trial has a finite integer angle in [-90, +90] (0 allowed) in all sessions', () => {
    let n = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const p of plans) {
      for (const blk of [p.mainA, p.mainB]) {
        for (const t of blk.trialParams) {
          if (!IMAGERY.includes(t.trial_type)) continue;
          const a = t.rotation_deg;
          expect(typeof a, `${t.trial_type} angle type`).toBe('number');
          expect(Number.isInteger(a), `${t.trial_type} angle ${a} not an integer`).toBe(true);
          expect(a >= LO && a <= HI, `${a} outside [${LO}, ${HI}]`).toBe(true);
          n++;
          min = Math.min(min, a);
          max = Math.max(max, a);
        }
      }
    }
    expect(n).toBe(SEEDS * 72);
    /* the whole closed range is reached, including both endpoints */
    expect(min).toBe(LO);
    expect(max).toBe(HI);
  });

  it('every angle of a condition is distinct within a session, with 12 counter-clockwise and 12 non-negative (0 or clockwise)', () => {
    for (const p of plans) {
      for (const type of IMAGERY) {
        const angles = [...p.mainA.trialParams, ...p.mainB.trialParams]
          .filter((t) => t.trial_type === type)
          .map((t) => t.rotation_deg);
        expect(angles).toHaveLength(24);
        expect(new Set(angles).size).toBe(24);
        expect(angles.filter((a) => a >= 0)).toHaveLength(12);
        expect(angles.filter((a) => a < 0)).toHaveLength(12);
      }
    }
  });

  it('consecutive rotated trials never repeat an angle and differ by at least 3 degrees', () => {
    for (const p of plans) {
      for (const blk of [p.mainA, p.mainB]) {
        expect(orderViolations(blk.trialParams)).toBe(0);
        const angles = blk.trialParams.map(trialAngleDeg).filter((a) => a !== null);
        for (let i = 1; i < angles.length; i++) {
          expect(angles[i]).not.toBe(angles[i - 1]);
          expect(Math.abs(angles[i] - angles[i - 1])).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('angles cover the range evenly (no 10-degree bin far from its expected share)', () => {
    const bins = Array(18).fill(0);
    let n = 0;
    for (const p of plans) {
      for (const blk of [p.mainA, p.mainB]) {
        for (const t of blk.trialParams) {
          if (!IMAGERY.includes(t.trial_type)) continue;
          bins[Math.min(17, Math.floor((t.rotation_deg - LO) / 10))]++;
          n++;
        }
      }
    }
    /* bins 0..16 hold 10 integer angles each (bin 9 holds -1..-0 without 0: 9);
     * the last bin holds 80..90 = 11. Allow 15 % either way. */
    const width = [10, 10, 10, 10, 10, 10, 10, 10, 10, 9, 10, 10, 10, 10, 10, 10, 10, 11];
    const total = width.reduce((a, b) => a + b, 0);
    bins.forEach((c, i) => {
      const expected = (n * width[i]) / total;
      expect(
        Math.abs(c - expected) / expected,
        `bin ${i}: ${c} vs ${expected.toFixed(0)}`
      ).toBeLessThan(0.15);
    });
  });

  it('the angle is unrelated to page shade and to position in the block', () => {
    const corr = (xs, ys) => {
      const n = xs.length;
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (ys[i] - my) ** 2;
      }
      return sxy / Math.sqrt(sxx * syy);
    };
    const absAngle = [];
    const signAngle = [];
    const shade = [];
    const position = [];
    for (const p of plans) {
      for (const blk of [p.mainA, p.mainB]) {
        blk.trialParams.forEach((t, i) => {
          if (!IMAGERY.includes(t.trial_type)) return;
          absAngle.push(Math.abs(t.rotation_deg));
          signAngle.push(Math.sign(t.rotation_deg));
          shade.push(t.background_shade === 'gray' ? 1 : 0);
          position.push(i);
        });
      }
    }
    expect(Math.abs(corr(absAngle, shade))).toBeLessThan(0.05);
    expect(Math.abs(corr(signAngle, shade))).toBeLessThan(0.05);
    expect(Math.abs(corr(absAngle, position))).toBeLessThan(0.05);
    expect(Math.abs(corr(signAngle, position))).toBeLessThan(0.05);
  });

  it('practice-size blocks (2 trials per task) draw from the same range', () => {
    let n = 0;
    for (let s = 0; s < 60; s++) {
      setSessionPRNG(`rot-practice-${s}`);
      resetSequencePools();
      const blocks = [
        generateImageryBlock({ blockSize: 2, sequencePoolLabel: `p${s}` }),
        generateDualBlock({ trialType: 'i_d', blockSize: 2, sequencePoolLabel: `p${s}` }),
        generateDualBlock({ trialType: 'i_t', blockSize: 2, sequencePoolLabel: `p${s}` }),
      ];
      for (const b of blocks) {
        for (const t of b) {
          expect(Number.isInteger(t.rotation_deg)).toBe(true);
          expect(t.rotation_deg >= LO && t.rotation_deg <= HI).toBe(true);
          n++;
        }
      }
    }
    expect(n).toBe(60 * 6);
  });

  it('the strata are built from config.grid.rotation_min_deg/max_deg and tile it exactly', () => {
    const flat = [];
    for (const [lo, hi] of ROTATION_STRATA) for (let a = lo; a <= hi; a++) flat.push(a);
    /* every whole degree of the configured closed range once, in order */
    expect(flat).toEqual(Array.from({ length: HI - LO + 1 }, (_, i) => LO + i));
    expect(ROTATION_STRATA).toHaveLength(6);
    /* three counter-clockwise strata and three that start at 0 or above */
    expect(ROTATION_STRATA.slice(0, 3).every(([, hi]) => hi < 0)).toBe(true);
    expect(ROTATION_STRATA.slice(3).every(([lo]) => lo >= 0)).toBe(true);
    expect(ROTATION_STRATA[3][0]).toBe(0);
    expect(rotationSignClass(0)).toBe(1);
    expect(rotationSignClass(-1)).toBe(-1);
  });

  it('0 degrees and both end points are drawn, each at its fair rate (4 of 31 / 4 of 30 per 24 trials)', () => {
    const rng = createPRNG('rot-zero-rate');
    const N = 4000;
    let zero = 0;
    let minus90 = 0;
    let plus90 = 0;
    for (let i = 0; i < N; i++) {
      const a = stratifiedRotationAngles(24, rng);
      if (a.includes(0)) zero++;
      if (a.includes(-90)) minus90++;
      if (a.includes(90)) plus90++;
    }
    /* binomial sd about 20 around 516 (4/31) and 533 (4/30); 5-sd bands */
    expect(Math.abs(zero - (N * 4) / 31)).toBeLessThan(100);
    expect(Math.abs(minus90 - (N * 4) / 30)).toBeLessThan(100);
    expect(Math.abs(plus90 - (N * 4) / 30)).toBeLessThan(100);
    expect(zero).toBeGreaterThan(0);
  });

  it('memory-only trials: T-only has no angle; D-only (display angle) obeys the same range', () => {
    const d = [];
    for (const p of plans) {
      for (const blk of [p.mainA, p.mainB]) {
        for (const t of blk.trialParams) {
          if (t.trial_type === 't_only') expect(trialAngleDeg(t)).toBeNull();
          if (t.trial_type === 'd_only') d.push(t.display_rotation_deg);
        }
      }
    }
    expect(d.length).toBe(SEEDS * 24);
    d.forEach((a) => expect(Number.isInteger(a) && a >= LO && a <= HI).toBe(true));
    /* sanity: the memory generator is the one the main plan uses */
    setSessionPRNG('rot-mem');
    resetSequencePools();
    expect(generateMemoryBlock({ trialType: 'd_only', blockSize: 24 })).toHaveLength(24);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Cue -> grid -> record chain, real nodes                           */
/* ------------------------------------------------------------------ */

const COND = {
  i_only: { compose: iOnlyTrial, gen: () => generateImageryBlock({ blockSize: 24 }) },
  i_d: { compose: iDTrial, gen: () => generateDualBlock({ trialType: 'i_d', blockSize: 24 }) },
  i_t: { compose: iTTrial, gen: () => generateDualBlock({ trialType: 'i_t', blockSize: 24 }) },
};
const FAKE = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'Date',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];
const STEP_MS = 20;
const ANGLES = [-90, -61, -1, 1, 45, 90];

const rotorAngles = () =>
  [...document.querySelectorAll('.grid-rotor')].map((r) => {
    const m = /rotate\(\s*(-?[\d.eE+-]+)/.exec(r.getAttribute('transform') ?? '');
    return m ? Number(m[1]) : 0;
  });
const arrowAngles = () =>
  [...document.querySelectorAll('img.rotation-arrow-cue')].map((img) => {
    const m = /rotate\(\s*(-?[\d.eE+-]+)deg\)/.exec(img.getAttribute('style') ?? '');
    return m ? Number(m[1]) : NaN;
  });

async function runTrial(cond, params) {
  document.body.innerHTML = '';
  const jsPsych = initJsPsych({});
  window.jsPsych = jsPsych;
  const timeline = COND[cond].compose(params);
  timeline.forEach((n) => {
    n.data = { ...(n.data ?? {}), block_label: 'main_a' };
  });
  let done = false;
  const runP = jsPsych.run(timeline).then(() => {
    done = true;
  });
  const press = (key) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const release = (key) =>
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  const samples = []; /* { phase, t, rotor: [], arrow: [] } */
  const probeStart = new Map();
  const encStart = new Map();
  for (let t = 0; t < 150000 && !done; t += STEP_MS) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    if (document.querySelector('.trial-start-hint')) {
      press('ArrowLeft');
      press('ArrowRight');
      release('ArrowLeft');
      release('ArrowRight');
    }
    const trial = jsPsych.getCurrentTrial?.();
    const phase = trial?.data?.phase ?? '';
    if (/_probe$/.test(phase)) {
      if (!probeStart.has(trial)) probeStart.set(trial, { t: performance.now(), done: false });
      const p = probeStart.get(trial);
      if (!p.done && performance.now() - p.t >= 600) {
        p.done = true;
        press('ArrowRight');
      }
    }
    if (/_encoding$/.test(phase) && !encStart.has(trial)) encStart.set(trial, performance.now());
    samples.push({
      phase,
      sinceEncoding: /_encoding$/.test(phase) ? performance.now() - encStart.get(trial) : null,
      rotor: rotorAngles(),
      arrow: arrowAngles(),
    });
  }
  await runP;
  return { samples, rows: jsPsych.data.get().values() };
}

describe('chain: cue, grid and data use ONE angle per trial (real trial nodes)', () => {
  beforeEach(async () => {
    _resetStorageForTests();
    await initStorage({ backend: 'memory' });
    vi.useFakeTimers({ toFake: FAKE });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const cases = [];
  for (const c of Object.keys(COND)) for (const a of ANGLES) cases.push([c, a]);

  it.each(cases)(
    '%s at %i degrees: arrow, rotor (end of animation), retention/probe frames and every row agree',
    async (cond, angle) => {
      setSessionPRNG(`rot-chain-${cond}`);
      resetSequencePools();
      const base = COND[cond].gen()[0];
      const params = { ...base, rotation_deg: angle };
      const { samples, rows } = await runTrial(cond, params);

      /* The arrow cue shows exactly this angle, over an upright grid. */
      const cue = samples.filter((s) => /_arrow_cue$/.test(s.phase) && s.arrow.length);
      expect(cue.length, 'arrow cue never shown').toBeGreaterThan(10);
      for (const s of cue) {
        expect(s.arrow).toEqual([angle]);
        expect(s.rotor.every((r) => r === 0)).toBe(true);
      }
      /* Clockwise-positive on both: the arrow tip (up = (0,-1)) after CSS rotate(a)
       * equals the SVG-rotated up vector, so a cue of +a and a grid of +a turn the
       * same way. */
      const rad = (angle * Math.PI) / 180;
      const tipCss = [Math.sin(rad), -Math.cos(rad)];
      const tipSvg = [
        0 * Math.cos(rad) - -1 * Math.sin(rad),
        0 * Math.sin(rad) + -1 * Math.cos(rad),
      ];
      expect(tipCss[0]).toBeCloseTo(tipSvg[0], 9);
      expect(tipCss[1]).toBeCloseTo(tipSvg[1], 9);
      expect(Math.sign(Math.round(tipCss[0] * 1e6))).toBe(Math.sign(angle));

      /* The arrow is gone before the grid rotates. */
      const enc = samples.filter((s) => /_encoding$/.test(s.phase));
      expect(enc.length).toBeGreaterThan(20);
      expect(enc.every((s) => s.arrow.length === 0)).toBe(true);
      /* Grid: starts upright, ends at the cued angle once the 500 ms animation
       * has been issued, and stays there for the rest of encoding. */
      expect(enc[0].rotor).toEqual([0]);
      const settled = enc.filter(
        (s) => s.sinceEncoding >= config.imagery.rotation_animation_ms + 60
      );
      expect(settled.length).toBeGreaterThan(10);
      for (const s of settled) expect(s.rotor).toEqual([angle]);

      /* Retention and probe frames (dual tasks) keep the same angle. */
      if (cond !== 'i_only') {
        for (const ph of ['retention', 'probe']) {
          const fr = samples.filter((s) => s.phase.endsWith(`_${ph}`) && s.rotor.length);
          expect(fr.length, `${cond}: no ${ph} frames`).toBeGreaterThan(5);
          for (const s of fr) expect(s.rotor).toEqual([angle]);
        }
      }

      /* Every recorded row that carries an angle carries THIS angle, and the
       * frames drawn after encoding are recorded at it. */
      const withAngle = rows.filter((r) => typeof r.rotation_deg === 'number');
      expect(withAngle.length).toBeGreaterThanOrEqual(4);
      for (const r of withAngle) expect(r.rotation_deg, r.phase).toBe(angle);
      const cueRow = rows.find((r) => /_arrow_cue$/.test(r.phase ?? ''));
      expect(cueRow?.rotation_deg).toBe(angle);
      const encRow = rows.find((r) => /_encoding$/.test(r.phase ?? ''));
      expect(encRow?.rotation_deg).toBe(angle);
      if (cond !== 'i_only') {
        for (const r of rows.filter((x) => /_(retention|probe)$/.test(x.phase ?? ''))) {
          const f = r.frame_rotation_deg ?? r.probe_frame_rotation_deg;
          expect(f, `${r.phase} frame angle`).toBe(angle);
        }
      }
    },
    180000
  );

  it.each(Object.keys(COND))(
    '%s: a generated (not overridden) trial is cued and drawn at its scheduled angle',
    async (cond) => {
      setSessionPRNG(`rot-chain-natural-${cond}`);
      resetSequencePools();
      const params = COND[cond].gen().find((p) => Math.abs(p.rotation_deg) >= 30);
      const { samples } = await runTrial(cond, params);
      const cue = samples.filter((s) => /_arrow_cue$/.test(s.phase) && s.arrow.length);
      expect(cue.length).toBeGreaterThan(10);
      for (const s of cue) expect(s.arrow).toEqual([params.rotation_deg]);
      const settled = samples.filter(
        (s) =>
          /_encoding$/.test(s.phase) && s.sinceEncoding >= config.imagery.rotation_animation_ms + 60
      );
      for (const s of settled) expect(s.rotor).toEqual([params.rotation_deg]);
    },
    180000
  );
});
