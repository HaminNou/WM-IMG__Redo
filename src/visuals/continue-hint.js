/**
 * Shared "Press <kbd>...</kbd> to continue" pill renderer.
 *
 * Every participant-facing screen ends with a one-line hint telling the
 * participant which key advances to the next step. The hint is large and
 * high-contrast — black text on a white rectangle with a thin black
 * border — so it remains legible regardless of the participant's OS
 * colour scheme (dark mode, Chrome Auto Dark Theme, etc., can darken the
 * page background).
 *
 * The styling is INLINE so the pill renders consistently inside jsPsych
 * stimulus HTML (which is injected into the experiment surface with no
 * global stylesheet of our own around it). No JS / no class hooks — the
 * pill is purely declarative.
 *
 * Usage:
 *   continueHintHtml('Press <kbd>Space</kbd> to begin Block 1.')
 *
 *   // For sites where pressing arrow keys advances pages (instructions
 *   // plugin), name the arrows explicitly so the participant doesn't
 *   // have to guess:
 *   continueHintHtml('Press <kbd>Space</kbd>, the <kbd>&larr;</kbd> left arrow, or the <kbd>&rarr;</kbd> right arrow to continue.')
 *
 * The helper returns ONE inline-block element so it sits centred when
 * wrapped in a centred parent and naturally hugs its text content
 * regardless of viewport width.
 */
const PILL_STYLE = [
  'display: inline-block',
  'margin: 1.25rem auto 0.25rem',
  'padding: 0.65rem 1.3rem',
  'background: #FFFFFF',
  'color: #000000',
  /* Sized so the longest hint variant — the demo's "Press Space when you
   * are ready to start the practice for Task X." — stays on one line on
   * 13" laptops without making short hints feel tiny. */
  'font-size: 1.05rem',
  'font-weight: 600',
  'line-height: 1.3',
  'border: 1.5px solid #000000',
  'border-radius: 0.55rem',
  'box-shadow: 0 1px 2px rgba(0,0,0,0.10)',
  'text-align: center',
  'max-width: 44rem',
].join('; ');

/**
 * Wrap the given hint markup in the standard continue-hint pill. The
 * outer wrapper centres the pill horizontally on its line; the inner
 * element carries the actual visual styling.
 *
 * @param {string} innerHtml — sanitised markup the call site supplies
 *   (typically a literal containing `<kbd>` elements; all call sites are
 *   author-controlled, so no escaping is performed here).
 */
export function continueHintHtml(innerHtml) {
  return `<div style="text-align: center; width: 100%;"><div style="${PILL_STYLE}">${innerHtml}</div></div>`;
}
