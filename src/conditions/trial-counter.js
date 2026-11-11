/**
 * Overall trial-counter overlay: a small gray "5/120" at the top-left of the
 * viewport that persists across every sub-node of a main trial (gate, encoding,
 * retention, probes, feedback, ITI), so the participant always sees how far
 * they are through the main task, counted across both blocks.
 *
 * Colour. The trial pages are white or light gray and the rest of the UI is dark,
 * so one fixed colour cannot be legible on both. The gray is therefore chosen by a
 * stylesheet rule that follows the page: dark gray on a trial page (the
 * `data-trial-bg` attribute that `setTrialPageBackground` puts on <html>), light
 * gray on the dark surface. The rule does not depend on when the counter was mounted.
 *
 * Top-left placement: least competing with the central fixation point, and where
 * participants of online experiments expect a progress indicator.
 *
 * The overlay is body-level (`position: fixed`), so it sits above the jsPsych content
 * area wherever the grid mounts. Each main-trial gate's on_load calls
 * `setTrialCounter(N, total)`; the end-of-task intro removes it with
 * `unmountTrialCounter()` so it does not bleed into the questionnaire. It is a
 * singleton: repeated calls reuse the same node.
 *
 * (The trial type is shown by the tag above the circle, not here; the third argument of
 * `setTrialCounter` is accepted and ignored so existing callers keep working.)
 */
const COUNTER_ID = 'overall-trial-counter';
const STYLE_ID = 'overall-trial-counter-style';

/* Same palette as the trial-type tag pills above the circle (shared.js uses it for the
 * coloured dot in each pill). Okabe & Ito (2008), colourblind-safe. */
const TYPE_COLOURS = Object.freeze({
  d_only: '#0072B2', // blue
  t_only: '#009E73', // bluish green
  i_only: '#E69F00', // orange
  i_d: '#CC79A7', // reddish purple
  i_t: '#D55E00', // vermillion
});

/* Gray on the dark surface and on the white / light-gray trial pages (WCAG contrast
 * about 6 : 1 on the dark surface, 4.6 : 1 on the light gray page, 7 : 1 on white). */
export const COUNTER_COLOUR_ON_DARK = '#9a9a9a';
export const COUNTER_COLOUR_ON_TRIAL_PAGE = '#5a5a5a';

const CONTAINER_STYLE =
  [
    'position: fixed',
    'top: 12px',
    'left: 16px',
    'font-size: 13px',
    'font-weight: 500',
    'font-family: system-ui, sans-serif',
    'font-variant-numeric: tabular-nums',
    'letter-spacing: 0.02em',
    'pointer-events: none',
    'z-index: 1000',
    'user-select: none',
  ].join('; ') + ';';

function ensureCounterStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${COUNTER_ID} { color: ${COUNTER_COLOUR_ON_DARK}; }
    html[data-trial-bg] #${COUNTER_ID} { color: ${COUNTER_COLOUR_ON_TRIAL_PAGE}; }
  `;
  document.head.appendChild(style);
}

/**
 * Update (or mount) the trial-counter overlay.
 *
 * @param {number} current   1-based trial index across all 120 main trials
 * @param {number} total     total number of main trials (120)
 */
export function setTrialCounter(current, total) {
  ensureCounterStyle();
  let container = document.getElementById(COUNTER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = COUNTER_ID;
    container.setAttribute('style', CONTAINER_STYLE);
    container.setAttribute('aria-hidden', 'true');
    document.body.appendChild(container);
  }
  container.textContent = `${current}/${total}`;
}

export function unmountTrialCounter() {
  const el = document.getElementById(COUNTER_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

/* Surfaced for tests and for the trial-type tag pills (shared.js). */
export const TRIAL_TYPE_TAG_COLOURS = TYPE_COLOURS;
