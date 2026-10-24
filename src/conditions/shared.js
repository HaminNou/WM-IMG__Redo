/**
 * Shared timing helpers and small jsPsych nodes used by every condition.
 *
 * Conventions:
 *   - Memory M-slot in D-only: dot 1000 ms + ISI 500 ms = 1500 ms.
 *   - Memory M-slot in T-only: tone 350 ms + silence 1150 ms = 1500 ms.
 *   - Memory M-slot in I-only: invisible open-square placeholder running on
 *     the dot envelope — 1000 ms + 500 ms empty-circle offset = 1500 ms
 *     total. I-only's M-slot dummies stand in for the *memory items*
 *     (dots / tones) of the matched dual-task conditions (I+D, I+T), so
 *     they inherit the M-slot envelope rather than the S-slot envelope
 *     used by D-only / T-only dummies. This keeps single-task encoding
 *     duration byte-identical to the matched dual-task encoding duration
 *     across all five conditions.
 *   - S-slot (dummy / star): 3000 ms visible onset + 500 ms empty-circle
 *     offset = 3500 ms total. D-only and T-only dummies sit here (they
 *     stand in for the *star* of the matched dual-task condition).
 *   - Retention: 2000 ms with central question mark over the persistent
 *     bull's-eye.
 *   - Per-probe response window: 3000 ms visible onset + 500 ms empty-circle
 *     offset. Answered probes recolour on the still-visible probe stimulus
 *     or question mark and remain on screen until the 3000 ms onset ends.
 *     Probes run back-to-back (no inter-probe interval); the 500 ms
 *     post-probe offset is the only gap between probe N and probe N+1.
 *
 * One shared 500 ms post-stimulus offset is used wherever
 * the design calls for an empty-circle gap after a visible event. That
 * offset applies to dot M-slots, star slots, open-square placeholders, and
 * the transition out of the 3000 ms recognition-probe onset.
 *
 * Feedback is delivered by recolouring the on-grid probe stimulus (the
 * white dot for D-only / I+D; the centre '?' overlay for T-only / I+T;
 * the white star for I-only). The grid frame and bull's-eye remain visible
 * across encoding → retention → probe → feedback → ITI so the
 * participant's eyes stay locked to the same fixation locus throughout.
 * The grid circle never disappears and feedback colour is applied to the
 * probe itself.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';
import { config } from '../config.js';
import { createGridFrame } from '../visuals/frame.js';
import { isValidBackgroundShade } from '../visuals/colour-palette.js';
import { setTrialPageBackground, clearTrialPageBackground } from '../visuals/page-background.js';
import { appendTrialRow, recordWriteFailure } from '../storage.js';
import { rowClock } from '../clock.js';
import { getPracticeIteration } from '../scheduler/trial-meta.js';
import { playToneByCell } from '../audio/tones.js';
import { getAudioContext, audioContextInfo } from '../audio/context.js';
import { setTrialCounter, TRIAL_TYPE_TAG_COLOURS } from './trial-counter.js';
import { unmountToggle as unmountVoiceoverToggle } from '../visuals/voiceover-slide.js';
import { getVoiceover } from '../visuals/voiceover.js';

const ROTATION_ARROW_ASSET_URL = `${import.meta.env.BASE_URL}assets/rotation-arrow.png`;

export const M_SLOT_MS = 1500;
export const DOT_VISIBLE_MS = config.memory.dot_duration_ms; /* 1000 */
export const STAR_DURATION_MS = config.imagery.star_duration_ms; /* 3000 visible onset */
const INTER_STAR_INTERVAL_MS = config.imagery.inter_star_interval_ms; /* 500 offset */
if (
  INTER_STAR_INTERVAL_MS !== config.memory.inter_stimulus_interval_ms ||
  INTER_STAR_INTERVAL_MS !== config.probes.feedback_duration_ms
) {
  throw new Error(
    'Timing lock violated: the shared 500 ms post-stimulus offset diverged across memory, imagery, and probe config.'
  );
}
const POST_STIMULUS_OFFSET_MS = INTER_STAR_INTERVAL_MS; /* 500 */
export const S_SLOT_MS = STAR_DURATION_MS + POST_STIMULUS_OFFSET_MS; /* 3500 total */
export const RETENTION_MS = config.memory.retention_interval_ms; /* 2000 */
export const PROBE_RESPONSE_MS = config.probes.response_window_ms; /* 3000 visible onset */
export const PROBE_OFFSET_MS = POST_STIMULUS_OFFSET_MS; /* 500 */

/* Imagery-side timings (config.imagery). */
export const ROTATION_ANIMATION_MS = config.imagery.rotation_animation_ms; /* 500 */
const POST_ROTATION_MS = config.imagery.post_rotation_delay_ms; /* 1000 */
/* Imagination period. Fixed 3500 ms empty-circle
 * hold inserted between the rotation-arrow cue and the encoding rotation
 * on every imagery-bearing trial (I-only, I+D, I+T). The participant uses
 * this window to pre-imagine the rotated pattern before the first
 * star/dot/tone fires; no input is accepted and the duration is fixed so
 * encoding-onset is identical within and across imagery conditions. */
