/**
 * Per-trial page-background flip.
 *
 * Each trial body uses a light/gray page background with stimuli in the
 * opposite (dark) shade. The rest of the UI (calibration, instructions,
 * demos, rest, questionnaire, upload, completion) uses a dark theme. This module
 * is the single mutator of the page chrome: it sets and clears a
 * `data-trial-bg` attribute on `<html>` (which `index.html`'s CSS reacts to)
 * AND mirrors the same fill into inline `backgroundColor` on `<html>` and
 * `<body>` so the flip lands even if the stylesheet misses the
 * attribute selector.
 *
 * Lifecycle (see `colour-palette.js` header):
 *   - Trial-start gate's `on_load` (per-trial gate at index 0 of every
 *     composer) calls `setTrialPageBackground(shade)` so the gate's
 *     "Press both arrow keys" page paints in the SAME shade as the
 *     upcoming trial body — no dark→light seam between gate and trial.
 *   - The same gate's `on_finish` re-applies the same shade as
 *     defence-in-depth (idempotent: a no-op when the page is already in
 *     the right state).
 *   - The ITI's `on_finish` (last node of every trial body) calls
 *     `clearTrialPageBackground()` so the page reverts to dark whenever
 *     the trial body ends without an immediately-following next gate
 *     (block boundaries, end of session). When there IS a next gate,
 *     its `on_load` immediately re-paints to the next trial's shade —
 *     jsPsych transitions between adjacent timeline nodes synchronously,
 *     so the dark interim is not visible as a flash.
 *
 * The flip is idempotent and safe to call from any node hook:
 *   - `setTrialPageBackground('white')` followed by another
 *     `setTrialPageBackground('white')` does nothing on the second call.
 *   - `clearTrialPageBackground()` from a non-trial node is a no-op.
 *   - Invalid shades are ignored (and warned to the console) rather than
 *     throwing, so a malformed trial param can never blank the screen.
 */
import { BACKGROUND_FILLS, isValidBackgroundShade } from './colour-palette.js';

const HTML_DATASET_KEY = 'trialBg';

export function setTrialPageBackground(shade) {
  if (!isValidBackgroundShade(shade)) {
    console.warn('[page-background] ignoring invalid shade', shade);
    return;
  }
  if (typeof document === 'undefined') return;
  const fill = BACKGROUND_FILLS[shade];
  document.documentElement.dataset[HTML_DATASET_KEY] = shade;
  document.documentElement.style.backgroundColor = fill;
  if (document.body) document.body.style.backgroundColor = fill;
}

export function clearTrialPageBackground() {
  if (typeof document === 'undefined') return;
  delete document.documentElement.dataset[HTML_DATASET_KEY];
  document.documentElement.style.backgroundColor = '';
  if (document.body) document.body.style.backgroundColor = '';
}
