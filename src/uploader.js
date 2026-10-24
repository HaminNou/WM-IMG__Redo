/**
 * Bucket-per-envelope data uploader.
 *
 * Rows are written to IndexedDB as they are produced (see `storage.js`); this
 * module handles the networking half.
 *
 * Design:
 *
 *   - **One DataPipe POST per logical bucket.** A session produces up to 10
 *     named bucket files in storage: one per analysis-relevant slice of the data
 *     (consent + demographics, practice, each of the five main-task
 *     conditions, music questionnaire, strategy questionnaire, and a meta
 *     bucket for everything else). Buckets that received no rows are not
 *     sent. Filenames are deterministic (`<session_id>__NN_<label>.json`) so a
 *     repeat of a bucket DataPipe already holds is reported as FILE_EXISTS and
 *     counted as delivered.
 *
 *   - **When uploads happen.** The consent and practice buckets are sent at
 *     the inter-block rest (`uploadConsentAndPractice`), and every rest screen
 *     sends a checkpoint file with the rows since the previous checkpoint
 *     (`uploadCheckpoint`). Both are cancelled when the rest ends, so no
 *     request is in flight during a trial. The remaining buckets are sent once
 *     at the debrief node (`uploadPendingData`) or, for a session ended by a
 *     check, at the exit screen. Checkpoint files are used in analysis only
 *     for sessions that did not finish.
 *
 *   - **Bounded requests.** Each POST is aborted after
 *     `config.uploader.request_timeout_ms`, and is retried up to `retryMax`
 *     times with `initialBackoffMs * 2^attempt` delays (default 5 retries /
 *     1 s initial). A caller can also cancel with an `AbortSignal`.
 *
 *   - **All-or-nothing cursor advance.** The upload cursor advances past the
 *     session's highest seq only after every bucket POST succeeds. A failure
 *     leaves the cursor untouched, so a re-run re-POSTs every bucket
 *     (buckets already stored come back as FILE_EXISTS and count as
 *     delivered, failed ones get another retry).
 *
 *   - **No silent failures.** A permanent bucket failure returns
 *     `status: 'partial'`. The caller (debrief node) offers a JSON download
 *     as a participant-visible fallback.
 *
 *   - **Provider-aware wire format.** The bucket envelope produced by
 *     `buildBucketEnvelope` is the canonical row carrier (rows + session
 *     metadata). When `provider === 'datapipe'`, each envelope is wrapped in
 *     DataPipe's `{experimentID, filename, data}` shape via
 *     `buildDataPipeEnvelope` before POST. Otherwise the raw bucket envelope
 *     is POSTed directly.
 *
 *   - **Provider absence = explicit no-op + download fallback.** When
 *     `config.uploader.endpoint` is null, or the provider is `'datapipe'`
 *     and `datapipe_experiment_id` is still the `PLACEHOLDER` token,
 *     `uploadPendingData` returns `{ status: 'no_endpoint' }` immediately and
 *     the download fallback handles the data egress.
 */
import { config } from './config.js';
import { getAllTrialRows, getTrialRowsAfter, getUploadCursor, setUploadCursor } from './storage.js';

const midSessionUploaded = new Set();

/* ---------- Bucket definitions ---------- */

/**
 * The 10 uploaded buckets, in the order they're uploaded and the order
 * they should appear in a directory listing (filenames carry the
 * two-digit prefix so alphanumeric sort matches this array).
 *
 * Each bucket has:
 *   - `id`      stable short identifier used in envelopes and tests
 *   - `label`   file-stem suffix (becomes `<session_id>__<label>.json`)
 *   - `matches` predicate over a single row; the first matching bucket
 *               (walking in array order) wins
 *
 * `meta` is the trailing catch-all — anything not claimed by an earlier
 * bucket (calibration, instructions, demos, fullscreen / visibility events,
 * pattern phases, rest screens, hidden-nav skip markers, upload-session-end,
 * completion-redirect, ...) lands here so no row is ever dropped.
 *
 * The exact membership rules are intentional and documented in the
 * pre-registration (`pre-reg/pre-reg.json#config_locked.uploader`):
 *
 *   - Main-task trial rows are bucketed by **trial-type prefix on `phase`**,
 *     gated on `block_label ∈ {main_a, main_b}` so practice runs of the same
 *     trial types are NOT mixed in. Practice trial rows (block_label =
 *     'practice') always go to the practice bucket regardless of phase.
 *   - The two questionnaires include their respective intro screens
 *     (`questionnaire_intro` for strategy; `music_experience_intro` for
 *     music) so each file is self-contained for analysis.
 */
