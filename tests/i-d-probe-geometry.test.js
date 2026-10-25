// @vitest-environment jsdom
/**
 * Rendered geometry of the rotated frame, checked on the actual SVG.
 *
 * History: in I+D the recognition probe was once drawn on an unrotated frame
 * while the encoded dots sat at the rotated cell centres, so a target probe
 * was displaced from its own encoding dot by up to ~37 mm. The data rows
 * (`probe_x_mm`) were computed from the same helper as the drawing, so they
 * could not reveal it. These tests read the DOM instead.
 *
 * The expected position never goes through `grid.js`: it is the centre of
 * the cell's own <rect> in the frame (data-cell-index), pushed through the
 * rotor's `rotate(a cx cy)` attribute with the SVG-spec matrix
 * (x' = cx + (x-cx)cos a - (y-cy)sin a, y' = cy + (x-cx)sin a + (y-cy)cos a;
 * positive a is clockwise on screen because y points down).
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

import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { iDTrial } from '../src/conditions/i_d.js';
import { _resetStorageForTests, initStorage } from '../src/storage.js';
import { createGridFrame } from '../src/visuals/frame.js';
import { addDot } from '../src/visuals/dot.js';
import { addStar } from '../src/visuals/star.js';
import { config } from '../src/config.js';
import { buildPatternOverlay, showPattern } from '../src/visuals/pattern.js';
import { isOnPattern } from '../src/grid.js';

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
const TOL_MM = 1e-6;

/** Parse `rotate(a cx cy)`. */
function parseRotor(rotor) {
  const m = /^rotate\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)$/.exec(
    rotor.getAttribute('transform')
  );
  if (!m) throw new Error(`unexpected rotor transform: ${rotor.getAttribute('transform')}`);
  return { a: Number(m[1]), cx: Number(m[2]), cy: Number(m[3]) };
}

/** Where the cell's own <rect> centre lands on screen, from the DOM alone. */
function renderedCellCentre(svg, cell) {
  const rect = svg.querySelector(`.grid-cells rect[data-cell-index="${cell}"]`);
  const x = Number(rect.getAttribute('x')) + Number(rect.getAttribute('width')) / 2;
  const y = Number(rect.getAttribute('y')) + Number(rect.getAttribute('height')) / 2;
  const { a, cx, cy } = parseRotor(svg.querySelector('.grid-rotor'));
  const t = (a * Math.PI) / 180;
  return {
    x: cx + (x - cx) * Math.cos(t) - (y - cy) * Math.sin(t),
    y: cy + (x - cx) * Math.sin(t) + (y - cy) * Math.cos(t),
  };
}

const ROTATIONS = [-90, -80, -60, -30, -5, 0, 5, 30, 60, 80, 90];
const CELLS = Array.from({ length: 25 }, (_, i) => i).filter((i) => i !== 12);

