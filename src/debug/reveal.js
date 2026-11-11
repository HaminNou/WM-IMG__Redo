/**
 * Secret grid reveal (experimenter debug mode only).
 *
 * Pressing `G` twice (two non-repeat keydowns within 450 ms) toggles an overlay that
 * shows the hidden grid and the pattern inside the circle while a trial is running:
 * the 25 cell outlines with their data ids (0-24, centre cell 12 marked), the
 * on-pattern cells filled, and a readout of the trial's rotation angle.
 *
 *  - The cell layer is a `<g>` appended INSIDE the rotating element (`frame.rotor`), so it
 *    follows the 500 ms turn and holds the trial's angle exactly like the pattern; the
 *    stimuli layer is painted above it, so dots and stars are never covered. Cell numbers
 *    are counter-rotated so they stay readable.
 *  - Purely visual: `pointer-events: none`, SVG content / absolutely positioned readout
 *    (no layout shift), no timers, no timing change.
 *  - The toggle state survives node changes within a trial: `createGridFrame` calls
 *    `onFrameCreated`, which re-attaches the overlay to every new frame while it is on.
 *    It is switched off at the end of the trial (`resetReveal`, called by trace.trialEnd /
 *    abort, and whenever a frame of a different trial_uid appears); the overlay is
 *    removed with the frame at teardown.
 *  - The keydown listener exists ONLY when debug mode is on (`installReveal`). It is a
 *    capture-phase listener that never calls preventDefault / stopPropagation, so it cannot
 *    interfere with response handlers; the response handlers ignore `g` anyway (they only
 *    accept their allowed keys).
 *  - Each toggle writes ONE data row (phase `debug_reveal`) through the injected `emitRow`
 *    (the runner passes `emitAuxDataRow`) and prints a console line, so an analyst can
 *    exclude trials in which the answer was visible. Pressed outside a trial (no frame on
 *    screen) it prints a console note only.
 *
 * This module must not import frame.js (frame.js imports it).
 */
import { svgEl } from '../visuals/svg.js';
import { config } from '../config.js';
import { cellTopLeftMm, cellCentreMm, totalCells, isCentre } from '../grid.js';
import { isDebugMode } from './debug-mode.js';

/** Maximum gap between the two presses of the toggle, ms. */
export const REVEAL_WINDOW_MS = 450;
/** Phase of the data row written for each toggle. */
export const REVEAL_ROW_PHASE = 'debug_reveal';

const OVERLAY_CLASS = 'debug-reveal';
const READOUT_CLASS = 'debug-reveal-readout';
const STROKE = 'rgba(255, 0, 200, 0.75)';
const FILL_ON = 'rgba(255, 0, 200, 0.28)';
const LABEL_FILL = 'rgba(200, 0, 150, 0.95)';

let installed = false;
let listenerTarget = null;
let keyHandler = null;
let emitRow = null;
let nowFn = () => performance.now();

let revealOn = false;
let revealUid = null;
let lastGAt = null;
let currentFrame = null;

/** Is the reveal installed (debug mode on)? */
export function isRevealInstalled() {
  return installed;
}

/** Is the overlay currently switched on? */
export function isRevealOn() {
  return revealOn;
}

