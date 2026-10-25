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
 *      Just before the redirect the rows written since the end-of-session
 *      upload (the upload summary and the completion row) are sent in one
 *      short extra file, limited to a few seconds.
 *
 * When the upload did NOT succeed (status partial, timed_out or no_endpoint)
 * the completion node does not redirect on its own. The participant has
 * finished the study, and a problem on our side must not cost them the
 * completion code, but nobody should be moved on before their data is safe
 * either. The screen therefore (a) says plainly what happened, (b) offers a
 * new upload attempt and a second download of the data file, and (c) shows a
 * "Continue to Prolific" button that the participant presses once the file is
 * saved. Pressing it writes `redirect_after_failed_upload: true` into the
 * completion row, tries one last upload for a few seconds, and then goes to
 * Prolific. The researcher can compare Prolific submissions with the files that
 * arrived to find who still needs to send a file.
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
  uploadTail,
  downloadAsJson,
  buildCompletionUrl,
  isPlaceholderCompletionUrl,
} from '../uploader.js';
import {
  appendTrialRow,
  getAllTrialRows,
  getCompletionUrl,
  getStorageFailureSummary,
} from '../storage.js';
import { rowClock } from '../clock.js';
import { markUploadDone } from '../session-guard.js';
import { continueHintHtml } from '../visuals/continue-hint.js';

const PROGRESS_MOUNT_ID = 'upload-progress-mount';
const REDIRECT_DELAY_MS_DEFAULT = 5000;
const REDIRECT_TICK_MS = 1000;
/* Longest the "Continue to Prolific" button waits for one last upload. */
const FINAL_UPLOAD_WAIT_MS = 6000;
/* Upload outcomes that count as saved. Anything else sends the participant to the failure screen. */
const UPLOAD_SAVED = ['uploaded', 'nothing_to_upload'];
const UPLOAD_FAILED = ['partial', 'timed_out', 'no_endpoint'];
/* Longest the redirect waits for the last upload. */
const TAIL_WAIT_MS = 2500;

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
        <p style="margin: 0; opacity: 0.85;">Please don't close this tab – this usually takes only a few seconds.</p>
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
  } catch (err) {
    /* The upload threw instead of resolving (for example while building a
     * file). That must not strand the data: report it as a partial upload so
     * the download fallback below is offered. */
    console.error('[debrief] upload failed', err);
    result = {
      status: 'partial',
      uploadedBuckets,
      totalBuckets,
      uploadedRows: 0,
      lastError: String(err?.message ?? err),
    };
  } finally {
    clearTimeout(limitTimer);
  }
  /* A late failure of the abandoned upload must not surface as unhandled. */
  upload.catch(() => {});

  let downloadFallback = false;
  let downloadName = null;
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
      downloadName = dl.filename;
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
    download_filename: downloadName,
    failed_buckets: result.failedBuckets ?? null,
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
      A copy of your data, <code>${escapeHtml(dl.filename)}</code> (${(dl.sizeBytes / 1024).toFixed(1)} KB),
      has been downloaded to your device. The next screen explains what to do with it.
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
 * @param {object} [opts.session]            prolific session object; needed for the last upload
 * @returns {object}                         jsPsych trial object
 */
