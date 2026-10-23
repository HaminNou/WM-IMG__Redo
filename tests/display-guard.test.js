// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ESCAPE_AFTER_MS,
  _resetGuardForTests,
  consumeGuardFlags,
  requireFullscreenFromNow,
  startDisplayGuard,
  stopDisplayGuard,
  stopDisplayGuardNode,
} from '../src/calibration/display-guard.js';
import { _resetStorageForTests, getAllTrialRows, initStorage } from '../src/storage.js';

const PX_PER_MM = 4.5;

function setDpr(value) {
  Object.defineProperty(window, 'devicePixelRatio', { value, configurable: true });
}

function setFullscreen(element) {
  Object.defineProperty(document, 'fullscreenElement', { value: element, configurable: true });
}

beforeEach(async () => {
  vi.useFakeTimers();
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.jsPsych = { pauseExperiment: vi.fn(), resumeExperiment: vi.fn() };
  setDpr(1);
  setFullscreen(null);
  document.documentElement.style.setProperty('--mm', `${PX_PER_MM}px`);
  _resetGuardForTests();
});

afterEach(() => {
  _resetGuardForTests();
  vi.useRealTimers();
  delete window.jsPsych;
});

describe('display guard', () => {
  it('pauses with an overlay when the zoom changes and resumes when it is restored', () => {
    startDisplayGuard({ pxPerMm: PX_PER_MM });
    setDpr(1.5);
    vi.advanceTimersByTime(1100);
    expect(window.jsPsych.pauseExperiment).toHaveBeenCalledTimes(1);
    expect(document.getElementById('display-guard-overlay')).not.toBeNull();

    setDpr(1);
    vi.advanceTimersByTime(1100);
    expect(window.jsPsych.resumeExperiment).toHaveBeenCalledTimes(1);
    expect(document.getElementById('display-guard-overlay')).toBeNull();
  });

  it('ignores a devicePixelRatio change inside the tolerance', () => {
    startDisplayGuard({ pxPerMm: PX_PER_MM });
    setDpr(1.005);
    vi.advanceTimersByTime(1100);
    expect(window.jsPsych.pauseExperiment).not.toHaveBeenCalled();
  });

  it('does not require fullscreen until asked to', () => {
    startDisplayGuard({ pxPerMm: PX_PER_MM });
    vi.advanceTimersByTime(1100);
    expect(window.jsPsych.pauseExperiment).not.toHaveBeenCalled();

    requireFullscreenFromNow();
    expect(window.jsPsych.pauseExperiment).toHaveBeenCalledTimes(1);
    expect(document.getElementById('dg-fs')).not.toBeNull();

    setFullscreen(document.documentElement);
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(window.jsPsych.resumeExperiment).toHaveBeenCalledTimes(1);
    expect(document.getElementById('display-guard-overlay')).toBeNull();
  });

  it('counts a fullscreen exit', () => {
    setFullscreen(document.documentElement);
    startDisplayGuard({ pxPerMm: PX_PER_MM });
    requireFullscreenFromNow();
    setFullscreen(null);
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(window.jsPsych.pauseExperiment).toHaveBeenCalledTimes(1);
  });

  it('restores --mm when it is overwritten', () => {
    startDisplayGuard({ pxPerMm: PX_PER_MM });
    document.documentElement.style.setProperty('--mm', '9px');
    vi.advanceTimersByTime(1100);
    expect(document.documentElement.style.getPropertyValue('--mm')).toBe(`${PX_PER_MM}px`);
    expect(consumeGuardFlags().guard_flags.split(',')).toContain('mm_reset');
  });

  it('hands accumulated events to the next trial once', () => {
    startDisplayGuard({ pxPerMm: PX_PER_MM });
    consumeGuardFlags();
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
    const flags = consumeGuardFlags();
    expect(flags.guard_flags.split(',')).toEqual(expect.arrayContaining(['blur', 'focus']));
    expect(flags.guard_n).toBe(2);
    expect(consumeGuardFlags()).toEqual({});
  });

  it('writes display_guard_event rows to storage', async () => {
    startDisplayGuard({ pxPerMm: PX_PER_MM });
    window.dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(0);
    const rows = await getAllTrialRows();
    const kinds = rows.filter((r) => r.phase === 'display_guard_event').map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['guard_start', 'blur']));
  });
});

