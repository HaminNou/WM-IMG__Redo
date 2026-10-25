/**
 * Desktop-only gate (pre-consent).
 *
 * Prolific allows participants on phones and tablets to start the study; our
 * task is unusable on those devices (no fullscreen API on iOS Safari, arrow
 * keys not reachable on touch keyboards, screen calibration assumes a real
 * card-vs-display geometry rather than a touch layer). Without this gate, a
 * mobile participant would burn ~5 minutes on consent + screen-cal before
 * failing fullscreen — wasting both their time and a recruit slot.
 *
 * The pure classifier (`evaluateEnvironment`) and the live-browser reader
 * (`readEnvironment`) live in `./desktop-detect.js` so unit tests can import
 * them without dragging jsPsych's static `window` references into the Node
 * test environment. This file wires the classifier into the jsPsych timeline.
 */
import callFunction from '@jspsych/plugin-call-function';
import { screenOutExit } from '../screen-out.js';
import { evaluateEnvironment, readEnvironment } from './desktop-detect.js';

/**
 * Synchronous data-only node — runs the classifier once and writes a
 * `desktop_gate` row. Place at the very start of the calibration chain
 * (before consent) so the gate decision is recorded even if the participant
 * never makes it past the exit screen.
 */
export function desktopGateTrial() {
  return {
    type: callFunction,
    async: false,
    func: () => evaluateEnvironment(readEnvironment()),
    data: { phase: 'desktop_gate' },
  };
}

/**
 * Conditional exit screen — only fires when the gate verdict was
 * `isDesktop === false`. Ends the session through the shared screen-out path
 * so no subsequent calibration or experimental nodes run. Nothing is
 * uploaded: the participant has not yet consented.
 */
export function desktopGateExit() {
  return screenOutExit({
    phase: 'desktop_gate_fail',
    exitReason: 'desktop_required',
    reasonHtml: `
      <h2>Sorry, this study requires a desktop or laptop computer</h2>
      <p>
        The task uses keyboard arrow keys and a fullscreen visual display.
        It cannot be completed on a phone or tablet.
      </p>
    `,
    condition: () => {
      const last = window.jsPsych?.data
        ?.get()
        .filter({ phase: 'desktop_gate' })
        .last(1)
        .values()[0];
      const result = last?.value;
      return result ? !result.isDesktop : false;
    },
    /* the consent form has not been shown yet at this point */
    beforeConsent: true,
  });
}
