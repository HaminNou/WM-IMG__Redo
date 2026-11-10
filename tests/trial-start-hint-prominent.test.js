/**
 * @vitest-environment jsdom
 *
 * The first gate after each task's demonstration (the first practice trial of
 * each of the five tasks) shows its instruction as a centred box with a coloured
 * border instead of the small pill at the bottom. Later gates keep the pill.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  trialStartGateNode,
  isFirstPracticeTrial,
  PROMINENT_HINT_TEXT,
  STANDARD_HINT_TEXT,
  HINT_FLASH_AFTER_MS,
  HINT_FLASH_PERIOD_MS,
} from '../src/conditions/shared.js';
import { dOnlyTrial } from '../src/conditions/d_only.js';
import { tOnlyTrial } from '../src/conditions/t_only.js';
import { iOnlyTrial } from '../src/conditions/i_only.js';
import { iDTrial } from '../src/conditions/i_d.js';
import { iTTrial } from '../src/conditions/i_t.js';
import { singleTypePractice } from '../src/scheduler/practice.js';
import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';

const COMPOSERS = {
  d_only: dOnlyTrial,
  t_only: tOnlyTrial,
  i_only: iOnlyTrial,
  i_d: iDTrial,
  i_t: iTTrial,
};

beforeEach(() => {
  document.body.innerHTML = '';
  const liveTrial = {};
  Object.defineProperty(window, 'jsPsych', {
    value: { getCurrentTrial: () => liveTrial, finishTrial: () => {} },
    configurable: true,
    writable: true,
  });
  setSessionPRNG('prominent-gate-seed');
  resetSequencePools();
});
afterEach(() => vi.useRealTimers());

function mountGate(opts) {
  const node = trialStartGateNode({
    trial_index_in_block: 0,
    phase: 'd_only_trial_start',
    ...opts,
  });
  const div = document.createElement('div');
  div.id = node.stimulus.match(/id="([^"]+)"/)[1];
  document.body.appendChild(div);
  node.on_load();
  return node;
}

describe('prominent trial-start gate', () => {
  it('is a centred, coloured-border box with the practice wording', () => {
    const node = mountGate({ prominent: true });
    const hint = document.querySelector('.trial-start-hint');
    expect(hint.classList.contains('trial-start-hint--prominent')).toBe(true);
    expect(hint.textContent).toBe(PROMINENT_HINT_TEXT);
    expect(PROMINENT_HINT_TEXT).toContain('Left');
    expect(PROMINENT_HINT_TEXT).toContain('Right');
    expect(PROMINENT_HINT_TEXT).toContain('at the same time');
    expect(PROMINENT_HINT_TEXT).toContain('practice trials');
    const style = hint.getAttribute('style');
    expect(style).toMatch(/top: 50%/);
    expect(style).toMatch(/left: 50%/);
    expect(style).toMatch(/translate\(-50%, -50%\)/);
    expect(style).toMatch(/border: 5px solid #772139/);
    expect(style).not.toMatch(/bottom:/);
    expect(style).toMatch(/opacity: 1;/);
    node.on_finish();
    expect(document.querySelectorAll('.trial-start-hint').length).toBe(0);
  });

  it('the default gate is unchanged: small pill at the bottom, standard wording', () => {
    mountGate({});
    const hint = document.querySelector('.trial-start-hint');
    expect(hint.classList.contains('trial-start-hint--prominent')).toBe(false);
    expect(hint.textContent).toBe(STANDARD_HINT_TEXT);
    expect(hint.getAttribute('style')).toMatch(/bottom: 30px/);
    expect(hint.getAttribute('style')).toMatch(/opacity: 0\.75;/);
  });

  it('records whether the gate was the prominent one', () => {
    expect(
      trialStartGateNode({ trial_index_in_block: 0, prominent: true }).data.gate_prominent
    ).toBe(true);
    expect(trialStartGateNode({ trial_index_in_block: 0 }).data.gate_prominent).toBe(false);
  });

  it('still flashes after 10 s and goes away when the gate ends', () => {
    vi.useFakeTimers();
    const node = mountGate({ prominent: true });
    const hint = document.querySelector('.trial-start-hint');
    vi.advanceTimersByTime(HINT_FLASH_AFTER_MS + HINT_FLASH_PERIOD_MS);
    expect(hint.style.opacity).toBe('0.35');
    vi.advanceTimersByTime(HINT_FLASH_PERIOD_MS);
    expect(hint.style.opacity).toBe('1');
    node.on_finish();
    expect(document.querySelectorAll('.trial-start-hint').length).toBe(0);
  });

  it('pops in with the Web Animations API unless reduced motion is requested', () => {
    const calls = [];
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (...args) {
      calls.push(args);
      return {};
    };
    try {
      window.matchMedia = () => ({ matches: false });
      mountGate({ prominent: true });
      expect(calls.length).toBe(1);
      expect(JSON.stringify(calls[0][0])).toContain('translate(-50%, -50%)');
      document.body.innerHTML = '';
      calls.length = 0;
      window.matchMedia = () => ({ matches: true });
      mountGate({ prominent: true });
      expect(calls.length).toBe(0);
      document.body.innerHTML = '';
      mountGate({});
      expect(calls.length).toBe(0);
    } finally {
      HTMLElement.prototype.animate = original;
      delete window.matchMedia;
    }
  });
});

describe('which gates are prominent (all five tasks, consistently)', () => {
  it('isFirstPracticeTrial is true only for practice position 0', () => {
    expect(isFirstPracticeTrial({ trial_meta: { is_practice: true, block_position: 0 } })).toBe(
      true
    );
    expect(isFirstPracticeTrial({ trial_meta: { is_practice: true, block_position: 1 } })).toBe(
      false
    );
    expect(isFirstPracticeTrial({ trial_meta: { is_practice: false, block_position: 0 } })).toBe(
      false
    );
    expect(isFirstPracticeTrial({})).toBe(false);
    expect(isFirstPracticeTrial(undefined)).toBe(false);
  });

  it.each(Object.keys(COMPOSERS))(
    '%s: the first practice trial has the prominent gate, the second does not',
    (type) => {
      const { trialParams } = singleTypePractice({ trialType: type, trialsPerType: 2 });
      expect(trialParams.length).toBe(2);
      const gates = trialParams.map((params) => {
        const nodes = COMPOSERS[type](params);
        const list = Array.isArray(nodes) ? nodes : (nodes.timeline ?? [nodes]);
        return list.find(
          (n) => typeof n?.data?.phase === 'string' && /trial_start$/.test(n.data.phase)
        );
      });
      expect(gates[0]?.data.gate_prominent).toBe(true);
      expect(gates[1]?.data.gate_prominent).toBe(false);
    }
  );
});
