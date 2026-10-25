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
 *     sent. Filenames are deterministic within a page load
 *     (`<session_id>__<run_id>__NN_<label>.json`), so a repeat of a bucket
 *     DataPipe already holds is reported as FILE_EXISTS and counted as
 *     delivered. The run id keeps a reloaded page from being mistaken for the
 *     earlier one, and only the rows of the current run are sent.
 *
 *   - **When uploads happen.** The consent and practice buckets are sent at
 *     the inter-block rest (`uploadConsentAndPractice`), and every rest screen
 *     sends a checkpoint file with the rows since the previous checkpoint
 *     (`uploadCheckpoint`). Both are cancelled when the rest ends, so no
 *     request is in flight during a trial. The remaining buckets are sent once
 *     at the debrief node (`uploadPendingData`) or, for a session ended by a
 *     check, at the exit screen. The rows written after that upload (the
 *     upload summary and the completion row) are sent in a short last file
 *     (`uploadTail`) just before the redirect. Rows that appear in a checkpoint
 *     and a bucket file are the same rows; the exporter removes the repeats.
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
import {
  getAllTrialRows,
  getTrialRowsAfter,
  getPendingRows,
  getUploadCursor,
  setUploadCursor,
  getRunId,
  getRecentRows,
  flushPendingWrites,
} from './storage.js';

const midSessionUploaded = new Set();

/* Highest seq of this run known to have reached the server, every row up to it
 * included (checkpoint, end-of-session upload, tail). The last-chance upload
 * on page hide sends only rows newer than this. A keepalive request cannot
 * report whether it arrived, so it never moves this number. */
let deliveredSeq = 0;
function noteDelivered(seq) {
  if (Number.isFinite(seq) && seq > deliveredSeq) deliveredSeq = seq;
}

/* Largest checkpoint request. The assumption is that DataPipe accepts a
 * request body of about 1 MB; a checkpoint with more rows than fit is sent as
 * several files, each with its own seq range. */
const CHECKPOINT_MAX_BYTES = 900_000;
/* Time allowed for the last upload before the redirect. */
const TAIL_TIMEOUT_MS = 2000;

/* Browser storage keeps the rows of every earlier run in this browser. An
 * upload sends the rows of the current run only; the others stay in storage
 * for recovery. */
function currentRunRows(rows) {
  const run = getRunId();
  return rows.filter((r) => r.run_id === run);
}

/* ---------- Bucket definitions ---------- */

/**
 * The 10 uploaded buckets, in the order they're uploaded and the order
 * they should appear in a directory listing (filenames carry the
 * two-digit prefix so alphanumeric sort matches this array).
 *
 * Each bucket has:
 *   - `id`      stable short identifier used in envelopes and tests
 *   - `label`   file-stem suffix (becomes `<session_id>__<run_id>__<label>.json`)
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
 *     The inter-trial-interval rows (`<condition>_iti`) carry the condition
 *     prefix, so they go with the rest of their trial.
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
    run_id: getRunId(),
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
 * DataPipe filename for a bucket: `<session_id>__<run_id>__<bucket_label>.json`
 * (for a regular bucket the label carries the seq range, see `bucketFileLabel`).
 *
 * Stability requirements:
 *   - **Unique per bucket per run.** DataPipe stores each POST as a
 *     separate file under the project; a repeated filename is refused. Each
 *     bucket's `label` is unique and the run id changes with every page load,
 *     so a reloaded page never meets the files of the earlier one.
 *   - **Deterministic for the same content.** The bucket label comes from the
 *     static `BUCKETS` table plus the seq range of the rows, so a retry of the
 *     same rows POSTs the same filename. DataPipe rejects a name that already
 *     exists (FILE_EXISTS); the uploader counts that as delivered, because the
 *     name identifies the same rows, and failed posts get another attempt. A
 *     bucket that gained rows since an earlier attempt has another name.
 *   - **Sorts alphabetically in storage in canonical order.** Labels carry a
 *     two-digit prefix (`01_…` through `10_…`) so a directory listing matches
 *     the analysis-relevant order without manual sort.
 */
export function dataPipeFilenameForBucket({ session_id, run_id, bucket_label }) {
  if (!session_id) {
    throw new Error('dataPipeFilenameForBucket: session_id is required');
  }
  if (!run_id) {
    throw new Error('dataPipeFilenameForBucket: run_id is required');
  }
  if (!bucket_label) {
    throw new Error('dataPipeFilenameForBucket: bucket_label is required');
  }
  return `${safeFilePart(session_id)}__${safeFilePart(run_id)}__${safeFilePart(bucket_label)}.json`;
}

