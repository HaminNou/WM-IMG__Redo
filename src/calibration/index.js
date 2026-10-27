/**
 * Calibration-chain composer.
 *
 * Order:
 *   desktop-gate → desktop-gate-exit (conditional, aborts if mobile/tablet) →
 *   consent → consent-gate → demographics →
 *   viewing-distance-instruction (~60 cm, eyes centred — set posture first) →
 *   display-mode-check (offer "Force light mode" escape hatch BEFORE px/mm cal
 *     so the calibration happens on the corrected surface) →
 *   screen-calibration-with-retry (two passes per attempt, validated, up to three
 *     attempts; ends the session if no attempt is usable) →
 *   speaker-volume-instruction (anchor system master volume near 50 %) →
 *   fullscreen → visibility-recorder →
 *   tone-audibility-and-comfort (24-box sweep + in-page playback-gain slider) →
 *   tone-audibility-exit (conditional, aborts if 10 sweeps elapsed without Yes) →
 *   timing-probe (+ exit)
 *
 * Failure paths:
 *   - mobile / tablet   → friendly exit + `jsPsych.abortExperiment()` so no
 *                         further nodes execute (saves ~5 min of wasted
 *                         calibration on an unsupported device)
 *   - declined consent  → friendly exit, timeline ends
 *   - bad screen-cal    → re-prompt with a hint (up to three attempts), then
 *                         the screen-out exit; a usable but inconsistent pair
 *                         on the last attempt is accepted and flagged
 *   - tone inaudible    → friendly exit if the audibility/comfort sweep
 *                         cycles ten times without the participant clicking
 *                         "I'm comfortable — continue" (covers laptop
 *                         speakers at low volume / muted output / etc.)
 *
 * Each step writes a `phase` tag so the data uploader can selectively send
 * calibration metadata before the first practice trial.
 */
import { consentTrial, consentGate } from './consent.js';
import { demographicsTrial } from './demographics.js';
import { desktopGateTrial, desktopGateExit } from './desktop-gate.js';
import { displayModeCheckTrial } from './display-mode.js';
import { screenCalibrationWithRetry } from './screen.js';
import { viewingDistanceTrial } from './viewing-distance.js';
import { speakerVolumeInstructionTrial } from './volume.js';
import { enterFullscreenTrial, attachVisibilityRecorder } from './fullscreen.js';
import { toneAudibilityAndComfortTrial, toneAudibilityExit } from './tone-familiarisation.js';
import { timingProbeNode } from './device-probe.js';

export function assembleCalibrationChain() {
  return [
    desktopGateTrial(),
    desktopGateExit(),

    consentTrial(),
    consentGate(),

    demographicsTrial(),

    /* Posture instruction (~60 cm, eyes centred) BEFORE the credit-card
     * screen-cal — keeps the card-vs-screen parallax roughly consistent
     * across participants and ensures the participant is already settled
     * when the cal step measures pixels-per-mm. */
    viewingDistanceTrial(),

    /* Display-mode escape hatch BEFORE the px/mm cal. If the participant's
     * browser is repainting the surface darker than designed, give them a
     * chance to engage the sticky `html.display-colour-locked` override so
     * the subsequent credit-card calibration happens on the corrected
     * surface (and so they actually see the credit-card outline at the
     * intended contrast). */
    displayModeCheckTrial(),

    screenCalibrationWithRetry(),

    /* Anchor the OS-level master volume near 50 % BEFORE the in-page
     * audibility/comfort step. This pre-stages the hardware so the
     * in-page playback-gain slider has headroom in both directions. */
    speakerVolumeInstructionTrial(),

    enterFullscreenTrial(),
    attachVisibilityRecorder(),

    toneAudibilityAndComfortTrial(),
    toneAudibilityExit(),

    /* Timing probe in the fullscreen condition the task will run in. */
    timingProbeNode(),
  ];
}