export const BUCKETS = Object.freeze([
  Object.freeze({
    id: 'consent_demographics',
    label: '01_consent_demographics',
    matches: (r) => r?.phase === 'consent' || r?.phase === 'demographics',
  }),
  Object.freeze({
    id: 'practice',
    label: '02_practice',
    matches: (r) =>
      r?.block_label === 'practice' ||
      r?.phase === 'practice_iteration_start' ||
      r?.phase === 'practice_feedback',
  }),
  Object.freeze({
    id: 'd_only',
    label: '03_d_only',
    matches: (r) => isMainBlock(r) && phaseStartsWith(r, 'd_only'),
  }),
  Object.freeze({
    id: 'i_only',
    label: '04_i_only_star_only',
    matches: (r) => isMainBlock(r) && phaseStartsWith(r, 'i_only'),
  }),
  Object.freeze({
    id: 't_only',
    label: '05_t_only',
    matches: (r) => isMainBlock(r) && phaseStartsWith(r, 't_only'),
  }),
  Object.freeze({
    id: 'i_t',
    label: '06_i_t_dual_tone_star',
    matches: (r) => isMainBlock(r) && phaseStartsWith(r, 'i_t_'),
  }),
  Object.freeze({
    id: 'i_d',
    label: '07_i_d_dual_dot_star',
    matches: (r) => isMainBlock(r) && phaseStartsWith(r, 'i_d_'),
  }),
  Object.freeze({
    id: 'music_questionnaire',
    label: '08_music_questionnaire',
    matches: (r) => phaseStartsWith(r, 'music_experience'),
  }),
  Object.freeze({
    id: 'strategy_questionnaire',
    label: '09_strategy_questionnaire',
    matches: (r) => r?.phase === 'questionnaire_intro' || phaseStartsWith(r, 'strategy_'),
  }),
  Object.freeze({
    id: 'meta',
    label: '10_meta',
    matches: () => true /* catch-all */,
  }),
]);

function isMainBlock(r) {
  return r?.block_label === 'main_a' || r?.block_label === 'main_b';
}

function phaseStartsWith(r, prefix) {
  return typeof r?.phase === 'string' && r.phase.startsWith(prefix);
}

/**
 * Return the bucket that claims `row` — the first one in `BUCKETS` order whose
 * `matches` predicate returns truthy. Always returns a bucket (the `meta`
 * catch-all is the last entry).
 *
 * @param {object} row
 * @returns {{id:string,label:string,matches:Function}}
 */
export function bucketForRow(row) {
  for (const b of BUCKETS) {
    if (b.matches(row)) return b;
  }
  /* Unreachable — meta's predicate returns true unconditionally. Defensive. */
  return BUCKETS[BUCKETS.length - 1];
}

/**
 * Partition `rows` into per-bucket lists, preserving input order within each
 * bucket. Returns one entry per bucket in `BUCKETS` order, including empty
 * buckets — the uploader filters those out before POSTing so empty files
 * don't pollute storage, but the full structure is returned for testing /
 * introspection.
 *
 * @param {object[]} rows
 * @returns {{bucket: object, rows: object[]}[]}
 */
export function partitionRowsIntoBuckets(rows) {
  const byId = new Map(BUCKETS.map((b) => [b.id, []]));
  for (const r of rows) {
    const b = bucketForRow(r);
    byId.get(b.id).push(r);
  }
  return BUCKETS.map((b) => ({ bucket: b, rows: byId.get(b.id) }));
}

/* ---------- Pure helpers (exported for tests) ---------- */