/* Longest piece of a file name kept as is; a longer one is cut and given a short hash. */
const FILE_PART_MAX = 64;

/**
 * One piece of a DataPipe file name, reduced to `[A-Za-z0-9_-]`. The session id
 * comes from the page URL, so it must not be able to put a path separator, a
 * dot sequence or any other special character into a name. Prolific ids (hex),
 * the run id (hex) and the bucket labels are already in this alphabet and pass
 * through unchanged, so file names stay identical to those of earlier builds.
 * The result depends only on the input, so a retry produces the same name.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function safeFilePart(value) {
  const raw = String(value);
  let out = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (out.length > FILE_PART_MAX || out !== raw) {
    /* Two different hostile ids must not collapse into one name. */
    let h = 0x811c9dc5;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const tag = h.toString(16).padStart(8, '0');
    out = `${out.slice(0, FILE_PART_MAX - 9)}_${tag}`;
  }
  return out;
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
      run_id: bucketEnvelope.run_id,
      bucket_label: bucketFileLabel(bucketEnvelope),
    }),
    data: JSON.stringify(bucketEnvelope),
  };
}

/* Bucket ids whose labels already carry their own seq range. */
const RANGE_LABELLED_BUCKETS = new Set(['checkpoint', 'tail', 'partial']);

/**
 * The label used in a bucket's DataPipe file name. A regular bucket
 * (`03_d_only`, `10_meta`, …) gets the seq range of the rows it holds appended
 * (`10_meta_s2-9`). DataPipe refuses a second file with the same name
 * (FILE_EXISTS) and the uploader counts that as "delivered", which is right only
 * if the content is the same. Rows are append-only with a unique seq, so the same
 * session, run and range always means the same content: an identical retry is
 * still FILE_EXISTS (delivered), while a bucket that grew between two attempts is
 * a new file and its new rows are sent. Rows present in two files are dropped by
 * the exporter on (run_id, seq). Checkpoint, tail and partial files already name
 * their range.
 *
 * @param {{bucket_id?: string, bucket_label: string, seq_min?: number|null, seq_max?: number|null}} env
 * @returns {string}
 */
