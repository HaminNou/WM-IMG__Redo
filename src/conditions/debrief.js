/**
 * End-of-session debrief flow.
 *
 * Two nodes:
 *
 *   1. `uploadProgressNode` — runs `uploadPendingData` on entry, displays a
 *      live progress bar ("Uploading file 4 of 10"), and writes a
 *      summary data row (`phase: 'upload_session_end'`) so the analyst can see
 *      every session's upload outcome. On endpoint absence or partial
 *      failure, falls back to triggering a JSON download — the participant
 *      can email the file to the lab. The node advances on Space once the
 *      upload settles or after `config.uploader.session_end_max_wait_ms`,
 *      whichever comes first, so a stuck upload never blocks the participant.
 *
 *   2. `completionRedirectNode` — reads the stored Prolific completion URL.
 *      If it's still the `PLACEHOLDER` template (study not yet published),
 *      shows a test-build notice with the URL displayed verbatim. Otherwise,
 *      counts down from 5 s and redirects via `window.location.href`. A
 *      "Click to continue" link is shown alongside the countdown in case the
 *      auto-redirect is blocked (e.g. some popup-blockers, embedded iframes).
 *
 * Why these are separate nodes: the upload step is a network operation that
 * should be retryable / observable; the redirect is a one-way trip out of the
 * page. Splitting them lets the participant see "your data is saved" before
 * the URL change, which is the kind of reassurance that keeps people from
 * abandoning the study at the last second.
 *
 * Why no automatic re-attempt loop: if the upload fails permanently
 * (retries exhausted), retrying again would just delay the participant. The download fallback gets the data off-device immediately —
 * better than a fourth retry that may fail too. Recovery is a manual
 * post-session step, not a re-loop.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';

import { config } from '../config.js';
import {
  uploadPendingData,
  downloadAsJson,
  buildCompletionUrl,
  isPlaceholderCompletionUrl,
} from '../uploader.js';
import { getAllTrialRows, getCompletionUrl, getStorageFailureSummary } from '../storage.js';
import { markUploadDone } from '../session-guard.js';
import { continueHintHtml } from '../visuals/continue-hint.js';

const PROGRESS_MOUNT_ID = 'upload-progress-mount';
const REDIRECT_DELAY_MS_DEFAULT = 5000;
const REDIRECT_TICK_MS = 1000;

/**
 * Upload-progress node.
 *
 * @param {object}  [opts]
 * @param {object}  [opts.session]              prolific session object — required
 * @param {string}  [opts.endpoint]             override config.uploader.endpoint
 * @param {string}  [opts.label]                phase tag (default 'upload_session_end')
 * @param {number}  [opts.maxWaitMs]            longest wait before the participant is released
 * @returns {object}                            jsPsych trial object
 */