const IMAGINATION_DURATION_MS = config.imagery.imagination_duration_ms; /* 3500 */
/* Pre-encoding pad applied to every trial. On
 * imagery-bearing trials the rotation animation (500 ms) plus the
 * post-rotation stabilisation (1000 ms) are already part of the encoding
 * schedule and consume this 1500 ms; on memory-only trials (D-only,
 * T-only) the same 1500 ms is held as a no-rotation grid-stabilisation
 * pad at the start of the encoding node so that the first dot/tone never
 * fires immediately after the gate passes. The shared constant keeps the
 * pad value defined exactly once. */
export const PRE_ENCODING_PAD_MS = ROTATION_ANIMATION_MS + POST_ROTATION_MS; /* 1500 */
/* Recolour palette for star / dot / question-mark feedback, chosen for
 * readability on the light (white/gray) trial backgrounds. */
export const FEEDBACK_COLOR_CORRECT = '#0BC926';
export const FEEDBACK_COLOR_WRONG = '#FF1818';

/* Text-context names for instruction decks' colour-coded word highlights.
 * The trial-side rendering applies the hex directly to SVG fills, and the
 * same full-opacity value is used for styled <span> elements in
 * instruction text. */
export const FEEDBACK_COLOR_CORRECT_TEXT = FEEDBACK_COLOR_CORRECT;
export const FEEDBACK_COLOR_WRONG_TEXT = FEEDBACK_COLOR_WRONG;

/* If no animation frame is delivered (hidden tab), a response window is
 * still closed this long after its planned end. */
export const WINDOW_FAILSAFE_MS = 250;

/**
 * Time of a key event on the performance.now() scale. Uses the event's own
 * timestamp (set when the browser received the key), not the time the
 * handler ran. Synthetic events and implausible values fall back to now.
 */
export function eventTime(e) {
  const now = performance.now();
  const t = e && e.isTrusted && typeof e.timeStamp === 'number' ? e.timeStamp : now;
  return Math.abs(t - now) > 5000 ? now : t;
}

/**
 * Sleep helper for use inside async on_load handlers. Resolves after `ms`.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stamp `value` onto the currently-running jsPsych trial's `data` payload
 * under `field`. Used by the timestamp-instrumentation pathway to record
 * stimulus-onset moments (`performance.now()`) without altering visible
 * behaviour. Mirrors the mutation pattern already used by the trial-start
 * gate (which stamps `gate_passed_at_ms`). Silently no-ops if jsPsych is
 * unavailable (test environments) or the field is null.
 *
 * Numeric values are rounded to integer milliseconds for storage consistency
 * with the rest of the schema (`response_rt_ms`, `gate_passed_at_ms`
 * use `Math.round(...)`). The user-facing
 * timestamp resolution is millisecond — sub-millisecond precision from the
 * `performance.now()` clock is intentionally discarded at the storage edge.
 */
export function stampTrialData(field, value) {
  if (!field) return;
  const data = window.jsPsych?.getCurrentTrial?.()?.data;
  if (data && typeof data === 'object') {
    data[field] = typeof value === 'number' ? Math.round(value) : value;
  }
}

/**
 * Build a centred mount div hosting a grid frame (with bull's-eye visible).
 * Returns `{ html, mount }` where `html` is the jsPsych `stimulus` payload
 * and `mount(elementId)` is the on_load helper that creates and inserts
 * the frame, returning the frame handle for further per-trial decoration.
 */
function gridMount(id) {
  const html = `<div id="${id}" style="margin: 0 auto;"></div>`;
  function mount(opts) {
    const el = document.getElementById(id);
    const frame = createGridFrame(opts);
    el.appendChild(frame.wrapper);
    return frame;
  }
  return { html, mount };
}

export function frameNode({
  mount_id,
  phase,
  trial_duration,
  fixation = '',
  rotation_deg = 0,
  background_shade = null,
  choices = 'NO_KEYS',
  response_ends_trial = false,
  data = {},
  on_load,
  on_finish,
  timestamp_field = null,
} = {}) {
  const { html, mount } = gridMount(mount_id);
  return {
    type: htmlKeyboardResponse,
    stimulus: html,
    choices,
    response_ends_trial,
    trial_duration,
    on_load: () => {
      const frame = mount({ rotation_deg, fixation, background_shade });
      on_load?.(frame);
      if (timestamp_field) stampTrialData(timestamp_field, performance.now());
    },
    on_finish,
    data: { phase, frame_rotation_deg: rotation_deg, ...data },
  };
}