export function bucketFileLabel(env) {
  const label = env.bucket_label;
  if (RANGE_LABELLED_BUCKETS.has(env.bucket_id)) return label;
  if (!Number.isFinite(env.seq_min) || !Number.isFinite(env.seq_max)) return label;
  return `${label}_s${env.seq_min}-${env.seq_max}`;
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

  const allRows = currentRunRows(await getAllTrialRows());
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
 * Split rows (in seq order) into groups whose JSON is at most `maxBytes`.
 * A single row larger than the limit forms a group of its own.
 */
function splitRowsBySize(rows, maxBytes) {
  const parts = [];
  let part = [];
  let size = 0;
  for (const row of rows) {
    const bytes = JSON.stringify(row).length;
    if (part.length > 0 && size + bytes > maxBytes) {
      parts.push(part);
      part = [];
      size = 0;
    }
    part.push(row);
    size += bytes;
  }
  if (part.length > 0) parts.push(part);
  return parts;
}

/**
 * Upload every row of this run after the last checkpoint as one file named
 * `<session_id>__<run_id>__ckpt_<seqMin>-<seqMax>.json`. File names are
 * unique, so no overwrite is involved. A checkpoint larger than
 * `CHECKPOINT_MAX_BYTES` is sent as several files. Called at the rest
 * screens, so a crash or a closed tab loses at most the stretch since the last
 * rest. The cursor advances after each file that arrived, so a cancelled or
 * failed checkpoint is included in the next one. The end-of-session bucket
 * upload is unaffected.
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
  const rows = currentRunRows(await getAllTrialRows()).filter((r) => r.seq > checkpointCursor);
  if (rows.length === 0) return { status: 'nothing' };
  let sent = 0;
  for (const part of splitRowsBySize(rows, CHECKPOINT_MAX_BYTES)) {
    const seqMin = Math.min(...part.map((r) => r.seq));
    const seqMax = Math.max(...part.map((r) => r.seq));
    const envelope = buildBucketEnvelope({
      session,
      bucket: { id: 'checkpoint', label: `ckpt_${seqMin}-${seqMax}` },
      bucketIndex: 0,
      totalBuckets: 1,
      rows: part,
    });
    const body =
      provider === 'datapipe'
        ? buildDataPipeEnvelope({ bucketEnvelope: envelope, experimentId })
        : envelope;
    try {
      await postWithRetry({ url, body, signal, fetchImpl, sleepImpl });
    } catch (err) {
      return { status: 'failed', error: err.message };
    }
    checkpointCursor = seqMax;
    noteDelivered(seqMax);
    sent += part.length;
  }
  return { status: 'ok', rows: sent };
}

/* Set once the end-of-session upload has finished; the last upload follows it. */
let finalUploadComplete = false;

/**
 * Send the rows written after the end-of-session upload (the upload summary
 * and the completion row) as one small file named
 * `<session_id>__<run_id>__tail_<seqMin>-<seqMax>.json`. One attempt only,
 * limited to `timeoutMs`, so the redirect that follows is never held up for
 * long. Does nothing unless the end-of-session upload finished.
 *
 * @param {object} opts
 * @param {object} opts.session
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.endpoint]
 * @param {string} [opts.datapipeExperimentId]
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{status: string, rows?: number, error?: string}>}
 */
export async function uploadTail({
  session,
  timeoutMs = TAIL_TIMEOUT_MS,
  endpoint,
  datapipeExperimentId,
  fetchImpl,
} = {}) {
  const url = endpoint ?? config.uploader.endpoint;
  const provider = config.uploader.provider ?? 'raw';
  const experimentId = datapipeExperimentId ?? config.uploader.datapipe_experiment_id ?? null;
  if (!url || (provider === 'datapipe' && isPlaceholderDataPipeId(experimentId))) {
    return { status: 'no_endpoint' };
  }
  if (!finalUploadComplete) return { status: 'skipped' };
  await flushPendingWrites();
  const rows = currentRunRows(await getTrialRowsAfter(await getUploadCursor()));
  if (rows.length === 0) return { status: 'nothing' };
  const seqs = rows.map((r) => r.seq);
  const seqMax = Math.max(...seqs);
  const envelope = buildBucketEnvelope({
    session,
    bucket: { id: 'tail', label: `tail_${Math.min(...seqs)}-${seqMax}` },
    bucketIndex: 0,
    totalBuckets: 1,
    rows,
  });
  const body =
    provider === 'datapipe'
      ? buildDataPipeEnvelope({ bucketEnvelope: envelope, experimentId })
      : envelope;
  try {
    await postWithRetry({ url, body, retryMax: 0, timeoutMs, fetchImpl });
  } catch (err) {
    return { status: 'failed', error: err.message };
  }
  await setUploadCursor(seqMax);
  noteDelivered(seqMax);
  return { status: 'ok', rows: rows.length };
}

/** Test helper: forget which rows were sent in checkpoints. */
export function _resetCheckpointForTests() {
  checkpointCursor = 0;
  finalUploadComplete = false;
  deliveredSeq = 0;
  lastFlushSeqMax = 0;
  lastFlushAt = 0;
  uninstallPageHideFlush();
}

/* ---------- Last-chance upload when the page is hidden or closed ---------- */

/* A keepalive request may carry about 64 KiB (65,536 bytes) in all, and the limit
 * is on the final request body in UTF-8 bytes. The rows are stringified twice (once
 * as rows, again inside the DataPipe envelope's `data` string), so quotes and
 * backslashes double and non-ASCII characters cost 2-4 bytes each. The body is
 * therefore MEASURED, with a margin below the limit. */
const FLUSH_MAX_BYTES = 48_000;

/** UTF-8 length of a string. */
function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str).length;
  if (typeof Blob !== 'undefined') return new Blob([str]).size;
  return str.length * 4; /* worst case */
}
/* No new flush sooner than this after the last one (tab switching fires often). */
const FLUSH_MIN_INTERVAL_MS = 15_000;
let lastFlushSeqMax = 0;
let lastFlushAt = 0;

/**
 * Best-effort upload of the newest unsent rows, for the moment a participant
 * closes the tab, switches away or the browser discards the page. It is a
 * safety net between checkpoints, not a replacement for them:
 *   - rows come from the in-memory tail (an IndexedDB read would not finish
 *     while the page is unloading) and only the newest ones that fit in one
 *     small request are sent; older rows stay in browser storage and in the
 *     recovery page;
 *   - the request uses `keepalive`, so the browser may finish it after the
 *     page is gone, and nothing waits for the answer;
 *   - the file is named `<session>__<run>__partial_<seqMin>-<seqMax>.json`: a
 *     range that was already sent is never sent twice, and DataPipe's
 *     one-file-per-name rule cannot block a later, different range. The
 *     exporter pools files by (run, seq) and drops duplicates, so rows that
 *     also arrive in a regular file are counted once;
 *   - it never throws and never changes the upload cursor;
 *   - tab switches fire `visibilitychange` often, so those flushes are throttled to one per
 *     15 s. `pagehide` is not throttled (`bypassThrottle`): the browser is about to discard
 *     the page, so it is the last chance, and rows written since the previous flush would
 *     otherwise be lost. It still sends only rows newer than the range already sent.
 *
 * @param {object} opts
 * @param {object} opts.session
 * @param {Function} [opts.fetchImpl]
 * @param {boolean} [opts.bypassThrottle]     skip the 15 s throttle (pagehide)
 * @param {number} [opts.nowMs]               clock for the throttle (tests)
 * @param {number} [opts.maxBytes]            limit for the request BODY in UTF-8 bytes (default 48,000)
 * @returns {{status: 'sent'|'nothing'|'throttled'|'no_endpoint'|'error', rows?: number, filename?: string}}
 */
