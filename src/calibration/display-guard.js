/**
 * Display guard: keeps the screen calibration valid after it is set.
 *
 * Watches for
 *   - browser zoom / display scaling change (devicePixelRatio drifts from the
 *     value at calibration),
 *   - loss of fullscreen,
 *   - window resize,
 *   - tab hidden and window blur,
 *   - `--mm` being overwritten.
 *
 * Zoom change and fullscreen loss show a blocking overlay and call
 * `jsPsych.pauseExperiment()`, so the next trial does not start until the
 * participant fixes it. jsPsych cannot pause inside a running trial, so every
 * event is also accumulated and written onto the next finished trial
 * (`guard_flags`, `guard_n`) through `consumeGuardFlags()`; analysis drops
 * flagged trials according to the preregistered rule.
 *
 * The overlay cannot trap the participant: after `ESCAPE_AFTER_MS` it offers a
 * button that ends the session through the handler given to
 * `startDisplayGuard`, and the guard is switched off with `stopDisplayGuard()`
 * before the questionnaires, the upload and every exit screen.
 *
 * Every event is also appended as a `display_guard_event` row.
 */
import callFunction from '@jspsych/plugin-call-function';
import { appendTrialRow, recordWriteFailure } from '../storage.js';
import { rowClock } from '../clock.js';
import { readDisplaySnapshot } from './device-probe.js';

const DPR_TOL = 0.01;
const RESIZE_DEBOUNCE_MS = 150;
const POLL_MS = 1000;
export const ESCAPE_AFTER_MS = 30000;
/* Events that do not mark the next trial as affected. */
const NOT_TRIAL_FLAGS = new Set(['guard_stop', 'escape']);

let started = false;
let base = null;
let overlay = null;
let paused = false;
let pending = [];
let hiddenSince = null;
let requireFullscreen = false;
let resizeTimer = null;
let teardown = null;
let escapeHandler = null;
let escapeTimer = null;
let escapeAvailable = false;
let lastReason = '';

function log(kind, extra = {}) {
  const ev = {
    phase: 'display_guard_event',
    kind,
    ts: performance.now(),
    iso: new Date().toISOString(),
    dpr: window.devicePixelRatio,
    inner_w: window.innerWidth,
    inner_h: window.innerHeight,
    is_fullscreen: !!document.fullscreenElement,
    ...rowClock(),
    ...extra,
  };
  if (!NOT_TRIAL_FLAGS.has(kind)) pending.push(kind);
  appendTrialRow(ev).catch((err) => recordWriteFailure(err));
}

/** Flags since the last call; for `on_trial_finish`. */
export function consumeGuardFlags() {
  if (pending.length === 0) return {};
  const out = { guard_flags: Array.from(new Set(pending)).join(','), guard_n: pending.length };
  pending = [];
  return out;
}

function zoomChanged() {
  return base && Math.abs(window.devicePixelRatio / base.dpr - 1) > DPR_TOL;
}

function mmDrifted() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mm'));
  return base && !(Math.abs(v - base.pxPerMm) < 1e-6);
}

function showOverlay(reason) {
  lastReason = reason;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'display-guard-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;background:#d3d3d3;color:#000;' +
      'display:flex;align-items:center;justify-content:center;text-align:center;' +
      'font-family:inherit;padding:2rem;';
    document.body.appendChild(overlay);
    window.addEventListener('keydown', blockKeys, true);
    window.addEventListener('keyup', blockKeys, true);
    escapeAvailable = false;
    escapeTimer = setTimeout(() => {
      escapeAvailable = true;
      if (overlay) showOverlay(lastReason);
    }, ESCAPE_AFTER_MS);
  }
  const zoom = reason.includes('zoom');
  const fs = reason.includes('fullscreen');
  overlay.innerHTML = `
    <div style="max-width:34rem">
      <h2>The task is paused</h2>
      ${
        zoom
          ? `<p>The page zoom or display scaling has changed, so the stimuli would
        no longer be the right size. Press <kbd>Ctrl</kbd>/<kbd>&#8984;</kbd> + <kbd>0</kbd>
        to reset zoom to 100%, and do not change the zoom again. The task continues
        by itself once the zoom is restored.</p>`
          : ''
      }
      ${
        fs
          ? `<p>The task must run in fullscreen.</p>
        <button id="dg-fs" class="jspsych-btn">Return to fullscreen</button>`
          : ''
      }
      <p id="dg-status" style="opacity:.7"></p>
      ${
        escapeAvailable
          ? `<p>If you cannot restore this, you can end the session here.</p>
        <button id="dg-escape" class="jspsych-btn">End the session</button>`
          : ''
      }
    </div>`;
  overlay.querySelector('#dg-fs')?.addEventListener('click', () => {
    document.documentElement.requestFullscreen?.().catch(() => {});
  });
  overlay.querySelector('#dg-escape')?.addEventListener('click', escape);
}