export function timedResponseWindowNode({
  mount_id,
  phase,
  onset_ms,
  offset_ms = 0,
  fixation = '',
  rotation_deg = 0,
  background_shade = null,
  allowed_keys = [],
  data = {},
  on_load,
  on_onset,
  on_response,
  on_onset_end,
  on_finish,
  timestamp_field = null,
} = {}) {
  const state = {
    frame: null,
    response_key: null,
    response_rt_ms: null,
    onset_ts: null,
    onset_closed: false,
    key_handler: null,
    onset_timer: null,
    failsafe_timer: null,
    raf_id: null,
    early_keypresses: 0,
    late_keypresses: 0,
    extra_keypresses: 0,
  };
  const { html, mount } = gridMount(mount_id);

  /* Ends the response window: no further response is accepted. The key
   * listener stays on until the node ends so that late presses are counted. */
  const closeOnset = () => {
    if (state.onset_closed) return;
    state.onset_closed = true;
    on_onset_end?.(state.frame, state);
  };

  const teardown = () => {
    if (state.onset_timer) clearTimeout(state.onset_timer);
    if (state.failsafe_timer) clearTimeout(state.failsafe_timer);
    if (state.raf_id !== null) cancelAnimationFrame(state.raf_id);
    state.onset_timer = state.failsafe_timer = state.raf_id = null;
    if (state.key_handler) {
      window.removeEventListener('keydown', state.key_handler, { capture: true });
      state.key_handler = null;
    }
  };

  return {
    type: htmlKeyboardResponse,
    stimulus: html,
    choices: 'NO_KEYS',
    response_ends_trial: false,
    trial_duration: onset_ms + offset_ms,
    on_load: () => {
      /* Reset mutable closure state so the node behaves correctly when
       * jsPsych replays the same object on a practice re-loop. */
      teardown();
      state.response_key = null;
      state.response_rt_ms = null;
      state.onset_ts = null;
      state.onset_closed = false;
      state.early_keypresses = 0;
      state.late_keypresses = 0;
      state.extra_keypresses = 0;

      state.frame = mount({ rotation_deg, fixation, background_shade });
      on_load?.(state.frame, state);

      const allowed = new Set(allowed_keys.map((key) => String(key).toLowerCase()));

      state.key_handler = (e) => {
        if (e.repeat) return;
        const key = String(e.key).toLowerCase();
        if (!allowed.has(key)) return;
        e.preventDefault();
        e.stopPropagation();
        const t = eventTime(e);
        if (state.onset_ts === null || t < state.onset_ts) {
          state.early_keypresses += 1;
          return;
        }
        const elapsedMs = t - state.onset_ts;
        if (state.onset_closed || elapsedMs >= onset_ms) {
          state.late_keypresses += 1;
          return;
        }
        if (state.response_key !== null) {
          state.extra_keypresses += 1;
          return;
        }
        state.response_key = key;
        state.response_rt_ms = Math.max(1, Math.round(elapsedMs));
        on_response?.(state.frame, state, key);
      };
      window.addEventListener('keydown', state.key_handler, { capture: true });

      /* The response clock starts at the frame in which the node's first
       * paint is committed. The window closes onset_ms later; the second
       * timer closes it anyway if no frame is delivered. */
      state.raf_id = requestAnimationFrame((ts) => {
        state.raf_id = null;
        state.onset_ts = ts;
        if (timestamp_field) stampTrialData(timestamp_field, ts);
        on_onset?.(state.frame, state, ts);
        state.onset_timer = setTimeout(closeOnset, Math.max(0, ts + onset_ms - performance.now()));
      });
      state.failsafe_timer = setTimeout(closeOnset, onset_ms + WINDOW_FAILSAFE_MS);
    },
    on_finish: (trialData) => {
      teardown();
      closeOnset();
      trialData.response = state.response_key;
      trialData.rt = state.response_rt_ms;
      trialData.early_keypresses = state.early_keypresses;
      trialData.late_keypresses = state.late_keypresses;
      trialData.extra_keypresses = state.extra_keypresses;
      on_finish?.(trialData, state);
    },
    data: { phase, frame_rotation_deg: rotation_deg, ...data },
  };
}

/**
 * Inter-trial interval (800 ms after the last probe before
 * the next trial). `phase` is `<condition>_iti`. Renders the grid + bull's-eye so the fixation locus is
 * continuous across trials. The `?` glyph remains visible from the start
 * of the retention/maintenance phase through every probe, feedback frame,
 * and the final post-trial ITI — a single continuous fixation locus —
 * until the encoding of the next trial starts (when
 * the '?' is blanked so the dots / stars / dummies are the only on-grid
 * stimuli).
 *
 * `fixation` defaults to `'?'` so any caller that asks for the final ITI
 * gets the persistent question mark by default. Pass `fixation: ''` for
 * the few cases where the ITI must be blank (e.g. between distinct
 * sessions / outside a maintenance window).
 *
 * I-only opts out of the default '?'. The star-only condition has no
 * retention/maintenance phase, so showing the maintenance glyph after the
 * last star would imply an upcoming probe that never comes. See
 * `i_only.js`'s `iOnlyTrial` composer, which calls `itiNode({ fixation: '' })`
 * to keep the post-trial gap blank.
 */
export function itiNode({ ms = 800, phase, fixation = '?', background_shade = null } = {}) {
  return frameNode({
    mount_id: 'iti-mount',
    phase,
    trial_duration: ms,
    fixation,
    background_shade,
    timestamp_field: 'iti_onset_ts_ms',
    /* End of trial body — revert the page to the dark UI theme so the next
     * trial-start gate (or any post-block node like rest / main_b_intro)
     * paints on the dark surface participants associate with "between
     * trials". The next gate's `on_load` clears defensively too. */
    on_finish: () => {
      document.body.style.cursor = '';
      clearTrialPageBackground();
    },
  });
}