/**
 * Build the JSON envelope POSTed for one bucket. The shape is intentionally
 * flat and explicit so a server-side handler in any language can consume it
 * without schema gymnastics.
 *
 * @param {object} opts
 * @param {object} opts.session         output of `prolific.initSession()`
 * @param {object} opts.bucket          one entry from `BUCKETS`
 * @param {number} opts.bucketIndex     zero-based index over the *uploaded*
 *                                      (non-empty) buckets
 * @param {number} opts.totalBuckets    count of non-empty buckets being POSTed
 * @param {object[]} opts.rows          rows from storage; each carries a `seq`
 * @returns {object}
 */
export function buildBucketEnvelope({ session, bucket, bucketIndex, totalBuckets, rows }) {
  if (!bucket || typeof bucket.id !== 'string' || typeof bucket.label !== 'string') {
    throw new Error('buildBucketEnvelope: bucket must be a BUCKETS entry with id + label');
  }
  const seqs = rows.map((r) => r.seq).filter((s) => Number.isFinite(s));
  return {
    session_id: session.params.session_id,
    prolific_pid: session.params.prolific_pid,
    study_id: session.params.study_id,
    is_preview: session.params.is_preview,
    prng_seed_uint32: session.prng_seed_uint32,
    schema_version: session.schema_version,
    build_id: session.build_id,
    is_pilot_run: session.is_pilot_run ?? false,
    pilot_label: session.pilot_label ?? null,
    started_at_iso: session.started_at_iso,
    user_agent: session.user_agent,
    bucket_id: bucket.id,
    bucket_label: bucket.label,
    bucket_index: bucketIndex,
    total_buckets: totalBuckets,
    seq_min: seqs.length ? Math.min(...seqs) : null,
    seq_max: seqs.length ? Math.max(...seqs) : null,
    n_rows: rows.length,
    rows,
    uploaded_at_iso: new Date().toISOString(),
  };
}

/**
 * DataPipe filename for a bucket: `<session_id>__<bucket_label>.json`.
 *
 * Stability requirements:
 *   - **Unique per bucket per session.** DataPipe stores each POST as a
 *     separate file under the project; a repeated filename is refused. Each
 *     bucket's `label` is unique, so the composite is unique per session.
 *   - **Deterministic across runs of the same session.** The bucket label
 *     comes from the static `BUCKETS` table, so a retry POSTs the same
 *     filename. DataPipe rejects a name that already exists (FILE_EXISTS);
 *     the uploader counts that as delivered, and failed posts get another
 *     attempt.
 *   - **Sorts alphabetically in storage in canonical order.** Labels carry a
 *     two-digit prefix (`01_…` through `10_…`) so a directory listing matches
 *     the analysis-relevant order without manual sort.
 */
export function dataPipeFilenameForBucket({ session_id, bucket_label }) {
  if (!session_id) {
    throw new Error('dataPipeFilenameForBucket: session_id is required');
  }
  if (!bucket_label) {
    throw new Error('dataPipeFilenameForBucket: bucket_label is required');
  }
  return `${session_id}__${bucket_label}.json`;
}

/**
 * Wrap a bucket envelope in DataPipe's `{experimentID, filename, data}` POST
 * shape (https://pipe.jspsych.org). DataPipe ignores everything outside the
 * three named fields, so the full bucket envelope is JSON-stringified into
 * `data` and stored in storage as a single per-bucket file.
 *
 * @param {object} opts
 * @param {object} opts.bucketEnvelope    output of `buildBucketEnvelope`
 * @param {string} opts.experimentId      DataPipe experiment ID for this study
 * @returns {{experimentID: string, filename: string, data: string}}
 */
export function buildDataPipeEnvelope({ bucketEnvelope, experimentId }) {
  if (!experimentId || isPlaceholderDataPipeId(experimentId)) {
    throw new Error(
      `buildDataPipeEnvelope: experimentId must be a non-placeholder string (got ${JSON.stringify(experimentId)})`
    );
  }
  if (!bucketEnvelope || typeof bucketEnvelope !== 'object') {
    throw new Error('buildDataPipeEnvelope: bucketEnvelope is required');
  }
  return {
    experimentID: experimentId,
    filename: dataPipeFilenameForBucket({
      session_id: bucketEnvelope.session_id,
      bucket_label: bucketEnvelope.bucket_label,
    }),
    data: JSON.stringify(bucketEnvelope),
  };
}

