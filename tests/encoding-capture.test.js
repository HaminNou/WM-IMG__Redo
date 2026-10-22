// @vitest-environment jsdom
/**
 * One full trial of each condition, run through the real jsPsych timeline on
 * a fake clock. Asserts that every response window produces exactly one data
 * row, written before the next phase starts, including the slot-6 star case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initJsPsych } from 'jspsych';

vi.mock('../src/audio/context.js', () => ({
  getAudioContext: () => ({ currentTime: performance.now() / 1000, state: 'running' }),
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
import { screenPositionMm } from '../src/grid.js';
import * as frameModule from '../src/visuals/frame.js';

const CONDITIONS = {
  d_only: {
    compose: dOnlyTrial,
    gen: (n) => generateMemoryBlock({ trialType: 'd_only', blockSize: n }),
    stars: 0,
    probes: 3,
  },
  t_only: {
    compose: tOnlyTrial,
    gen: (n) => generateMemoryBlock({ trialType: 't_only', blockSize: n }),
    stars: 0,
    probes: 3,
  },
  i_only: {
    compose: iOnlyTrial,
    gen: (n) => generateImageryBlock({ blockSize: n }),
    stars: 3,
    probes: 0,
  },
  i_d: {
    compose: iDTrial,
    gen: (n) => generateDualBlock({ trialType: 'i_d', blockSize: n }),
    stars: 3,
    probes: 3,
  },
  i_t: {
    compose: iTTrial,
    gen: (n) => generateDualBlock({ trialType: 'i_t', blockSize: n }),
    stars: 3,
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
const STEP_MS = 10;

/** Pick a trial whose sequence ends in an S-slot (the slot-6 star case) or in an M-slot. */
function pickTrial(cond, lastKind) {
  setSessionPRNG(`harness-${cond}`);
  resetSequencePools();
  const block = CONDITIONS[cond].gen(24);
  const t = block.find((p) => p.sequence[p.sequence.length - 1] === lastKind);
  if (!t) throw new Error(`no ${cond} trial ending in ${lastKind}`);
  return t;
}

/**
 * Drive the timeline. `policy` decides when the simulated participant presses
 * a key. Returns the jsPsych data rows plus a log of what the loop observed.
 */
async function runTrial(cond, params, policy = {}) {
  const {
    starRtMs = 700,
    probeRtMs = 600,
    starKey = 'ArrowRight',
    probeKey = 'ArrowRight',
    lateStarSkewMs = null,
    abortEncodingAtMs = null,
  } = policy;
  const added = [];
  const removed = [];
  const origAdd = window.addEventListener.bind(window);
  const origRemove = window.removeEventListener.bind(window);
  window.addEventListener = (type, fn, opts) => {
    if (type === 'keydown') added.push(fn);
    return origAdd(type, fn, opts);
  };
  window.removeEventListener = (type, fn, opts) => {
    if (type === 'keydown') removed.push(fn);
    return origRemove(type, fn, opts);
  };

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
  /* A key handled late: the handler sees a clock `skewMs` ahead of the star's
   * own timers, as when the main thread is busy past the end of the window
   * while the star is still on screen. */
  const pressSkewed = (key, skewMs) => {
    const realNow = performance.now.bind(performance);
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + skewMs);
    try {
      press(key);
    } finally {
      spy.mockRestore();
    }
  };
  const release = (key) =>
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));

  const encStart = new Map();
  const emitPhases = [];
  let lastStarCount = 0;
  const seenStarAt = new Map();
  const probeSeenAt = new Map();
  for (let t = 0; t < 120000 && !done; t += STEP_MS) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    const now = performance.now();
    const nStars = jsPsych.data
      .get()
      .values()
      .filter((r) => (r.phase ?? '').endsWith('_star')).length;
    if (nStars > lastStarCount) {
      for (let k = lastStarCount; k < nStars; k++)
        emitPhases.push(jsPsych.getCurrentTrial?.()?.data?.phase ?? null);
      lastStarCount = nStars;
    }
    if (document.querySelector('.trial-start-hint')) {
      press('ArrowLeft');
      press('ArrowRight');
      release('ArrowLeft');
      release('ArrowRight');
    }
    const star = document.querySelector('polygon.star');
    if (star) {
      if (!seenStarAt.has(star)) seenStarAt.set(star, { t: now, done: false });
      const s = seenStarAt.get(star);
      const rt = lateStarSkewMs === null ? starRtMs : 2950;
      if (!s.done && now - s.t >= rt) {
        s.done = true;
        if (lateStarSkewMs === null) press(starKey);
        else pressSkewed(starKey, lateStarSkewMs);
      }
    }
    const trial = jsPsych.getCurrentTrial?.();
    const phase = trial?.data?.phase ?? '';
    if (abortEncodingAtMs !== null && phase.endsWith('_encoding')) {
      if (!encStart.has(trial)) encStart.set(trial, now);
      if (now - encStart.get(trial) >= abortEncodingAtMs) {
        encStart.set(trial, Infinity);
        jsPsych.finishTrial();
      }
    }
    if (phase.endsWith('_probe')) {
      if (!probeSeenAt.has(trial)) probeSeenAt.set(trial, { t: now, done: false });
      const p = probeSeenAt.get(trial);
      if (!p.done && now - p.t >= probeRtMs) {
        p.done = true;
        press(probeKey);
      }
    }
  }
  await runP;
  window.addEventListener = origAdd;
  window.removeEventListener = origRemove;
  const rows = jsPsych.data.get().values();
  const unbalanced = added.filter((fn) => !removed.includes(fn)).length;
  return { rows, unbalancedKeydownListeners: unbalanced, jsPsych, emitPhases };
}

