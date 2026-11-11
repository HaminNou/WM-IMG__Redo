/**
 * Response buttons shared by the task demonstrations and the practice trials.
 *
 * A "button" is a label with the arrow-key cap under it (left button + the left
 * arrow cap, right button + the right arrow cap). The demonstrations mount them in
 * their own button row (`instructions/demos.js`, together with the demo hands and
 * the "do not press" note). The practice trials show the same pair under the circle
 * while a response window is open (`createTrialResponseButtons`), so a participant
 * who has seen the demo sees the same thing again while answering.
 *
 * This module owns only the look (CSS), the markup of one button stack, the label
 * text and the key-to-side table. It does not know the key mapping of the task: the
 * conditions combine `ARROW_KEY_SIDE` with `KEY_YES` / `KEY_NO` / `KEY_ON` /
 * `KEY_OFF` from `conditions/shared.js` (see `conditions/practice-buttons.js`).
 */

/* Label text. Right = Yes / On-pattern, Left = No / Not on-pattern. */
export const PROBE_BUTTON_TEXT = Object.freeze({ yes: 'Yes', no: 'No' });
export const STAR_BUTTON_TEXT = Object.freeze({ on: 'On-pattern', off: 'Not on-pattern' });

/* Which button an arrow key belongs to. */
export const ARROW_KEY_SIDE = Object.freeze({ arrowleft: 'left', arrowright: 'right' });

/* Look of the buttons (also used by the demonstration frame). Dark-ink pills with
 * a thin black bar underneath (the depressible-key affordance) and a key cap under
 * each. pointer-events: none so a click does nothing and the buttons never take
 * hover or focus paint. */
export const RESPONSE_BUTTON_CSS = `
      .demo-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 9rem;
        padding: 0.7rem 1.4rem;
        border-radius: 0.65rem;
        background: rgba(0,0,0,0.04);
        border: 1px solid rgba(0,0,0,0.30);
        color: rgba(0,0,0,0.85);
        font-size: 1.05rem;
        font-weight: 500;
        box-shadow: 0 4px 0 rgba(0,0,0,0.35);
        user-select: none;
        cursor: default;
        /* Participant is NEVER meant to click a demo button — the animated
         * hand glyph performs every press. Disabling pointer-events kills
         * the browser's default hover/focus paint that otherwise made the
         * buttons look interactive (and could falsely cue a response during
         * passive watch/listen phases). The replay button at end-of-demo
         * is the only clickable affordance and overrides this rule with
         * an inline pointer-events:auto + cursor:pointer style. */
        pointer-events: none;
      }
      /* Per-button keyboard-key indicator. A small key-cap glyph rendered
       * directly below each button so the participant sees which physical
       * arrow key maps to which response, persistently. The key is
       * decorative (aria-hidden); the button label already carries the
       * response meaning for assistive tech. */
      .demo-btn-stack {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        gap: 0.4rem;
      }
      .demo-btn-key {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 1.6rem;
        height: 1.6rem;
        padding: 0 0.35rem;
        border: 1px solid rgba(0, 0, 0, 0.35);
        border-bottom-width: 2px;
        border-radius: 0.3rem;
        background: rgba(255, 255, 255, 0.55);
        font-size: 1.05rem;
        line-height: 1;
        color: rgba(0, 0, 0, 0.8);
        user-select: none;
        pointer-events: none;
      }
`;

/* Extra rules for the buttons outside the demo card (practice trials, the notice
 * after the first practice trial): opaque white with black ink, so they read on the
 * white, gray and dark trial backgrounds alike. */
const TRIAL_BUTTON_CSS = `
      .trial-response-buttons {
        position: fixed;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: flex-start;
        gap: 1.25rem;
        z-index: 1000;
        pointer-events: none;
        user-select: none;
        font-family: system-ui, sans-serif;
      }
      .trial-response-buttons .demo-btn {
        background: #FFFFFF;
        color: #000000;
        border: 1.5px solid #000000;
        box-shadow: 0 4px 0 #000000;
        font-weight: 600;
      }
      .trial-response-buttons .demo-btn-key {
        background: #FFFFFF;
        color: #000000;
        border-color: #000000;
      }
      /* The key the participant pressed: the label turns bold. Nothing else changes
       * (no colour, no movement), so it can never read as correct/incorrect feedback. */
      .trial-response-buttons .demo-btn-stack.is-pressed .demo-btn {
        font-weight: 900;
      }
      .trial-response-buttons .demo-btn-stack.is-pressed .demo-btn-key {
        font-weight: 900;
      }
      .trial-response-buttons--large .demo-btn {
        font-size: 1.9rem;
        min-width: 13rem;
        padding: 1.1rem 2rem;
      }
      .trial-response-buttons--large .demo-btn-key {
        font-size: 1.6rem;
        min-width: 2.4rem;
        height: 2.4rem;
      }
      .trial-response-buttons--inflow {
        position: static;
        transform: none;
        justify-content: center;
      }
`;

