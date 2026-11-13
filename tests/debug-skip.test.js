// @vitest-environment jsdom
/**
 * Secret stage skip (N N): the real runner timeline (real instruction decks, demos, practice and main
 * trial nodes, rests, block intros) on a fake clock, with the real hidden-nav trial-start hook.
 * Every stage transition, the data rows, cleanup (listeners, audio gate, trial counter, trace
 * groups), the practice bypass, and that nothing is installed when debug is off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  setAudioStateLogger: () => {},
}));
vi.mock('../src/audio/tones.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, playToneByCell: vi.fn(() => Promise.resolve()) };
});

import { initJsPsych } from 'jspsych';
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';
import { _resetStorageForTests, initStorage } from '../src/storage.js';
import { REAL_FAKE_TIMERS } from './helpers/real-rows.js';
import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { generateMainBlockPair } from '../src/scheduler/main-blocks.js';
import { assembleInstructionsAndPractice } from '../src/instructions/index.js';
import { restNode } from '../src/conditions/rest.js';
import { emitAuxDataRow } from '../src/conditions/shared.js';
import {
  mainAIntroNode,
  mainATagReminderNode,
  mainBIntroNode,
  endOfTaskIntroNode,
} from '../src/runner-intros.js';
import { stopDisplayGuardNode } from '../src/calibration/display-guard.js';
import { getHiddenNavTrialStartHook, __resetHiddenNavForTests } from '../src/hidden-nav.js';
import { __isAudioMutedForTests } from '../src/audio/dsp.js';
import { _setTraceEnabled, _resetTraceState, _openGroupDepth } from '../src/debug/trace.js';
import {
  installSkip,
  uninstallSkip,
  isSkipInstalled,
  isSkipping,
  isPracticeBypassed,
  classifyStage,
  handleSkipKey,
  SKIP_WINDOW_MS,
} from '../src/debug/skip.js';

let jsPsych;
let added;
let removed;
let origAdd;
let origRemove;
let origDocAdd;
let origDocRemove;
let logSpy;
let errs;
const onErr = (e) => errs.push(e.message);

const liveListeners = () => added.filter((f) => !removed.includes(f)).length;

const phaseNow = () => jsPsych.getCurrentTrial()?.data?.phase;
const uidNow = () => {
  const d = jsPsych.getCurrentTrial()?.data;
  return typeof d === 'function' ? d().trial_uid : d?.trial_uid;
};
const key = (k, init = {}) =>
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  );
const up = (k) =>
  document.body.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
const space = () => {
  key(' ');
  up(' ');
};
const nn = () => {
  key('n');
  vi.advanceTimersByTime(100);
  key('n');
};
async function step(ms = 100) {
  for (let t = 0; t < ms; t += 10) await vi.advanceTimersByTimeAsync(10);
}
async function until(pred, maxMs = 20000) {
  for (let t = 0; t < maxMs; t += 10) {
    if (pred()) return true;
    await vi.advanceTimersByTimeAsync(10);
  }
  return pred();
}
const skipRows = () => jsPsych.data.get().filter({ phase: 'debug_skip' }).values();
const phasesRun = () =>
  jsPsych.data
    .get()
    .values()
    .map((r) => r.phase);

/** Real timeline: stub calibration, the instruction + practice arc, main A, rest, main B, the end. */
function buildTimeline() {
  setSessionPRNG('skip-test');
  resetSequencePools();
  const pair = generateMainBlockPair();
  const stub = (phase) => ({
    type: htmlKeyboardResponse,
    stimulus: phase,
    choices: [' '],
    data: { phase },
  });
  return [
    stub('screen_calibration'),
    ...assembleInstructionsAndPractice(),
    mainAIntroNode(),
    mainATagReminderNode(),
    ...pair.mainA.nodes,
    restNode({ session: { params: {} } }),
    mainBIntroNode(),
    ...pair.mainB.nodes,
    stopDisplayGuardNode(),
    endOfTaskIntroNode(),
    stub('questionnaire_intro'),
  ];
}

