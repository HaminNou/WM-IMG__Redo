/**
 * Top-level jsPsych timeline assembly.
 *
 * Session flow:
 *   1. Calibration chain.
 *   2. Instructions + interleaved per-type practice: each task's teaching
 *      screen is followed immediately by that task's practice trials; three
 *      typed-instruction attention checks sit at the boundaries of the
 *      memory / imagery / dual teaching arcs. The whole block is wrapped in
 *      a single jsPsych `loop_function` gated on cumulative practice
 *      accuracy versus the criterion (= 0.7), with one re-loop allowed.
 *   3. Main A: 60 trials (12 x 5 types).
 *   4. Inter-block rest: 30 s forced countdown.
 *   5. Main B: 60 trials (12 x 5 types).
 *   6. The display guard is switched off, then the questionnaire chain: strategy questionnaire (19 items across five
 *      condition-specific pages; see src/questionnaire/strategy.js) and
 *      music-experience covariate (Gold-MSI MT subscale + AP self-report).
 *   7. Upload: the pending rows from IndexedDB are POSTed per bucket to the
 *      configured endpoint, with timeouts, retry/backoff and a JSON-download
 *      fallback; the participant is released after a bounded wait.
 *   8. Completion redirect: countdown then `window.location.href` to the
 *      Prolific completion URL (or test-build notice if the URL is still
 *      the placeholder).
 *
 * Each per-trial data row is mirrored into IndexedDB on `on_data_update` so
 * a participant who crashes the browser mid-session loses at most the
 * in-flight trial. The Prolific completion URL is also persisted at session
 * start so the participant can retrieve it manually if the network is down
 * at completion time.
 */
import { initJsPsych } from 'jspsych';

import { initSession } from './prolific.js';
import { assembleCalibrationChain } from './calibration/index.js';
import { getVisibilityEvents } from './calibration/fullscreen.js';
import { generateMainBlockPair } from './scheduler/main-blocks.js';
import { restNode } from './conditions/rest.js';
import { uploadProgressNode, completionRedirectNode } from './conditions/debrief.js';
import { initStorage, appendTrialRow, recordWriteFailure } from './storage.js';
import { assembleInstructionsAndPractice } from './instructions/index.js';
import { assembleQuestionnaireChain } from './questionnaire/index.js';
import { installHiddenNav, getHiddenNavTrialStartHook } from './hidden-nav.js';
import { getToneBank } from './audio/tones.js';
/* Note: `installVoiceoverSlideObserver` is intentionally NOT imported any
 * more — read-aloud is now scoped to the per-task demos only (see the
 * comment block at the observer-install site below). The toggle pill is
 * still mounted on demand by `demos.js::setCaption` whenever a demo
 * actually speaks. */
import { mainAIntroNode, mainBIntroNode, endOfTaskIntroNode } from './runner-intros.js';
import { sessionInfoNode } from './session-info-node.js';
import { getUserPlaybackGain } from './audio/dsp.js';
import { consumeGuardFlags, stopDisplayGuardNode } from './calibration/display-guard.js';
import { startSessionGuard, markUploadDone } from './session-guard.js';

const session = initSession();

/* Storage init runs in parallel with the rest of module load. The first
 * jsPsych trial doesn't fire data hooks until the user starts the timeline,
 * so by then init is complete. We capture the promise here to await it
 * before `jsPsych.run` if needed. */
const storageReadyPromise = initStorage();

/* Warm any lazily-built assets at module load so no main-block trial pays a
 * first-touch cost.
 *   - Tone bank: `getToneBank()` builds the analytic cell↔tone maps in
 *     `audio/tones.js` (cached after first call). Without this, the first
 *     `playToneByCell` of the session would build the maps on its hot path.
 *     The familiarisation screen plays a frequency ladder via `dsp.js` and
 *     does not exercise the cell-keyed bank, so it does not warm this for us.
 *   - Rotation arrow PNG: kick off the network fetch now via an offscreen
 *     `Image()` so the browser cache is warm before the first imagery
 *     instruction demo (and therefore well before the first main trial).
 *     The literal URL matches the other consumers — this is a fetch-warmer,
 *     not a new asset reference. */
function warmupAssets() {
  getToneBank();
  if (typeof Image !== 'undefined') {
    const img = new Image();
    img.src = `${import.meta.env.BASE_URL}assets/rotation-arrow.png`;
  }
}
warmupAssets();

