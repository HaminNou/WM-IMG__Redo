/**
 * Web-Audio DSP primitives.
 *
 * Two operations the experiment needs:
 *   1. playSineTone()    — single-frequency tone with a cosine ramp, mono.
 *   2. buildToneBank()   — the 24-tone log-spaced bank.
 *
 * Levels: the experiment never claims a calibrated SPL — we set a soft
 * digital level (peak ≈ 0.25, ~−12 dBFS) and rely on the volume-
 * calibration step to put the participant's *system* volume in the right
 * neighbourhood. The `target_db_spl` field in config is documentation only.
 */
import { getAudioContext, ensureRunning } from './context.js';

/* Peak amplitude (about -12 dBFS) before the per-tone gain and the participant's volume setting. */
export const DEFAULT_PEAK = 0.25;

/* Registry of in-flight scheduled audio nodes.
 *
 * Web Audio schedules `osc.start(when)` / `osc.stop(when + dur)` against the
 * AudioContext clock. Once scheduled, the oscillator plays at `when`
 * regardless of whether JavaScript control flow has moved on — finishing a
 * jsPsych trial does NOT silence already-scheduled audio. The hidden-nav
 * `U` / `R` keys therefore need a way to interrupt every scheduled tone
 * (currently ringing AND queued for the future) when the experimenter skips
 * a screen mid-playback. Each entry holds the source nodes and the gain
 * nodes that carry their envelopes; `stopAllScheduledAudio` walks the set,
 * cancels each gain's automation, ramps to silence over a short fade
 * (no audible click), and overrides the scheduled stop with `now + fade`.
 * For tones whose `start(when)` time hasn't yet been reached, pinning the
 * gain at 0 before that time means the tone is born silent — exactly what
 * we want. Entries self-deregister via `onended` once playback finishes
 * naturally, so the set stays bounded under normal use. */
const TEARDOWN_FADE_SEC = 0.03;
const scheduledNodes = new Set();

function trackScheduledAudio(entry) {
  scheduledNodes.add(entry);
}

function untrackScheduledAudio(entry) {
  scheduledNodes.delete(entry);
}

/* User-set playback gain. Captured during the combined tone-audibility +
 * comfort calibration step: the participant adjusts an in-page slider
 * while the 24-tone bank sweeps, and the slider position becomes a linear
 * scalar applied multiplicatively to every subsequent `playSineTone` call
 * (peak * gainDb-linear * userPlaybackGain). Default 1.0 leaves all existing call-sites and tests
 * byte-identical until the calibration step writes a new value. The slider
 * UI maps 0–100 % onto a perceptually reasonable 0.0–1.0 linear scale —
 * gain shaping (e.g. a log curve) is the responsibility of the calibration
 * UI, not this module. Setting from outside (`setUserPlaybackGain`) is the
 * only way the value changes; nothing reads the slider directly here. */
let userPlaybackGain = 1.0;

export function setUserPlaybackGain(gain) {
  const g = Number(gain);
  if (!Number.isFinite(g) || g < 0) {
    throw new Error(`setUserPlaybackGain: gain must be finite and ≥ 0, got ${gain}`);
  }
  userPlaybackGain = g;
}

export function getUserPlaybackGain() {
  return userPlaybackGain;
}

/* Audio-mute gate. Necessary because some trial-context schedulers
 * (`runEncodingSchedule` in `t_only.js` / `i_t.js`, the demo loops in
 * `instructions/demos.js`) sit inside `async` functions launched from
 * `on_load` and keep ticking through `await sleep(M_SLOT_MS)` long after
 * the trial has ended — fire-and-forget. When the experimenter presses
 * `U` to skip out of one of those trials, the in-flight scheduler will
 * continue calling `playToneByCell` on its own clock and re-populate the
 * audio scheduler with fresh tones, so a one-shot `stopAllScheduledAudio`
 * is not enough. Setting `audioMuted = true` makes every subsequent
 * `playSineTone` resolves immediately
 * without scheduling anything, until `setAudioMuted(false)` re-enables.
 * The `hidden-nav` skip-forward path raises the gate on `U`, and the
 * `on_trial_start` checkpoint hook drops it again when the next
 * registered checkpoint runs. */
let audioMuted = false;

export function setAudioMuted(muted) {
  audioMuted = !!muted;
  if (audioMuted) stopAllScheduledAudio();
}