/**
 * True iff the configured DataPipe experiment ID is still the placeholder
 * token. Mirrors `isPlaceholderCompletionUrl` — the gating predicate the
 * uploader (and preflight) use to decide whether DataPipe is provisioned.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isPlaceholderDataPipeId(id) {
  if (typeof id !== 'string') return true;
  if (id.length === 0) return true;
  return id.includes('PLACEHOLDER');
}

/**
 * POST `body` to `url` with bounded exponential-backoff retry. Resolves on
 * first 2xx, rejects after `retryMax` failed attempts.
 *
 * Failure modes that trigger retry:
 *   - network error (fetch throws) or a request that exceeds `timeoutMs`;
 *   - non-2xx response (server returned an error code).
 * Failure modes that do NOT retry:
 *   - 4xx with status 400/401/403/404/422 (programming error — retrying
 *     won't help). Throws immediately with the response status.
 *   - the caller's `signal` is aborted. Throws immediately.
 *
 * @param {object}        opts
 * @param {string}        opts.url
 * @param {object}        opts.body
 * @param {number}        [opts.retryMax]
 * @param {number}        [opts.initialBackoffMs]
 * @param {number}        [opts.timeoutMs]       per-request limit
 * @param {AbortSignal}   [opts.signal]          cancels the whole call
 * @param {Function}      [opts.fetchImpl]       defaults to globalThis.fetch — overridable for tests
 * @param {Function}      [opts.sleepImpl]       defaults to setTimeout-based; overridable for tests
 * @returns {Promise<{ok: true, status: number, attempt: number}>}
 */
export async function postWithRetry({
  url,
  body,
  retryMax = config.uploader.retry_max,
  initialBackoffMs = config.uploader.retry_initial_backoff_ms,
  timeoutMs = config.uploader.request_timeout_ms,
  signal,
  fetchImpl,
  sleepImpl,
} = {}) {
  const fetcher = fetchImpl ?? globalThis.fetch;
  const sleeper = sleepImpl ?? defaultSleep;
  let lastError = null;

  for (let attempt = 0; attempt <= retryMax; attempt++) {
    if (signal?.aborted) throw new Error('postWithRetry: cancelled');
    if (attempt > 0) {
      const delay = initialBackoffMs * 2 ** (attempt - 1);
      await sleeper(delay);
      if (signal?.aborted) throw new Error('postWithRetry: cancelled');
    }
    let response;
    try {
      response = await fetchWithTimeout(
        fetcher,
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        timeoutMs,
        signal
      );
    } catch (err) {
      if (signal?.aborted) throw new Error('postWithRetry: cancelled');
      lastError = err;
      continue;
    }
    if (response.ok) {
      return { ok: true, status: response.status, attempt };
    }
    if ([400, 401, 403, 404, 422].includes(response.status)) {
      const text = await safeReadText(response);
      /* DataPipe refuses a second file with the same name. A repeat of a
       * file that already arrived (for example after a lost response) is
       * therefore already stored, not a failure. */
      if (response.status === 400 && text && text.includes('FILE_EXISTS')) {
        return { ok: true, status: response.status, attempt, duplicate: true };
      }
      throw new Error(
        `postWithRetry: non-retryable ${response.status} from ${url}: ${text || 'no body'}`
      );
    }
    lastError = new Error(`postWithRetry: ${response.status} ${response.statusText}`);
  }
  throw new Error(
    `postWithRetry: gave up after ${retryMax + 1} attempts to ${url}: ${lastError?.message ?? 'unknown error'}`
  );
}

