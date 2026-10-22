/**
 * Credit-card screen calibration -> CSS `--mm` custom property.
 *
 * Participants resize a card outline until it matches a real ID-1 card
 * (85.60 mm wide). The matched width in CSS px gives px-per-mm, published as
 * `--mm` for every stimulus primitive.
 *
 * Implementation notes
 *   - jsPsych clears the trial DOM before `on_finish` runs, so nothing here
 *     reads the slider in `on_finish`. The value is held in `state.px` and
 *     updated on every `input` event; the button is also read in capture
 *     phase as a second source.
 *   - The starting width is random per participant and per pass, one low and
 *     one high, in random order. The two settings must agree within
 *     CONSISTENCY_TOL; the mean is used.
 *   - The button stays disabled until the slider has moved, so a participant
 *     cannot accept the starting width.
 *   - Final value is validated against a px/mm range and against the screen
 *     width the value implies. Failure re-prompts; after MAX_ATTEMPTS the
 *     session ends (no silent fallback).
 *   - After success `startDisplayGuard` watches zoom, fullscreen and
 *     visibility for the rest of the session.
 */
import htmlButtonResponse from '@jspsych/plugin-html-button-response';
import callFunction from '@jspsych/plugin-call-function';
import { registerHiddenNavStep, trackHiddenNavNode } from '../hidden-nav.js';
import { isDisplayColourLocked } from '../visuals/display-colour-lock.js';
import { readDisplaySnapshot } from './device-probe.js';
import { startDisplayGuard } from './display-guard.js';
import { screenOutExit, finishScreenOut } from '../screen-out.js';
import { buildScreenOutUrl } from '../uploader.js';

const CARD_MM_WIDTH = 85.6;
const CARD_ASPECT = 53.98 / 85.6;
const PX_PER_MM_MIN = 2.2;
const PX_PER_MM_MAX = 9.0;
const IMPLIED_SCREEN_MM_MIN = 180;
const IMPLIED_SCREEN_MM_MAX = 1200;
const SLIDER_MIN_PX = 150;
const SLIDER_MAX_PX = 850;
const START_LOW_PX = [180, 280];
const START_HIGH_PX = [430, 620];
const MIN_MOVE_PX = 8;
const MIN_DWELL_MS = 3000;
const CONSISTENCY_TOL = 0.05;
const MAX_ATTEMPTS = 3;
const TRACE_MAX = 80;
const STEP_ID = 'screen_calibration';
const HINT_STEP_ID = 'screen_calibration_retry_hint';

/* Module state for the current calibration run. */
const cal = {
  attempts: 0,
  passes: [] /* passes of the current attempt */,
  allPasses: [],
  final: null,
  startOrder: null,
};

function randInt([lo, hi]) {
  return Math.round(lo + Math.random() * (hi - lo));
}

function buildHtml(startPx, pass) {
  return `
  <h2>Calibrate the screen (${pass} of 2)</h2>
  <p data-voiceover-target style="max-width: 40rem; margin: 0 auto 0.5rem;">
    First set your browser zoom to <strong>100%</strong> (press
    <kbd>Ctrl</kbd>/<kbd>&#8984;</kbd> + <kbd>0</kbd>). Then hold a
    <strong>credit card</strong> flat against the screen, long side
    horizontal. Drag the slider until the left and right edges of the blue
    rectangle line up with the edges of the card.
  </p>
  <div id="cc-stage" style="margin: 1rem auto; position: relative; min-height: 14rem;">
    <div id="cc-rect"
         style="position: absolute; left: 50%; top: 0; transform: translateX(-50%);
                width: ${startPx}px; height: ${startPx * CARD_ASPECT}px; border: 2px solid #000;
                border-radius: 6px; box-sizing: border-box;
                background: linear-gradient(135deg, #1f3a8a 0%, #1e40af 100%);">
    </div>
  </div>
  <input id="cc-slider" type="range" min="${SLIDER_MIN_PX}" max="${SLIDER_MAX_PX}" step="1"
         value="${startPx}" aria-label="Card width"
         style="width: 36rem; max-width: 90%;" />
  <p style="opacity: 0.7; margin-top: 0.75rem;">
    A standard card is <strong>85.6 mm</strong> wide. The arrow keys move the
    slider one pixel at a time.
  </p>
`;
}

