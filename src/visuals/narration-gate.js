/**
 * Keep a screen's continue key locked until its voiceover has finished.
 *
 * `gateUntilNarrationEnds(controller, onOpen)` watches the controller that the voiceover engine
 * returns for a narration (`narrateNowIfPresent()`, `getVoiceover().narrateInPlace(...)`) and calls
 * `onOpen(info)` exactly once, when it is time to let the participant continue:
 *
 *   - `narration_end`  the recording played to its end (the last word is revealed first);
 *   - `voice_off`      the participant's voice toggle is off (at the start, or switched off while
 *                      the recording played);
 *   - `no_audio`       there is nothing to wait for: no controller, no recording for this text, the
 *                      recording failed to load, or the browser blocked playback;
 *   - `timeout`        safety net: the recording started but never reported its end. Limit =
 *                      the engine's own watchdog for the recording (expected duration + 3 s) plus
 *                      `NARRATION_GATE_SLACK_MS`, never more than `NARRATION_GATE_MAX_MS`.
 *
 * The participant can therefore never be stuck. `info` is
 * `{ gate_reason, space_enabled_after_ms, narration_finished }`; `space_enabled_after_ms` is null
 * when the gate opened at once (nothing was ever locked).
 *
 * The helper owns no DOM and no keyboard listener; the screen decides what "locked" looks like and
 * which key it listens for (see `mainAIntroNode`). It returns `{ dispose, isOpen, info }`; call
 * `dispose()` on every exit path so no timer or promise callback fires into a finished trial.
 */
import { getVoiceover } from './voiceover.js';

export const NARRATION_GATE_MAX_MS = 120_000;
export const NARRATION_GATE_SLACK_MS = 2_000;
/* Until the recording is resolved (manifest fetch and hashing) the limit is this one. */
export const NARRATION_GATE_START_MS = 15_000;

export const GATE_REASONS = Object.freeze(['narration_end', 'voice_off', 'timeout', 'no_audio']);

function defaultIsMuted() {
  try {
    return !!getVoiceover().muted;
  } catch {
    return false;
  }
}

/**
 * @param {object|null|undefined} controller  engine controller (`done`, `_started`, `_state`)
 * @param {(info: {gate_reason: string, space_enabled_after_ms: number|null, narration_finished: boolean}) => void} onOpen
 * @param {{isMuted?: () => boolean, now?: () => number}} [opts]
 */
export function gateUntilNarrationEnds(controller, onOpen, opts = {}) {
  const isMuted = opts.isMuted ?? defaultIsMuted;
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  let opened = false;
  let disposed = false;
  let timer = null;
  let result = null;
  let sync = true;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const open = (reason) => {
    if (opened || disposed) return;
    opened = true;
    clear();
    result = {
      gate_reason: reason,
      space_enabled_after_ms: sync ? null : Math.round(now() - t0),
      narration_finished: reason === 'narration_end',
    };
    onOpen(result);
  };
  const arm = (ms) => {
    clear();
    timer = setTimeout(() => open('timeout'), Math.max(0, ms));
  };

  if (isMuted() || !controller) {
    open(isMuted() ? 'voice_off' : 'no_audio');
    sync = false;
    return { dispose: () => (disposed = true), isOpen: () => opened, info: () => result };
  }

  arm(NARRATION_GATE_START_MS);
  const state = controller._state ?? {};

  Promise.resolve(controller._started).then(
    () => {
      if (opened || disposed) return;
      if (state.finished) return; /* `done` decides */
      if (!state.audioEl) {
        open('no_audio'); /* silent typing-speed reveal: no recording to wait for */
        return;
      }
      const limit = Math.min(
        (state.audioLimitMs ?? NARRATION_GATE_START_MS) + NARRATION_GATE_SLACK_MS,
        NARRATION_GATE_MAX_MS
      );
      arm(limit - (now() - t0));
    },
    () => open('no_audio')
  );

  Promise.resolve(controller.done).then((how) => {
    if (opened || disposed) return;
    if (state.audioEnded) open('narration_end');
    else if (isMuted()) open('voice_off');
    else if (how === 'completed' && state.audioPlaying) open('timeout');
    else open('no_audio'); /* blocked, failed, cancelled or skipped without sound */
  });

  sync = false;
  return {
    dispose: () => {
      disposed = true;
      clear();
    },
    isOpen: () => opened,
    info: () => result,
  };
}