describe('primitives land on the rotated cell, read from the DOM', () => {
  it.each(ROTATIONS)('dot and star at rotation %i deg', (rot) => {
    const frame = createGridFrame({ rotation_deg: rot, background_shade: 'white' });
    document.body.appendChild(frame.wrapper);
    const R = config.imagery.star_size_mm / 2;
    for (const cell of CELLS) {
      const want = renderedCellCentre(frame.svg, cell);
      const dot = addDot(frame, cell);
      expect(Number(dot.getAttribute('cx'))).toBeCloseTo(want.x, 6);
      expect(Number(dot.getAttribute('cy'))).toBeCloseTo(want.y, 6);
      /* Star: first vertex points up, so it is (cx, cy - R). */
      const star = addStar(frame, cell);
      const [vx, vy] = star.getAttribute('points').split(' ')[0].split(',').map(Number);
      expect(vx).toBeCloseTo(want.x, 6);
      expect(vy + R).toBeCloseTo(want.y, 6);
    }
    frame.wrapper.remove();
  });

  it('is clockwise on screen: the top-left cell goes to the top-right at +90 deg', () => {
    const frame = createGridFrame({ rotation_deg: 90, background_shade: 'white' });
    document.body.appendChild(frame.wrapper);
    const mid = 25;
    const dot = addDot(frame, 0); /* top-left, (-20, -20) from the centre */
    expect(Number(dot.getAttribute('cx')) - mid).toBeCloseTo(20, 6);
    expect(Number(dot.getAttribute('cy')) - mid).toBeCloseTo(-20, 6);
    frame.wrapper.remove();
  });

  it('indexes cells row-major with no mirroring: 0 top-left, 4 top-right, 20 bottom-left, 24 bottom-right', () => {
    const frame = createGridFrame({ rotation_deg: 0, background_shade: 'white' });
    const centre = (i) => {
      const r = frame.svg.querySelector(`.grid-cells rect[data-cell-index="${i}"]`);
      return [
        Number(r.getAttribute('x')) + Number(r.getAttribute('width')) / 2,
        Number(r.getAttribute('y')) + Number(r.getAttribute('height')) / 2,
      ];
    };
    expect(centre(0)).toEqual([5, 5]);
    expect(centre(4)).toEqual([45, 5]);
    expect(centre(20)).toEqual([5, 45]);
    expect(centre(24)).toEqual([45, 45]);
    expect(centre(12)).toEqual([25, 25]);
    for (let i = 0; i < 25; i++) {
      expect(centre(i)).toEqual([(i % 5) * 10 + 5, Math.floor(i / 5) * 10 + 5]);
    }
  });

  it.each([0, 37, -90, 90])(
    'a star on an on-pattern cell sits inside a gray pattern square, off-pattern outside, at %i deg',
    (rot) => {
      const frame = createGridFrame({ rotation_deg: rot, background_shade: 'white' });
      document.body.appendChild(frame.wrapper);
      buildPatternOverlay(frame);
      showPattern(frame);
      const grayCells = new Set(
        [...frame.svg.querySelectorAll('.grid-pattern rect')].map((r) =>
          Number(r.getAttribute('data-cell-index'))
        )
      );
      for (const cell of CELLS) {
        /* The pattern layer is inside the rotor, so a pattern square covers the
         * same rotated cell the star is drawn on: same rect, same transform. */
        const prect = frame.svg.querySelector(`.grid-pattern rect[data-cell-index="${cell}"]`);
        const crect = frame.svg.querySelector(`.grid-cells rect[data-cell-index="${cell}"]`);
        if (prect) {
          for (const a of ['x', 'y', 'width', 'height'])
            expect(prect.getAttribute(a)).toBe(crect.getAttribute(a));
        }
        expect(grayCells.has(cell)).toBe(isOnPattern(cell));
      }
      expect(grayCells.has(12)).toBe(true);
      expect(frame.svg.querySelector('.grid-pattern').closest('.grid-rotor')).not.toBeNull();
      frame.wrapper.remove();
    }
  );

  it('keeps the centre cell and fixation fixed under rotation', () => {
    const frame = createGridFrame({ rotation_deg: 73, background_shade: 'white' });
    const c = renderedCellCentre(frame.svg, 12);
    expect(c.x).toBeCloseTo(25, 6);
    expect(c.y).toBeCloseTo(25, 6);
    expect(frame.svg.querySelector('.grid-bullseye-dot').closest('.grid-rotor')).toBeNull();
    expect(frame.fixationEl.closest('.grid-rotor')).toBeNull();
    expect(frame.stimuliLayer.closest('.grid-rotor')).toBeNull();
  });
});