function newPassState() {
  return {
    start_px: null,
    px: null,
    n_input: 0,
    n_distinct: 0,
    min_px: null,
    max_px: null,
    t_load: 0,
    t_first_input: null,
    t_last_input: null,
    trace: [],
    seen: new Set(),
    input_kinds: new Set(),
  };
}

let ps = newPassState();

function screenCalibrationPass(passIdx) {
  const node = {
    type: htmlButtonResponse,
    stimulus: () => {
      /* Evaluated once at trial start: pick this pass's random start. */
      ps = newPassState();
      const kind = cal.startOrder[passIdx - 1];
      ps.start_px = kind === 'low' ? randInt(START_LOW_PX) : randInt(START_HIGH_PX);
      ps.px = ps.start_px;
      ps.kind = kind;
      return buildHtml(ps.start_px, passIdx);
    },
    choices: ['This matches my card'],
    button_html: (choice, idx) =>
      `<button class="jspsych-btn" data-idx="${idx}" disabled aria-disabled="true"
        style="opacity: 0.55; cursor: not-allowed;">${choice}</button>`,
    on_load: () => {
      const slider = document.getElementById('cc-slider');
      const rect = document.getElementById('cc-rect');
      const stage = document.getElementById('cc-stage');
      const btn = document.querySelector('button.jspsych-btn[data-idx="0"]');
      ps.t_load = performance.now();

      const draw = (px) => {
        rect.style.width = `${px}px`;
        rect.style.height = `${px * CARD_ASPECT}px`;
        stage.style.height = `${px * CARD_ASPECT + 8}px`;
      };
      const canAccept = () =>
        Math.abs(ps.px - ps.start_px) >= MIN_MOVE_PX &&
        performance.now() - ps.t_load >= MIN_DWELL_MS;
      const refreshButton = () => {
        if (!btn) return;
        const ok = canAccept();
        btn.disabled = !ok;
        btn.setAttribute('aria-disabled', String(!ok));
        btn.style.opacity = ok ? '' : '0.55';
        btn.style.cursor = ok ? '' : 'not-allowed';
      };
      const onInput = (e) => {
        const px = parseInt(slider.value, 10);
        const now = performance.now() - ps.t_load;
        ps.px = px;
        ps.n_input += 1;
        if (!ps.seen.has(px)) {
          ps.seen.add(px);
          ps.n_distinct = ps.seen.size;
        }
        ps.min_px = ps.min_px === null ? px : Math.min(ps.min_px, px);
        ps.max_px = ps.max_px === null ? px : Math.max(ps.max_px, px);
        if (ps.t_first_input === null) ps.t_first_input = now;
        ps.t_last_input = now;
        ps.input_kinds.add(e?.pointerType || (e?.isTrusted ? 'trusted' : 'synthetic'));
        if (ps.trace.length < TRACE_MAX) ps.trace.push([Math.round(now), px]);
        draw(px);
        refreshButton();
      };
      slider.addEventListener('input', onInput);
      /* Capture-phase read just before jsPsych tears the page down. */
      btn?.addEventListener(
        'click',
        () => {
          ps.px = parseInt(slider.value, 10);
        },
        { capture: true }
      );
      draw(ps.start_px);
      setTimeout(refreshButton, MIN_DWELL_MS + 50);
      slider.focus();
    },
    on_finish: (data) => {
      const px = ps.px;
      const px_per_mm = px / CARD_MM_WIDTH;
      const moved = Math.abs(px - ps.start_px) >= MIN_MOVE_PX;
      Object.assign(data, {
        cal_pass: passIdx,
        cal_attempt: cal.attempts + 1,
        cal_start_kind: ps.kind,
        cal_start_px: ps.start_px,
        cc_px_width: px,
        px_per_mm,
        px_per_mm_in_bounds: px_per_mm >= PX_PER_MM_MIN && px_per_mm <= PX_PER_MM_MAX,
        px_per_mm_min: PX_PER_MM_MIN,
        px_per_mm_max: PX_PER_MM_MAX,
        cal_moved: moved,
        cal_n_input: ps.n_input,
        cal_n_distinct_values: ps.n_distinct,
        cal_min_px: ps.min_px,
        cal_max_px: ps.max_px,
        cal_t_first_input_ms: ps.t_first_input,
        cal_t_last_input_ms: ps.t_last_input,
        cal_dwell_ms: Math.round(performance.now() - ps.t_load),
        cal_input_kinds: Array.from(ps.input_kinds).join(','),
        cal_trace: ps.trace,
        display_colour_locked: isDisplayColourLocked(),
        ...readDisplaySnapshot(),
      });
      cal.passes.push({ px, moved, in_bounds: data.px_per_mm_in_bounds });
      cal.allPasses.push({ attempt: cal.attempts + 1, pass: passIdx, px });
    },
    data: { phase: 'screen_calibration' },
  };
  registerHiddenNavStep(`${STEP_ID}_${passIdx}`, () => screenCalibrationPass(passIdx));
  return trackHiddenNavNode(node, `${STEP_ID}_${passIdx}`);
}