export function completionRedirectNode({ redirectDelayMs, session } = {}) {
  const delayMs = redirectDelayMs ?? REDIRECT_DELAY_MS_DEFAULT;
  let redirectUrl = null;
  let trialFinished = false;
  /* True when the upload before this screen did not succeed (see the header). */
  let failedUpload = false;
  let countdownTimer = null;
  let removeSpaceBlock = null;
  /* Upload attempts made on this screen after the end-of-session upload failed.
   * Each one writes an `upload_retry_result` row, so the data show the LATEST
   * outcome and not only the first (`upload_session_end` keeps the status of
   * the first attempt, e.g. 'partial', even when a retry then delivered every
   * file). The row is written before the next tail upload, so it travels. */
  let uploadAttempts = 0;
  const recordUploadAttempt = async (status, trigger) => {
    uploadAttempts += 1;
    const first = lastUploadRow();
    await appendTrialRow({
      phase: 'upload_retry_result',
      status,
      upload_attempt: uploadAttempts,
      after_failure: true,
      retry_trigger: trigger,
      previous_status: first?.status ?? null,
      ...rowClock(),
    }).catch((err) => console.error('[debrief] upload retry row failed', err));
  };
  /* Send the rows written since the end-of-session upload. Never waits longer
   * than TAIL_WAIT_MS, and a failure changes nothing for the participant. */
  const sendTail = async () => {
    if (!session) return;
    let timer = null;
    const limit = new Promise((resolve) => {
      timer = setTimeout(resolve, TAIL_WAIT_MS);
    });
    try {
      await Promise.race([uploadTail({ session }), limit]);
    } catch (err) {
      console.error('[debrief] last upload failed', err);
    } finally {
      clearTimeout(timer);
    }
  };
  /* After a failed upload: one more attempt, bounded, with the completion row
   * already in storage so that it travels with the data if the attempt works. */
  const finalUploadAttempt = async () => {
    if (!session) return;
    let timer = null;
    const limit = new Promise((resolve) => {
      timer = setTimeout(resolve, FINAL_UPLOAD_WAIT_MS);
    });
    let status = 'timed_out';
    try {
      const result = await Promise.race([uploadPendingData({ session }), limit]);
      if (result && typeof result.status === 'string') status = result.status;
    } catch (err) {
      status = 'error';
      console.error('[debrief] final upload attempt failed', err);
    } finally {
      clearTimeout(timer);
    }
    await recordUploadAttempt(status, 'continue_button');
  };
  const redirect = async (url, { afterFailedUpload = false } = {}) => {
    /* The page is about to be left, so the trial will not finish: write its
     * row here, unless the participant already ended the trial. */
    if (!trialFinished) {
      await appendTrialRow({
        phase: 'completion_redirect',
        completion_redirect_url: url,
        completion_was_placeholder: false,
        redirect_after_failed_upload: afterFailedUpload,
        ...rowClock(),
      }).catch((err) => console.error('[debrief] completion row failed', err));
    }
    if (afterFailedUpload) await finalUploadAttempt();
    await sendTail();
    markUploadDone();
    window.location.href = url;
  };
  const startCountdown = (mount, url) => {
    blockSpaceOutsideControls();
    let remainingS = Math.ceil(delayMs / 1000);
    mount.innerHTML = renderRedirectCountdown(url, remainingS);
    countdownTimer = setInterval(() => {
      remainingS -= 1;
      if (remainingS <= 0) {
        clearInterval(countdownTimer);
        void redirect(url);
        return;
      }
      const node = document.getElementById('completion-countdown');
      if (node) node.textContent = String(remainingS);
      const unit = document.getElementById('completion-countdown-unit');
      if (unit) unit.textContent = secondsWord(remainingS);
    }, REDIRECT_TICK_MS);
  };
  /* While the failure screen or the countdown is up, Space must never reach
   * jsPsych: this trial accepts [' '] as a response, and a Space that bubbles to
   * the engine ends the trial, which empties the screen and leaves the
   * participant with nothing (and no redirect). So the key is always stopped here.
   * On a real button or link the default action is kept, because that is how the
   * keyboard activates it (the click fires on keyup, after the trial could have
   * been ended). Anywhere else the default is cancelled too. */
  const blockSpaceOutsideControls = () => {
    if (removeSpaceBlock) return;
    const handler = (e) => {
      if (e.key !== ' ' && e.code !== 'Space') return;
      e.stopPropagation();
      const t = e.target;
      if (t && typeof t.closest === 'function' && t.closest('button, a')) return;
      e.preventDefault();
    };
    document.addEventListener('keydown', handler, true);
    removeSpaceBlock = () => {
      document.removeEventListener('keydown', handler, true);
      removeSpaceBlock = null;
    };
  };
  const showUploadFailure = (mount, url, downloadName) => {
    mount.innerHTML = renderUploadFailure({
      downloadName,
      canRetry: Boolean(session),
    });
    blockSpaceOutsideControls();
    const status = document.getElementById('upload-failure-status');
    const say = (text) => {
      if (status) status.textContent = text;
    };
    const buttons = () => Array.from(mount.querySelectorAll('button'));
    const setBusy = (busy) => buttons().forEach((b) => (b.disabled = busy));

    document.getElementById('upload-download-again')?.addEventListener('click', async () => {
      try {
        const rows = await getAllTrialRows();
        const dl = downloadAsJson({ session, rows });
        say(`Saved ${dl.filename} to your downloads.`);
      } catch {
        say('The file could not be saved. Please message the researcher through Prolific.');
      }
    });

    document.getElementById('upload-retry')?.addEventListener('click', async () => {
      setBusy(true);
      say('Sending… this can take up to a minute.');
      let result;
      try {
        result = await uploadPendingData({
          session,
          onProgress: ({ bucketIndex: i, totalBuckets: n }) =>
            say(`Sending file ${i + 1} of ${n}…`),
        });
      } catch {
        result = { status: 'partial' };
      }
      await recordUploadAttempt(result.status, 'retry_button');
      if (UPLOAD_SAVED.includes(result.status)) {
        removeSpaceBlock?.();
        failedUpload = false;
        startCountdown(mount, url);
        return;
      }
      say(
        'We still could not reach our server. Please keep the downloaded file and use the button below.'
      );
      setBusy(false);
    });

    document.getElementById('upload-continue')?.addEventListener('click', () => {
      setBusy(true);
      say('Taking you back to Prolific…');
      void redirect(url, { afterFailedUpload: true });
    });
  };
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
      redirectUrl = url;
      const outcome = lastUploadRow();
      failedUpload = Boolean(outcome && UPLOAD_FAILED.includes(outcome.status));
      if (failedUpload) {
        showUploadFailure(mount, url, outcome.download_filename ?? null);
        return;
      }
      startCountdown(mount, url);
    },
    on_finish: (data) => {
      trialFinished = true;
      removeSpaceBlock?.();
      data.completion_redirect_url = redirectUrl;
      data.completion_was_placeholder = !redirectUrl;
      data.redirect_after_failed_upload = failedUpload;
      /* The row is stored after this callback returns. */
      setTimeout(() => void sendTail(), 0);
    },
    data: { phase: 'completion_redirect' },
  };
}