export function flushOnHide({
  session,
  fetchImpl,
  bypassThrottle = false,
  nowMs = Date.now(),
  maxBytes = FLUSH_MAX_BYTES,
} = {}) {
  try {
    const url = config.uploader.endpoint;
    const provider = config.uploader.provider ?? 'raw';
    const experimentId = config.uploader.datapipe_experiment_id ?? null;
    if (!url || !session || (provider === 'datapipe' && isPlaceholderDataPipeId(experimentId))) {
      return { status: 'no_endpoint' };
    }
    const run = getRunId();
    const floor = Math.max(deliveredSeq, lastFlushSeqMax);
    const unsent = getRecentRows().filter((r) => r.run_id === run && r.seq > floor);
    if (unsent.length === 0) return { status: 'nothing' };
    if (!bypassThrottle && nowMs - lastFlushAt < FLUSH_MIN_INTERVAL_MS && lastFlushAt > 0) {
      return { status: 'throttled' };
    }
    const fetcher = fetchImpl ?? globalThis.fetch;
    if (typeof fetcher !== 'function') return { status: 'error' };
    /* The request body for a set of rows, and its size in UTF-8 bytes. */
    const requestFor = (rows) => {
      const envelope = buildBucketEnvelope({
        session,
        bucket: { id: 'partial', label: `partial_${rows[0].seq}-${rows[rows.length - 1].seq}` },
        bucketIndex: 0,
        totalBuckets: 1,
        rows,
      });
      const body =
        provider === 'datapipe'
          ? buildDataPipeEnvelope({ bucketEnvelope: envelope, experimentId })
          : envelope;
      const json = JSON.stringify(body);
      return { body, json, bytes: utf8Bytes(json) };
    };
    /* Newest rows first, until the size limit; then back into seq order. The
     * running estimate counts each row twice-escaped; the real body is measured
     * afterwards and the oldest rows are dropped until it fits. */
    const chosen = [];
    let estimate = 0;
    for (let i = unsent.length - 1; i >= 0; i--) {
      const size = utf8Bytes(JSON.stringify(JSON.stringify(unsent[i]))) - 1;
      if (estimate + size > maxBytes && chosen.length > 0) break;
      if (size > maxBytes) break;
      chosen.push(unsent[i]);
      estimate += size;
    }
    if (chosen.length === 0) return { status: 'nothing' };
    chosen.reverse();
    let request = requestFor(chosen);
    while (request.bytes > maxBytes && chosen.length > 1) {
      chosen.shift();
      request = requestFor(chosen);
    }
    if (request.bytes > maxBytes) return { status: 'nothing' }; /* one row alone is too big */
    const seqMax = chosen[chosen.length - 1].seq;
    const { body, json } = request;
    lastFlushSeqMax = seqMax;
    lastFlushAt = nowMs;
    const pending = fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: true,
    });
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    return { status: 'sent', rows: chosen.length, filename: body.filename ?? null };
  } catch {
    return { status: 'error' };
  }
}

let removePageHideListeners = null;

/**
 * Start flushing on `visibilitychange` (hidden) and `pagehide`. Idempotent.
 *
 * @param {object} opts
 * @param {object} opts.session
 * @param {Document} [opts.doc]
 * @param {Window} [opts.win]
 * @returns {() => void} removes the listeners
 */
export function installPageHideFlush({
  session,
  doc = typeof document !== 'undefined' ? document : undefined,
  win = typeof window !== 'undefined' ? window : undefined,
} = {}) {
  if (removePageHideListeners) return removePageHideListeners;
  if (!doc || !win) return () => {};
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') flushOnHide({ session });
  };
  const onPageHide = () => {
    /* last chance before the page is discarded: do not throttle */
    flushOnHide({ session, bypassThrottle: true });
  };
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onPageHide);
  removePageHideListeners = () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', onPageHide);
    removePageHideListeners = null;
  };
  return removePageHideListeners;
}