/** Test accessor for the mute gate. */
export function __isAudioMutedForTests() {
  return audioMuted;
}

/**
 * Cancel every audio node scheduled via `playSineTone`
 * that has not already self-completed. Each entry is faded to zero over
 * ~30 ms (no click) and its source nodes are stopped just after the fade.
 *
 * Idempotent and safe to call when nothing is scheduled — the early return
 * skips the AudioContext lookup so the function is also safe in non-audio
 * contexts (e.g. unit tests where the context was never constructed).
 */
export function stopAllScheduledAudio() {
  if (scheduledNodes.size === 0) return;
  let ctx;
  try {
    ctx = getAudioContext();
  } catch {
    scheduledNodes.clear();
    return;
  }
  const now = ctx.currentTime;
  for (const entry of scheduledNodes) {
    try {
      for (const gain of entry.gains) {
        const param = gain.gain;
        param.cancelScheduledValues(now);
        /* Pin the parameter to its current computed value so the ramp
         * starts from wherever we are (peak, mid-ramp, or pre-start
         * silence) — `value` returns the most current/computed value per
         * the Web Audio spec. */
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(0, now + TEARDOWN_FADE_SEC);
      }
      for (const src of entry.sources) {
        try {
          src.stop(now + TEARDOWN_FADE_SEC + 0.01);
        } catch {
          /* Source may already be stopped or never started — ignore. */
        }
      }
    } catch {
      /* Best-effort cleanup; never throw. */
    }
  }
  scheduledNodes.clear();
}

/* Raised-cosine onset/offset ramps, built from RAMP_STEPS short linear
 * segments each. With 32 segments the envelope departs from the exact
 * raised cosine by < 0.1 % of the peak (below −60 dB), and only
 * `setValueAtTime` / `linearRampToValueAtTime` are needed, which every
 * browser implements the same way. (A single linear ramp is NOT a cosine
 * ramp: it has a corner at each end and more spectral splatter.) */
const RAMP_STEPS = 32;

function applyCosineRamp(gainNode, ctx, startTime, durationSec, rampSec, peak) {
  const g = gainNode.gain;
  g.setValueAtTime(0, startTime);
  for (let k = 1; k <= RAMP_STEPS; k++) {
    const v = peak * 0.5 * (1 - Math.cos((Math.PI * k) / RAMP_STEPS));
    g.linearRampToValueAtTime(v, startTime + (rampSec * k) / RAMP_STEPS);
  }
  const fallStart = startTime + durationSec - rampSec;
  g.setValueAtTime(peak, fallStart);
  for (let k = 1; k <= RAMP_STEPS; k++) {
    const v = peak * 0.5 * (1 + Math.cos((Math.PI * k) / RAMP_STEPS));
    g.linearRampToValueAtTime(v, fallStart + (rampSec * k) / RAMP_STEPS);
  }
}

/**
 * Schedules a sine tone. Resolves once playback is finished.
 *
 * `gainDb` (optional) applies an extra ±dB scaling on top of `peak` —
 * `peak * 10^(gainDb / 20)`. The 24-tone bank uses this to apply
 * ISO 226:2023 70-phon equal-loudness compensation per tone (Formula (1)
 * evaluated at 70 phons; see `src/audio/equal-loudness.js`); `playToneByIndex` in `tones.js` looks
 * the per-tone value up and forwards it here. Other callers (e.g. the
 * volume-calibration tone) leave `gainDb` undefined and get the
 * uncompensated default.
 *
 * @param {number} freqHz
 * @param {object} opts  { durationMs, rampMs, peak, gainDb, when }
 */
export async function playSineTone(freqHz, opts = {}) {
  if (audioMuted) return;
  await ensureRunning();
  const ctx = getAudioContext();
  const durationSec = (opts.durationMs ?? 350) / 1000;
  const rampSec = (opts.rampMs ?? 10) / 1000;
  const basePeak = opts.peak ?? DEFAULT_PEAK;
  const gainLinear = opts.gainDb !== undefined ? Math.pow(10, opts.gainDb / 20) : 1;
  const peak = basePeak * gainLinear * userPlaybackGain;
  const when = opts.when ?? ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freqHz;

  const gain = ctx.createGain();
  applyCosineRamp(gain, ctx, when, durationSec, rampSec, peak);

  osc.connect(gain).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + durationSec + 0.05);

  const entry = { sources: [osc], gains: [gain] };
  trackScheduledAudio(entry);

  return new Promise((resolve) => {
    osc.onended = () => {
      untrackScheduledAudio(entry);
      resolve();
    };
  });
}

