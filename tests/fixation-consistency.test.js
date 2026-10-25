// @vitest-environment jsdom
/**
 * Fixation target, every condition, every in-trial phase.
 *
 * The bull's-eye (outer ring + centre dot) must be on screen at the frame
 * centre, upright, from the start of encoding through the delay and the
 * test, in all five conditions — I-only included. The '?' cue never
 * replaces the dot: it is a path whose period IS the dot. One real trial of
 * each condition is run through jsPsych on a fake clock and the DOM is
 * sampled every step; nothing here calls the helpers under test to decide
 * what "correct" is.
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

import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { generateMemoryBlock } from '../src/scheduler/memory-block.js';
import { generateImageryBlock } from '../src/scheduler/imagery-block.js';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { dOnlyTrial } from '../src/conditions/d_only.js';
import { tOnlyTrial } from '../src/conditions/t_only.js';
import { iOnlyTrial } from '../src/conditions/i_only.js';
import { iDTrial } from '../src/conditions/i_d.js';
import { iTTrial } from '../src/conditions/i_t.js';
import { _resetStorageForTests, initStorage } from '../src/storage.js';
import { createGridFrame, setFixation, clearStimuli } from '../src/visuals/frame.js';
import { questionMarkPath, QMARK_STROKE_MM } from '../src/visuals/fixation-mark.js';
import { config } from '../src/config.js';
import { slideStimulusPage } from '../src/visuals/slide-layout.js';
import { patternPhaseNode } from '../src/conditions/pattern-phase.js';
import { ARROW_CENTRE_HOLE_STYLE } from '../src/visuals/rotation-arrow-style.js';
import { buildPatternOverlay, showPattern, hidePattern } from '../src/visuals/pattern.js';

const CONDITIONS = {
  i_only: {
    compose: iOnlyTrial,
    gen: () => generateImageryBlock({ blockSize: 24 }),
    phases: ['encoding', 'iti'],
    probes: 0,
  },
  i_d: {
    compose: iDTrial,
    gen: () => generateDualBlock({ trialType: 'i_d', blockSize: 24 }),
    phases: ['encoding', 'retention', 'probe', 'iti'],
    probes: 3,
  },
  i_t: {
    compose: iTTrial,
    gen: () => generateDualBlock({ trialType: 'i_t', blockSize: 24 }),
    phases: ['encoding', 'retention', 'probe', 'iti'],
    probes: 3,
  },
  d_only: {
    compose: dOnlyTrial,
    gen: () => generateMemoryBlock({ trialType: 'd_only', blockSize: 24 }),
    phases: ['encoding', 'retention', 'probe', 'iti'],
    probes: 3,
  },
  t_only: {
    compose: tOnlyTrial,
    gen: () => generateMemoryBlock({ trialType: 't_only', blockSize: 24 }),
    phases: ['encoding', 'retention', 'probe', 'iti'],
    probes: 3,
  },
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
const MID = 25; /* 5 x 10 mm grid */

/** A rotated trial (so "upright under rotation" is actually exercised). */
function pickTrial(cond) {
  setSessionPRNG(`fixation-${cond}`);
  resetSequencePools();
  const block = CONDITIONS[cond].gen();
  const withRotation = block.filter((p) => Math.abs(p.rotation_deg ?? 0) >= 45);
  return withRotation[0] ?? block[0];
}