describe('display guard escape route and release', () => {
  function pauseOnZoom(opts = {}) {
    startDisplayGuard({ pxPerMm: PX_PER_MM, ...opts });
    setDpr(1.5);
    vi.advanceTimersByTime(1100);
  }

  it('offers no escape button at first, and a button after the delay', () => {
    pauseOnZoom({ onEscape: vi.fn() });
    expect(document.getElementById('dg-escape')).toBeNull();
    vi.advanceTimersByTime(ESCAPE_AFTER_MS);
    expect(document.getElementById('dg-escape')).not.toBeNull();
  });

  it('keeps the escape button through the periodic re-render of the overlay', () => {
    pauseOnZoom({ onEscape: vi.fn() });
    vi.advanceTimersByTime(ESCAPE_AFTER_MS + 5000);
    expect(document.getElementById('dg-escape')).not.toBeNull();
  });

  it('the button ends the session through the handler, removes the overlay and resumes jsPsych', () => {
    const onEscape = vi.fn();
    pauseOnZoom({ onEscape });
    vi.advanceTimersByTime(ESCAPE_AFTER_MS);
    document.getElementById('dg-escape').click();
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(document.getElementById('display-guard-overlay')).toBeNull();
    expect(window.jsPsych.resumeExperiment).toHaveBeenCalledTimes(1);
  });

  it('records the escape without marking the next trial as disturbed', async () => {
    pauseOnZoom({ onEscape: vi.fn() });
    consumeGuardFlags();
    vi.advanceTimersByTime(ESCAPE_AFTER_MS);
    document.getElementById('dg-escape').click();
    expect(consumeGuardFlags()).toEqual({});
    await vi.advanceTimersByTimeAsync(0);
    const rows = await getAllTrialRows();
    const escape = rows.find((r) => r.phase === 'display_guard_event' && r.kind === 'escape');
    expect(escape.exit_reason).toBe('display_guard_escape');
  });

  it('the overlay disappears by itself when the condition is restored before the delay', () => {
    pauseOnZoom({ onEscape: vi.fn() });
    setDpr(1);
    vi.advanceTimersByTime(1100);
    expect(document.getElementById('display-guard-overlay')).toBeNull();
    vi.advanceTimersByTime(ESCAPE_AFTER_MS * 2);
    expect(document.getElementById('dg-escape')).toBeNull();
  });

  it('stopDisplayGuard removes a showing overlay, resumes, and ignores later zoom and fullscreen changes', () => {
    pauseOnZoom();
    expect(document.getElementById('display-guard-overlay')).not.toBeNull();
    stopDisplayGuard();
    expect(document.getElementById('display-guard-overlay')).toBeNull();
    expect(window.jsPsych.resumeExperiment).toHaveBeenCalledTimes(1);

    window.jsPsych.pauseExperiment.mockClear();
    setDpr(2);
    setFullscreen(null);
    document.dispatchEvent(new Event('fullscreenchange'));
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(ESCAPE_AFTER_MS);
    expect(window.jsPsych.pauseExperiment).not.toHaveBeenCalled();
    expect(document.getElementById('display-guard-overlay')).toBeNull();
    expect(consumeGuardFlags().guard_flags ?? '').not.toContain('blur');
  });

  it('stopDisplayGuard drops the fullscreen requirement', () => {
    setFullscreen(document.documentElement);
    startDisplayGuard({ pxPerMm: PX_PER_MM });
    requireFullscreenFromNow();
    stopDisplayGuard();
    setFullscreen(null);
    document.dispatchEvent(new Event('fullscreenchange'));
    vi.advanceTimersByTime(2000);
    expect(window.jsPsych.pauseExperiment).not.toHaveBeenCalled();
  });

  it('stopDisplayGuard is safe before the guard started and when repeated', () => {
    expect(() => stopDisplayGuard()).not.toThrow();
    startDisplayGuard({ pxPerMm: PX_PER_MM });
    stopDisplayGuard();
    expect(() => stopDisplayGuard()).not.toThrow();
  });

  it('stopping leaves the next finished trial unflagged', () => {
    startDisplayGuard({ pxPerMm: PX_PER_MM });
    consumeGuardFlags();
    stopDisplayGuard();
    expect(consumeGuardFlags()).toEqual({});
  });

  it('the timeline node stops the guard and tags its row', () => {
    pauseOnZoom();
    const node = stopDisplayGuardNode();
    expect(node.data.phase).toBe('display_guard_stop');
    expect(node.func()).toEqual({ guard_stopped: true });
    expect(document.getElementById('display-guard-overlay')).toBeNull();
  });
});
