/**
 * Singleton AudioContext with user-gesture unlock.
 *
 * Browsers block AudioContext.start() until the user has interacted with the
 * page (consent button click counts). We construct the context lazily on first
 * unlock, then reuse it for every tone in the task.
 *
 * Some browsers (Safari, some Chrome configs) auto-suspend the AudioContext
 * after ~30 s of audio silence. `ensureRunning()` re-resumes it before any
 * tone playback so that a practice re-loop or a long instruction screen
 * doesn't silently kill subsequent audio.
 *
 * Sample rate is left to the browser default (typically 44.1 or 48 kHz). Our
 * stimuli are all in the 200–3900 Hz band so any rate ≥ 8 kHz is fine.
 */

let audioCtx = null;
let unlocked = false;

export function getAudioContext() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      throw new Error('Web Audio API not available in this browser.');
    }
    audioCtx = new Ctor();
  }
  return audioCtx;
}

/**
 * Must be called from inside a user-gesture handler (button click, keypress).
 * Returns a promise that resolves once the context is in `running` state.
 */
export async function unlockAudio() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  if (!unlocked) {
    /* Some Safari builds need a silent buffer pulse before they accept later
     * scheduled tones. Cheap insurance — runs once. */
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    unlocked = true;
  }
  return ctx;
}

/**
 * Re-resume the AudioContext if it has been auto-suspended by the browser.
 * Safe to call outside a user gesture — `resume()` only requires a gesture
 * the FIRST time; subsequent calls after an auto-suspend succeed without one
 * in every major browser. Called by `playSineTone` before
 * scheduling any audio node.
 *
 * @returns {Promise<void>}
 */
export async function ensureRunning() {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
}