function snapshotFrames() {
  return [...document.querySelectorAll('svg')]
    .filter((svg) => svg.querySelector('.grid-bullseye-ring'))
    .map((svg) => {
      const ring = svg.querySelector('.grid-bullseye-ring');
      const dot = svg.querySelector('.grid-bullseye-dot');
      const qm = svg.querySelector('.grid-fixation-qmark');
      const rotor = svg.querySelector('.grid-rotor');
      const m = /rotate\(\s*(-?[\d.eE+-]+)/.exec(rotor?.getAttribute('transform') ?? '');
      return {
        ring: ['cx', 'cy', 'r'].map((a) => Number(ring.getAttribute(a))),
        dot: ['cx', 'cy', 'r'].map((a) => Number(dot.getAttribute(a))),
        dotVisible: dot.getAttribute('visibility') !== 'hidden',
        dotInRotor: dot.closest('.grid-rotor') !== null,
        ringInRotor: ring.closest('.grid-rotor') !== null,
        qmVisible: qm.getAttribute('visibility') === 'visible',
        qmD: qm.getAttribute('d'),
        qmStroke: qm.getAttribute('stroke'),
        dotFill: dot.getAttribute('fill'),
        qmInRotor: qm.closest('.grid-rotor') !== null,
        rotation: m ? Number(m[1]) : 0,
      };
    });
}

/** Run one real trial; returns per-phase samples of the on-screen frame(s). */
async function runTrial(cond, params) {
  document.body.innerHTML = '';
  const jsPsych = initJsPsych({});
  window.jsPsych = jsPsych;
  const timeline = CONDITIONS[cond].compose(params);
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

  const byPhase = new Map(); /* phase suffix -> frames sampled */
  const gaps = []; /* samples with no frame after encoding began */
  const probeStart = new Map();
  let encodingBegan = false;
  for (let t = 0; t < 150000 && !done; t += STEP_MS) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    if (document.querySelector('.trial-start-hint')) {
      press('ArrowLeft');
      press('ArrowRight');
      release('ArrowLeft');
      release('ArrowRight');
    }
    const trial = jsPsych.getCurrentTrial?.();
    const phase = (trial?.data?.phase ?? '').replace(
      /^[a-z]+(_[a-z]+)?_(?=encoding|retention|probe|iti|star)/,
      ''
    );
    const key = phase.split('_').pop();
    if (/_probe$/.test(trial?.data?.phase ?? '')) {
      if (!probeStart.has(trial)) probeStart.set(trial, { t: performance.now(), done: false });
      const p = probeStart.get(trial);
      if (!p.done && performance.now() - p.t >= 600) {
        p.done = true;
        press('ArrowRight');
      }
    }
    const frames = snapshotFrames();
    const label = /_(encoding|retention|probe|iti)$/.exec(trial?.data?.phase ?? '')?.[1];
    if (label === 'encoding') encodingBegan = true;
    if (encodingBegan && !done) {
      if (frames.length === 0 && label) gaps.push({ t, phase: trial?.data?.phase });
    }
    if (label && frames.length) {
      if (!byPhase.has(label)) byPhase.set(label, []);
      byPhase.get(label).push(...frames);
    }
    void key;
  }
  await runP;
  return { byPhase, gaps };
}

