/**
 * Combined tone audibility + playback-comfort calibration.
 *
 * One screen, three jobs:
 *
 *   1. Familiarise the participant with the full 24-tone bank by sweeping
 *      it in ascending pitch order. Each tone briefly highlights its own
 *      numbered box (1..24, no frequency labels — the cell↔tone mapping
 *      is analytic-only per design §3.2 / §3.3 and the Hz values are
 *      irrelevant to the participant).
 *   2. Let the participant set the experiment's playback gain to a
 *      comfortable level via an in-page slider whose value scales every
 *      subsequent tone the experiment plays (`setUserPlaybackGain`,
 *      consumed inside `playSineTone`).
 *      The page upstream (`speakerVolumeInstructionTrial`) has already
 *      anchored their system volume near 50 %, so the slider here has
 *      headroom in both directions.
 *   3. Carry the surviving audibility self-report. Pressing
 *      "I'm comfortable — continue" stamps `tones_audible: true`. If the
 *      sweep cycles through the bank ten times without a press, the
 *      page advances itself and stamps `tones_audible: false`, which
 *      fires the existing `toneAudibilityExit` gate (friendly close +
 *      `jsPsych.abortExperiment()`).
 *
 * One combined screen: the participant has only one decision to make
 * here — "comfortable, audible, all 24 land". The 24-box layout + live
 * slider lets them iterate on volume in real time.
 *
 * Tone scheduling is on the AudioContext clock (drift-free across the
 * 32-s-per-sweep cycle); each sweep is enqueued tone-by-tone so a slider
 * change takes effect on the very next tone (already-scheduled tones
 * have their gain baked into the envelope at schedule time and cannot
 * be retroactively rescaled).
 *
 * Box-highlight class follows the tone-explorer.html convention
 * (.playing toggles the accent fill) so the UI is visually familiar to
 * anyone who used the in-house bank-explorer tool.
 */
import htmlButtonResponse from '@jspsych/plugin-html-button-response';
import { getToneBank, playToneByIndex } from '../audio/tones.js';
import { getAudioContext } from '../audio/context.js';
import { setUserPlaybackGain, stopAllScheduledAudio } from '../audio/dsp.js';
import { config } from '../config.js';
import { registerHiddenNavStep, trackHiddenNavNode } from '../hidden-nav.js';
import { screenOutExit } from '../screen-out.js';
import { getVoiceover } from '../visuals/voiceover.js';

/* Inter-tone silence within one sweep. 200 ms is short enough to keep
 * the full 24-tone sweep brisk (~13 s end-to-end) so the participant
 * can iterate the slider against the entire pitch range without waiting
 * out a long-running cycle, while still leaving a clear gap between
 * successive tones so each one reads as a distinct event. */
const INTER_TONE_MS = 200;

/* Inter-sweep silence. Half-second gap signals "the cycle restarted"
 * without making the page feel idle. */
const INTER_SWEEP_MS = 500;

/* Audio-clock lead-in so the first tone of the first sweep doesn't fire
 * before the page has finished its layout / paint. */
const AUDIO_LEAD_IN_MS = 50;

/* Hard cap. At 24 × (350 + 200) ms ≈ 13.2 s per sweep, ten sweeps is a
 * ~2.2-minute envelope — comfortable for adjustment, intolerable as a
 * default outcome, so a participant who can't find a comfort setting
 * routes to the audibility-fail exit. */
export const MAX_SWEEPS = 10;

/* Initial slider position. Multiplied by 0.01 to obtain the linear
 * gain scalar passed to `setUserPlaybackGain` (so 50 % → 0.5). */
const SLIDER_DEFAULT_PCT = 50;

const ACCENT_COLOUR = '#60a5fa'; /* tailwind blue-400 — matches existing chrome */

function waitUntilAudioTime(ctx, targetTimeSec) {
  return new Promise((resolve) => {
    const poll = () => {
      const remainingMs = (targetTimeSec - ctx.currentTime) * 1000;
      if (remainingMs <= 0) {
        resolve();
        return;
      }
      setTimeout(poll, Math.min(remainingMs, 10));
    };
    poll();
  });
}

function buildBoxesHtml(count) {
  const cells = [];
  for (let i = 0; i < count; i++) {
    cells.push(`<div class="tac-box" id="tac-box-${i}" data-idx="${i}">${i + 1}</div>`);
  }
  return cells.join('');
}