const jsPsych = initJsPsych({
  display_element: undefined,
  /* Hidden-nav skip-forward hook: when the experimenter presses `U` from
   * inside a non-checkpoint trial, the keydown handler in `hidden-nav.js`
   * arms a skip token; this hook neutralises every following non-checkpoint
   * trial (zero duration, no input) until the next registered checkpoint
   * (instructions / demo / intro). Without this hook, `U` from a trial
   * would only advance one trial. */
  on_trial_start: getHiddenNavTrialStartHook(),
  on_data_update: (datum) => {
    /* Mirror every data row into IndexedDB so the participant can crash the
     * browser at any point without losing more than the in-flight trial
     * Fire-and-forget — appendTrialRow throws on
     * unrecoverable backend failure, which we surface to the console; the
     * participant can still finish the session because the data is also held
     * in jsPsych's in-memory store and gets uploaded at the end. */
    appendTrialRow(datum).catch((err) => {
      console.error('[runner] storage append failed', err);
      recordWriteFailure(err);
    });
  },
  on_trial_finish: (data) => {
    /* Display-guard events since the previous trial, and the playback gain in
     * force, so analysis can drop or adjust affected trials. */
    Object.assign(data, consumeGuardFlags());
    data.user_gain = getUserPlaybackGain();
  },
  on_finish: () => {
    markUploadDone();
    /* Stamp session-level metadata onto every row for the analyst. Upload
     * already ran in the upload-progress node; this just adds session-wide
     * fields to whatever's still in memory (in case the experimenter copies
     * out the in-memory data via `jsPsych.data.get()` for debugging). */
    const data = jsPsych.data?.get?.();
    if (data && typeof data.addProperties === 'function') {
      data.addProperties({
        session_id: session.params.session_id,
        prolific_pid: session.params.prolific_pid,
        study_id: session.params.study_id,
        is_preview: session.params.is_preview,
        is_pilot_run: session.is_pilot_run,
        pilot_label: session.pilot_label,
        prng_seed_uint32: session.prng_seed_uint32,
        schema_version: session.schema_version,
        build_id: session.build_id,
      });
    }
    console.info('[runner] session', session, 'visibility', getVisibilityEvents());
  },
});
window.jsPsych = jsPsych;

/* Hidden experimenter navigation — `U` advances the current registered
 * screen and `R` takes one registered screen back. Available only on the
 * development server (?devnav=1); absent from the production build. */
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('devnav')) {
  installHiddenNav(jsPsych);
}

/* Voiceover scope: read-aloud is restricted to the per-task demos.
 * Instruction decks, calibration intros, rest screens, debrief, consent,
 * strategy, music-experience and attention checks run silent; participants
 * read those at their own pace.
 *
 * `slideTextPage` stamps `data-voiceover-target` and (where the author
 * supplied one) `data-voiceover-script` on each page's body; these are
 * inert at runtime and are read by the voiceover harvest scripts.
 *
 * Demo speech: `demos.js::setCaption` calls `getVoiceover().speak(...)`
 * imperatively per caption, and mounts the mute pill on demand the moment a
 * demo first speaks. The trial-start gate in `conditions/shared.js`
 * unmounts the pill before live trials begin. */

const mainPair = generateMainBlockPair();

const timeline = [
  ...assembleCalibrationChain(),
  ...assembleInstructionsAndPractice(),
  sessionInfoNode(session),
  mainAIntroNode(),
  ...mainPair.mainA.nodes,
  restNode({ session }),
  mainBIntroNode(),
  ...mainPair.mainB.nodes,
  /* Zoom and fullscreen no longer matter after the last trial. */
  stopDisplayGuardNode(),
  endOfTaskIntroNode(),
  ...assembleQuestionnaireChain(),
  uploadProgressNode({ session }),
  completionRedirectNode(),
];

/* If IDB open fails fatally we'd otherwise sit on a blank screen forever —
 * `initStorage` already falls back to the in-memory backend on a recoverable
 * error, so a rejected promise here means something has gone genuinely wrong
 * (browser blocking storage entirely, etc.). Surface a fatal error UI rather
 * than starting a session whose data we can't persist. */
storageReadyPromise
  .then(() => startSessionGuard(session))
  .then(() => jsPsych.run(timeline))
  .catch((err) => {
    console.error('[runner] fatal startup failure', err);
    const root = document.body;
    root.innerHTML = `
      <div style="max-width: 36rem; margin: 4rem auto; padding: 2rem; text-align: center;">
        <h2>Unable to start the experiment</h2>
        <p>Your browser is blocking the local storage this study needs. Please
        try a different browser (Chrome, Firefox, or Safari) on a desktop or
        laptop computer, with private/incognito mode disabled.</p>
        <p><small>Error reference: <code>${(err && err.message) || 'unknown'}</code></small></p>
      </div>
    `;
  });
