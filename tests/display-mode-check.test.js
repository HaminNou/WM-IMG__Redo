/**
 * @vitest-environment jsdom
 *
 * Display-mode check slide — Continue-button gate.
 *
 * The slide makes lock engagement an explicit gesture: the Continue
 * button is rendered disabled and only flips to enabled once the lock
 * has been engaged on `<html>` (`display-colour-locked` class). The
 * gate accepts two pathways to "engaged": clicking "Force light mode"
 * in this slide, or re-entering the slide via hidden-nav with the lock
 * already engaged from a previous visit.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { registerHiddenNavStep, trackHiddenNavNode } = vi.hoisted(() => ({
  registerHiddenNavStep: vi.fn(),
  trackHiddenNavNode: vi.fn((node) => node),
}));

vi.mock('../src/hidden-nav.js', () => ({
  registerHiddenNavStep,
  trackHiddenNavNode,
}));

import { displayModeCheckTrial } from '../src/calibration/display-mode.js';
import { DISPLAY_COLOUR_LOCK_CLASS } from '../src/visuals/display-colour-lock.js';

/**
 * Mount the slide stimulus + render the Continue button exactly as
 * jsPsych v8's html-button-response plugin would, then invoke the
 * trial's `on_load`. Returns the relevant DOM handles.
 */
function mountTrial(node) {
  document.body.innerHTML = '';
  const stimulusHost = document.createElement('div');
  stimulusHost.id = 'jspsych-html-button-response-stimulus';
  stimulusHost.innerHTML = node.stimulus;
  document.body.appendChild(stimulusHost);

  const buttonGroup = document.createElement('div');
  buttonGroup.id = 'jspsych-html-button-response-btngroup';
  node.choices.forEach((choice, idx) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = node.button_html(choice, idx);
    buttonGroup.appendChild(wrap.firstElementChild);
  });
  document.body.appendChild(buttonGroup);

  node.on_load();

  return {
    lockBtn: document.getElementById('display-colour-lock-btn'),
    lockStatus: document.getElementById('display-colour-lock-status'),
    gateHint: document.getElementById('display-mode-gate-hint'),
    continueBtn: document.querySelector('button.jspsych-btn[data-idx="0"]'),
  };
}

describe('displayModeCheckTrial — Continue gate (first visit, lock not yet engaged)', () => {
  beforeEach(() => {
    document.documentElement.className = '';
  });

  it('renders the Continue button disabled with aria-disabled on first load', () => {
    const node = displayModeCheckTrial();
    const { continueBtn } = mountTrial(node);
    expect(continueBtn).not.toBeNull();
    expect(continueBtn.disabled).toBe(true);
    expect(continueBtn.getAttribute('aria-disabled')).toBe('true');
    expect(continueBtn.style.cursor).toBe('not-allowed');
  });

  it('shows the gate hint explaining what unlocks Continue', () => {
    const node = displayModeCheckTrial();
    const { gateHint } = mountTrial(node);
    expect(gateHint).not.toBeNull();
    expect(gateHint.textContent.toLowerCase()).toContain('force light mode');
    expect(gateHint.style.display).not.toBe('none');
  });

  it('clicking "Force light mode" engages the lock and enables Continue', () => {
    const node = displayModeCheckTrial();
    const { lockBtn, lockStatus, gateHint, continueBtn } = mountTrial(node);
    expect(document.documentElement.classList.contains(DISPLAY_COLOUR_LOCK_CLASS)).toBe(false);

    lockBtn.click();

    expect(document.documentElement.classList.contains(DISPLAY_COLOUR_LOCK_CLASS)).toBe(true);
    expect(continueBtn.disabled).toBe(false);
    expect(continueBtn.getAttribute('aria-disabled')).toBe('false');
    expect(continueBtn.style.cursor).toBe('');
    expect(continueBtn.style.opacity).toBe('');
    expect(gateHint.style.display).toBe('none');
    expect(lockBtn.disabled).toBe(true);
    expect(lockBtn.textContent).toMatch(/forced/i);
    expect(lockStatus.style.visibility).toBe('visible');
  });

  it('on_finish stamps display_colour_locked=false when the participant has not engaged the lock', () => {
    const node = displayModeCheckTrial();
    mountTrial(node);
    const data = {};
    node.on_finish(data);
    expect(data.display_colour_locked).toBe(false);
  });

  it('on_finish stamps display_colour_locked=true after the lock was engaged in-slide', () => {
    const node = displayModeCheckTrial();
    const { lockBtn } = mountTrial(node);
    lockBtn.click();
    const data = {};
    node.on_finish(data);
    expect(data.display_colour_locked).toBe(true);
  });
});

describe('displayModeCheckTrial — Continue gate (re-entry, lock already engaged)', () => {
  beforeEach(() => {
    document.documentElement.className = '';
  });

  it('reflects the locked state and pre-enables Continue when re-entering the slide', () => {
    /* Simulate the participant having engaged the lock on a previous
     * visit to this slide (or any code path that engaged it). */
    document.documentElement.classList.add(DISPLAY_COLOUR_LOCK_CLASS);

    const node = displayModeCheckTrial();
    const { lockBtn, lockStatus, gateHint, continueBtn } = mountTrial(node);

    expect(continueBtn.disabled).toBe(false);
    expect(continueBtn.getAttribute('aria-disabled')).toBe('false');
    expect(gateHint.style.display).toBe('none');
    expect(lockBtn.disabled).toBe(true);
    expect(lockBtn.textContent).toMatch(/forced/i);
    expect(lockStatus.style.visibility).toBe('visible');
  });

  it('on_finish stamps display_colour_locked=true on re-entry', () => {
    document.documentElement.classList.add(DISPLAY_COLOUR_LOCK_CLASS);
    const node = displayModeCheckTrial();
    mountTrial(node);
    const data = {};
    node.on_finish(data);
    expect(data.display_colour_locked).toBe(true);
  });
});

describe('displayModeCheckTrial — slide registration', () => {
  it('registers itself under the display_mode_check hidden-nav step id', () => {
    registerHiddenNavStep.mockClear();
    displayModeCheckTrial();
    expect(registerHiddenNavStep).toHaveBeenCalledWith('display_mode_check', expect.any(Function));
  });

  it('stamps the display_mode_check phase on the trial data row', () => {
    const node = displayModeCheckTrial();
    expect(node.data).toEqual({ phase: 'display_mode_check' });
  });
});