function uninstallPageHideFlush() {
  removePageHideListeners?.();
}

/* ---------- Public uploader entrypoint ---------- */

/**
 * Upload all rows in storage that haven't been uploaded yet, partitioned into
 * the canonical 10-bucket layout.
 *
 * Reads the upload cursor; pulls the rows of this run with `seq > cursor`; partitions
 * them by bucket; POSTs each non-empty bucket in `BUCKETS` order; advances
 * the cursor past the highest uploaded seq only after every bucket succeeds.
 * On endpoint absence, returns `{status: 'no_endpoint'}` without touching the
 * cursor. A bucket that fails permanently does not stop the ones after it:
 * every bucket is attempted. If any failed, returns `{status: 'partial'}`
 * with `uploadedBuckets` (how many arrived) and `failedBuckets` (their ids);
 * the cursor stays where it was, so a re-run re-POSTs every bucket from
 * scratch (idempotent via deterministic filenames).
 *
 * @param {object}   opts
 * @param {object}   opts.session                  output of `prolific.initSession()`
 * @param {string}   [opts.endpoint]               defaults to config.uploader.endpoint
 * @param {string}   [opts.provider]               'datapipe' | 'raw'; defaults to config.uploader.provider ?? 'raw'
 * @param {string}   [opts.datapipeExperimentId]   defaults to config.uploader.datapipe_experiment_id
 * @param {Function} [opts.onProgress]             called with {bucketIndex, totalBuckets, bucketId, bucketLabel, status, error?}
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.sleepImpl]
 * @param {boolean}  [opts.allRuns]                send the rows of earlier runs too (the recovery page)
 * @returns {Promise<{
 *   status: 'uploaded' | 'no_endpoint' | 'partial' | 'nothing_to_upload',
 *   uploadedBuckets: number,
 *   totalBuckets: number,
 *   uploadedRows: number,
 *   failedBuckets?: string[],
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
  allRuns = false,
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
  /* The recovery page (`allRuns`) sends whatever is pending in any run; each
   * run has its own cursor. */
  const pendingRows = allRuns
    ? await getPendingRows()
    : currentRunRows(await getTrialRowsAfter(cursor));
  if (pendingRows.length === 0) {
    finalUploadComplete = true;
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
  const failedBuckets = [];

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
      await postWithRetry({
        url,
        body,
        fetchImpl,
        sleepImpl,
        /* After one bucket has used up its retries the server is most likely
         * down: the buckets after it get a single attempt each, so an outage
         * costs one back-off sequence, not one per bucket. If the server is
         * back, those single attempts still deliver them. */
        ...(failedBuckets.length > 0 ? { retryMax: 0 } : {}),
      });
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
      failedBuckets.push(bucket.id);
      onProgress?.({
        bucketIndex: i,
        totalBuckets,
        bucketId: bucket.id,
        bucketLabel: bucket.label,
        status: 'failed',
        error: err.message,
      });
      /* A bucket that cannot be sent must not stop the buckets after it: each
       * is a separate file, and one that arrives is data saved. */
    }
  }

  if (failedBuckets.length > 0) {
    /* All-or-nothing cursor: don't advance on partial — the re-run re-POSTs
     * every bucket (filenames are deterministic, so buckets already stored
     * come back as FILE_EXISTS and count as delivered). */
    return {
      status: 'partial',
      uploadedBuckets,
      totalBuckets,
      uploadedRows,
      failedBuckets,
      lastError,
    };
  }

  if (allRuns) {
    const maxByRun = new Map();
    for (const r of pendingRows) {
      if (Number.isFinite(r.seq) && r.seq > (maxByRun.get(r.run_id) ?? 0)) {
        maxByRun.set(r.run_id, r.seq);
      }
    }
    for (const [run, seq] of maxByRun) await setUploadCursor(seq, run);
  } else {
    await setUploadCursor(maxUploadedSeq);
  }
  finalUploadComplete = true;
  noteDelivered(maxUploadedSeq);

  return {
    status: 'uploaded',
    uploadedBuckets,
    totalBuckets,
    uploadedRows,
    failedBuckets: [],
    lastError: null,
  };
}

/** 8 random hex characters for a file name (crypto when available). */
function randomFileToken() {
  const bytes = new Uint8Array(4);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
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
  /* The Prolific id is NOT put in the file name: a name travels in e-mails and download
   * folders. A random token tells two downloads apart; the file CONTENT still carries
   * the id (the researcher needs it to approve and pay the participant). */
  const token = randomFileToken();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${prefix}__${token}__${stamp}.json`;
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