describe("bull's-eye fixation in every condition and phase (real trials, DOM)", () => {
  beforeEach(async () => {
    _resetStorageForTests();
    await initStorage({ backend: 'memory' });
    vi.useFakeTimers({ toFake: FAKE });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const reference = {};

  it.each(Object.keys(CONDITIONS))(
    '%s: ring + centre dot visible, centred and upright in every in-trial phase',
    async (cond) => {
      const params = pickTrial(cond);
      const { byPhase, gaps } = await runTrial(cond, params);

      /* Every expected phase was actually observed on screen. */
      for (const ph of CONDITIONS[cond].phases) {
        expect(byPhase.has(ph), `${cond}: no frame sampled in ${ph}`).toBe(true);
      }
      /* No blank screen between the start of encoding and the end of the ITI. */
      expect(gaps, `${cond}: gaps without a frame`).toEqual([]);

      let sawRotated = false;
      for (const [ph, frames] of byPhase) {
        for (const f of frames) {
          const where = `${cond}/${ph}`;
          /* Same geometry as every other condition and phase. */
          reference.ring ??= f.ring;
          reference.dot ??= f.dot;
          reference.qmD ??= f.qmD;
          expect(f.ring, where).toEqual(reference.ring);
          expect(f.dot, where).toEqual(reference.dot);
          expect(f.qmD, where).toBe(reference.qmD);
          /* Centred. */
          expect(f.ring.slice(0, 2), where).toEqual([MID, MID]);
          expect(f.dot.slice(0, 2), where).toEqual([MID, MID]);
          /* The dot is ALWAYS visible — also while the '?' is shown. */
          expect(f.dotVisible, `${where}: dot hidden`).toBe(true);
          /* Upright: none of the fixation parts live inside the rotor. */
          expect(f.dotInRotor, where).toBe(false);
          expect(f.ringInRotor, where).toBe(false);
          expect(f.qmInRotor, where).toBe(false);
          /* The '?' period is the dot: they share one colour while it shows. */
          if (f.qmVisible) expect(f.dotFill, where).toBe(f.qmStroke);
          if (Math.abs(f.rotation) > 1) sawRotated = true;
        }
      }
      /* The test exercised a rotated frame for the rotated conditions. */
      if (['i_only', 'i_d', 'i_t'].includes(cond)) expect(sawRotated).toBe(true);
      /* '?' appears exactly where the dot/tone tests are announced. */
      if (CONDITIONS[cond].probes > 0) {
        const qmSeen = (ph) => (byPhase.get(ph) ?? []).some((f) => f.qmVisible);
        expect(qmSeen('retention')).toBe(true);
        expect(qmSeen('probe')).toBe(true);
      }
    },
    180000
  );
});

describe('the shared frame helper', () => {
  it("keeps the dot visible and recolours it with the '?' (feedback), then restores both", () => {
    const frame = createGridFrame({ background_shade: 'white' });
    const dot = frame.svg.querySelector('.grid-bullseye-dot');
    const qm = frame.svg.querySelector('.grid-fixation-qmark');
    const base = dot.getAttribute('fill');
    expect(qm.getAttribute('visibility')).toBe('hidden');
    setFixation(frame, '?');
    expect(qm.getAttribute('visibility')).toBe('visible');
    expect(dot.getAttribute('visibility')).not.toBe('hidden');
    setFixation(frame, '?', { color: '#00aa00' });
    expect(qm.getAttribute('stroke')).toBe('#00aa00');
    expect(dot.getAttribute('fill')).toBe('#00aa00');
    setFixation(frame, '');
    expect(qm.getAttribute('visibility')).toBe('hidden');
    expect(dot.getAttribute('fill')).toBe(base);
    expect(dot.getAttribute('visibility')).not.toBe('hidden');
  });

  it("a frame created with fixation '?' shows the cue from the first paint", () => {
    const frame = createGridFrame({ fixation: '?', background_shade: 'white' });
    expect(frame.svg.querySelector('.grid-fixation-qmark').getAttribute('visibility')).toBe(
      'visible'
    );
    expect(frame.svg.querySelector('.grid-bullseye-dot').getAttribute('visibility')).not.toBe(
      'hidden'
    );
  });

  it("the '?' clears the nearest stimulus: farthest point < 7.5 mm from the centre", () => {
    /* Read the hook radius, hook centre and stem end from the generated path
     * itself (M x y  A r r 0 0 1 x y  C ... x y), not from module constants. */
    const d = questionMarkPath(0, 0);
    const m = /^M (-?[\d.]+) (-?[\d.]+) A ([\d.]+) \3 0 0 1 (-?[\d.]+) (-?[\d.]+) C /.exec(d);
    expect(m, d).not.toBeNull();
    const [, , hy, r, rx] = m;
    const top = Number(hy) - Number(r) - QMARK_STROKE_MM / 2; /* top of the hook, incl. stroke */
    const side = Number(r) + QMARK_STROKE_MM / 2;
    const farthest = Math.max(Math.abs(top), Math.hypot(side, Number(hy)));
    const nearestStimulusEdge = 10 - config.memory.dot_diameter_mm / 2; /* cell centre 10 mm out */
    expect(farthest).toBeLessThan(nearestStimulusEdge);
    expect(Number(rx)).toBeGreaterThan(0);
  });
});

describe('instruction-card exemplar matches the live cue', () => {
  const card = (exemplar) =>
    document
      .createRange()
      .createContextualFragment(slideStimulusPage({ title: 't', body: '<p>b</p>', exemplar }));
  it("the 'qmark' card draws the shared path and keeps the centre dot", () => {
    const frag = card(['qmark']);
    const path = frag.querySelector('path');
    expect(path).not.toBeNull();
    /* Slide units are the live frame's mm: same path as the trial cue. */
    expect(path.getAttribute('d')).toBe(questionMarkPath(25, 25));
    expect(frag.querySelector('text')).toBeNull();
    const dot = [...frag.querySelectorAll('circle')].find((c) => c.getAttribute('r') === '0.65');
    expect(dot).toBeDefined();
    expect([dot.getAttribute('cx'), dot.getAttribute('cy')]).toEqual(['25', '25']);
  });
  it("the plain card (no exemplar) shows the bull's-eye dot too", () => {
    const frag = card([]);
    expect([...frag.querySelectorAll('circle')].some((c) => c.getAttribute('r') === '0.65')).toBe(
      true
    );
  });
});

describe("pattern-reminder screen shows the same bull's-eye", () => {
  const attrs = (el) => ({
    cx: el.getAttribute('cx'),
    cy: el.getAttribute('cy'),
    r: el.getAttribute('r'),
    fill: el.getAttribute('fill'),
  });
  const visibleDots = (svg) =>
    [...svg.querySelectorAll('circle')].filter(
      (c) =>
        (c.getAttribute('class') === 'grid-bullseye-dot' ||
          c.getAttribute('class') === 'pattern-reference-dot') &&
        c.getAttribute('visibility') !== 'hidden'
    );

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each(['white', 'gray'])(
    'the real pattern-phase node (%s shade) draws the standard ring and dot, on top of the overlay',
    (shade) => {
      const standard = createGridFrame({ rotation_deg: 0, background_shade: shade });
      const node = patternPhaseNode({
        block_label: 'main_a',
        trial_index_in_block: 0,
        background_shade: shade,
      });
      document.body.innerHTML = node.stimulus;
      node.on_load();
      const svg = document.querySelector('#pattern-phase-mount svg');
      expect(svg).not.toBeNull();

      /* ring: present, same geometry and ink as an ordinary frame */
      const ring = svg.querySelector('.grid-bullseye-ring');
      expect(ring).not.toBeNull();
      expect(attrs(ring)).toEqual(attrs(standard.svg.querySelector('.grid-bullseye-ring')));

      /* exactly one visible centre dot, identical to the standard frame's */
      const dots = visibleDots(svg);
      expect(dots).toHaveLength(1);
      expect(attrs(dots[0])).toEqual(attrs(standard.centerDot));
      const mid = (config.grid.cells_per_side * config.grid.cell_size_mm) / 2;
      expect(Number(dots[0].getAttribute('cx'))).toBeCloseTo(mid, 6);
      expect(Number(dots[0].getAttribute('cy'))).toBeCloseTo(mid, 6);

      /* upright (outside the rotor) and painted after, i.e. above, the pattern overlay */
      expect(dots[0].closest('.grid-rotor')).toBeNull();
      const order = [...svg.querySelectorAll('*')];
      expect(order.indexOf(dots[0])).toBeGreaterThan(
        order.indexOf(svg.querySelector('.grid-pattern'))
      );
      expect(svg.querySelector('.grid-pattern').getAttribute('visibility')).toBe('visible');
    }
  );

  it('after a demo replay clears the stimuli, showPattern puts the centre dot back (one visible dot)', () => {
    const frame = createGridFrame({ rotation_deg: 0, background_shade: 'white' });
    document.body.appendChild(frame.wrapper);
    buildPatternOverlay(frame);
    showPattern(frame);
    expect(visibleDots(frame.svg)).toHaveLength(1);
    /* what the instruction demos do between loops */
    clearStimuli(frame);
    hidePattern(frame);
    showPattern(frame);
    const dots = visibleDots(frame.svg);
    expect(dots).toHaveLength(1);
    expect(dots[0].getAttribute('class')).toBe('pattern-reference-dot');
    expect(dots[0].parentNode).toBe(frame.stimuliLayer);
    expect(attrs(dots[0])).toEqual(attrs(frame.centerDot));
    /* a detached (never-mounted) frame must not accumulate copies either */
    showPattern(frame);
    showPattern(frame);
    expect(frame.svg.querySelectorAll('.pattern-reference-dot')).toHaveLength(1);
  });

  it('showPattern/hidePattern swap the dot cleanly and never leave two or zero dots', () => {
    const frame = createGridFrame({ rotation_deg: 0, background_shade: 'white' });
    document.body.appendChild(frame.wrapper);
    buildPatternOverlay(frame);
    expect(visibleDots(frame.svg)).toHaveLength(1);
    showPattern(frame);
    showPattern(frame);
    expect(visibleDots(frame.svg)).toHaveLength(1);
    hidePattern(frame);
    expect(visibleDots(frame.svg)).toHaveLength(1);
    expect(visibleDots(frame.svg)[0]).toBe(frame.centerDot);
  });
});

/* ------------------------------------------------------------------ */
/* Before encoding: arrow cue, blank imagination period, rotation      */
/* ------------------------------------------------------------------ */

/** Sample the on-screen frame in every pre-encoding step of one real trial. */
async function runPreEncoding(cond, params) {
  document.body.innerHTML = '';
  const jsPsych = initJsPsych({});
  window.jsPsych = jsPsych;
  const timeline = CONDITIONS[cond].compose(params);
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
  const steps = new Map(); /* step -> { frames, arrowStyles, times } */
  let encStart = null;
  const prefix = /^(i_only|i_d|i_t|d_only|t_only)_/;
  for (let t = 0; t < 40000 && !done; t += STEP_MS) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    if (document.querySelector('.trial-start-hint')) {
      press('ArrowLeft');
      press('ArrowRight');
      release('ArrowLeft');
      release('ArrowRight');
    }
    const phase = (jsPsych.getCurrentTrial?.()?.data?.phase ?? '').replace(prefix, '');
    let step = phase;
    if (phase === 'encoding') {
      encStart ??= performance.now();
      /* rotation (500 ms) + stabilisation (1000 ms) before the first slot */
      if (performance.now() - encStart > 1400) break;
      step = 'encoding_pre';
    }
    if (!['trial_start', 'arrow_cue', 'imagination', 'encoding_pre'].includes(step)) continue;
    const frames = snapshotFrames();
    if (!steps.has(step)) steps.set(step, { frames: [], arrowStyles: [], count: 0 });
    const rec = steps.get(step);
    rec.count += 1;
    rec.frames.push(...frames);
    const arrow = document.querySelector('img.rotation-arrow-cue');
    if (arrow) rec.arrowStyles.push(arrow.getAttribute('style'));
  }
  jsPsych.abortExperiment?.('test over');
  await vi.advanceTimersByTimeAsync(50);
  void runP;
  return steps;
}

describe("bull's-eye before encoding (arrow cue, imagination period, rotation)", () => {
  beforeEach(async () => {
    _resetStorageForTests();
    await initStorage({ backend: 'memory' });
    vi.useFakeTimers({ toFake: FAKE });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['i_only', 'i_d', 'i_t', 'd_only'])(
    '%s: ring + dot stay visible, centred and upright through every pre-encoding step',
    async (cond) => {
      const params = pickTrial(cond);
      const angle = params.rotation_deg ?? params.display_rotation_deg;
      const steps = await runPreEncoding(cond, params);
      const expected =
        cond === 'd_only' ? ['encoding_pre'] : ['arrow_cue', 'imagination', 'encoding_pre'];
      for (const step of expected) {
        const rec = steps.get(step);
        expect(rec, `${cond}: step ${step} never sampled`).toBeDefined();
        expect(rec.frames.length, `${cond}/${step}: no frame on screen`).toBeGreaterThan(0);
        for (const f of rec.frames) {
          const where = `${cond}/${step}`;
          expect(f.ring.slice(0, 2), where).toEqual([MID, MID]);
          expect(f.dot.slice(0, 2), where).toEqual([MID, MID]);
          expect(f.dotVisible, `${where}: dot hidden`).toBe(true);
          expect(f.dotInRotor, where).toBe(false);
          expect(f.ringInRotor, where).toBe(false);
        }
      }
      /* The grid is upright until the encoding animation turns it to the trial angle. */
      if (cond !== 'd_only') {
        for (const step of ['arrow_cue', 'imagination'])
          for (const f of steps.get(step).frames) expect(f.rotation).toBe(0);
      }
      const last = steps.get('encoding_pre').frames.at(-1);
      expect(last.rotation).toBeCloseTo(angle, 3);
    },
    120000
  );

  it.each(['i_only', 'i_d', 'i_t'])(
    "%s: the blank imagination period lasts its configured time with the bull's-eye in view",
    async (cond) => {
      const steps = await runPreEncoding(cond, pickTrial(cond));
      const rec = steps.get('imagination');
      const ms = rec.count * STEP_MS;
      expect(Math.abs(ms - config.imagery.imagination_duration_ms)).toBeLessThanOrEqual(
        2 * STEP_MS
      );
      expect(rec.frames.length).toBeGreaterThanOrEqual(rec.count);
      expect(rec.frames.every((f) => f.dotVisible)).toBe(true);
      /* no arrow on screen during the blank period */
      expect(rec.arrowStyles).toEqual([]);
    },
    120000
  );

  it.each(['i_only', 'i_d', 'i_t'])(
    "%s: the arrow cue leaves a hole at its centre so the bull's-eye dot shows through",
    async (cond) => {
      const params = pickTrial(cond);
      const steps = await runPreEncoding(cond, params);
      const styles = steps.get('arrow_cue').arrowStyles;
      expect(styles.length).toBeGreaterThan(0);
      for (const st of styles) {
        expect(st).toContain('radial-gradient');
        expect(st).toContain('mask-image');
        expect(st).toContain(ARROW_CENTRE_HOLE_STYLE);
        /* the cue itself is unchanged: size, centring and rotation by the trial angle */
        expect(st).toContain(`rotate(${params.rotation_deg}deg)`);
        expect(st).toContain(`width: ${config.imagery.rotation_arrow_size_px}px`);
      }
      expect(steps.get('arrow_cue').frames.every((f) => f.dotVisible)).toBe(true);
    },
    120000
  );
});