/**
 * Combined tone audibility + comfort calibration trial.
 *
 * Outcome data:
 *   - phase: 'tone_audibility_and_comfort'
 *   - tones_audible: boolean (true if user pressed Yes; false if 10-sweep cap hit)
 *   - user_playback_gain: 0..1 linear scalar applied to subsequent audio
 *   - user_playback_pct: 0..100 raw slider value
 *   - sweeps_completed: integer count of sweeps started (1..MAX_SWEEPS)
 */
export function toneAudibilityAndComfortTrial() {
  const stepId = 'tone_audibility_and_comfort';

  /* Closure state. Reset on each trial mount via `on_load`. */
  let stopped = false;
  let timedOut = false;
  let userPressedYes = false;
  let sweepsCompleted = 0;
  let lastSliderPct = SLIDER_DEFAULT_PCT;
  let nSliderInputs = 0;
  let minPct = SLIDER_DEFAULT_PCT;
  let maxPct = SLIDER_DEFAULT_PCT;
  let tLoad = 0;
  let tFirstInput = null;

  const node = {
    type: htmlButtonResponse,
    stimulus: `
      <style>
        .tac-bank {
          display: grid;
          grid-template-columns: repeat(8, 1fr);
          gap: 8px;
          max-width: 36rem;
          margin: 0 auto 1.5rem;
          padding: 0;
        }
        .tac-box {
          aspect-ratio: 1 / 1;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255, 255, 255, 0.45);
          color: rgba(0, 0, 0, 0.65);
          border: 1px solid rgba(0, 0, 0, 0.2);
          border-radius: 4px;
          font-family: monospace;
          font-size: 0.95rem;
          font-variant-numeric: tabular-nums;
          user-select: none;
          transition: background 60ms linear, color 60ms linear, transform 60ms linear;
        }
        .tac-box.playing {
          background: ${ACCENT_COLOUR};
          color: #0b1220;
          font-weight: 600;
          transform: scale(1.06);
        }
        .tac-slider-wrap {
          max-width: 36rem;
          margin: 0 auto 1.25rem;
        }
        .tac-slider-wrap input[type=range] { width: 100%; }
        .tac-slider-readout {
          display: flex;
          justify-content: space-between;
          font-size: 0.85rem;
          opacity: 0.7;
          margin-top: 0.25rem;
          font-variant-numeric: tabular-nums;
        }
        .tac-instructions {
          max-width: 38rem;
          margin: 0 auto 1.25rem;
        }
      </style>
      <h2>Adjust the volume to a comfortable level</h2>
      <div data-voiceover-target data-tac-narration>
        <p class="tac-instructions">
          ${config.tones.count} tones will start playing in a loop in a
          moment, from low to high. Each box lights up while its tone
          plays. Use the slider below to set a level that is
          <strong>clearly audible but never uncomfortably loud</strong>,
          even on the very lowest and very highest tones.
        </p>
        <p class="tac-instructions">
          When the level feels right, click
          <strong>I'm comfortable — continue</strong>.
        </p>
      </div>
      <div class="tac-bank" id="tac-bank" aria-label="24 tones">
        ${buildBoxesHtml(config.tones.count)}
      </div>
      <div class="tac-slider-wrap">
        <input
          id="tac-slider"
          type="range"
          min="0"
          max="100"
          step="1"
          value="${SLIDER_DEFAULT_PCT}"
          aria-label="Playback volume"
        />
        <div class="tac-slider-readout">
          <span>quieter</span>
          <span id="tac-slider-readout">${SLIDER_DEFAULT_PCT}%</span>
          <span>louder</span>
        </div>
      </div>
    `,
    choices: ["I'm comfortable — continue"],
    /* The button opens after one complete sweep of all tones has played. */
    button_html: (label) =>
      `<button class="jspsych-btn" id="tac-yes-btn" disabled aria-disabled="true" style="opacity: 0.55">${label}</button>`,
    on_load: async () => {
      /* Closure reset — `on_load` is called fresh each time jsPsych
       * mounts the trial (including the rare retry path triggered by
       * hidden-nav navigation). */
      stopped = false;
      timedOut = false;
      userPressedYes = false;
      sweepsCompleted = 0;
      lastSliderPct = SLIDER_DEFAULT_PCT;
      nSliderInputs = 0;
      minPct = SLIDER_DEFAULT_PCT;
      maxPct = SLIDER_DEFAULT_PCT;
      tFirstInput = null;
      tLoad = performance.now();

      /* === Voiceover gating ===
       *
       * Read-aloud is scoped to the per-task demos only (see the comment block at the
       * observer-install site in `runner.js`). The calibration intro therefore runs silent: no
       * narrateInPlace, no toggle pill, no spacebar-skip binding. The
       * 24-tone sweep starts as soon as `on_load` settles, gated only
       * by the no-op `narrationDone` resolved Promise so the downstream
       * `await narrationDone` site keeps its shape (and any future
       * re-enable just plugs a real controller back in). */
      const narrationDone = Promise.resolve();

      /* Apply the default slider position immediately so the very first
       * tone the participant hears is at the configured default gain
       * (rather than at whatever an earlier trial left in the module
       * scalar). */
      setUserPlaybackGain(SLIDER_DEFAULT_PCT / 100);

      const slider = document.getElementById('tac-slider');
      const readout = document.getElementById('tac-slider-readout');
      if (slider) {
        slider.addEventListener('input', () => {
          const pct = Number(slider.value);
          lastSliderPct = pct;
          nSliderInputs += 1;
          minPct = Math.min(minPct, pct);
          maxPct = Math.max(maxPct, pct);
          if (tFirstInput === null) tFirstInput = performance.now() - tLoad;
          if (readout) readout.textContent = `${pct}%`;
          /* Linear 0..100 → 0..1. A perceptual log curve was rejected:
           * the participant is solving for "comfortable" which is a
           * subjective destination they can iterate toward; a linear
           * mapping keeps the slider's centre near the 50 % anchor
           * left by the previous step. */
          setUserPlaybackGain(pct / 100);
        });
      }

      /* User-press sentinel. The 10-sweep timeout path advances the
       * timeline by synthesising a click on this button (`btn.click()`
       * fires both htmlButtonResponse's own handler and our listener
       * here), so the listener cannot blindly flip `userPressedYes` on
       * every click. The `timedOut` flag is set BEFORE the synthetic
       * click in `on_load`, and our listener gates the press flag on
       * `!timedOut` — meaning the synthetic click leaves
       * `userPressedYes` false (correct: timeout, not a press) while a
       * genuine participant click flips it true.
       *
       * `{ capture: true }` is critical: htmlButtonResponse registers
       * its own click listener on this button during plugin setup
       * (which runs BEFORE `on_load`), and that listener synchronously
       * calls `finishTrial`, which synchronously runs `on_finish` —
       * reading `userPressedYes` before any later-registered bubble
       * listener gets a chance to flip the flag. Capture-phase listeners
       * fire before bubble-phase listeners regardless of registration
       * order, so this guarantees our flag is set before `on_finish`
       * reads it. (Without capture, a bubble-phase ordering could read
       * `userPressedYes` as false and misclassify a real click.) */
      const yesBtn = document.getElementById('tac-yes-btn');
      if (yesBtn) {
        yesBtn.addEventListener(
          'click',
          () => {
            if (!timedOut) userPressedYes = true;
            stopped = true;
          },
          { capture: true }
        );
      }

      /* Await narration completion before any tone fires. With read-
       * aloud disabled on calibration screens (see the voiceover-gating
       * comment above), `narrationDone` is a resolved Promise and this
       * await is a microtask handoff — the sweep starts immediately on
       * the next tick. The await is preserved so a future re-enable
       * just swaps the Promise back to a real controller's `done` and
       * the gating semantics return unchanged. If the user clicked
       * Continue during the microtask, `stopped` is already true and
       * the sweep loop below short-circuits without firing any tone. */
      await narrationDone;
      if (stopped) return;

      /* Sweep loop. Each sweep schedules tones one at a time so the
       * slider's current value is captured at each tone's schedule
       * moment. Highlighting is gated to the audio clock for
       * drift-free sync. */
      const ctx = getAudioContext();
      const tones = getToneBank();
      const durationSec = config.tones.duration_ms / 1000;
      const stepSec = (config.tones.duration_ms + INTER_TONE_MS) / 1000;
      const interSweepSec = INTER_SWEEP_MS / 1000;

      const boxEls = [];
      for (let i = 0; i < tones.length; i++) {
        boxEls.push(document.getElementById(`tac-box-${i}`));
      }

      let cursorSec = ctx.currentTime + AUDIO_LEAD_IN_MS / 1000;

      try {
        for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
          if (stopped) break;
          sweepsCompleted = sweep + 1;
          for (let i = 0; i < tones.length; i++) {
            if (stopped) break;
            const onsetSec = cursorSec;
            playToneByIndex(i, { when: onsetSec });
            await waitUntilAudioTime(ctx, onsetSec);
            if (stopped) break;
            const box = boxEls[i];
            if (box) box.classList.add('playing');
            await waitUntilAudioTime(ctx, onsetSec + durationSec);
            if (box) box.classList.remove('playing');
            cursorSec = onsetSec + stepSec;
          }
          if (sweep === 0) {
            const yesBtn = document.getElementById('tac-yes-btn');
            if (yesBtn) {
              yesBtn.disabled = false;
              yesBtn.setAttribute('aria-disabled', 'false');
              yesBtn.style.opacity = '';
            }
          }
          /* Inter-sweep gap. */
          if (!stopped) {
            await waitUntilAudioTime(ctx, cursorSec + interSweepSec);
            cursorSec += interSweepSec;
          }
        }
      } catch {
        /* Any unexpected audio failure (e.g. context closed during
         * teardown) should not throw out of `on_load`; the timeout
         * path below still finalises the trial cleanly. */
      }

      /* Timeout: 10 sweeps elapsed without a Yes. Mark the timeout
       * sentinel and synthesise a click on the Yes button — htmlButton-
       * Response's own click handler then advances the timeline. */
      if (!userPressedYes && !stopped) {
        timedOut = true;
        const btn = document.getElementById('tac-yes-btn');
        if (btn) btn.click();
      }
    },
    on_finish: (data) => {
      /* Drop any tones still ringing from a fast Yes-click mid-tone
       * — `stopAllScheduledAudio` fades them over ~30 ms so the next
       * trial does not start under residual playback. */
      stopAllScheduledAudio();
      /* Defence-in-depth: cancel any narration still in flight. With
       * read-aloud disabled on this screen the engine's `current`
       * controller should be null/finished, but a demo immediately
       * preceding this trial (in test/sandbox flows) could have left a
       * live controller behind. Cheap to check, safe to call. */
      const vo = getVoiceover();
      if (vo.current && !vo.current._state?.finished) vo.current.cancel();
      data.tones_audible = userPressedYes && !timedOut;
      data.user_playback_pct = lastSliderPct;
      data.user_playback_gain = lastSliderPct / 100;
      data.sweeps_completed = sweepsCompleted;
      data.n_slider_inputs = nSliderInputs;
      data.slider_min_pct = minPct;
      data.slider_max_pct = maxPct;
      data.t_first_slider_input_ms = tFirstInput === null ? null : Math.round(tFirstInput);
      data.applied_peak_dbfs = 20 * Math.log10(0.25 * (lastSliderPct / 100) || 1e-6);
    },
    data: { phase: 'tone_audibility_and_comfort' },
  };
  registerHiddenNavStep(stepId, toneAudibilityAndComfortTrial);
  return trackHiddenNavNode(node, stepId);
}

/**
 * Screen-out exit if the audibility/comfort step timed out without a Yes
 * (10 sweeps elapsed). The session ends through the shared screen-out path
 * so none of the practice or main-task nodes execute.
 */
export function toneAudibilityExit() {
  return screenOutExit({
    phase: 'tone_audibility_fail',
    exitReason: 'tones_not_audible',
    flush: true,
    reasonHtml: `
      <h2>Sorry, the audio does not seem to be coming through</h2>
      <p>
        Without a comfortable, clearly audible setting for every tone, the
        task cannot be completed accurately.
      </p>
    `,
    /* Fires only if the most recent audibility/comfort row reports
     * `tones_audible === false`. A natural Yes (the common path)
     * leaves `tones_audible === true` and skips this exit cleanly. */
    condition: () => {
      const last = window.jsPsych?.data
        ?.get()
        .filter({ phase: 'tone_audibility_and_comfort' })
        .last(1)
        .values()[0];
      return last ? last.tones_audible === false : false;
    },
  });
}
