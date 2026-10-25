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

import { rowClock } from '../clock.js';

let audioCtx = null;
let unlocked = false;

/* Audio-state log. The context can leave `running` without any action by the
 * participant: Safari sets `interrupted` after a call, a headset change or a
 * tab switch, and Chrome suspends an idle context. Each change is written as
 * one row (`audio_state_change`) so the analyst can see which sessions had
 * silent stretches, and a suspended or interrupted context is resumed at once.
 * The runner supplies the row writer; nothing here depends on storage. */
const STATE_LOG_MAX = 50;
let stateLogger = null;
let stateLogged = 0;

/** @param {((row: object) => unknown)|null} fn  writes one row; null stops logging */
export function setAudioStateLogger(fn) {
  stateLogger = typeof fn === 'function' ? fn : null;
}

function onStateChange() {
  try {
    const state = audioCtx?.state;
    if (stateLogger && stateLogged < STATE_LOG_MAX) {
      stateLogged += 1;
      let clock = {};
      try {
        clock = rowClock();
      } catch {
        clock = {};
      }
      const written = stateLogger({
        phase: 'audio_state_change',
        audio_state: state ?? null,
        ts: performance.now(),
        ...clock,
      });
      if (written && typeof written.catch === 'function') written.catch(() => {});
    }
    if (state === 'suspended' || state === 'interrupted') {
      /* Outside a user gesture this can be refused; the next tone's
       * `ensureRunning()` and the next key press try again. */
      Promise.resolve(audioCtx.resume()).catch(() => {});
    }
  } catch {
    /* A state listener must never throw. */
  }
}

export function getAudioContext() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) {
      throw new Error('Web Audio API not available in this browser.');
    }
    audioCtx = new Ctor();
    audioCtx.addEventListener?.('statechange', onStateChange);
  }
  return audioCtx;
}

/**
 * Must be called from inside a user-gesture handler (button click, keypress).
 * Returns a promise that resolves once the context is in `running` state.
 */
export async function unlockAudio() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
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
  if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') {
    await audioCtx.resume();
  }
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * State of the audio context as reported by the browser. Base latency is the
 * context's own processing delay, output latency the delay to the audio
 * device; they are kept apart. `null` if the context cannot be created.
 *
 * @returns {{sample_rate_hz: number, state: string, base_latency_ms: number|null, output_latency_ms: number|null}|null}
 */
export function audioContextInfo() {
  try {
    const ac = getAudioContext();
    return {
      sample_rate_hz: ac.sampleRate,
      state: ac.state,
      base_latency_ms: Number.isFinite(ac.baseLatency) ? round1(ac.baseLatency * 1000) : null,
      output_latency_ms: Number.isFinite(ac.outputLatency) ? round1(ac.outputLatency * 1000) : null,
    };
  } catch {
    return null;
  }
}