const STYLE_ID = 'response-buttons-style';
const KEY_GLYPH = Object.freeze({ left: '&larr;', right: '&rarr;' });

/** Add the buttons' stylesheet to the page once. */
export function ensureResponseButtonStyles(doc = document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = RESPONSE_BUTTON_CSS + TRIAL_BUTTON_CSS;
  doc.head.appendChild(style);
}

/**
 * Markup of one button with its arrow-key cap under it. `extraHtml` is appended
 * inside the stack (the demos put a hand glyph there). `tag: 'div'` gives a
 * non-focusable, non-tabbable element (trials); the demos keep a real <button>.
 */
export function responseButtonStackHtml({ side, label, extraHtml = '', tag = 'button' }) {
  const attrs = tag === 'button' ? 'type="button" ' : '';
  return `<div class="demo-btn-stack" data-side="${side}">
        <${tag} ${attrs}class="demo-btn" data-side="${side}">
          <span class="demo-btn-label">${label}</span>
        </${tag}>
        <span class="demo-btn-key" data-side="${side}" aria-hidden="true">${KEY_GLYPH[side]}</span>${extraHtml}
      </div>`;
}

function motionAllowed() {
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

/**
 * Animated scale-up of a centred element (Web Animations API). With
 * `prefers-reduced-motion` or without `element.animate` nothing animates and the
 * element simply appears at its final size. Returns whether it animated.
 */
export function zoomIn(el, { durationMs = 650, from = 0.25 } = {}) {
  if (typeof el.animate !== 'function' || !motionAllowed()) return false;
  el.animate(
    [
      { transform: `scale(${from})`, opacity: 0 },
      { transform: 'scale(1.08)', opacity: 1, offset: 0.7 },
      { transform: 'scale(1)', opacity: 1 },
    ],
    { duration: durationMs, easing: 'ease-out' }
  );
  return true;
}

/**
 * Markup of the pair for the trial style (left button first). `large` is the
 * notice's size; `inflow` puts the pair in the flow instead of fixed on the page.
 */
export function trialButtonPairHtml(labels, { large = false, inflow = false } = {}) {
  const cls = ['trial-response-buttons']
    .concat(large ? ['trial-response-buttons--large'] : [])
    .concat(inflow ? ['trial-response-buttons--inflow'] : [])
    .join(' ');
  return `<div class="${cls}" aria-hidden="true">${responseButtonStackHtml({
    side: 'left',
    label: labels.left,
    tag: 'div',
  })}${responseButtonStackHtml({ side: 'right', label: labels.right, tag: 'div' })}</div>`;
}

/**
 * The pair shown under the circle of a practice trial while a response window is
 * open. The element is built and positioned when this is called (not time
 * critical); `show()` only attaches it, `hide()` only detaches it, so opening and
 * closing a window costs one DOM insert / removal. It is `position: fixed` (no
 * layout reflow, nothing moves), below the bottom of `anchorEl` (the circle),
 * `pointer-events: none`, `aria-hidden` and not focusable.
 *
 * @param {object} opts
 * @param {{left: string, right: string}} opts.labels
 * @param {Element} opts.anchorEl   the grid wrapper; the pair sits below its bottom edge
 * @returns {{el: Element, show: () => void, hide: () => void, press: (key: string) => void}}
 */
export function createTrialResponseButtons({ labels, anchorEl }) {
  const doc = anchorEl?.ownerDocument ?? document;
  ensureResponseButtonStyles(doc);
  for (const stale of doc.querySelectorAll('.trial-response-buttons')) stale.remove();
  const holder = doc.createElement('div');
  holder.innerHTML = trialButtonPairHtml(labels);
  const el = holder.firstElementChild;
  const mmPx = parseFloat(getComputedStyle(doc.documentElement).getPropertyValue('--mm')) || 3;
  const bottomPx = anchorEl?.getBoundingClientRect?.().bottom ?? 0;
  el.style.top = `${bottomPx + 3 * mmPx}px`;
  return {
    el,
    show() {
      for (const stack of el.querySelectorAll('.demo-btn-stack'))
        stack.classList.remove('is-pressed');
      if (!el.isConnected) doc.body.appendChild(el);
    },
    hide() {
      el.remove();
    },
    press(key) {
      const side = ARROW_KEY_SIDE[String(key).toLowerCase()];
      if (!side) return;
      for (const stack of el.querySelectorAll('.demo-btn-stack')) {
        stack.classList.toggle('is-pressed', stack.dataset.side === side);
      }
    },
  };
}