/** The data row the upload screen wrote (`phase: 'upload_session_end'`), or null. */
function lastUploadRow() {
  try {
    const rows = window.jsPsych?.data?.get?.().filter({ phase: 'upload_session_end' }).values();
    return rows && rows.length > 0 ? rows[rows.length - 1] : null;
  } catch {
    return null;
  }
}

function renderUploadFailure({ downloadName, canRetry }) {
  const fileLine = downloadName
    ? `<p>A copy of your answers was downloaded to your device as <code>${escapeHtml(downloadName)}</code> (look in your Downloads folder). Please keep that file and send it to the researcher through Prolific messaging.</p>`
    : `<p>Use the button below to save a copy of your answers to your device, then send that file to the researcher through Prolific messaging.</p>`;
  const retry = canRetry
    ? `<button id="upload-retry" type="button" style="font-size: 1rem; padding: 0.5rem 1rem;">Try sending my answers again</button>`
    : '';
  return `
    <h2 style="margin: 0;">Thank you – one more step</h2>
    <p style="margin: 0;">You have finished the study, but we could not send your answers to our server automatically.</p>
    ${fileLine}
    <div style="display: flex; gap: 0.75rem; flex-wrap: wrap; justify-content: center;">
      ${retry}
      <button id="upload-download-again" type="button" style="font-size: 1rem; padding: 0.5rem 1rem;">Download my data file again</button>
    </div>
    <p id="upload-failure-status" aria-live="polite" style="margin: 0; min-height: 1.5em;"></p>
    <p style="margin: 0;">When your file is saved, press the button below. It takes you back to Prolific to record that you finished.</p>
    <button id="upload-continue" type="button" style="font-size: 1.1rem; padding: 0.6rem 1.2rem;">Continue to Prolific</button>
  `;
}

function renderTestBuildNotice(url) {
  return `
    <h2 style="margin: 0;">You're done – thank you!</h2>
    <p style="margin: 0;">This is a development build. The Prolific completion URL hasn't been
    locked yet, so we're not redirecting automatically.</p>
    <div style="opacity: 0.7; font-size: 0.9em; margin-top: 0.5rem;">
      Configured URL: <code>${escapeHtml(url || '(none)')}</code>
    </div>
    ${continueHintHtml('Press <kbd>Space</kbd> to close.')}
  `;
}

/** "second" for 1, "seconds" otherwise ("in 1 seconds" is wrong). */
function secondsWord(n) {
  return n === 1 ? 'second' : 'seconds';
}

/* Link colour on the light page backgrounds (#d3d3d3 grey, #ffffff white).
 * #1e40af gives 5.8:1 on grey and 8.7:1 on white; the previous #60a5fa gave
 * 1.7:1 and 2.5:1 (verifier V4-03). WCAG AA for normal text needs 4.5:1. */
const COMPLETION_LINK_COLOUR = '#1e40af';

function renderRedirectCountdown(url, remainingS) {
  return `
    <h2 style="margin: 0;">Thank you!</h2>
    <p style="margin: 0;">Redirecting to Prolific in <span id="completion-countdown" style="font-weight: bold;">${remainingS}</span> <span id="completion-countdown-unit">${secondsWord(remainingS)}</span>…</p>
    <p style="margin-top: 0.5rem; opacity: 0.85;">
      If the redirect doesn't happen, <a href="${escapeHtml(url)}" style="color: ${COMPLETION_LINK_COLOUR}; text-decoration: underline;">click here</a>.
    </p>
  `;
}
/* Tests reference these constants so they can verify the locked defaults. */
export const _testHelpers = Object.freeze({
  REDIRECT_DELAY_MS_DEFAULT,
  PROGRESS_MOUNT_ID,
  COMPLETION_LINK_COLOUR,
  renderRedirectCountdown,
});