/**
 * Yes / No → cell-was-presented mapping. Right arrow = "yes / target",
 * Left arrow = "no / foil". The same arrow
 * mapping is used for star judgments so the participant doesn't have to learn two
 * different keymaps across conditions.
 */
export const KEY_YES = 'arrowright';
export const KEY_NO = 'arrowleft';

/**
 * Rotation-cue (arrow-cue) phase.
 *
 * On imagery-bearing trials (I-only, I+D, I+T) the trial begins with a
 * fixed-duration rotation arrow shown over the empty grid + bull's-eye.
 * After `ARROW_CUE_MS` the arrow disappears and the trial-start gate
 * takes over (the "empty circle" the participant looks at while
 * imagining the rotated pattern and pressing both arrow keys to start).
 *
 * The arrow is the rotation-arrow PNG asset, 100 px wide so the cue is
 * visually unmistakable at the centre of the screen. It is positioned
 * absolutely over the grid wrapper (HTML `<img>`) rather than as an SVG
 * <image> in mm-space, because the cue size is a CSS-px constant rather
 * than a physical-mm one. The arrow is centred at the bull's-eye but is
 * NOT contained inside the central cell — at 100 px it overlaps the
 * surrounding cells.
 *
 * The arrow cue carries no input — `choices: 'NO_KEYS'`, fixed
 * `trial_duration`. Pressing arrow keys during the cue does nothing;
 * the gate that follows is where the participant arms the trial.
 */
const ARROW_CUE_MS = 2000;

export function arrowCueNode({
  trial_index_in_block,
  rotation_deg,
  phase,
  background_shade = null,
  durationMs = ARROW_CUE_MS,
  data = {},
} = {}) {
  const mountId = `arrow-cue-mount-${Math.random().toString(36).slice(2, 9)}`;
  /* When a background shade is set the arrow PNG is forced to solid
   * black via a CSS filter so it reads as a stimulus on white/gray;
   * otherwise the source mid-gray PNG shows through unmodified. */
  /* Inked-black silhouette plus a four-direction white drop-shadow halo so
   * the chevron stays legible against any backdrop a participant's OS
   * (light / dark mode) may compose. */
  const tintFilter = background_shade
    ? ' filter: brightness(0) saturate(100%) drop-shadow(1px 0 0 #fff) drop-shadow(-1px 0 0 #fff) drop-shadow(0 1px 0 #fff) drop-shadow(0 -1px 0 #fff);'
    : '';
  return {
    type: htmlKeyboardResponse,
    stimulus: `<div id="${mountId}" style="margin: 0 auto;"></div>`,
    choices: 'NO_KEYS',
    response_ends_trial: false,
    trial_duration: durationMs,
    on_load: () => {
      const mount = document.getElementById(mountId);
      const frame = createGridFrame({
        rotation_deg: 0,
        fixation: '',
        background_shade,
      });
      mount.appendChild(frame.wrapper);
      stampTrialData('arrow_cue_onset_ts_ms', performance.now());

      const px = config.imagery.rotation_arrow_size_px;
      const arrowImg = document.createElement('img');
      arrowImg.src = ROTATION_ARROW_ASSET_URL;
      arrowImg.alt = 'rotation cue';
      arrowImg.className = 'rotation-arrow-cue';
      arrowImg.setAttribute(
        'style',
        [
          'position: absolute',
          'top: 50%',
          'left: 50%',
          `width: ${px}px`,
          `height: ${px}px`,
          `transform: translate(-50%, -50%) rotate(${rotation_deg}deg)`,
          'pointer-events: none',
          'z-index: 10',
          'user-select: none',
        ].join('; ') +
          ';' +
          tintFilter
      );
      frame.wrapper.appendChild(arrowImg);
    },
    data: {
      phase,
      trial_index_in_block,
      rotation_deg,
      frame_rotation_deg: 0,
      duration_ms: durationMs,
      ...data,
    },
  };
}

/**
 * Imagination period.
 *
 * Fixed-duration empty-circle hold rendered between the rotation-arrow cue
 * and the encoding node on every imagery-bearing trial (I-only, I+D, I+T).
 * The participant uses this window to pre-imagine the 13-cell pattern at
 * the rotation angle just shown by the arrow; the window is fixed
 * (`IMAGINATION_DURATION_MS`, default 3500 ms) so the time available for
 * imagination is identical across trials.
 *
 * Crucially, this is NOT the trial-start gate: the gate sits earlier in
 * the trial (between trials), is participant-paced, has no auto-pass, and
 * its hint flashes after 10 s of inactivity. The imagination period has
 * no input, no flash, no skip; it always lasts exactly its configured
 * duration and only happens once the participant has already armed the
 * trial via the gate.
 *
 * The grid frame is rendered at rotation = 0° so the imagined rotation
 * is in the participant's head, not on the screen. The encoding node
 * then animates the actual rotation (500 ms) and stabilises (1000 ms)
 * before the first slot fires.
 */