/** Run one real I+D trial on a fake clock and record what is drawn. */
async function runIDTrial(params) {
  document.body.innerHTML = '';
  const jsPsych = initJsPsych({});
  window.jsPsych = jsPsych;
  const timeline = iDTrial(params);
  timeline.forEach((n) => {
    n.data = { ...(n.data ?? {}), block_label: 'main_a' };
  });
  let done = false;
  const runP = jsPsych.run(timeline).then(() => {
    done = true;
  });
  const press = (k) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const release = (k) =>
    window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));

  const seen = new WeakSet();
  const encodingDots = []; /* { cell, x, y, angle, want } */
  const probeDots = [];
  const stars = [];
  for (let t = 0; t < 120000 && !done; t += STEP_MS) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    if (document.querySelector('.trial-start-hint')) {
      press('ArrowLeft');
      press('ArrowRight');
      release('ArrowLeft');
      release('ArrowRight');
    }
    for (const el of document.querySelectorAll(
      '.grid-stimuli circle.dot, .grid-stimuli polygon.star'
    )) {
      if (seen.has(el)) continue;
      seen.add(el);
      const svg = el.closest('svg');
      const mountId = el.closest('[id]:not(svg)')?.id ?? '';
      const cell = Number(el.getAttribute('data-cell-index'));
      const want = renderedCellCentre(svg, cell);
      const angle = parseRotor(svg.querySelector('.grid-rotor')).a;
      if (el.tagName.toLowerCase() === 'polygon') {
        const [vx, vy] = el.getAttribute('points').split(' ')[0].split(',').map(Number);
        stars.push({ cell, x: vx, y: vy + config.imagery.star_size_mm / 2, angle, want });
        continue;
      }
      const rec = {
        cell,
        x: Number(el.getAttribute('cx')),
        y: Number(el.getAttribute('cy')),
        angle,
        want,
      };
      if (mountId === 'i-d-mount') encodingDots.push(rec);
      else if (mountId === 'i-d-probe-mount') probeDots.push(rec);
    }
  }
  await runP;
  return { encodingDots, probeDots, stars };
}

function pickTrials(block) {
  const targets = [-90, -80, -60, -30, -5, 5, 30, 60, 80, 90];
  const picked = new Map();
  for (const want of targets) {
    const t = [...block]
      .filter((p) => !picked.has(p))
      .sort((a, b) => Math.abs(a.rotation_deg - want) - Math.abs(b.rotation_deg - want))[0];
    picked.set(t, true);
  }
  return [...picked.keys()];
}

describe('real I+D trials: probe dot vs encoded dot, from the DOM', () => {
  it('covers the whole rotation range', () => {
    const angles = trials.map((p) => p.rotation_deg);
    expect(Math.min(...angles)).toBeLessThanOrEqual(-85);
    expect(Math.max(...angles)).toBeGreaterThanOrEqual(85);
    expect(angles.some((a) => Math.abs(a) <= 8)).toBe(true);
  });

  beforeEach(async () => {
    _resetStorageForTests();
    await initStorage({ backend: 'memory' });
    vi.useFakeTimers({ toFake: FAKE });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /* Several seeded blocks, so the nearest available angle to each target is
   * within a few degrees (angles are unique integers within one block). */
  const pool = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((k) => {
    setSessionPRNG(`i-d-geometry-${k}`);
    resetSequencePools();
    return generateDualBlock({ trialType: 'i_d', blockSize: 24 });
  });
  const trials = pickTrials(pool);

  it.each(trials.map((p) => [p.rotation_deg, p]))(
    'rotation %i deg: probes, dots and stars sit on the rotated cells',
    async (rot, params) => {
      const { encodingDots, probeDots, stars } = await runIDTrial(params);
      const eps = TOL_MM;

      expect(encodingDots).toHaveLength(params.memory_items.length);
      expect(probeDots).toHaveLength(params.probes.length);
      expect(stars).toHaveLength(params.stars.length);

      /* Every drawn stimulus is in a frame rotated by the trial angle and sits
       * on the rotated cell rectangle. */
      for (const d of [...encodingDots, ...probeDots, ...stars]) {
        expect(d.angle).toBe(rot);
        expect(Math.abs(d.x - d.want.x)).toBeLessThan(eps);
        expect(Math.abs(d.y - d.want.y)).toBeLessThan(eps);
      }

      /* A target probe coincides with the dot encoded in that cell. */
      const encByCell = new Map(encodingDots.map((d) => [d.cell, d]));
      let nTargets = 0;
      params.probes.forEach((probe, i) => {
        const drawn = probeDots[i];
        expect(drawn.cell).toBe(probe.cell);
        if (probe.is_target) {
          nTargets += 1;
          const enc = encByCell.get(probe.cell);
          expect(enc).toBeDefined();
          expect(Math.hypot(drawn.x - enc.x, drawn.y - enc.y)).toBeLessThan(eps);
        } else {
          /* A foil is never drawn on top of an encoded dot. */
          expect(encByCell.has(probe.cell)).toBe(false);
        }
      });
      expect(nTargets).toBeGreaterThan(0);
    },
    120000
  );
});