export function uploadProgressNode({ session, endpoint, label, maxWaitMs } = {}) {
  if (!session) {
    throw new Error('uploadProgressNode: session is required');
  }
  let summary = null;
  return {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="display: grid; place-items: center; gap: 1.25rem; max-width: 36rem; margin: 0 auto;">
        <h2 style="margin: 0;">Saving your data</h2>
        <p style="margin: 0; opacity: 0.85;">Please don't close this tab — this usually takes only a few seconds.</p>
        <div id="${PROGRESS_MOUNT_ID}" style="font-size: 1.1rem;">Starting…</div>
      </div>
    `,
    /* `choices: 'NO_KEYS'` is intentional. The plugin would otherwise accept
     * Space immediately, letting a participant dismiss the upload screen
     * mid-upload — `completionRedirectNode` then fires `window.location.href`
     * and any chunks not already in flight are lost. Instead, we attach our
     * own Space listener inside `on_load` that is gated on `canAdvance`,
     * which flips true once `runUploadFlow` resolves (it is bounded by
     * `maxWaitMs`). The trial ends via `jsPsych.finishTrial()` from the
     * listener. */
    choices: 'NO_KEYS',
    on_load: function () {
      let canAdvance = false;
      const handleSpace = (e) => {
        if (!canAdvance) return;
        if (e.key === ' ' || e.code === 'Space') {
          e.preventDefault();
          e.stopPropagation();
          document.removeEventListener('keydown', handleSpace, true);
          window.jsPsych.finishTrial();
        }
      };
      document.addEventListener('keydown', handleSpace, true);

      summary = null;
      runUploadFlow({ session, endpoint, maxWaitMs })
        .then((out) => {
          summary = out;
        })
        .catch((err) => {
          /* Defensive — runUploadFlow already catches and renders all known
           * error paths. Anything reaching here is a programming bug. */
          console.error('[debrief] unexpected upload-flow error', err);
          const mount = document.getElementById(PROGRESS_MOUNT_ID);
          if (mount) {
            mount.innerHTML = renderError(err.message ?? 'unknown error');
          }
        })
        .finally(() => {
          /* Open the gate. The render functions above already showed the
           * "Press Space to continue" prompt; key handling now agrees. */
          canAdvance = true;
        });
    },
    on_finish: (data) => {
      /* Stamp whatever the in-flight closure last published into the data
       * row, so the data record always carries a definitive upload outcome. */
      Object.assign(
        data,
        summary ?? {
          status: 'unknown',
          uploadedBuckets: 0,
          totalBuckets: 0,
          uploadedRows: 0,
          downloadFallback: false,
        }
      );
      /* Also stamp the storage-write failure tally so the analyst can see
       * whether any rows were silently dropped at append time during the
       * session (fire-and-forget catch in runner.js). */
      const storageFailures = getStorageFailureSummary();
      data.storage_write_failures = storageFailures.writeFailures;
      data.storage_last_error = storageFailures.lastError;
      data.storage_last_failure_at = storageFailures.lastFailureAtIso;
    },
    data: { phase: label ?? 'upload_session_end' },
  };
}

async function runUploadFlow({ session, endpoint, maxWaitMs }) {
  const mount = document.getElementById(PROGRESS_MOUNT_ID);
  const update = (html) => {
    if (mount) mount.innerHTML = html;
  };
  let uploadedBuckets = 0;
  let totalBuckets = 0;
  const upload = uploadPendingData({
    session,
    endpoint,
    onProgress: ({ bucketIndex: idx, totalBuckets: total, bucketLabel: label, status }) => {
      totalBuckets = total;
      if (status === 'ok') uploadedBuckets += 1;
      update(renderProgress(idx + 1, total, label));
    },
  });
  /* A stuck request must not hold the participant: after the limit the
   * download fallback is offered and the gate opens. */
  const limitMs = maxWaitMs ?? config.uploader.session_end_max_wait_ms;
  let limitTimer = null;
  const limit = new Promise((resolve) => {
    limitTimer = setTimeout(
      () =>
        resolve({
          status: 'timed_out',
          uploadedBuckets,
          totalBuckets,
          uploadedRows: 0,
          lastError: 'upload exceeded the time limit',
        }),
      limitMs
    );
  });
  let result;
  try {
    result = await Promise.race([upload, limit]);
  } finally {
    clearTimeout(limitTimer);
  }
  /* A late failure of the abandoned upload must not surface as unhandled. */
  upload.catch(() => {});

  let downloadFallback = false;
  if (['no_endpoint', 'partial', 'timed_out'].includes(result.status)) {
    /* Cases that land here:
     *   - no endpoint configured (before the upload endpoint is configured);
     *   - partial upload (retries exhausted on some bucket);
     *   - the upload did not finish within the time limit.
     * Dump everything we have to a JSON download so the data isn't trapped on
     * the participant's device. */
    try {
      const rows = await getAllTrialRows();
      const dl = downloadAsJson({ session, rows });
      downloadFallback = true;
      update(renderDownloadFallback(result, dl));
    } catch (err) {
      update(renderError(err.message));
    }
  } else if (result.status === 'nothing_to_upload') {
    update(renderNothingToUpload());
  } else {
    update(renderUploadDone(result));
  }
  return {
    status: result.status,
    uploadedBuckets: result.uploadedBuckets,
    totalBuckets: result.totalBuckets,
    uploadedRows: result.uploadedRows,
    downloadFallback,
    last_error: result.lastError,
  };
}

function renderProgress(bucketIndex, totalBuckets, bucketLabel) {
  const pct = totalBuckets > 0 ? Math.round((bucketIndex / totalBuckets) * 100) : 0;
  const labelLine = bucketLabel
    ? `<div style="margin-top: 0.25rem; opacity: 0.7; font-size: 0.85em;"><code>${escapeHtml(bucketLabel)}</code></div>`
    : '';
  return `
    <div>Uploading file ${bucketIndex} of ${totalBuckets}…</div>
    ${labelLine}
    <div style="margin-top: 0.5rem; width: 18rem; height: 0.5rem; background: #333; border-radius: 0.25rem; overflow: hidden;">
      <div style="width: ${pct}%; height: 100%; background: #34d399; transition: width 0.2s;"></div>
    </div>
  `;
}

function renderUploadDone(result) {
  return `
    <div style="color: #0a7c4d;">✓ Saved (${result.uploadedRows} rows in ${result.uploadedBuckets} files).</div>
    ${continueHintHtml('Press <kbd>Space</kbd> to continue.')}
  `;
}

function renderNothingToUpload() {
  return `
    <div style="color: #0a7c4d;">✓ Already saved.</div>
    ${continueHintHtml('Press <kbd>Space</kbd> to continue.')}
  `;
}

function renderDownloadFallback(result, dl) {
  const head =
    result.status === 'no_endpoint'
      ? `<div style="color: #8a6d00;">No upload server configured for this build.</div>`
      : `<div style="color: #8a6d00;">Upload incomplete (${result.uploadedBuckets} / ${result.totalBuckets} files). Saved a copy to your device.</div>`;
  return `
    ${head}
    <div style="margin-top: 0.5rem; opacity: 0.85;">
      A file <code>${dl.filename}</code> (${(dl.sizeBytes / 1024).toFixed(1)} KB) has been
      downloaded. Please email it to the experimenter if asked.
    </div>
    ${continueHintHtml('Press <kbd>Space</kbd> to continue.')}
  `;
}

function renderError(message) {
  return `
    <div style="color: #b3261e;">Something went wrong: ${escapeHtml(message)}</div>
    ${continueHintHtml('Press <kbd>Space</kbd> to continue.')}
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/**
 * Completion-redirect node. Counts down `redirectDelayMs` (default 5 s) and
 * navigates to the stored Prolific completion URL.
 *
 * If the URL is the placeholder template (`config.prolific.completion_url`
 * still ends in `cc=PLACEHOLDER` because the study isn't published), the
 * node skips the redirect entirely and shows a test-build notice.
 *
 * @param {object} [opts]
 * @param {number} [opts.redirectDelayMs]    default 5000
 * @returns {object}                         jsPsych trial object
 */
export function completionRedirectNode({ redirectDelayMs } = {}) {
  const delayMs = redirectDelayMs ?? REDIRECT_DELAY_MS_DEFAULT;
  let redirectUrl = null;
  return {
    type: htmlKeyboardResponse,
    stimulus: `<div id="completion-mount" style="display: grid; place-items: center; gap: 1rem; max-width: 36rem; margin: 0 auto;">Loading…</div>`,
    choices: [' '],
    trial_duration: null,
    on_load: async function () {
      const mount = document.getElementById('completion-mount');
      if (!mount) return;
      const stored = await getCompletionUrl().catch(() => null);
      const url = stored ?? buildCompletionUrl();
      const isPlaceholder = isPlaceholderCompletionUrl(url);
      if (isPlaceholder || !url) {
        mount.innerHTML = renderTestBuildNotice(url);
        redirectUrl = null;
        return;
      }
      let remainingS = Math.ceil(delayMs / 1000);
      mount.innerHTML = renderRedirectCountdown(url, remainingS);
      const interval = setInterval(() => {
        remainingS -= 1;
        if (remainingS <= 0) {
          clearInterval(interval);
          markUploadDone();
          window.location.href = url;
          return;
        }
        const node = document.getElementById('completion-countdown');
        if (node) node.textContent = String(remainingS);
      }, REDIRECT_TICK_MS);
      redirectUrl = url;
    },
    on_finish: (data) => {
      data.completion_redirect_url = redirectUrl;
      data.completion_was_placeholder = !redirectUrl;
    },
    data: { phase: 'completion_redirect' },
  };
}

function renderTestBuildNotice(url) {
  return `
    <h2 style="margin: 0;">You're done — thank you!</h2>
    <p style="margin: 0;">This is a development build. The Prolific completion URL hasn't been
    locked yet, so we're not redirecting automatically.</p>
    <div style="opacity: 0.7; font-size: 0.9em; margin-top: 0.5rem;">
      Configured URL: <code>${escapeHtml(url || '(none)')}</code>
    </div>
    ${continueHintHtml('Press <kbd>Space</kbd> to close.')}
  `;
}

function renderRedirectCountdown(url, remainingS) {
  return `
    <h2 style="margin: 0;">Thank you!</h2>
    <p style="margin: 0;">Redirecting to Prolific in <span id="completion-countdown" style="font-weight: bold;">${remainingS}</span> seconds…</p>
    <p style="margin-top: 0.5rem; opacity: 0.85;">
      If the redirect doesn't happen, <a href="${escapeHtml(url)}" style="color: #60a5fa;">click here</a>.
    </p>
  `;
}
/* Tests reference these constants so they can verify the locked defaults. */
export const _testHelpers = Object.freeze({
  REDIRECT_DELAY_MS_DEFAULT,
  PROGRESS_MOUNT_ID,
});
