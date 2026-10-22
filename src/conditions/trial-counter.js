/**
 * Overall trial-counter overlay — a small dim badge at the top-left of the
 * viewport that persists across every trial sub-node (gate, encoding,
 * retention, probes, feedback, ITI) so the participant always sees their
 * progress through the main task.
 *
 * The overlay carries:
 *   - a SOLID COLOURED SQUARE encoding the trial type (5 distinct hues from
 *     Okabe–Ito's colourblind-safe palette — see TYPE_COLOURS), so the
 *     participant can identify which task they are currently on at a glance
 *     without having to remember the order;
 *   - the trial number ("Trial X / 120") inside / next to the square.
 *
 * Top-left placement rationale:
 *   1. Western reading order makes top-left peripheral / least competing
 *      with the central fixation locus during the trial — a top-RIGHT
 *      placement falls in the saccadic-priority hemifield for right-handed
 *      majority and is more likely to capture attention away from the
 *      bull's-eye.
 *   2. Convention. E-Prime, Inquisit, and OpenSesame default progress
 *      indicators to the top-left of the stimulus canvas; participants
 *      familiar with online experiments expect them there.
 *   3. The dim "Trial X / N" overlay shares the top-left placement, so the
 *      two do not compete as separate visual landmarks.
 *
 * The overlay is body-level (`position: fixed`) so it sits above the
 * jsPsych content area regardless of where the grid mount is. Each main-
 * trial gate's on_load calls `setTrialCounter(N, total, trialType)` to
 * update it; the end-of-task intro removes it via `unmountTrialCounter()`
 * so it doesn't bleed into the questionnaire.
 *
 * Mounted on demand and singleton — repeated `setTrialCounter` calls reuse
 * the same DOM nodes instead of creating duplicates.
 */
const COUNTER_ID = 'overall-trial-counter';
const TAG_ID = 'overall-trial-counter-tag';
const TEXT_ID = 'overall-trial-counter-text';

/* Okabe–Ito colourblind-safe palette (Okabe & Ito 2008, "Color Universal
 * Design"). Five of eight hues — picked for maximum mutual contrast in
 * the Wong (2011) Nature Methods extension of that palette. The palette
 * is invariant under deuteranopia/protanopia/tritanopia simulations. */
const TYPE_COLOURS = Object.freeze({
  d_only: '#0072B2', // blue
  t_only: '#009E73', // bluish green
  i_only: '#E69F00', // orange
  i_d: '#CC79A7', // reddish purple
  i_t: '#D55E00', // vermillion
});

const CONTAINER_STYLE =
  [
    'position: fixed',
    'top: 12px',
    'left: 16px',
    'display: inline-flex',
    'align-items: center',
    'gap: 8px',
    'color: rgba(255, 255, 255, 0.6)',
    'font-size: 13px',
    'font-family: system-ui, sans-serif',
    'letter-spacing: 0.02em',
    'pointer-events: none',
    'z-index: 1000',
    'user-select: none',
  ].join('; ') + ';';

const TAG_BASE_STYLE =
  [
    'display: inline-block',
    'width: 12px',
    'height: 12px',
    'border-radius: 2px',
    /* Subtle dark outline so the tag remains visible against the
     * task's near-black background even at low alpha. */
    'box-shadow: 0 0 0 1px rgba(0,0,0,0.4)',
  ].join('; ') + ';';

/**
 * Update (or mount) the trial-counter overlay.
 *
 * @param {number} current   1-based trial index across all 120 trials
 * @param {number} total     total trial count (120)
 * @param {string} [trialType]   one of d_only / t_only / i_only / i_d / i_t.
 *                               If omitted or unknown, the colour tag is
 *                               hidden — useful for non-main-task contexts.
 */
export function setTrialCounter(current, total, trialType) {
  let container = document.getElementById(COUNTER_ID);
  let tag, text;
  if (!container) {
    container = document.createElement('div');
    container.id = COUNTER_ID;
    container.className = 'overall-trial-counter';
    container.setAttribute('style', CONTAINER_STYLE);
    tag = document.createElement('span');
    tag.id = TAG_ID;
    tag.className = 'overall-trial-counter-tag';
    text = document.createElement('span');
    text.id = TEXT_ID;
    text.className = 'overall-trial-counter-text';
    container.appendChild(tag);
    container.appendChild(text);
    document.body.appendChild(container);
  } else {
    tag = container.querySelector(`#${TAG_ID}`);
    text = container.querySelector(`#${TEXT_ID}`);
  }
  const colour = trialType && TYPE_COLOURS[trialType];
  if (colour) {
    tag.setAttribute('style', `${TAG_BASE_STYLE} background: ${colour};`);
    tag.style.display = 'inline-block';
  } else {
    tag.style.display = 'none';
  }
  text.textContent = `Trial ${current} / ${total}`;
}

export function unmountTrialCounter() {
  const el = document.getElementById(COUNTER_ID);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

/* Surfaced for tests + downstream UI (e.g., a legend at the start of
 * Main A explaining what each colour means). */
export const TRIAL_TYPE_TAG_COLOURS = TYPE_COLOURS;
