/**
 * Realistic raw rows: runs the REAL condition timelines (src/conditions/*) through
 * jsPsych on a fake clock and returns the rows exactly as the runtime writes them.
 * Used by the tidy-table tests. A test file that uses it must be jsdom and must
 * mock the audio modules (vi.mock is hoisted per test file), initialise the memory
 * storage and use fake timers: see tests/events-table.test.js for the boilerplate.
 */
import { vi } from 'vitest';
import { initJsPsych } from 'jspsych';
import { setSessionPRNG } from '../../src/prng.js';
import { resetSequencePools } from '../../src/scheduler/within-trial.js';
import { generateMainPlan } from '../../src/scheduler/main-plan.js';
import { dOnlyTrial } from '../../src/conditions/d_only.js';
import { tOnlyTrial } from '../../src/conditions/t_only.js';
import { iOnlyTrial } from '../../src/conditions/i_only.js';
import { iDTrial } from '../../src/conditions/i_d.js';
import { iTTrial } from '../../src/conditions/i_t.js';
import { generateMemoryBlock } from '../../src/scheduler/memory-block.js';
import { generateImageryBlock } from '../../src/scheduler/imagery-block.js';
import { generateDualBlock } from '../../src/scheduler/dual-block.js';

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

/**
 * Drive the timeline. `policy` decides when the simulated participant presses
 * a key. Returns the jsPsych data rows plus a log of what the loop observed.
 */
export async function runTrial(cond, params, policy = {}) {
  const {
    starRtMs = 700,
    probeRtMs = 600,
    starKey = 'ArrowRight',
    probeKey = 'ArrowRight',
    lateStarSkewMs = null,
    abortEncodingAtMs = null,
    spamKeys = false,
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
    n.data = { ...(n.data ?? {}), ...(params.trial_meta ?? {}), block_label: 'main_a' };
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
    if (spamKeys && (jsPsych.getCurrentTrial?.()?.data?.phase ?? '').endsWith('_encoding')) {
      press('ArrowLeft');
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

export const REAL_FAKE_TIMERS = FAKE;

/**
 * Rows of `perCondition` trials of every condition for one seed, with a
 * session_info row first and `seq` / `schema_version` / `build_id` stamped as the
 * storage layer does. `override(cond, params, i)` may change a trial's parameters
 * (e.g. force an angle) before it runs.
 */
export async function realSessionRows({ seed, perCondition = 3, shade = 'white', override } = {}) {
  setSessionPRNG(seed);
  resetSequencePools();
  const plan = generateMainPlan({});
  const want = {};
  plan.mainA.trialParams.forEach((p, i) => {
    (want[plan.mainA.schedule[i]] ??= []).push(p);
  });
  let seq = 0;
  const out = [{ phase: 'session_info', seq: ++seq, schema_version: '1.2.0', build_id: 'test' }];
  for (const cond of Object.keys(CONDITIONS)) {
    for (const [i, p0] of want[cond].slice(0, perCondition).entries()) {
      const params = override ? override(cond, { ...p0 }, i) : p0;
      const { rows } = await runTrial(cond, params);
      for (const r of rows)
        out.push({
          ...r,
          background_shade: shade,
          seq: ++seq,
          schema_version: '1.2.0',
          build_id: 'test',
        });
    }
  }
  return out;
}
