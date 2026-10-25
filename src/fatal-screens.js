/**
 * Screens for a session that cannot go on.
 *
 * Three different situations need three different texts, because the old
 * single screen ("your browser is blocking the local storage") was shown for
 * every failure, including a bug in the middle of the task, and told the
 * participant to do something that would not help:
 *
 *   - `storage`  the browser would not give the study a place to keep data
 *                (storage blocked, private window): a browser problem;
 *   - `startup`  something else failed while the study was loading;
 *   - `running`  the task stopped in the middle (an exception ended the
 *                timeline). Answers up to that point are kept in this browser,
 *                so the screen offers to send them and names the recovery page.
 *
 * All text is put in with `textContent`; nothing from an error object is
 * parsed as HTML.
 */

const MESSAGE_MAX = 200;

/** @param {unknown} err @returns {string} short, plain description for the researcher */
export function errorReference(err) {
  const name = err && typeof err === 'object' && typeof err.name === 'string' ? err.name : 'Error';
  const message =
    err && typeof err === 'object' && typeof err.message === 'string'
      ? err.message
      : String(err ?? 'unknown');
  return `${name}: ${message}`.replace(/\s+/g, ' ').slice(0, MESSAGE_MAX);
}

/* The wording per stage, kept apart from the DOM code so tests can read it. */
export const FATAL_TEXT = Object.freeze({
  storage: Object.freeze({
    title: 'This study cannot save your progress in this browser',
    paragraphs: Object.freeze([
      'Your browser did not allow the study to store data on your computer, and the study needs that to run safely.',
      'Please open the same link again in a current desktop version of Chrome, Edge, Firefox or Safari, with private or incognito mode turned off.',
    ]),
  }),
  startup: Object.freeze({
    title: 'The study could not start',
    paragraphs: Object.freeze([
      'Something went wrong while the study was loading. Please reload this page once.',
      'If this message appears again, try a different desktop browser (Chrome, Edge, Firefox or Safari) and tell the researcher about it through Prolific messaging.',
    ]),
  }),
  running: Object.freeze({
    title: 'The study stopped unexpectedly',
    paragraphs: Object.freeze([
      'We are sorry. Your answers up to this point are saved on this computer.',
      'Please press the button below to send them to us, then message the researcher through Prolific and tell us roughly when this happened. We will tell you how to continue. Reloading this page would start the study again from the beginning.',
    ]),
  }),
});

export const SAVE_BUTTON_TEXT = 'Send my saved data';
export const RECOVERY_LINK_TEXT = 'Data recovery page (opens in a new tab)';

function element(doc, tag, text, attrs = {}) {
  const el = doc.createElement(tag);
  if (text !== undefined) el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * Replace the page with the screen for `stage`.
 *
 * @param {object} opts
 * @param {'storage'|'startup'|'running'} opts.stage
 * @param {unknown} [opts.error]                         shown as a short reference line
 * @param {() => Promise<{ok: boolean, text: string}>} [opts.saveData]   only used for `running`
 * @param {Document} [opts.doc]
 * @returns {HTMLElement} the container that was mounted
 */
export function renderFatalScreen({ stage, error, saveData, doc = document }) {
  const text = FATAL_TEXT[stage] ?? FATAL_TEXT.startup;
  const box = element(doc, 'div', undefined, {
    id: 'fatal-screen',
    role: 'alert',
    style: 'max-width: 36rem; margin: 4rem auto; padding: 2rem; text-align: center;',
  });
  box.appendChild(element(doc, 'h2', text.title));
  for (const p of text.paragraphs) box.appendChild(element(doc, 'p', p));

  if (stage === 'running' && typeof saveData === 'function') {
    const button = element(doc, 'button', SAVE_BUTTON_TEXT, {
      id: 'fatal-save',
      type: 'button',
      style: 'font-size: 1.1rem; padding: 0.6rem 1.2rem; margin: 0.5rem 0;',
    });
    const status = element(doc, 'p', '', { id: 'fatal-status', 'aria-live': 'polite' });
    button.addEventListener('click', async () => {
      button.disabled = true;
      status.textContent = 'Sending…';
      try {
        const result = await saveData();
        status.textContent = String(result?.text ?? '');
      } catch {
        status.textContent =
          'We could not save the data automatically. Please message the researcher through Prolific.';
      }
      button.disabled = false;
    });
    box.appendChild(button);
    box.appendChild(status);
    const link = element(doc, 'a', RECOVERY_LINK_TEXT, {
      id: 'fatal-recover',
      href: 'recover.html',
      target: '_blank',
      rel: 'noopener',
    });
    const linkLine = element(doc, 'p');
    linkLine.appendChild(link);
    box.appendChild(linkLine);
  }

  if (error !== undefined) {
    const small = element(doc, 'small');
    small.appendChild(doc.createTextNode('Technical detail for the researcher: '));
    small.appendChild(element(doc, 'code', errorReference(error)));
    box.appendChild(element(doc, 'p')).appendChild(small);
  }

  const body = doc.body;
  body.textContent = '';
  body.appendChild(box);
  return box;
}
