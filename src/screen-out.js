/**
 * Screen-out exit path.
 *
 * Every in-study check that ends a session (desktop check, screen-size
 * calibration, tone audibility, pitch-discrimination check, timing check,
 * practice-accuracy criterion, and the display guard's end-the-session
 * button) ends through
 * `screenOutExit` or `finishScreenOut`. The participant sees a short, polite explanation, and the
 * single button sends them to the Prolific screen-out completion URL
 * (`config.prolific.screen_out_completion_code`), so the submission is
 * recorded on Prolific rather than left open. These checks are disclosed in
 * the consent form and in the Prolific study description.
 *
 * The exit row carries `exit_reason`. For exits after consent, any rows not
 * yet uploaded are flushed (best effort, bounded wait) before the redirect.
 * Exits before consent never upload anything. The explanation stays on screen
 * during the flush, with a status line and a visible link to the screen-out
 * URL in case the automatic redirect does not happen.
 */
import htmlButtonResponse from '@jspsych/plugin-html-button-response';
import { buildScreenOutUrl, isPlaceholderScreenOutUrl, uploadPendingData } from './uploader.js';
import { getSessionObject } from './storage.js';
import { markUploadDone } from './session-guard.js';
import { stopDisplayGuard } from './calibration/display-guard.js';

const STATUS_ID = 'screen-out-status';

/** Delay that lets the exit row reach storage before the final flush. */
const FLUSH_SETTLE_MS = 250;
/** Longest the redirect waits for the flush. */
const FLUSH_TIMEOUT_MS = 8000;

async function flushPendingRows() {
  await new Promise((resolve) => setTimeout(resolve, FLUSH_SETTLE_MS));
  const session = await getSessionObject();
  if (!session) return;
  await uploadPendingData({ session });
}

function navigateTo(url) {
  window.location.href = url;
}

function setStatus(html) {
  const el = typeof document !== 'undefined' ? document.getElementById(STATUS_ID) : null;
  if (el) el.innerHTML = html;
}

function pageHtml({ reasonHtml, url, live }) {
  const link = live
    ? `<p>If you are not taken to Prolific automatically, <a id="screen-out-link" href="${url}">click here to continue to Prolific</a>.</p>`
    : '';
  return (
    `<div style="max-width: 38rem; margin: 0 auto; text-align: center; line-height: 1.6;">` +
    `${reasonHtml}<p id="${STATUS_ID}" style="opacity: 0.8;"></p>${link}</div>`
  );
}

/**
 * End the experiment, flush data if requested, then send the participant to
 * the screen-out URL (skipped for the placeholder URL used in test builds).
 * The explanation is rendered by this function and stays visible throughout.
 */
export async function finishScreenOut({ reasonHtml, flush, url, navigate = navigateTo }) {
  stopDisplayGuard();
  const live = Boolean(url) && !isPlaceholderScreenOutUrl(url);
  if (typeof window !== 'undefined' && window.jsPsych?.abortExperiment) {
    window.jsPsych.abortExperiment(pageHtml({ reasonHtml, url, live }));
    /* jsPsych writes the end message once the aborted trial has settled. */
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (flush) {
    setStatus('Saving your data…');
    try {
      await Promise.race([
        flushPendingRows(),
        new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.error('[screen-out] flush failed', err);
    }
  }
  if (live) {
    setStatus('Returning to Prolific…');
    markUploadDone();
    navigate(url);
  } else {
    setStatus('');
  }
}

/**
 * Build a conditional exit node that screens the participant out.
 *
 * @param {object}   opts
 * @param {string}   opts.phase              data phase tag of the exit row
 * @param {string}   opts.exitReason         value written to `exit_reason`
 * @param {string|Function} opts.reasonHtml  heading and explanation markup
 * @param {Function} opts.condition          conditional_function
 * @param {boolean}  [opts.flush]            upload pending rows before redirect
 * @param {Function} [opts.onFinish]         extra `data` stamping
 * @param {boolean}  [opts.beforeConsent]    the exit happens before the consent form has been
 *                                           shown (device gate), so the generic text must not
 *                                           refer to "the consent form"
 * @returns {object} jsPsych conditional timeline node
 */
export function screenOutExit({
  phase,
  exitReason,
  reasonHtml,
  condition,
  flush = false,
  onFinish,
  beforeConsent = false,
}) {
  const url = buildScreenOutUrl();
  const isPlaceholder = isPlaceholderScreenOutUrl(url) || !url;
  const resolveReason = () => (typeof reasonHtml === 'function' ? reasonHtml() : reasonHtml);

  return {
    timeline: [
      {
        type: htmlButtonResponse,
        stimulus: () => {
          const next = isPlaceholder
            ? '<p style="opacity: 0.7; font-size: 0.9em;">This is a test build. No Prolific action is required.</p>'
            : `<p>${
                beforeConsent
                  ? 'This session has ended.'
                  : 'This session has ended because of one of the checks described in the consent form.'
              } Click the button below to submit the screen-out completion code to Prolific, ` +
              'where your submission will be recorded.</p>';
          return `<div style="max-width: 38rem; margin: 0 auto; text-align: center; line-height: 1.6;">${resolveReason()}${next}</div>`;
        },
        choices: [isPlaceholder ? 'Close' : 'Submit code to Prolific'],
        data: { phase, exit_reason: exitReason },
        on_finish: (data) => {
          if (onFinish) onFinish(data);
          void finishScreenOut({ reasonHtml: resolveReason(), flush, url });
        },
      },
    ],
    conditional_function: condition,
  };
}