/**
 * Schedules a two-channel sine tone for the headphone check. With
 * `antiphase` the right channel is inverted, so the two channels cancel when
 * both come out of one loudspeaker or leak into each other, and stay
 * distinct on headphones. Same level rules as `playSineTone`.
 *
 * @param {number} freqHz
 * @param {object} opts  { durationMs, rampMs, peak, gainDb, when, antiphase }
 */
export async function playStereoSine(freqHz, opts = {}) {
  if (audioMuted) return;
  await ensureRunning();
  const ctx = getAudioContext();
  const durationSec = (opts.durationMs ?? 1000) / 1000;
  const rampSec = (opts.rampMs ?? 25) / 1000;
  const basePeak = opts.peak ?? DEFAULT_PEAK;
  const gainLinear = opts.gainDb !== undefined ? Math.pow(10, opts.gainDb / 20) : 1;
  const peak = basePeak * gainLinear * userPlaybackGain;
  const when = opts.when ?? ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freqHz;

  const envelope = ctx.createGain();
  applyCosineRamp(envelope, ctx, when, durationSec, rampSec, peak);

  const merger = ctx.createChannelMerger(2);
  const left = ctx.createGain();
  const right = ctx.createGain();
  right.gain.value = opts.antiphase ? -1 : 1;

  osc.connect(envelope);
  envelope.connect(left).connect(merger, 0, 0);
  envelope.connect(right).connect(merger, 0, 1);
  merger.connect(ctx.destination);
  osc.start(when);
  osc.stop(when + durationSec + 0.05);

  const entry = { sources: [osc], gains: [envelope] };
  trackScheduledAudio(entry);

  return new Promise((resolve) => {
    osc.onended = () => {
      untrackScheduledAudio(entry);
      resolve();
    };
  });
}

/**
 * Builds the 24-tone bank as { index, freq_hz } for the analytic cell↔tone
 * mapping. Tones are *audio-only* — never rendered visually.
 *
 * Spacing is **logarithmic between two anchors**, not on the chromatic scale.
 * A chromatic spec (220 × 2^((k−1)/12), 24 semitones spanning
 * A3..G♯5) would be identifiable to musically trained participants — every tone
 * landed on a named pitch class, opening a re-encoding strategy (note-name
 * mnemonics) the analyst cannot disambiguate from genuine auditory WM.
 *
 * The spacing adapts Li, Cowan, & Saults (2013, *Attention, Perception &
 * Psychophysics* 75(1), 145–160; methods at p. 150) to a 24-tone variant.
 * Li et al. used 12 sine tones from 200 Hz to 3900 Hz with a 31 %
 * neighbour-step (~ 19.5× total ratio, far from any Western interval) plus an
 * explicit "no simple harmonic relationship" check, yielding tones that are
 * not nameable as pitches. We preserve the same anchor band (200–3900 Hz,
 * within Sek & Moore 1995's similar-DLF range) and the same log-spacing
 * principle, but at 24 tones the step ratio becomes
 *   r = (highFreqHz / lowFreqHz)^(1 / (count − 1)) ≈ 1.138 (≈ 13.8 %)
 * — distinct from any Western interval (semitone 5.9 %, whole-tone 12.25 %,
 * minor third 18.92 %, etc.). The companion test in `tests/tones.test.js`
 * pins the no-clean-harmonic invariant pairwise across the bank.
 *
 * @param {number} count        number of tones (24)
 * @param {number} lowFreqHz    frequency of the lowest tone (rank 1)
 * @param {number} highFreqHz   frequency of the highest tone (rank `count`)
 */
export function buildToneBank(count, lowFreqHz, highFreqHz) {
  if (count < 2) {
    throw new Error(`buildToneBank: count must be ≥ 2, got ${count}`);
  }
  if (!(lowFreqHz > 0) || !(highFreqHz > lowFreqHz)) {
    throw new Error(
      `buildToneBank: require 0 < lowFreqHz (${lowFreqHz}) < highFreqHz (${highFreqHz})`
    );
  }
  const ratio = highFreqHz / lowFreqHz;
  const tones = [];
  for (let i = 0; i < count; i++) {
    tones.push({
      index: i,
      freq_hz: lowFreqHz * Math.pow(ratio, i / (count - 1)),
    });
  }
  return tones;
}