async function boot({ debug = true } = {}) {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: REAL_FAKE_TIMERS });
  document.body.innerHTML = '';
  __resetHiddenNavForTests();
  _resetTraceState();
  _setTraceEnabled(debug);
  jsPsych = initJsPsych({ on_trial_start: getHiddenNavTrialStartHook() });
  window.jsPsych = jsPsych;
  const installed = installSkip({ enabled: debug, emitRow: emitAuxDataRow });
  const timeline = buildTimeline();
  jsPsych.run(timeline);
  await until(() => phaseNow() === 'screen_calibration', 2000);
  return installed;
}

beforeEach(() => {
  errs = [];
  window.addEventListener('error', onErr);
  added = [];
  removed = [];
  origAdd = window.addEventListener.bind(window);
  origRemove = window.removeEventListener.bind(window);
  origDocAdd = document.addEventListener.bind(document);
  origDocRemove = document.removeEventListener.bind(document);
  window.addEventListener = (t, fn, o) => {
    if (t === 'keydown') added.push(fn);
    return origAdd(t, fn, o);
  };
  window.removeEventListener = (t, fn, o) => {
    if (t === 'keydown') removed.push(fn);
    return origRemove(t, fn, o);
  };
  document.addEventListener = (t, fn, o) => {
    if (t === 'keydown') added.push(fn);
    return origDocAdd(t, fn, o);
  };
  document.removeEventListener = (t, fn, o) => {
    if (t === 'keydown') removed.push(fn);
    return origDocRemove(t, fn, o);
  };
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'group').mockImplementation(() => {});
  vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
  vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
  vi.spyOn(console, 'table').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  window.removeEventListener('error', onErr);
  try {
    jsPsych?.pluginAPI?.cancelAllKeyboardResponses?.();
    jsPsych?.pluginAPI?.clearAllTimeouts?.();
  } catch {
    /* ignore */
  }
  window.addEventListener = origAdd;
  window.removeEventListener = origRemove;
  document.addEventListener = origDocAdd;
  document.removeEventListener = origDocRemove;
  uninstallSkip();
  __resetHiddenNavForTests();
  _setTraceEnabled(false);
  _resetTraceState();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.jsPsych;
  document.body.innerHTML = '';
});

describe('classifyStage (pure)', () => {
  it('maps node data to stages', () => {
    const c = (d, m) => classifyStage(d, m);
    expect(c({ phase: 'instructions_overview' }).stage).toBe(1);
    expect(c({ phase: 'demo_t_only' }).stage).toBe(1);
    expect(c({ phase: 'practice_readiness' }).stage).toBe(1);
    expect(c({ phase: 'd_only_encoding', trial_uid: 'practice-d_only-01' }).stage).toBe(2);
    expect(c({ phase: 'practice_feedback' }).stage).toBe(2);
    expect(c({ phase: 'attention_check' }).stage).toBe(2);
    expect(c({ phase: 'practice_buttons_notice' }).stage).toBe(2);
    expect(c({ phase: 'main_a_intro' }).stage).toBe(3);
    expect(c({ phase: 'i_d_probe', trial_uid: 'main_a-004-i_d' }).stage).toBe(3);
    expect(c({ phase: 'rest' }, { mainBlock: 'main_a' }).stage).toBe(3);
    expect(c({ phase: 'rest', block_label: 'main_b' }, { mainBlock: 'main_b' }).stage).toBe(4);
    expect(c({ phase: 'rest_resume_gate' }, { mainBlock: 'main_b' }).stage).toBe(4);
    expect(c({ phase: 'main_b_intro' }).stage).toBe(4);
    expect(c({ phase: 't_only_trial_start', trial_uid: 'main_b-077-t_only' }).stage).toBe(4);
    expect(c({ phase: 'end_of_task_intro' }).kind).toBe('end');
    for (const phase of [
      'consent',
      'demographics',
      'screen_calibration',
      'timing_probe',
      'tone_audibility_and_comfort',
      'speaker_volume_instruction',
      'hand_placement',
    ]) {
      expect(c({ phase }).kind).toBe('setup');
    }
  });
});