export function imaginationNode({
  trial_index_in_block,
  rotation_deg,
  phase,
  background_shade = null,
  durationMs = IMAGINATION_DURATION_MS,
  data = {},
} = {}) {
  const mountId = `imagination-mount-${Math.random().toString(36).slice(2, 9)}`;
  return {
    type: htmlKeyboardResponse,
    stimulus: `<div id="${mountId}" style="margin: 0 auto;"></div>`,
    choices: 'NO_KEYS',
    response_ends_trial: false,
    trial_duration: durationMs,
    on_load: () => {
      const mount = document.getElementById(mountId);
      const frame = createGridFrame({
        rotation_deg: 0,
        fixation: '',
        background_shade,
      });
      mount.appendChild(frame.wrapper);
      stampTrialData('imagination_onset_ts_ms', performance.now());
    },
    data: {
      phase,
      trial_index_in_block,
      rotation_deg,
      frame_rotation_deg: 0,
      duration_ms: durationMs,
      ...data,
    },
  };
}

/**
 * Trial-start gate (both arrow keys together).
 *
 * Every trial begins with the participant pressing ArrowLeft + ArrowRight
 * simultaneously while looking at the persistent grid + bull's-eye ("the
 * empty circle"). This (a) ensures both hands are on the keys before the
 * trial begins so the participant can respond at any moment without
 * finger-finding latency, and (b) gives the participant the agency to
 * start each trial when ready.
 *
 * Gate-first ordering. The rotation-arrow cue
 * (`arrowCueNode`) and the periodic pattern-phase reminder are part
 * of the *trial body*, mounted AFTER the gate — i.e., the participant
 * always sees the empty circle + "press both arrow keys to start the
 * next trial" message first, presses both keys, and only THEN does the
 * pattern reminder / rotation cue render. This makes "presentation of
 * the arrow and pattern is part of the trial" literally true at the
 * timeline level. The `showArrow` / `rotation_deg` parameters are
 * surfaced on the data row for analytic tagging (so
 * analysts can identify imagery vs. non-imagery trials and the
 * per-trial rotation); they do not drive any visual rendering
 * inside this node.
 *
 * No auto-pass. The gate has no `trial_duration` cap — it waits
 * indefinitely for the both-arrow-keys combo. To prompt a participant
 * who has stopped engaging, the hint text begins flashing
 * (opacity-toggling) at `HINT_FLASH_AFTER_MS` (= 10 s) and continues
 * until the gate is armed. There is intentionally no timeout: we never
 * start a trial without an explicit ready signal from the participant.
 *
 * After the gate is passed, the node ends immediately and hands off to
 * the next node in the trial body. For imagery trials that's the
 * (optional) pattern phase, then the arrow cue, then the encoding
 * sequence; for memory-only trials it's directly the encoding node.
 */
export const POST_GATE_DELAY_MS = 0;
/* Time after gate onset at which the hint message starts flashing if the
 * participant hasn't yet pressed both arrow keys. The flashing continues
 * until the gate is armed (the gate never auto-passes — see the docstring
 * above). 10 s is short enough that a wandering participant gets a clear
 * "press the keys" reminder, long enough that an attentive participant
 * never sees the flash on a normal trial. */
export const HINT_FLASH_AFTER_MS = 10_000;
/* Hint flash toggle period — opacity flips every HINT_FLASH_PERIOD_MS once
 * the flash interval is active. */
export const HINT_FLASH_PERIOD_MS = 500;
const HINT_OPACITY_NORMAL = '0.75';
const HINT_OPACITY_DIM = '0.15';
/* Both keys are considered "simultaneous" if both have been registered
 * within this window of each other. 300 ms is loose enough that the
 * participant can press one fractionally before the other; tighter than
 * this risks frustrating participants whose finger timing is uneven. */
const BOTH_KEYS_WINDOW_MS = 300;

export const TRIAL_TYPE_LABELS = Object.freeze({
  d_only: 'Dots',
  t_only: 'Tones',
  i_only: 'Stars',
  i_d: 'Stars + Dots',
  i_t: 'Stars + Tones',
});