/** fetch that is aborted after `timeoutMs` or when `outerSignal` aborts. */
async function fetchWithTimeout(fetcher, url, init, timeoutMs, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------- Early upload at the inter-block rest ---------- */

/**
 * Upload ONLY the consent_demographics and practice buckets during the
 * inter-block rest. These two small files serve as proof-of-progress: their
 * presence in storage confirms the participant completed calibration, consent,
 * demographics, instructions, practice, and all of Main A.
 *
 * Successfully uploaded bucket IDs are recorded in `midSessionUploaded` so
 * the end-of-session `uploadPendingData` skips them — no redundant POST.
 * If this upload fails, no bucket is marked and the end-of-session upload
 * sends everything as usual (fail-safe).
 *
 * @param {object} opts
 * @param {object} opts.session   prolific session object
 * @param {AbortSignal} [opts.signal]   cancels the upload (the rest screen ends)
 * @returns {Promise<{uploaded: string[], failed: string|null}>}
 */
export async function uploadConsentAndPractice({ session, signal } = {}) {
  const url = config.uploader.endpoint;
  const provider = config.uploader.provider ?? 'raw';
  const experimentId = config.uploader.datapipe_experiment_id ?? null;

  if (!url || (provider === 'datapipe' && isPlaceholderDataPipeId(experimentId))) {
    return { uploaded: [], failed: 'no_endpoint' };
  }

  const allRows = await getAllTrialRows();
  const partitioned = partitionRowsIntoBuckets(allRows);
  const targetIds = new Set(['consent_demographics', 'practice']);
  const targets = partitioned.filter((p) => targetIds.has(p.bucket.id) && p.rows.length > 0);

  if (targets.length === 0) {
    return { uploaded: [], failed: null };
  }

  const uploaded = [];
  for (const { bucket, rows } of targets) {
    const envelope = buildBucketEnvelope({
      session,
      bucket,
      bucketIndex: uploaded.length,
      totalBuckets: targets.length,
      rows,
    });
    const body =
      provider === 'datapipe'
        ? buildDataPipeEnvelope({ bucketEnvelope: envelope, experimentId })
        : envelope;
    try {
      await postWithRetry({ url, body, signal });
      uploaded.push(bucket.id);
      midSessionUploaded.add(bucket.id);
    } catch (err) {
      return { uploaded, failed: err.message };
    }
  }
  return { uploaded, failed: null };
}

/* ---------- Checkpoint uploads ---------- */

/** Highest row sequence already sent in a checkpoint file. */
let checkpointCursor = 0;

/**
 * Upload every row after the last checkpoint as one file named
 * `<session_id>__ckpt_<seqMin>-<seqMax>.json`. File names are unique, so no
 * overwrite is involved. Called at the rest screens, so a crash or a closed
 * tab loses at most the stretch since the last rest. The cursor advances only
 * on success, so a cancelled or failed checkpoint is included in the next
 * one. The end-of-session bucket upload is unaffected; analysis uses the
 * checkpoint files only for sessions that did not finish.
 *
 * @param {object} opts
 * @param {object} opts.session   prolific session object
 * @param {AbortSignal} [opts.signal]   cancels the upload (the rest screen ends)
 * @param {string} [opts.endpoint]   defaults to config.uploader.endpoint
 * @param {string} [opts.datapipeExperimentId]   defaults to config.uploader.datapipe_experiment_id
 * @param {Function} [opts.fetchImpl]   overridable for tests
 * @param {Function} [opts.sleepImpl]   overridable for tests
 * @returns {Promise<{status: string, rows?: number, error?: string}>}
 */
export async function uploadCheckpoint({
  session,
  signal,
  endpoint,
  datapipeExperimentId,
  fetchImpl,
  sleepImpl,
} = {}) {
  const url = endpoint ?? config.uploader.endpoint;
  const provider = config.uploader.provider ?? 'raw';
  const experimentId = datapipeExperimentId ?? config.uploader.datapipe_experiment_id ?? null;
  if (!url || (provider === 'datapipe' && isPlaceholderDataPipeId(experimentId))) {
    return { status: 'no_endpoint' };
  }
  const rows = (await getAllTrialRows()).filter((r) => r.seq > checkpointCursor);
  if (rows.length === 0) return { status: 'nothing' };
  const seqMin = Math.min(...rows.map((r) => r.seq));
  const seqMax = Math.max(...rows.map((r) => r.seq));
  const envelope = buildBucketEnvelope({
    session,
    bucket: { id: 'checkpoint', label: `ckpt_${seqMin}-${seqMax}` },
    bucketIndex: 0,
    totalBuckets: 1,
    rows,
  });
  const body =
    provider === 'datapipe'
      ? buildDataPipeEnvelope({ bucketEnvelope: envelope, experimentId })
      : envelope;
  try {
    await postWithRetry({ url, body, signal, fetchImpl, sleepImpl });
    checkpointCursor = seqMax;
    return { status: 'ok', rows: rows.length };
  } catch (err) {
    return { status: 'failed', error: err.message };
  }
}

/** Test helper: forget which rows were sent in checkpoints. */
export function _resetCheckpointForTests() {
  checkpointCursor = 0;
}

/* ---------- Public uploader entrypoint ---------- */

/**
 * Upload all rows in storage that haven't been uploaded yet, partitioned into
 * the canonical 10-bucket layout.
 *
 * Reads the upload cursor; pulls all rows with `seq > cursor`; partitions
 * them by bucket; POSTs each non-empty bucket in `BUCKETS` order; advances
 * the cursor past the highest uploaded seq only after every bucket succeeds.
 * On endpoint absence, returns `{status: 'no_endpoint'}` without touching the
 * cursor. On a permanent per-bucket failure, returns `{status: 'partial'}`
 * with `uploadedBuckets` reflecting how many buckets made it through before
 * the failure — a re-run will re-POST every bucket from scratch (idempotent
 * via deterministic filenames).
 *
 * @param {object}   opts
 * @param {object}   opts.session                  output of `prolific.initSession()`
 * @param {string}   [opts.endpoint]               defaults to config.uploader.endpoint
 * @param {string}   [opts.provider]               'datapipe' | 'raw'; defaults to config.uploader.provider ?? 'raw'
 * @param {string}   [opts.datapipeExperimentId]   defaults to config.uploader.datapipe_experiment_id
 * @param {Function} [opts.onProgress]             called with {bucketIndex, totalBuckets, bucketId, bucketLabel, status, error?}
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.sleepImpl]
 * @returns {Promise<{
 *   status: 'uploaded' | 'no_endpoint' | 'partial' | 'nothing_to_upload',
 *   uploadedBuckets: number,
 *   totalBuckets: number,
 *   uploadedRows: number,
 *   lastError: string | null,
 * }>}
 */
export async function uploadPendingData({
  session,
  endpoint,
  provider,
  datapipeExperimentId,
  onProgress,
  fetchImpl,
  sleepImpl,
} = {}) {
  const url = endpoint ?? config.uploader.endpoint;
  const resolvedProvider = provider ?? config.uploader.provider ?? 'raw';
  const resolvedExperimentId =
    datapipeExperimentId ?? config.uploader.datapipe_experiment_id ?? null;
  /* No-endpoint short-circuit covers two cases that both want the download
   * fallback: missing URL, or DataPipe provider with an unprovisioned
   * placeholder experiment ID. */
  if (!url) {
    return {
      status: 'no_endpoint',
      uploadedBuckets: 0,
      totalBuckets: 0,
      uploadedRows: 0,
      lastError: null,
    };
  }
  if (resolvedProvider === 'datapipe' && isPlaceholderDataPipeId(resolvedExperimentId)) {
    return {
      status: 'no_endpoint',
      uploadedBuckets: 0,
      totalBuckets: 0,
      uploadedRows: 0,
      lastError: null,
    };
  }
  const cursor = await getUploadCursor();
  const pendingRows = await getTrialRowsAfter(cursor);
  if (pendingRows.length === 0) {
    return {
      status: 'nothing_to_upload',
      uploadedBuckets: 0,
      totalBuckets: 0,
      uploadedRows: 0,
      lastError: null,
    };
  }

  const partitioned = partitionRowsIntoBuckets(pendingRows);
  const nonEmpty = partitioned.filter(
    (p) => p.rows.length > 0 && !midSessionUploaded.has(p.bucket.id)
  );
  const totalBuckets = nonEmpty.length;

  let uploadedBuckets = 0;
  let uploadedRows = 0;
  let lastError = null;
  let maxUploadedSeq = cursor;

  for (let i = 0; i < nonEmpty.length; i++) {
    const { bucket, rows } = nonEmpty[i];
    const envelope = buildBucketEnvelope({
      session,
      bucket,
      bucketIndex: i,
      totalBuckets,
      rows,
    });
    const body =
      resolvedProvider === 'datapipe'
        ? buildDataPipeEnvelope({ bucketEnvelope: envelope, experimentId: resolvedExperimentId })
        : envelope;
    try {
      await postWithRetry({ url, body, fetchImpl, sleepImpl });
      uploadedBuckets += 1;
      uploadedRows += rows.length;
      const seqs = rows.map((r) => r.seq).filter((s) => Number.isFinite(s));
      if (seqs.length) {
        const bucketMaxSeq = Math.max(...seqs);
        if (bucketMaxSeq > maxUploadedSeq) maxUploadedSeq = bucketMaxSeq;
      }
      onProgress?.({
        bucketIndex: i,
        totalBuckets,
        bucketId: bucket.id,
        bucketLabel: bucket.label,
        status: 'ok',
      });
    } catch (err) {
      lastError = err.message;
      onProgress?.({
        bucketIndex: i,
        totalBuckets,
        bucketId: bucket.id,
        bucketLabel: bucket.label,
        status: 'failed',
        error: err.message,
      });
      /* All-or-nothing cursor: don't advance on partial — the re-run re-POSTs
       * every bucket (filenames are deterministic, so buckets already stored
       * come back as FILE_EXISTS and count as delivered). */
      return {
        status: 'partial',
        uploadedBuckets,
        totalBuckets,
        uploadedRows,
        lastError,
      };
    }
  }

  await setUploadCursor(maxUploadedSeq);

  return {
    status: 'uploaded',
    uploadedBuckets,
    totalBuckets,
    uploadedRows,
    lastError: null,
  };
}

/**
 * Trigger a browser download of the full session data as a JSON file. Used as
 * the participant-visible fallback when the server endpoint is missing or
 * upload failed permanently — the participant can email the file to the lab,
 * or the experimenter can collect it during a pilot session.
 *
 * @param {object}   opts
 * @param {object}   opts.session
 * @param {object[]} opts.rows                  full set of rows (use storage.getAllTrialRows())
 * @param {string}   [opts.filenamePrefix]      default 'wm-img-followup'
 * @param {Document} [opts.doc]                 default `document` — overridable for tests
 * @returns {{filename: string, sizeBytes: number}}
 */
export function downloadAsJson({ session, rows, filenamePrefix, doc } = {}) {
  const documentRef = doc ?? document;
  const prefix = filenamePrefix ?? 'wm-img-followup';
  const pid = session?.params?.prolific_pid ?? 'preview';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${prefix}__${pid}__${stamp}.json`;
  const payload = {
    session,
    n_rows: rows.length,
    rows,
    exported_at_iso: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = documentRef.createElement('a');
  a.href = url;
  a.download = filename;
  documentRef.body.appendChild(a);
  a.click();
  documentRef.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { filename, sizeBytes: blob.size };
}

/**
 * Return the configured Prolific completion URL.
 *
 * The Prolific `cc` parameter is a study-level completion code that Prolific
 * generates when the study is published — NOT a participant identifier. So
 * the URL is the same for every participant in a given study. Until the user
 * publishes the study and locks the actual completion code, the configured
 * URL still contains `PLACEHOLDER`; the debrief node detects this via
 * `isPlaceholderCompletionUrl` and shows a test-build notice instead of
 * redirecting.
 *
 * @returns {string}
 */
export function buildCompletionUrl() {
  return config.prolific.completion_url ?? '';
}

/**
 * True iff the configured completion URL is still the placeholder template.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isPlaceholderCompletionUrl(url) {
  return typeof url === 'string' && url.includes('PLACEHOLDER');
}

/**
 * Return the Prolific completion URL for participants screened out by an
 * in-study check. Prolific completion codes are study-level, so the URL is
 * the same for every screened-out participant.
 *
 * @returns {string}
 */
export function buildScreenOutUrl() {
  const code = config.prolific.screen_out_completion_code;
  if (typeof code !== 'string' || code.length === 0) return '';
  return `https://app.prolific.com/submissions/complete?cc=${encodeURIComponent(code)}`;
}

/**
 * True iff the screen-out completion URL is still the placeholder.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isPlaceholderScreenOutUrl(url) {
  return typeof url === 'string' && url.includes('PLACEHOLDER');
}
