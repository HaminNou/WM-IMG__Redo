import { config } from './config.js';
import {
  initStorage,
  getAllTrialRows,
  getPendingRows,
  getSessionId,
  getSessionStartedAt,
  getSessionObject,
} from './storage.js';
import { uploadPendingData, partitionRowsIntoBuckets } from './uploader.js';

const mount = document.getElementById('mount');

function render(html) {
  mount.innerHTML = `<h2>Data Recovery</h2>${html}`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

async function main() {
  let storageKind;
  try {
    const result = await initStorage();
    storageKind = result.kind;
  } catch {
    render(`
      <p class="error">Could not open browser storage. This can happen if you
      cleared your browser data or are using a different browser than the one
      you used for the experiment.</p>
    `);
    return;
  }

  if (storageKind === 'memory') {
    render(`
      <p class="error">No persistent storage found. IndexedDB is unavailable in
      this browser. Please use the same browser you used for the experiment
      (Chrome, Firefox, or Edge on a desktop computer).</p>
    `);
    return;
  }

  const rows = await getAllTrialRows();
  if (!rows || rows.length === 0) {
    render(`
      <p class="warn">No session data found in this browser. This can happen if:</p>
      <ul>
        <li>You cleared your browser data since the experiment</li>
        <li>You are using a different browser or device</li>
        <li>You are in a private/incognito window</li>
      </ul>
      <p>If you have the downloaded JSON file, please send it to the
      researcher through Prolific messaging.</p>
    `);
    return;
  }

  const sessionId = await getSessionId();
  const startedAt = await getSessionStartedAt();
  const storedSession = await getSessionObject();

  /* Pending is judged per run: a later run that finished uploading must not
   * hide the unsent rows of an earlier one. */
  const pendingRows = await getPendingRows();
  const nonEmpty = partitionRowsIntoBuckets(pendingRows).filter((p) => p.rows.length > 0);

  if (pendingRows.length === 0) {
    render(`
      <p class="success">All data from this session has already been uploaded
      successfully. No recovery is needed.</p>
      <table class="meta-table">
        <tr><td>Session</td><td><code>${escapeHtml(sessionId)}</code></td></tr>
        <tr><td>Total rows</td><td>${rows.length}</td></tr>
      </table>
    `);
    return;
  }

  let session = storedSession;
  if (!session) {
    const urlParams = new URLSearchParams(window.location.search);
    const pid = urlParams.get('PROLIFIC_PID') || null;
    const studyId = urlParams.get('STUDY_ID') || null;

    session = {
      params: {
        session_id: sessionId,
        prolific_pid: pid,
        study_id: studyId,
        is_preview: false,
      },
      prng_seed_uint32: 0,
      schema_version: config.schema_version,
      build_id: config.build_id,
      is_pilot_run: false,
      pilot_label: null,
      started_at_iso: startedAt,
      user_agent: navigator.userAgent,
    };
  }

  const uploadedAlready = rows.length - pendingRows.length;

  render(`
    <p>Found session data that was not fully uploaded.</p>
    <table class="meta-table">
      <tr><td>Session</td><td><code>${escapeHtml(sessionId)}</code></td></tr>
      <tr><td>Started</td><td>${escapeHtml(startedAt ?? 'unknown')}</td></tr>
      <tr><td>Total rows</td><td>${rows.length}</td></tr>
      <tr><td>Already uploaded</td><td>${uploadedAlready} rows</td></tr>
      <tr><td>Pending upload</td><td>${pendingRows.length} rows</td></tr>
      <tr><td>Files to upload</td><td>${nonEmpty.length}</td></tr>
    </table>
    <p>Click the button below to re-upload your data. This usually takes a few seconds.</p>
    <button id="upload-btn">Upload my data</button>
    <div id="progress-area" class="hidden">
      <div class="progress-bar"><div class="progress-bar-fill" id="bar-fill"></div></div>
      <div class="status" id="status-text">Starting&hellip;</div>
    </div>
  `);

  document.getElementById('upload-btn').addEventListener('click', () => {
    runUpload(session);
  });
}

async function runUpload(session) {
  const btn = document.getElementById('upload-btn');
  const progressArea = document.getElementById('progress-area');
  const barFill = document.getElementById('bar-fill');
  const statusText = document.getElementById('status-text');

  btn.disabled = true;
  btn.textContent = 'Uploading…';
  progressArea.classList.remove('hidden');

  try {
    const result = await uploadPendingData({
      session,
      allRuns: true,
      onProgress: ({ bucketIndex, totalBuckets, bucketLabel, status }) => {
        const done = bucketIndex + 1;
        const pct = Math.round((done / totalBuckets) * 100);
        barFill.style.width = `${pct}%`;
        const icon = status === 'ok' ? '✓' : '✗';
        statusText.textContent = `${icon} File ${done} of ${totalBuckets} (${bucketLabel})`;
      },
    });

    if (result.status === 'uploaded') {
      barFill.style.width = '100%';
      statusText.innerHTML = `<span class="success">✓ All data uploaded successfully
        (${result.uploadedRows} rows in ${result.uploadedBuckets} files).</span>
        <br><br>You can close this page. Thank you!`;
      btn.textContent = 'Done';
    } else if (result.status === 'nothing_to_upload') {
      statusText.innerHTML = `<span class="success">✓ All data was already uploaded. Nothing to do.</span>`;
      btn.textContent = 'Done';
    } else if (result.status === 'partial') {
      barFill.style.background = '#f59e0b';
      statusText.innerHTML = `<span class="warn">Partial upload: ${result.uploadedBuckets} of
        ${result.totalBuckets} files sent.</span>
        <br>Error: <code>${escapeHtml(result.lastError)}</code>
        <br><br>Please try again, or contact the researcher through Prolific messaging.`;
      btn.disabled = false;
      btn.textContent = 'Retry';
    } else {
      statusText.innerHTML = `<span class="error">Upload could not start (${escapeHtml(result.status)}).
        Please contact the researcher through Prolific messaging.</span>`;
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  } catch (err) {
    statusText.innerHTML = `<span class="error">Unexpected error: ${escapeHtml(err.message)}</span>
      <br><br>Please try again, or contact the researcher through Prolific messaging.`;
    btn.disabled = false;
    btn.textContent = 'Retry';
  }
}

main().catch((err) => {
  console.error('[recover] fatal error', err);
  render(`<p class="error">Something went wrong: ${escapeHtml(err.message)}</p>`);
});