export function trialStartGateNode({
  trial_index_in_block,
  showArrow = false,
  rotation_deg = null,
  phase = 'trial_start_gate',
  background_shade = null,
  postGateDelayMs = POST_GATE_DELAY_MS,
  trialType = null,
  data = {},
} = {}) {
  const mountId = `trial-start-gate-mount-${Math.random().toString(36).slice(2, 9)}`;
  const hintId = `trial-start-hint-${Math.random().toString(36).slice(2, 9)}`;
  const labelId = `trial-type-label-${Math.random().toString(36).slice(2, 9)}`;
  return {
    type: htmlKeyboardResponse,
    stimulus: `<div id="${mountId}" style="margin: 0 auto;"></div>`,
    choices: 'NO_KEYS',
    response_ends_trial: false,
    /* No trial_duration cap — the gate waits indefinitely for the both-arrow
     * combo. The flash interval below provides the visible "you need to
     * press the keys" prompt for participants who have stopped engaging. */
    trial_duration: null,
    on_load: () => {
      /* Paint the gate page in the SAME shade as the upcoming trial body
       * so the gate's circle + hint and the subsequent encoding /
       * arrow-cue / pattern phase all render on a single continuous page
       * colour, with no dark→light seam at gate-pass.
       *
       * The shade is also re-applied (idempotently) in the gate-pass
       * `finishGate` closure as defence-in-depth — calling
       * `setTrialPageBackground` with the same value is a no-op, but the
       * second call is a safety net in case any path between gate-mount
       * and gate-pass nudged the page back to dark.
       *
       * When `background_shade` is null/invalid, any lingering trial-bg is
       * cleared so the gate sits on the dark UI surface. */
      if (isValidBackgroundShade(background_shade)) {
        setTrialPageBackground(background_shade);
      } else {
        clearTrialPageBackground();
      }
      /* Tear down any leftover narration UI from the preceding instruction /
       * demo arc. Two pieces:
       *   - The voice-toggle pill (top-right of the viewport) is mounted by
       *     the slide-narration observer when it first hands a slide to the
       *     engine; once we cross into trial bodies the pill has nothing
       *     left to control and would only compete with the stimulus, so
       *     we unmount here. The observer will re-mount it the next time a
       *     `[data-voiceover-target]` enters the DOM.
       *   - Any in-flight utterance from a narrated screen that the
       *     participant advanced past quickly. `engine.cancel()` stops the
       *     speech-synth and finalises the controller — without this, a
       *     trailing word can audibly land on top of the gate. Idempotent
       *     when nothing is active. */
      unmountVoiceoverToggle();
      try {
        getVoiceover().cancel();
      } catch {
        /* Engine init touches `localStorage` / `document`; in the rare
         * case those throw under restricted-storage modes, swallow — the
         * trial gate must not be brittle. */
      }
      const mount = document.getElementById(mountId);
      /* Forward `background_shade` so the bull's-eye ring + centre dot
       * (and any future fixation overlay) recolour to the dark-on-light
       * palette when the gate paints on white / gray. Without this,
       * `createGridFrame` would use the dark-theme white-on-black colours
       * (BULLSEYE_COLOUR / FIXATION_MARK_COLOUR) which become invisible
       * once the page is already light. Passing `background_shade: null`
       * (non-trial use) keeps the dark-theme palette. */
      const frame = createGridFrame({
        rotation_deg: 0,
        fixation: '',
        background_shade,
      });
      mount.appendChild(frame.wrapper);
      stampTrialData('trial_start_gate_onset_ts_ms', performance.now());

      /* Overall main-trial counter: only stamped during Main A / Main B by
       * `generateMainBlockPair`. When present, mount or update the dim
       * top-left "Trial X / N" overlay. The overlay persists across every
       * sub-node of this trial and gets refreshed at the next gate. */
      const overallN = data?.main_trial_number_overall;
      const overallTotal = data?.main_trial_total;
      const overallType = data?.main_trial_type;
      if (Number.isFinite(overallN) && Number.isFinite(overallTotal)) {
        setTrialCounter(overallN, overallTotal, overallType);
      }

      /* Trial-start hint at the bottom of the viewport
       * (`position: fixed; bottom: 30px; font-size: 18px`). Appended to <body> so it sits
       * on top of the jsPsych content area regardless of where the grid
       * mount is. Removed when the gate passes (both keys down) so it
       * does not bleed into the encoding sequence.
       *
       * Rendered as a high-contrast pill (black text on a
       * white rectangle with a thin black border) — same pattern as the
       * `continueHintHtml` instruction-page pill — so the cue stays
       * legible across the dark UI surface AND any light-trial page
       * background (white / gray) without needing a separate cascade
       * override per trial shade. `white-space: nowrap` keeps the
       * one-line sentence inside a snug rectangle that hugs the text. */
      const hintEl = document.createElement('div');
      hintEl.id = hintId;
      hintEl.className = 'trial-start-hint';
      hintEl.textContent = 'Press both Left and Right arrow keys to start the next trial.';
      hintEl.setAttribute(
        'style',
        [
          'position: fixed',
          'bottom: 30px',
          'left: 50%',
          'transform: translateX(-50%)',
          'background: #FFFFFF',
          'color: #000000',
          'font-size: 18px',
          'font-weight: 600',
          'line-height: 1.3',
          'padding: 0.55rem 1.1rem',
          'border: 1.5px solid #000000',
          'border-radius: 0.55rem',
          'box-shadow: 0 1px 2px rgba(0,0,0,0.10)',
          `opacity: ${HINT_OPACITY_NORMAL}`,
          'pointer-events: none',
          'z-index: 1000',
          'font-family: system-ui, sans-serif',
          'letter-spacing: 0.01em',
          'white-space: nowrap',
          /* Animate opacity changes so the flash is a smooth pulse rather
           * than a jarring blink. */
          'transition: opacity 200ms linear',
        ].join('; ') + ';'
      );
      document.body.appendChild(hintEl);

      let labelEl = null;
      if (trialType && TRIAL_TYPE_LABELS[trialType]) {
        const colour = TRIAL_TYPE_TAG_COLOURS[trialType] || '#888';
        const mmPx =
          parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mm')) || 3;
        const circleTopPx = frame.wrapper.getBoundingClientRect().top;
        const labelTopPx = circleTopPx - 25.4 * mmPx;
        labelEl = document.createElement('div');
        labelEl.id = labelId;
        labelEl.className = 'trial-type-label';
        const dot = document.createElement('span');
        dot.setAttribute(
          'style',
          [
            'display: inline-block',
            'width: 11px',
            'height: 11px',
            'border-radius: 50%',
            `background: ${colour}`,
            `box-shadow: 0 0 0 3px ${colour}40`,
            'margin-right: 9px',
            'flex-shrink: 0',
          ].join('; ') + ';'
        );
        const text = document.createElement('span');
        text.textContent = TRIAL_TYPE_LABELS[trialType];
        labelEl.appendChild(dot);
        labelEl.appendChild(text);
        labelEl.setAttribute(
          'style',
          [
            'position: fixed',
            `top: ${labelTopPx}px`,
            'left: 50%',
            'transform: translateX(-50%) translateY(-100%)',
            'display: inline-flex',
            'align-items: center',
            'background: rgba(255, 255, 255, 0.93)',
            'backdrop-filter: blur(12px)',
            '-webkit-backdrop-filter: blur(12px)',
            'color: #1a1a1a',
            'font-size: 15px',
            'font-weight: 700',
            'line-height: 1',
            'padding: 0.5rem 1.15rem 0.5rem 0.9rem',
            'border: 1px solid rgba(0, 0, 0, 0.10)',
            'border-radius: 999px',
            'box-shadow: 0 4px 16px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.06)',
            'letter-spacing: 0.03em',
            'pointer-events: none',
            'z-index: 1001',
            'user-select: none',
            'font-family: system-ui, sans-serif',
            'white-space: nowrap',
          ].join('; ') + ';'
        );
        document.body.appendChild(labelEl);
      }

      let flashTimeout = null;
      let flashInterval = null;
      let flashDim = false;

      const stopFlashing = () => {
        if (flashTimeout) {
          clearTimeout(flashTimeout);
          flashTimeout = null;
        }
        if (flashInterval) {
          clearInterval(flashInterval);
          flashInterval = null;
        }
        if (hintEl) hintEl.style.opacity = HINT_OPACITY_NORMAL;
      };

      flashTimeout = setTimeout(() => {
        flashTimeout = null;
        flashInterval = setInterval(() => {
          if (!hintEl) return;
          flashDim = !flashDim;
          hintEl.style.opacity = flashDim ? HINT_OPACITY_DIM : HINT_OPACITY_NORMAL;
        }, HINT_FLASH_PERIOD_MS);
      }, HINT_FLASH_AFTER_MS);

      const removeHint = () => {
        stopFlashing();
        if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl);
        if (labelEl && labelEl.parentNode) labelEl.parentNode.removeChild(labelEl);
      };

      const startTs = performance.now();
      let leftDownTs = null;
      let rightDownTs = null;
      let gatePassed = false;
      let gatePassedAtMs = null;

      const removeKeyListeners = () => {
        window.removeEventListener('keydown', onDown, { capture: true });
        window.removeEventListener('keyup', onUp, { capture: true });
      };

      const finishAfterDelay = () => {
        gatePassedAtMs = Math.round(performance.now() - startTs);
        removeHint();
        const finishGate = () => {
          removeKeyListeners();
          /* Stash gate timing on the trial's data row before finishing. */
          const data = window.jsPsych?.getCurrentTrial?.()?.data;
          if (data && typeof data === 'object') {
            data.gate_passed_at_ms = gatePassedAtMs;
            data.gate_post_delay_ms = postGateDelayMs;
          }
          /* Re-affirm the trial-body shade on gate-pass as defence-in-depth.
           * The gate's `on_load` already painted the page to this same
           * shade (so the participant never sees a dark gate followed by a
           * white/gray trial body) — this second call is a no-op when the
           * page is still in the right state and a safety net otherwise.
           * Skipped on bypass paths (e.g. hidden-nav skip-forward that
           * sets trial_duration:0) so they fall through to `on_finish`'s
           * dark default. */
          setTrialPageBackground(background_shade);
          document.body.style.cursor = 'none';
          window.jsPsych?.finishTrial?.();
        };
        if (postGateDelayMs > 0) {
          setTimeout(finishGate, postGateDelayMs);
        } else {
          finishGate();
        }
      };

      /* Failsafe: if the gate ends through any path that bypasses
       * `finishAfterDelay` (e.g. the hidden-nav hook setting
       * `trial_duration: 0`) we still need to remove the hint AND the
       * global Arrow keydown/keyup listeners before the next trial
       * begins. The listeners call `e.preventDefault()` on Arrow keys,
       * so a leaked one would silently swallow probe / star responses
       * on later trials. The teardown closures are stashed on the live
       * trial here so the on_finish handler can run them. */
      const trial = window.jsPsych?.getCurrentTrial?.();
      if (trial && typeof trial === 'object') {
        trial._gate_hint_cleanup = removeHint;
        trial._gate_listeners_cleanup = removeKeyListeners;
      }

      const checkBothDown = (now) => {
        if (gatePassed) return;
        if (leftDownTs === null || rightDownTs === null) return;
        if (Math.abs(leftDownTs - rightDownTs) <= BOTH_KEYS_WINDOW_MS) {
          gatePassed = true;
          finishAfterDelay(now);
        }
      };

      const onDown = (e) => {
        if (e.repeat) return;
        const k = e.key.toLowerCase();
        if (k !== 'arrowleft' && k !== 'arrowright') return;
        e.preventDefault();
        e.stopPropagation();
        const now = performance.now();
        if (k === 'arrowleft') leftDownTs = now;
        if (k === 'arrowright') rightDownTs = now;
        checkBothDown(now);
      };
      const onUp = (e) => {
        const k = e.key.toLowerCase();
        if (k === 'arrowleft') leftDownTs = null;
        if (k === 'arrowright') rightDownTs = null;
      };
      window.addEventListener('keydown', onDown, { capture: true });
      window.addEventListener('keyup', onUp, { capture: true });
    },
    on_finish: () => {
      /* Failsafe cleanup on every termination path that did NOT go through
       * the gate-pass `finishGate` flow (e.g. the hidden-nav skip-forward
       * neutralisation that sets `trial_duration: 0`). The teardown
       * closures were stashed on the live trial during `on_load`. */
      const stale = document.getElementById(hintId);
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
      const staleLabel = document.getElementById(labelId);
      if (staleLabel && staleLabel.parentNode) staleLabel.parentNode.removeChild(staleLabel);
      const liveTrial = window.jsPsych?.getCurrentTrial?.();
      if (liveTrial && typeof liveTrial === 'object') {
        try {
          liveTrial._gate_listeners_cleanup?.();
        } catch (err) {
          console.warn('[trialStartGateNode] listener cleanup threw', err);
        }
        liveTrial._gate_hint_cleanup = null;
        liveTrial._gate_listeners_cleanup = null;
      }
    },
    data: {
      phase,
      trial_index_in_block,
      gate_show_arrow: showArrow,
      gate_rotation_deg: showArrow ? rotation_deg : null,
      gate_trial_type: trialType || null,
      ...data,
    },
  };
}