describe('debug off', () => {
  it('installs nothing: no listener, no hook, N N does nothing', async () => {
    const installed = await boot({ debug: false });
    expect(installed).toBe(false);
    expect(isSkipInstalled()).toBe(false);
    space();
    await until(() => phaseNow() === 'instructions_overview', 2000);
    const phase = phaseNow();
    nn();
    await step(300);
    expect(phaseNow()).toBe(phase);
    expect(skipRows()).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('N N key handling', () => {
  it('needs two non-repeat presses inside the window, ignores modifiers and inputs', async () => {
    await boot();
    space();
    await until(() => phaseNow() === 'instructions_overview', 2000);
    key('n');
    await step(SKIP_WINDOW_MS + 50);
    key('n');
    await step(100);
    expect(phaseNow()).toBe('instructions_overview'); /* too slow: a new first press */
    key('n', { repeat: true });
    key('N', { ctrlKey: true });
    key('N', { metaKey: true });
    key('N', { altKey: true });
    await step(100);
    expect(phaseNow()).toBe('instructions_overview');
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
    await step(100);
    expect(phaseNow()).toBe('instructions_overview');
    expect(skipRows()).toHaveLength(0);
    expect(typeof handleSkipKey).toBe('function');
  });

  it('calibration cannot be skipped: a console note, no row, the screen stays', async () => {
    await boot();
    expect(phaseNow()).toBe('screen_calibration');
    nn();
    await step(300);
    expect(phaseNow()).toBe('screen_calibration');
    expect(skipRows()).toHaveLength(0);
    expect(
      logSpy.mock.calls.some((c) => String(c[0]).includes('calibration cannot be skipped'))
    ).toBe(true);
  });
});

describe('the four stage transitions on the real timeline', () => {
  it('instructions -> first practice gate -> main_a_intro -> main_b_intro -> end_of_task_intro', async () => {
    await boot();
    const baseline = liveListeners();

    /* ---- stage 1: first instruction page (overview) -> Task 1 practice gate */
    space();
    await until(() => phaseNow() === 'instructions_overview', 2000);
    nn();
    expect(await until(() => /_trial_start$/.test(phaseNow() ?? ''), 5000)).toBe(true);
    expect(phaseNow()).toBe('d_only_trial_start');
    expect(uidNow()).toBe('practice-d_only-01');
    expect(skipRows()).toHaveLength(1);
    expect(skipRows()[0]).toMatchObject({
      from_stage: 'instructions',
      to_stage: 'practice_gate',
      debug_node_phase: 'instructions_overview',
    });
    expect(isSkipping()).toBe(false);
    expect(__isAudioMutedForTests()).toBe(false);
    /* every instruction deck / demo / readiness screen was skipped, none was shown */
    const ran1 = phasesRun();
    expect(ran1).toContain('instructions_memory_d_only');
    expect(ran1).toContain('demo_d_only');
    expect(ran1).toContain('practice_readiness');
    expect(ran1).not.toContain('d_only_encoding');

    /* ---- Task 1 practice: pass the gate and press N N inside the practice trial */
    key('ArrowLeft');
    key('ArrowRight');
    expect(await until(() => phaseNow() === 'd_only_encoding', 5000)).toBe(true);
    await step(500);
    expect(isPracticeBypassed()).toBe(false);
    nn();
    expect(await until(() => phaseNow() === 'main_a_intro', 20000)).toBe(true);
    expect(skipRows()).toHaveLength(2);
    expect(skipRows()[1]).toMatchObject({ from_stage: 'practice', to_stage: 'main_a_intro' });
    expect(skipRows()[1].trial_uid).toBe('practice-d_only-01');
    expect(isPracticeBypassed()).toBe(false); /* released on arrival */
    expect(phasesRun()).not.toContain('practice_disqualification');
    expect(phasesRun()).toContain('practice_feedback'); /* its row exists, bypassed */
    expect(__isAudioMutedForTests()).toBe(false);
    expect(_openGroupDepth()).toBe(0);
    expect(liveListeners()).toBeLessThanOrEqual(baseline);
    expect(document.getElementById('overall-trial-counter')).toBeNull();

    /* ---- Block 1 intro and tag reminder by hand, then Main A trial 1 gate */
    space();
    await until(() => phaseNow() === 'main_a_tag_reminder', 2000);
    await step(2000);
    space();
    expect(await until(() => /_trial_start$/.test(phaseNow() ?? ''), 3000)).toBe(true);
    expect(uidNow()).toMatch(/^main_a-001-/);
    expect(document.getElementById('overall-trial-counter')?.textContent).toBe('1/120');
    key('ArrowLeft');
    key('ArrowRight');
    await until(() => /_encoding$/.test(phaseNow() ?? ''), 5000);
    await step(300);
    nn();
    expect(await until(() => phaseNow() === 'main_b_intro', 60000)).toBe(true);
    expect(skipRows()[2]).toMatchObject({ from_stage: 'main_a', to_stage: 'main_b_intro' });
    expect(skipRows()[2].trial_uid).toMatch(/^main_a-001-/);
    expect(__isAudioMutedForTests()).toBe(false);
    expect(_openGroupDepth()).toBe(0);
    expect(liveListeners()).toBeLessThanOrEqual(baseline);

    /* ---- Main B: the numbering continues at 61/120 for the trials that DO run */
    space();
    expect(await until(() => /_trial_start$/.test(phaseNow() ?? ''), 3000)).toBe(true);
    expect(uidNow()).toMatch(/^main_b-061-/);
    expect(document.getElementById('overall-trial-counter')?.textContent).toBe('61/120');
    nn();
    expect(await until(() => phaseNow() === 'end_of_task_intro', 60000)).toBe(true);
    expect(skipRows()[3]).toMatchObject({ from_stage: 'main_b', to_stage: 'end_of_task_intro' });
    expect(skipRows()).toHaveLength(4);
    expect(document.getElementById('overall-trial-counter')).toBeNull();
    expect(phasesRun()).toContain('display_guard_stop'); /* the guard was still stopped */
    expect(__isAudioMutedForTests()).toBe(false);
    expect(_openGroupDepth()).toBe(0);
    expect(liveListeners()).toBeLessThanOrEqual(baseline);

    /* nothing left to skip */
    nn();
    await step(300);
    expect(phaseNow()).toBe('end_of_task_intro');
    expect(skipRows()).toHaveLength(4);

    /* no stale key listener threw while the session went on, and the session continues */
    expect(errs).toEqual([]);
    /* the session continues normally after the skip */
    space();
    expect(await until(() => phaseNow() === 'questionnaire_intro', 3000)).toBe(true);
  }, 240000);

  it('N N on a practice feedback / attention-check screen also lands on main_a_intro', async () => {
    await boot();
    space();
    await until(() => phaseNow() === 'instructions_overview', 2000);
    space();
    await until(() => phaseNow() === 'practice_readiness', 3000);
    expect(classifyStage({ phase: phaseNow() }).stage).toBe(1);
    nn();
    await until(() => phaseNow() === 'd_only_trial_start', 5000);
    nn(); /* on the practice gate: stage 2 */
    expect(await until(() => phaseNow() === 'main_a_intro', 20000)).toBe(true);
    expect(skipRows().map((r) => r.from_stage)).toEqual(['instructions', 'practice']);
    expect(phasesRun()).not.toContain('practice_disqualification');
  }, 120000);

  it('the practice criterion is bypassed: 0% feedback row, no retry loop, no disqualification', async () => {
    await boot();
    space();
    await until(() => phaseNow() === 'instructions_overview', 2000);
    nn();
    await until(() => phaseNow() === 'd_only_trial_start', 5000);
    nn();
    expect(await until(() => phaseNow() === 'main_a_intro', 20000)).toBe(true);
    const fb = jsPsych.data.get().filter({ phase: 'practice_feedback' }).values();
    expect(fb).toHaveLength(1);
    expect(fb[0].iteration_passed).toBe(false); /* would re-loop and then disqualify */
    expect(phasesRun().filter((p) => p === 'practice_iteration_start')).toHaveLength(1);
    expect(phasesRun()).not.toContain('practice_disqualification');
    expect(isPracticeBypassed()).toBe(false);
  }, 120000);

  it('a double N on the setup of Main A rests: in-block rest is stage 3, Block 2 rest is stage 4', () => {
    expect(
      classifyStage({ phase: 'rest', block_label: 'main_a' }, { mainBlock: 'main_a' }).stage
    ).toBe(3);
    expect(
      classifyStage({ phase: 'rest', block_label: 'main_b' }, { mainBlock: 'main_b' }).stage
    ).toBe(4);
    expect(
      classifyStage({ phase: 'rest', block_label: 'inter_block' }, { mainBlock: 'main_a' }).stage
    ).toBe(3);
  });
});