function readTrialData() {
  try {
    const d = window.jsPsych?.getCurrentTrial?.()?.data;
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

function frameLive(frame) {
  return !!frame?.wrapper && frame.wrapper.isConnected === true;
}

const dirWord = (deg) => (!deg ? 'none' : deg > 0 ? 'cw' : 'ccw');
const readoutText = (deg) =>
  `rotation ${deg > 0 ? '+' : ''}${Math.round((deg ?? 0) * 100) / 100}° (${dirWord(deg)})`;

function applyLabelCounterRotation(frame) {
  const overlay = frame.rotor?.querySelector?.(`.${OVERLAY_CLASS}`);
  if (!overlay) return;
  const deg = frame.rotation_deg ?? 0;
  const transition = frame.rotor.style.transition || '';
  for (const label of overlay.querySelectorAll('text')) {
    label.style.transition = transition;
    label.style.transform = `rotate(${-deg}deg)`;
  }
  const readout = frame.wrapper.querySelector(`.${READOUT_CLASS}`);
  if (readout) readout.textContent = readoutText(deg);
}

function mountOverlay(frame) {
  if (!frame?.rotor || !frame.wrapper || frame.rotor.querySelector(`.${OVERLAY_CLASS}`)) return;
  const cs = config.grid.cell_size_mm;
  const onCells = new Set(config.pattern.gray_pattern_cells);
  const g = svgEl('g', { class: OVERLAY_CLASS, 'pointer-events': 'none' });
  for (let i = 0; i < totalCells(); i++) {
    const { x_mm, y_mm } = cellTopLeftMm(i);
    const centre = isCentre(i);
    g.appendChild(
      svgEl('rect', {
        x: x_mm,
        y: y_mm,
        width: cs,
        height: cs,
        fill: onCells.has(i) ? FILL_ON : 'none',
        stroke: STROKE,
        'stroke-width': centre ? 0.5 : 0.2,
        'stroke-dasharray': centre ? '1.2 0.8' : null,
        'data-debug-cell': i,
        'data-on-pattern': onCells.has(i) ? '1' : '0',
        'pointer-events': 'none',
      })
    );
    const c = cellCentreMm(i);
    const label = svgEl('text', {
      x: x_mm + cs * 0.12,
      y: y_mm + cs * 0.3,
      'font-size': cs * 0.26,
      'font-family': 'Arial, sans-serif',
      'font-weight': 'bold',
      fill: LABEL_FILL,
      'pointer-events': 'none',
      'data-debug-label': i,
    });
    label.textContent = centre ? `${i} C` : String(i);
    label.style.transformBox = 'fill-box';
    label.style.transformOrigin = 'center';
    g.appendChild(label);
    if (centre) {
      g.appendChild(
        svgEl('path', {
          d: `M ${c.x_mm - cs * 0.2} ${c.y_mm} H ${c.x_mm + cs * 0.2} M ${c.x_mm} ${c.y_mm - cs * 0.2} V ${c.y_mm + cs * 0.2}`,
          stroke: STROKE,
          'stroke-width': 0.3,
          fill: 'none',
          'pointer-events': 'none',
        })
      );
    }
  }
  frame.rotor.appendChild(g);

  const readout = document.createElement('div');
  readout.className = READOUT_CLASS;
  readout.setAttribute('aria-hidden', 'true');
  readout.style.cssText =
    'position:absolute;left:0;top:0;pointer-events:none;font:11px/1.2 monospace;' +
    `color:${LABEL_FILL};background:rgba(255,255,255,0.6);padding:1px 4px;border-radius:3px;`;
  frame.wrapper.appendChild(readout);
  applyLabelCounterRotation(frame);
}

function unmountOverlay(frame) {
  frame?.rotor?.querySelector?.(`.${OVERLAY_CLASS}`)?.remove();
  frame?.wrapper?.querySelector?.(`.${READOUT_CLASS}`)?.remove();
}

/**
 * Hook for `createGridFrame`: remember the newest frame and, while the reveal is on,
 * attach the overlay to it. A no-op unless the reveal is installed.
 * @param {object} frame the frame handle returned by createGridFrame
 */
export function onFrameCreated(frame) {
  if (!installed) return;
  try {
    const uid = readTrialData().trial_uid ?? null;
    if (revealOn && uid !== null && revealUid !== null && uid !== revealUid) {
      resetReveal(); /* a new trial: the previous trial's reveal ends with it */
    }
    currentFrame = frame;
    if (revealOn) mountOverlay(frame);
  } catch {
    /* debug tooling never breaks the trial */
  }
}

/**
 * Hook for `setRotation`: keep the counter-rotation of the labels and the angle readout
 * in step with the frame. A no-op unless the overlay is on.
 * @param {object} frame
 */
export function onFrameRotated(frame) {
  if (!installed || !revealOn) return;
  try {
    applyLabelCounterRotation(frame);
  } catch {
    /* ignore */
  }
}

/** Switch the overlay off and remove it (end of trial). Writes no row. */
export function resetReveal() {
  if (!installed) return;
  revealOn = false;
  revealUid = null;
  lastGAt = null;
  unmountOverlay(currentFrame);
}

function toggle() {
  const data = readTrialData();
  if (!frameLive(currentFrame)) {
    console.log('[debug] reveal: no grid on screen (press G G inside a trial)');
    return;
  }
  revealOn = !revealOn;
  revealUid = data.trial_uid ?? null;
  if (revealOn) mountOverlay(currentFrame);
  else unmountOverlay(currentFrame);
  const row = {
    phase: 'debug_reveal',
    debug_reveal_on: revealOn,
    trial_uid: data.trial_uid ?? null,
    debug_node_phase: data.phase ?? null,
    ts: Math.round(nowFn()),
  };
  try {
    emitRow?.(row);
  } catch (err) {
    console.error('[debug] reveal row not written', err);
  }
  console.log(
    `[debug] reveal ${revealOn ? 'ON' : 'OFF'}  trial ${row.trial_uid ?? '?'}  node ${row.debug_node_phase ?? '?'}` +
      (revealOn ? `  ${readoutText(currentFrame.rotation_deg)}` : '')
  );
}

function isEditable(t) {
  if (!t || typeof t.tagName !== 'string') return false;
  const tag = t.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}

/**
 * The keydown handler (exported for tests): two non-repeat `g`/`G` keydowns within
 * {@link REVEAL_WINDOW_MS} toggle the overlay. Never prevents or stops the event.
 * @param {KeyboardEvent} e
 */
export function handleRevealKey(e) {
  try {
    if (e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'g' && e.key !== 'G') return;
    if (isEditable(e.target) || isEditable(document.activeElement)) return;
    const now = nowFn();
    if (lastGAt !== null && now - lastGAt <= REVEAL_WINDOW_MS) {
      lastGAt = null;
      toggle();
    } else {
      lastGAt = now;
    }
  } catch {
    /* ignore */
  }
}

/**
 * Install the reveal. Does nothing (and adds no listener) unless debug mode is on.
 * Call once from the runner, where the other global listeners are installed.
 * @param {object} [opts]
 * @param {(row: object) => void} [opts.emitRow] writes a data row (the runner passes emitAuxDataRow)
 * @param {boolean} [opts.enabled] override of isDebugMode() (tests)
 * @param {EventTarget} [opts.target] where to listen (default: window)
 * @param {() => number} [opts.now] clock in ms (tests)
 * @returns {boolean} true when installed
 */
export function installReveal({ emitRow: emit, enabled, target, now } = {}) {
  const on = enabled ?? isDebugMode();
  if (!on || installed) return installed;
  emitRow = typeof emit === 'function' ? emit : null;
  nowFn = typeof now === 'function' ? now : () => performance.now();
  listenerTarget = target ?? window;
  keyHandler = handleRevealKey;
  listenerTarget.addEventListener('keydown', keyHandler, { capture: true });
  installed = true;
  return true;
}

/** Remove the listener and forget all state (tests). */
export function uninstallReveal() {
  if (listenerTarget && keyHandler) {
    listenerTarget.removeEventListener('keydown', keyHandler, { capture: true });
  }
  unmountOverlay(currentFrame);
  installed = false;
  listenerTarget = null;
  keyHandler = null;
  emitRow = null;
  revealOn = false;
  revealUid = null;
  lastGAt = null;
  currentFrame = null;
  nowFn = () => performance.now();
}