export function judgeProbeResponse(keyPressed, isTarget) {
  if (keyPressed === null || keyPressed === undefined) return { responded: false, correct: false };
  const k = keyPressed.toLowerCase();
  if (k !== KEY_YES && k !== KEY_NO) return { responded: false, correct: false };
  const said_yes = k === KEY_YES;
  return {
    responded: true,
    said_yes,
    correct: said_yes === isTarget,
  };
}

/**
 * Star (imagery) on/off-pattern judgement. Same physical key bindings as
 * the recognition probe — ArrowRight = "on the rotated pattern" (yes / on),
 * ArrowLeft = "off the pattern" (no / off). We alias the constants under
 * imagery-meaningful names so the call sites in i_only.js / i+d / i+t read
 * clearly without the participant having to learn two different keymaps.
 */
export const KEY_ON = KEY_YES; /* ArrowRight = on-pattern */
export const KEY_OFF = KEY_NO; /* ArrowLeft  = off-pattern */

export function judgeStarResponse(keyPressed, isOnPattern) {
  if (keyPressed === null || keyPressed === undefined) return { responded: false, correct: false };
  const k = keyPressed.toLowerCase();
  if (k !== KEY_ON && k !== KEY_OFF) return { responded: false, correct: false };
  const said_on = k === KEY_ON;
  return {
    responded: true,
    said_on,
    correct: said_on === isOnPattern,
  };
}