const phaseOf = (r) => r.phase ?? '';
const starRows = (rows) => rows.filter((r) => phaseOf(r).endsWith('_star'));
const probeRows = (rows) => rows.filter((r) => phaseOf(r).endsWith('_probe'));

beforeEach(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: FAKE });
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each(Object.keys(CONDITIONS))('%s: one trial, all rows captured', (cond) => {
  describe.each([['S'], ['M']])('sequence ends in %s-slot', (lastKind) => {
    it('writes the expected rows, before the next phase, with no leaked listeners', async () => {
      const params = pickTrial(cond, lastKind);
      const spec = CONDITIONS[cond];
      const { rows, unbalancedKeydownListeners, emitPhases } = await runTrial(cond, params);

      const stars = starRows(rows);
      expect(stars).toHaveLength(spec.stars);
      expect(probeRows(rows)).toHaveLength(spec.probes);
      expect(rows.filter((r) => phaseOf(r).endsWith('_encoding'))).toHaveLength(1);

      if (spec.stars) {
        const expectedSlots = params.stars.map((s) => s.slot_index_in_seq).sort();
        expect(stars.map((r) => r.slot_index_in_seq).sort()).toEqual(expectedSlots);
        for (const r of stars) {
          expect(r.responded).toBe(true);
          expect(r.response_rt_ms).toBeGreaterThan(0);
          expect(r.response_rt_ms).toBeLessThanOrEqual(3000);
        }
        /* Each row is written while the encoding node is still on screen. */
        expect(emitPhases).toHaveLength(spec.stars);
        for (const ph of emitPhases) expect(ph).toBe(`${cond}_encoding`);
      }
      expect(unbalancedKeydownListeners).toBe(0);
      expect(document.querySelectorAll('polygon.star').length).toBe(0);
      /* Nothing from the encoding schedule may still be pending after the trial. */
      await vi.advanceTimersByTimeAsync(10000);
      expect(starRows(rows)).toHaveLength(spec.stars);
    }, 60000);
  });

  if (['i_only', 'i_d', 'i_t'].includes(cond)) {
    it('rejects a star key handled after the 3000 ms window and counts it as late', async () => {
      const params = pickTrial(cond, 'S');
      const { rows } = await runTrial(cond, params, { lateStarSkewMs: 100 });
      const stars = starRows(rows);
      expect(stars).toHaveLength(3);
      for (const r of stars) {
        expect(r.displayed).toBe(true);
        expect(r.responded).toBe(false);
        expect(r.response_rt_ms).toBeNull();
        expect(r.late_keypresses).toBe(1);
        expect(r.early_keypresses).toBe(0);
        expect(r.extra_keypresses).toBe(0);
      }
      const enc = rows.find((r) => phaseOf(r).endsWith('_encoding'));
      expect(enc.keys_outside_window).toBe(0);
    }, 60000);

    it('counts a key pressed after the window has closed as outside the window, not as a response', async () => {
      const params = pickTrial(cond, 'S');
      const { rows } = await runTrial(cond, params, { starRtMs: 3050 });
      const stars = starRows(rows);
      expect(stars).toHaveLength(3);
      for (const r of stars) {
        expect(r.responded).toBe(false);
        expect(r.response_rt_ms).toBeNull();
        expect(r.late_keypresses).toBe(0);
      }
    }, 60000);
  }
});

