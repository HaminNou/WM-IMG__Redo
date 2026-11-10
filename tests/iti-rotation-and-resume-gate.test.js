// @vitest-environment jsdom
/**
 * Regression guards:
 *  - the ITI / post-trial frame keeps the trial's rotation (it used to snap upright);
 *  - the post-rest resume gate needs BOTH arrows DOWN together (like trialStartGateNode),
 *    clears on keyup and preventDefaults;
 *  - the trial-start gate's on_finish also tears down the hint (timer + element).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { generateImageryBlock } from '../src/scheduler/imagery-block.js';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { generateMemoryBlock } from '../src/scheduler/memory-block.js';
import { dOnlyTrial } from '../src/conditions/d_only.js';
import { tOnlyTrial } from '../src/conditions/t_only.js';
import { iOnlyTrial } from '../src/conditions/i_only.js';
import { iDTrial } from '../src/conditions/i_d.js';
import { iTTrial } from '../src/conditions/i_t.js';
import { resumeAfterRestGateNode } from '../src/conditions/rest.js';
import { itiNode, trialStartGateNode } from '../src/conditions/shared.js';

const COND = {
  d_only: [dOnlyTrial, () => generateMemoryBlock({ trialType: 'd_only', blockSize: 24 }), 'rot'],
  t_only: [tOnlyTrial, () => generateMemoryBlock({ trialType: 't_only', blockSize: 24 }), 'norot'],
  i_only: [iOnlyTrial, () => generateImageryBlock({ blockSize: 24 }), 'rot'],
  i_d: [iDTrial, () => generateDualBlock({ trialType: 'i_d', blockSize: 24 }), 'rot'],
  i_t: [iTTrial, () => generateDualBlock({ trialType: 'i_t', blockSize: 24 }), 'rot'],
};

describe('ITI frame keeps the trial angle', () => {
  it.each(Object.keys(COND))('%s: ITI row records the trial angle', (cond) => {
    setSessionPRNG(`iti-rot-${cond}`);
    resetSequencePools();
    const [compose, gen, kind] = COND[cond];
    const base = gen()[0];
    const params = { ...base };
    if (kind === 'rot') {
      params.rotation_deg = 37;
      params.display_rotation_deg = 37;
    } else {
      params.rotation_deg = 0;
      params.display_rotation_deg = 0;
    }
    const iti = compose(params).find((n) => /_iti$/.test(n.data?.phase ?? ''));
    expect(iti, 'ITI node').toBeTruthy();
    expect(iti.data.frame_rotation_deg).toBe(kind === 'rot' ? 37 : 0);
  });

  it('itiNode paints the grid rotor at the requested angle', () => {
    document.body.innerHTML = '';
    const n = itiNode({ phase: 'x_iti', rotation_deg: -37, fixation: '' });
    document.body.innerHTML = n.stimulus;
    n.on_load();
    const t = document.querySelector('.grid-rotor').getAttribute('transform');
    expect(Number(/rotate\(\s*(-?[\d.]+)/.exec(t)[1])).toBe(-37);
  });
});

describe('resumeAfterRestGateNode requires both arrows down together', () => {
  let liveTrial;
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    liveTrial = {};
    window.jsPsych = { finishTrial: vi.fn(), getCurrentTrial: () => liveTrial };
    const n = resumeAfterRestGateNode({});
    document.body.innerHTML = n.stimulus;
    n.on_load();
  });
  afterEach(() => {
    liveTrial._resume_gate_cleanup?.();
    vi.useRealTimers();
    delete window.jsPsych;
  });
  const key = (type, k) => {
    const e = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return e;
  };

  it('Left now and Right seconds later does not pass', () => {
    key('keydown', 'ArrowLeft');
    vi.advanceTimersByTime(2000);
    key('keydown', 'ArrowRight');
    expect(window.jsPsych.finishTrial).not.toHaveBeenCalled();
  });

  it('releasing a key clears it', () => {
    key('keydown', 'ArrowLeft');
    key('keyup', 'ArrowLeft');
    key('keydown', 'ArrowRight');
    expect(window.jsPsych.finishTrial).not.toHaveBeenCalled();
  });

  it('both within the window passes once, and arrows are preventDefaulted', () => {
    const a = key('keydown', 'ArrowLeft');
    vi.advanceTimersByTime(100);
    const b = key('keydown', 'ArrowRight');
    expect(a.defaultPrevented && b.defaultPrevented).toBe(true);
    expect(window.jsPsych.finishTrial).toHaveBeenCalledTimes(1);
  });
});

describe('trialStartGateNode on_finish tears down the hint', () => {
  it('removes the hint element and stops its timers on the bypass path', () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    });
    const trial = {};
    window.jsPsych = { getCurrentTrial: () => trial, finishTrial: vi.fn() };
    const n = trialStartGateNode({ phase: 'g', background_shade: 'white', trialType: 'd_only' });
    document.body.innerHTML = n.stimulus;
    n.on_load?.();
    expect(typeof trial._gate_hint_cleanup).toBe('function');
    const spy = vi.spyOn(trial, '_gate_hint_cleanup');
    n.on_finish();
    expect(spy).toHaveBeenCalled();
    expect(document.querySelector('.trial-start-hint')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    delete window.jsPsych;
  });
});