/**
 * Append a non-trial data row (e.g. one star judgement emitted from inside an
 * async encoding schedule) to both jsPsych's in-memory collection and the
 * persistent storage backend. jsPsych 8's `data.write()` accepts Trial
 * objects, not arbitrary row payloads, so these auxiliary rows must be
 * inserted explicitly.
 */
export function emitAuxDataRow(row) {
  const datum = { ...rowClock(), ...row };
  if (datum.block_label === 'practice') datum.practice_iteration = getPracticeIteration();

  const dataCollection = window.jsPsych?.data?.get?.();
  if (typeof dataCollection?.push === 'function') {
    dataCollection.push(datum);
  } else {
    console.warn('[shared] jsPsych data collection unavailable for aux row', datum);
  }

  appendTrialRow(datum).catch((err) => {
    console.error('[shared] storage append failed for aux row', err);
    recordWriteFailure(err);
  });
}

/**
 * Play the tone of an auditory recognition probe at the start of its response
 * window and write what the audio context reported at that moment on the
 * running trial's row. A failure to play is recorded on the row
 * (`tone_error`, `tone_error_message`) and does not stop the trial.
 */
export function playProbeTone(cell) {
  const trialData = window.jsPsych?.getCurrentTrial?.()?.data;
  stampTrialData('tone_error', false);
  const fail = (err) => {
    if (!trialData || typeof trialData !== 'object') return;
    trialData.tone_error = true;
    trialData.tone_error_message = String(err?.message ?? err);
  };
  try {
    const ac = getAudioContext();
    stampTrialData('audio_perf_at_onset_ms', performance.now());
    stampTrialData('audio_context_time_at_onset_ms', ac.currentTime * 1000);
    stampTrialData(
      'audio_output_latency_ms',
      Math.round(((ac.outputLatency || 0) + (ac.baseLatency || 0)) * 1000)
    );
    stampTrialData('audio_context', audioContextInfo());
    Promise.resolve(playToneByCell(cell)).catch(fail);
  } catch (err) {
    fail(err);
  }
}
