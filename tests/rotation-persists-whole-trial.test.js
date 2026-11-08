// @vitest-environment jsdom
/**
 * Regression guard for the "grid snapped back to upright during the delay" bug.
 *
 * For every imagery trial type (I-only, I+D, I+T), both page shades and angles
 * -90, -37, 0, 37, 90, a REAL trial is run (real nodes, jsdom, fake clock) and
 * the rotor of EVERY grid frame on screen is sampled every 10 ms. Unlike a
 * per-phase check, this one is phase-agnostic: from the moment the rotation has
 * settled until the last frame before the ITI, every sampled rotor must be at the
 * trial angle, so a new or mis-built node in the delay (whatever its phase name)
 * that re-creates the frame upright is caught. Dot probes must additionally be
 * drawn at the rotated cell centre (computed here from the SVG rotation formula,
 * not through the helpers under test) and, for targets, on exactly the screen
 * position the dot had at encoding.
 *
 * Angle 0 cannot show a reset, so the 0 cases only pin the frame-angle records;
 * the non-zero angles are what protect against the regression.
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
import { generateImageryBlock } from '../src/scheduler/imagery-block.js';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { iOnlyTrial } from '../src/conditions/i_only.js';
import { iDTrial } from '../src/conditions/i_d.js';
import { iTTrial } from '../src/conditions/i_t.js';
import { _resetStorageForTests, initStorage } from '../src/storage.js';
import { config } from '../src/config.js';
import { gridSizeMm, cellCentreMm } from '../src/grid.js';

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
const STEP_MS = 10;
const ANGLES = [-90, -37, 0, 37, 90];
const SHADES = ['white', 'gray'];

const rotorAngles = () =>
  [...document.querySelectorAll('.grid-rotor')].map((r) => {
    const m = /rotate\(\s*(-?[\d.eE+-]+)/.exec(r.getAttribute('transform') ?? '');
    return m ? Number(m[1]) : 0;
  });
const dotCentres = () =>
  [...document.querySelectorAll('.grid-stimuli circle.dot')].map((c) => ({
    cell: Number(c.getAttribute('data-cell-index')),
    cx: Number(c.getAttribute('cx')),
    cy: Number(c.getAttribute('cy')),
  }));

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
  const samples = [];
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
    if (/_encoding$/.test(phase) && !encStart.has(trial)) encStart.set(trial, performance.now());
    samples.push({
      phase,
      sinceEncoding: /_encoding$/.test(phase) ? performance.now() - encStart.get(trial) : null,
      rotor: rotorAngles(),
      dots: dotCentres(),
    });
  }
  await runP;
  return { samples, rows: jsPsych.data.get().values() };
}

describe('the rotated hidden grid stays at the trial angle from rotation to the last probe', () => {
  beforeEach(async () => {
    _resetStorageForTests();
    await initStorage({ backend: 'memory' });
    vi.useFakeTimers({ toFake: FAKE });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const cases = [];
  for (const c of Object.keys(COND))
    for (const a of ANGLES) for (const s of SHADES) cases.push([c, a, s]);

  it.each(cases)(
    '%s at %i degrees, %s page: no frame in the delay or probes is upright',
    async (cond, angle, shade) => {
      setSessionPRNG(`rot-persist-${cond}-${shade}`);
      resetSequencePools();
      const base = COND[cond].gen()[0];
      const params = { ...base, rotation_deg: angle, background_shade: shade };
      const { samples, rows } = await runTrial(cond, params);

      const settleMs = config.imagery.rotation_animation_ms + 60;
      const from = samples.findIndex(
        (s) => s.sinceEncoding !== null && s.sinceEncoding >= settleMs
      );
      expect(from, 'encoding never settled').toBeGreaterThan(-1);
      const lastBeforeIti = samples
        .map((s) => s.phase)
        .lastIndexOf(
          samples
            .map((s) => s.phase)
            .reverse()
            .find((p) => p && !/_iti$/.test(p))
        );
      const window_ = samples.slice(from, lastBeforeIti + 1).filter((s) => s.rotor.length);
      expect(window_.length).toBeGreaterThan(100);
      for (const s of window_) {
        expect(s.rotor, `${s.phase}: rotor left the trial angle`).toEqual([angle]);
      }

      if (cond === 'i_only') return; /* no delay, no probes */

      /* The delay (retention) really is part of that window. */
      const ret = window_.filter((s) => /_retention$/.test(s.phase));
      expect(ret.length, 'retention frames sampled').toBeGreaterThan(100);
      const probes = window_.filter((s) => /_probe$/.test(s.phase));
      expect(probes.length).toBeGreaterThan(100);

      /* Rows record the angle the frame was actually drawn at. */
      for (const r of rows.filter((x) => /_(retention|probe)$/.test(x.phase ?? ''))) {
        expect(r.frame_rotation_deg, `${r.phase} frame_rotation_deg`).toBe(angle);
        if (/_probe$/.test(r.phase)) expect(r.probe_frame_rotation_deg).toBe(angle);
      }

      if (cond !== 'i_d') return;

      /* Dot probes are drawn in the rotated coordinate system: SVG rotate(a) about the
       * grid centre applied to the upright cell centre (grid.js cellCentreMm); a target is
       * drawn on exactly the screen position the dot had at encoding. */
      const mid = gridSizeMm() / 2;
      const rad = (angle * Math.PI) / 180;
      const expected = (cell) => {
        const c = cellCentreMm(cell);
        const dx = c.x_mm - mid;
        const dy = c.y_mm - mid;
        return [
          mid + dx * Math.cos(rad) - dy * Math.sin(rad),
          mid + dx * Math.sin(rad) + dy * Math.cos(rad),
        ];
      };
      const encDots = new Map();
      for (const s of samples.filter((x) => /_encoding$/.test(x.phase)))
        for (const d of s.dots) encDots.set(d.cell, [d.cx, d.cy]);
      const probeDots = new Map();
      for (const s of probes) for (const d of s.dots) probeDots.set(d.cell, [d.cx, d.cy]);
      expect(probeDots.size, 'every probe drew a dot').toBe(params.probes.length);
      for (const [cell, [cx, cy]] of probeDots) {
        const [ex, ey] = expected(cell);
        expect(cx, `probe cell ${cell} x`).toBeCloseTo(ex, 6);
        expect(cy, `probe cell ${cell} y`).toBeCloseTo(ey, 6);
      }
      for (const p of params.probes.filter((q) => q.is_target)) {
        expect(encDots.has(p.cell), `target cell ${p.cell} was encoded`).toBe(true);
        expect(probeDots.get(p.cell)).toEqual(encDots.get(p.cell));
      }
    },
    180000
  );
});