function escape() {
  log('escape', { exit_reason: 'display_guard_escape' });
  const handler = escapeHandler;
  stopDisplayGuard();
  handler?.();
}

function blockKeys(e) {
  if (overlay) {
    e.stopPropagation();
    e.preventDefault();
  }
}

function hideOverlay() {
  clearTimeout(escapeTimer);
  escapeTimer = null;
  escapeAvailable = false;
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  window.removeEventListener('keydown', blockKeys, true);
  window.removeEventListener('keyup', blockKeys, true);
}

function evaluate() {
  if (!started) return;
  if (mmDrifted()) {
    document.documentElement.style.setProperty('--mm', `${base.pxPerMm}px`);
    log('mm_reset');
  }
  const reasons = [];
  if (zoomChanged()) reasons.push('zoom');
  if (requireFullscreen && !document.fullscreenElement) reasons.push('fullscreen');
  if (reasons.length) {
    if (!paused) {
      paused = true;
      window.jsPsych?.pauseExperiment?.();
      log('pause', { reasons: reasons.join(',') });
    }
    showOverlay(reasons.join(','));
  } else if (paused) {
    paused = false;
    hideOverlay();
    window.jsPsych?.resumeExperiment?.();
    log('resume');
  }
}

/**
 * @param {object} opts
 * @param {number} opts.pxPerMm
 * @param {boolean} [opts.fullscreen]   require fullscreen from the start
 * @param {Function} [opts.onEscape]    called when the participant uses the
 *                                      overlay's end-the-session button
 */
export function startDisplayGuard({ pxPerMm, fullscreen = false, onEscape }) {
  if (started) {
    base = { ...base, pxPerMm };
    return;
  }
  started = true;
  escapeHandler = onEscape ?? null;
  requireFullscreen = fullscreen;
  base = { ...readDisplaySnapshot(), pxPerMm };
  log('guard_start', { px_per_mm: pxPerMm, base_dpr: base.dpr });

  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!paused) log('resize');
      evaluate();
    }, RESIZE_DEBOUNCE_MS);
  };
  const onFullscreenChange = () => {
    evaluate();
  };
  const onVisibility = () => {
    if (document.hidden) {
      hiddenSince = performance.now();
      log('hidden');
    } else {
      log('visible', {
        hidden_ms: hiddenSince ? Math.round(performance.now() - hiddenSince) : null,
      });
      hiddenSince = null;
      evaluate();
    }
  };
  const onBlur = () => {
    log('blur');
  };
  const onFocus = () => log('focus');

  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);

  /* devicePixelRatio changes do not always fire `resize`. */
  let dprQuery = null;
  let dprListener = null;
  const watchDpr = () => {
    if (typeof window.matchMedia !== 'function') return;
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprListener = () => {
      evaluate();
      watchDpr();
    };
    dprQuery.addEventListener('change', dprListener, { once: true });
  };
  watchDpr();

  /* Fallback for browsers that skip the events above on zoom. */
  const poll = setInterval(evaluate, POLL_MS);

  teardown = () => {
    window.removeEventListener('resize', onResize);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    dprQuery?.removeEventListener('change', dprListener);
    clearInterval(poll);
    clearTimeout(resizeTimer);
  };
}

/**
 * Switch the guard off: remove the listeners and the overlay and resume the
 * experiment if it was paused. Safe to call at any time and more than once.
 * Called before the questionnaires, the upload and every exit screen, which
 * do not depend on the calibration.
 */
export function stopDisplayGuard() {
  if (!started) return;
  const wasPaused = paused;
  teardown?.();
  teardown = null;
  started = false;
  paused = false;
  requireFullscreen = false;
  escapeHandler = null;
  hideOverlay();
  log('guard_stop');
  if (wasPaused) window.jsPsych?.resumeExperiment?.();
}

/** Timeline node that switches the guard off. */
export function stopDisplayGuardNode() {
  return {
    type: callFunction,
    async: false,
    func: () => {
      stopDisplayGuard();
      return { guard_stopped: true };
    },
    data: { phase: 'display_guard_stop' },
  };
}

/** Call after fullscreen has been entered to start enforcing it. */
export function requireFullscreenFromNow() {
  requireFullscreen = true;
  evaluate();
}

export function _resetGuardForTests() {
  teardown?.();
  teardown = null;
  started = false;
  base = null;
  paused = false;
  requireFullscreen = false;
  hiddenSince = null;
  escapeHandler = null;
  pending = [];
  hideOverlay();
}