/** Pure evaluation of one attempt (two passes). Exported for tests. */
export function evaluateAttempt(passes, screenWidthCssPx) {
  const reasons = [];
  if (passes.length < 2) reasons.push('missing_pass');
  if (passes.some((p) => !p.moved)) reasons.push('slider_not_moved');
  if (passes.some((p) => !p.in_bounds)) reasons.push('px_per_mm_out_of_range');
  const [a, b] = passes.map((p) => p.px);
  const mean = (a + b) / 2;
  const rel_diff = Math.abs(a - b) / mean;
  const consistent = rel_diff <= CONSISTENCY_TOL;
  const px_per_mm = mean / CARD_MM_WIDTH;
  const implied = Number.isFinite(screenWidthCssPx) ? screenWidthCssPx / px_per_mm : null;
  if (implied !== null && (implied < IMPLIED_SCREEN_MM_MIN || implied > IMPLIED_SCREEN_MM_MAX)) {
    reasons.push('implied_screen_width_implausible');
  }
  const usable =
    !reasons.includes('missing_pass') &&
    !reasons.includes('slider_not_moved') &&
    !reasons.includes('px_per_mm_out_of_range') &&
    !reasons.includes('implied_screen_width_implausible');
  return {
    usable,
    consistent,
    rel_diff,
    mean_px: mean,
    px_per_mm,
    implied_screen_mm: implied,
    reasons,
  };
}

/* The display guard's overlay offers this when the participant cannot restore
 * the zoom or fullscreen. */
function endSessionFromGuard() {
  void finishScreenOut({
    reasonHtml: `
      <h2>The session has ended</h2>
      <p>The page could not be kept at the calibrated zoom and in fullscreen, so
      the task cannot continue.</p>`,
    flush: true,
    url: buildScreenOutUrl(),
  });
}