describe.each(Object.keys(CONDITIONS))('%s: timing and cleanup', (cond) => {
  it('encoding lasts 16500 ms and slot onsets follow the plan', async () => {
    const params = pickTrial(cond, 'S');
    const { rows } = await runTrial(cond, params);
    const enc = rows.find((r) => phaseOf(r).endsWith('_encoding'));
    const next = rows.find((r) => /_(retention|iti)$/.test(phaseOf(r)));
    const nextOnset = next.retention_onset_ts_ms ?? next.iti_onset_ts_ms;
    expect(nextOnset - enc.encoding_onset_ts_ms).toBeGreaterThanOrEqual(16500);
    expect(nextOnset - enc.encoding_onset_ts_ms).toBeLessThan(16500 + 40);
    let t = 1500;
    [...params.sequence].forEach((kind, i) => {
      const got = enc.slot_onsets_ts_ms[i] - enc.encoding_onset_ts_ms;
      expect(Math.abs(got - t)).toBeLessThanOrEqual(35); /* two frames */
      t += kind === 'M' ? 1500 : 3500;
    });
  }, 60000);

  if (['i_only', 'i_d', 'i_t'].includes(cond)) {
    it('closing the node early still writes all star rows, flagged, and leaves nothing running', async () => {
      const params = pickTrial(cond, 'S');
      const { rows } = await runTrial(cond, params, { abortEncodingAtMs: 9000 });
      const stars = starRows(rows);
      expect(stars).toHaveLength(3);
      expect(stars.some((r) => r.truncated)).toBe(true);
      expect(vi.getTimerCount()).toBeLessThan(5);
    }, 60000);
  }
});

describe.each(['d_only', 't_only', 'i_d', 'i_t'])('%s: probe response window', (cond) => {
  it('rejects a response after 3000 ms and counts it as late', async () => {
    const params = pickTrial(cond, 'M');
    const { rows } = await runTrial(cond, params, { probeRtMs: 3050 });
    const probes = probeRows(rows);
    expect(probes).toHaveLength(3);
    for (const r of probes) {
      expect(r.responded).toBe(false);
      expect(r.rt).toBeNull();
      expect(r.late_keypresses).toBe(1);
    }
  }, 60000);

  it('keeps the first key only and records a valid RT', async () => {
    const params = pickTrial(cond, 'M');
    const { rows } = await runTrial(cond, params, { probeRtMs: 600 });
    for (const r of probeRows(rows)) {
      expect(r.responded).toBe(true);
      expect(r.rt).toBeGreaterThan(550);
      expect(r.rt).toBeLessThan(650);
      expect(r.extra_keypresses).toBe(0);
    }
  }, 60000);
});

describe('rotation fields on the rows', () => {
  it('d_only records the display rotation on the encoding row, the trial spec and every probe', async () => {
    const params = pickTrial('d_only', 'M');
    expect(params.display_rotation_deg).not.toBe(0);
    const { rows } = await runTrial('d_only', params);
    const enc = rows.find((r) => phaseOf(r) === 'd_only_encoding');
    expect(enc.display_rotation_deg).toBe(params.display_rotation_deg);
    expect(enc.trial_spec.display_rotation_deg).toBe(params.display_rotation_deg);
    expect(enc.trial_spec.rotation_deg).toBeNull();
    const probes = probeRows(rows);
    expect(probes).toHaveLength(3);
    for (const r of probes) {
      expect(r.probe_frame_rotation_deg).toBe(params.display_rotation_deg);
      const pos = screenPositionMm(r.probed_cell, params.display_rotation_deg);
      expect(r.probe_x_mm).toBeCloseTo(pos.x_mm, 2);
      expect(r.probe_y_mm).toBeCloseTo(pos.y_mm, 2);
    }
  }, 60000);

  it('d_only draws the grid rotated by the display rotation during encoding', async () => {
    const params = pickTrial('d_only', 'M');
    const spy = vi.spyOn(frameModule, 'createGridFrame');
    await runTrial('d_only', params);
    const rotations = spy.mock.calls.map(([opts]) => opts.rotation_deg);
    spy.mockRestore();
    /* Gate and ITI are upright; encoding, retention and the three probes use the display angle. */
    expect(rotations).toEqual([0, ...Array(5).fill(params.display_rotation_deg), 0]);
  }, 60000);

  it.each(['i_only', 'i_d', 'i_t'])(
    '%s records the trial rotation as the star frame rotation and null display rotation',
    async (cond) => {
      const params = pickTrial(cond, 'S');
      const { rows } = await runTrial(cond, params);
      const enc = rows.find((r) => phaseOf(r).endsWith('_encoding'));
      expect(enc.trial_spec.rotation_deg).toBe(params.rotation_deg);
      expect(enc.trial_spec.display_rotation_deg).toBeNull();
      for (const r of starRows(rows)) expect(r.star_frame_rotation_deg).toBe(params.rotation_deg);
    },
    60000
  );

  it('t_only has neither rotation', async () => {
    const params = pickTrial('t_only', 'M');
    const { rows } = await runTrial('t_only', params);
    const enc = rows.find((r) => phaseOf(r) === 't_only_encoding');
    expect(enc.trial_spec.rotation_deg).toBeNull();
    expect(enc.trial_spec.display_rotation_deg).toBeNull();
  }, 60000);
});