function screenCalibrationEvaluate() {
  return {
    type: callFunction,
    async: false,
    func: () => {
      cal.attempts += 1;
      const ev = evaluateAttempt(cal.passes, window.screen?.width);
      /* Accept: usable and consistent; or usable but inconsistent on the last
       * attempt (accepted and flagged for the exclusion rule). */
      const last = cal.attempts >= MAX_ATTEMPTS;
      const accepted = ev.usable && (ev.consistent || last);
      if (accepted) {
        cal.final = {
          ...ev,
          attempts_used: cal.attempts,
          status: ev.consistent ? 'ok' : 'inconsistent_accepted',
        };
        document.documentElement.style.setProperty('--mm', `${ev.px_per_mm}px`);
        startDisplayGuard({ pxPerMm: ev.px_per_mm, onEscape: endSessionFromGuard });
      } else {
        cal.final = null;
      }
      const out = {
        attempt: cal.attempts,
        accepted,
        status: accepted ? cal.final.status : 'retry',
        px_per_mm: ev.px_per_mm,
        cc_px_width: ev.mean_px,
        rel_diff: ev.rel_diff,
        consistent: ev.consistent,
        usable: ev.usable,
        reasons: ev.reasons,
        implied_screen_mm: ev.implied_screen_mm,
        attempts_used: cal.attempts,
        max_attempts: MAX_ATTEMPTS,
        retried: cal.attempts > 1,
        px_per_mm_in_bounds: !ev.reasons.includes('px_per_mm_out_of_range'),
      };
      cal.passes = [];
      return out;
    },
    data: { phase: 'screen_calibration_outcome' },
  };
}

const RETRY_HINT_HTML = `
  <h2>Let's try the calibration again</h2>
  <div data-voiceover-target>
    <p style="max-width: 38rem; margin: 0 auto 1rem;">
      The two settings did not agree closely enough, or the size was outside
      the range we can use. Please use an actual <strong>credit card</strong>
      (or any bank, ID or loyalty card of the same size), hold it
      <em>flat against the screen</em>, and match its left and right edges.
      Make sure your browser zoom is 100%.
    </p>
  </div>
`;

function retryHintTrial() {
  const node = {
    type: htmlButtonResponse,
    stimulus: RETRY_HINT_HTML,
    choices: ['Continue'],
    data: { phase: 'screen_calibration_retry_hint' },
  };
  registerHiddenNavStep(HINT_STEP_ID, retryHintTrial);
  return trackHiddenNavNode(node, HINT_STEP_ID);
}

function failExit() {
  return screenOutExit({
    phase: 'screen_calibration_fail',
    exitReason: 'screen_calibration_failed',
    reasonHtml: `
      <h2>Sorry, we could not calibrate your screen</h2>
      <p>
        The task needs stimuli at a fixed physical size, and the screen size
        could not be set reliably on this device.
      </p>`,
    condition: () => cal.final === null,
    flush: true,
  });
}

/**
 * Composite node: [hint] -> pass 1 -> pass 2 -> evaluate, looped until an
 * attempt is accepted or MAX_ATTEMPTS is reached; then an exit screen if no
 * attempt was accepted.
 */
export function screenCalibrationWithRetry() {
  return {
    timeline: [
      {
        type: callFunction,
        async: false,
        func: () => {
          cal.attempts = 0;
          cal.passes = [];
          cal.allPasses = [];
          cal.final = null;
          cal.startOrder = Math.random() < 0.5 ? ['low', 'high'] : ['high', 'low'];
          return { start_order: cal.startOrder.join(',') };
        },
        data: { phase: 'screen_calibration_start' },
      },
      {
        timeline: [
          {
            timeline: [retryHintTrial()],
            conditional_function: () => cal.attempts >= 1,
          },
          screenCalibrationPass(1),
          screenCalibrationPass(2),
          screenCalibrationEvaluate(),
        ],
        loop_function: () => cal.final === null && cal.attempts < MAX_ATTEMPTS,
      },
      failExit(),
    ],
  };
}

export function getCalibration() {
  return cal.final;
}

export const _testHelpers = Object.freeze({
  CARD_MM_WIDTH,
  PX_PER_MM_MIN,
  PX_PER_MM_MAX,
  SLIDER_MIN_PX,
  SLIDER_MAX_PX,
  CONSISTENCY_TOL,
  MAX_ATTEMPTS,
  MIN_MOVE_PX,
  IMPLIED_SCREEN_MM_MIN,
  IMPLIED_SCREEN_MM_MAX,
});
