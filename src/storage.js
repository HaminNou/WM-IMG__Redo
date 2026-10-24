/**
 * Persistent trial storage.
 *
 * Why persistent storage at all:
 *   - Data are written incrementally to IndexedDB. The participant must be
 *     able to crash the browser at any point without losing more than the
 *     most recent trial.
 *   - The Prolific completion URL is built once, at session start, and
 *     stored in IndexedDB. Even if the network drops, the participant must
 *     have a valid completion URL to copy.
 *
 * The module exposes a thin Promise-based API and selects a backend at init
 * time:
 *   - `IndexedDBBackend` (production) — durable across crashes, refreshes,
 *     and most kinds of accidental tab closes;
 *   - `MemoryBackend` (test, fallback) — used when IndexedDB is unavailable
 *     (private-mode Safari, locked-down kiosks, or in Vitest's jsdom env where
 *     IDB doesn't exist), and explicitly selectable from tests.
 *
 * The "upload cursor" pattern lets the uploader pull only un-POSTed rows on
 * each upload pass: rows are append-only with monotonically increasing
 * sequence numbers, and the cursor stores the highest sequence number that
 * has been confirmed uploaded. The end-of-session upload POSTs every
 * row past the cursor and advances it once all buckets succeed.
 *
 * No silent failures: every backend method throws on
 * unrecoverable errors. The runner-level layer is responsible for catching
 * and either retrying (uploader) or surfacing to the participant.
 */

const DB_NAME = 'wm_img_followup';
const DB_VERSION = 1;
const STORE_TRIALS = 'trials';
const STORE_META = 'meta';

const META_KEYS = Object.freeze({
  completionUrl: 'completion_url',
  uploadCursor: 'upload_cursor' /* highest sequence confirmed uploaded */,
  sessionId: 'session_id',
  sessionStartedAt: 'session_started_at_iso',
  sessionObject: 'session_object',
});

/* ---------- Public API ---------- */

let activeBackend = null;

/* Storage-write failure tracking. The runner's `on_data_update` hook does a
 * fire-and-forget `appendTrialRow().catch(...)` so the participant can keep
 * playing if a single write throws (e.g. transient IDB quota error, hostile
 * extension). Without this counter those failures are invisible — the
 * console log dies with the tab. We expose a `getStorageFailureSummary()`
 * that the debrief node stamps onto the upload-summary row, so the analyst
 * can flag any session where rows went missing.
 *
 * State is module-level so the failure history survives across many trial
 * rows but resets between test cases via `_resetStorageForTests()`. */
let writeFailures = 0;
let lastWriteFailureMessage = null;
let lastWriteFailureAtIso = null;

/**
 * Initialise persistent storage. Selects IndexedDB if available, otherwise
 * falls back to in-memory storage (with a console warning). Idempotent —
 * calling twice returns the same backend.
 *
 * @param {object} [opts]
 * @param {'auto'|'indexeddb'|'memory'} [opts.backend]  force a backend (default 'auto')
 * @returns {Promise<{kind: string}>}                   resolves with backend metadata
 */
export async function initStorage({ backend = 'auto' } = {}) {
  if (activeBackend) return { kind: activeBackend.kind };
  const choice =
    backend === 'auto' ? (typeof indexedDB !== 'undefined' ? 'indexeddb' : 'memory') : backend;
  if (choice === 'indexeddb') {
    activeBackend = await IndexedDBBackend();
  } else {
    if (backend === 'auto') {
      console.warn(
        '[storage] IndexedDB unavailable – falling back to in-memory storage. Data will not survive a refresh.'
      );
    }
    activeBackend = MemoryBackend();
  }
  return { kind: activeBackend.kind };
}

/** Reset the module-level backend handle. Used by tests. */
export function _resetStorageForTests() {
  activeBackend = null;
  pendingWrites.clear();
  writeFailures = 0;
  lastWriteFailureMessage = null;
  lastWriteFailureAtIso = null;
}

/**
 * Record an `appendTrialRow` failure. Call from the runner's fire-and-forget
 * catch handler; the count rides out on the upload-summary row at session
 * end. Defensive — accepts anything.
 *
 * @param {unknown} err
 */
export function recordWriteFailure(err) {
  writeFailures += 1;
  lastWriteFailureMessage = err instanceof Error ? err.message : String(err ?? 'unknown');
  lastWriteFailureAtIso = new Date().toISOString();
}

/**
 * @returns {{writeFailures: number, lastError: string|null, lastFailureAtIso: string|null}}
 */
export function getStorageFailureSummary() {
  return {
    writeFailures,
    lastError: lastWriteFailureMessage,
    lastFailureAtIso: lastWriteFailureAtIso,
  };
}

function require_active() {
  if (!activeBackend) {
    throw new Error('storage: initStorage() must be called before any other storage method');
  }
  return activeBackend;
}

/* One id per page load. A reload, or a second visit from the same browser,
 * appends to the same IndexedDB store; the id lets analysis separate runs. */
const RUN_ID = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 8);

/** Id of this page load. Uploads send only the rows of the current run. */
export function getRunId() {
  return RUN_ID;
}

/* Writes that have been started and not yet finished. */
const pendingWrites = new Set();

export async function appendTrialRow(row) {
  const write = require_active().appendTrialRow({ run_id: RUN_ID, wall_ms: Date.now(), ...row });
  pendingWrites.add(write);
  const settled = () => pendingWrites.delete(write);
  write.then(settled, settled);
  return write;
}

/** Resolves when every row written so far has reached the backend (or failed). */
export async function flushPendingWrites() {
  await Promise.allSettled(Array.from(pendingWrites));
}

export async function getAllTrialRows() {
  return require_active().getAllTrialRows();
}

export async function getTrialRowsAfter(seq) {
  return require_active().getTrialRowsAfter(seq);
}

export async function getUploadCursor() {
  /* `?? 0` must be applied to the resolved value, not the Promise itself —
   * otherwise an unset cursor leaks `undefined` to callers. */
  const v = await require_active().getMeta(META_KEYS.uploadCursor);
  return v ?? 0;
}

export async function setUploadCursor(seq) {
  return require_active().setMeta(META_KEYS.uploadCursor, seq);
}

export async function setCompletionUrl(url) {
  return require_active().setMeta(META_KEYS.completionUrl, url);
}

export async function getCompletionUrl() {
  return require_active().getMeta(META_KEYS.completionUrl);
}

export async function setSessionId(id) {
  return require_active().setMeta(META_KEYS.sessionId, id);
}

export async function getSessionId() {
  return require_active().getMeta(META_KEYS.sessionId);
}

export async function setSessionStartedAt(iso) {
  return require_active().setMeta(META_KEYS.sessionStartedAt, iso);
}

export async function getSessionStartedAt() {
  return require_active().getMeta(META_KEYS.sessionStartedAt);
}

export async function setSessionObject(obj) {
  return require_active().setMeta(META_KEYS.sessionObject, obj);
}

export async function getSessionObject() {
  return require_active().getMeta(META_KEYS.sessionObject);
}

/* ---------- Memory backend (tests + fallback) ---------- */

function MemoryBackend() {
  const trials = []; /* {seq, row} */
  const meta = new Map();
  let nextSeq = 1;
  return {
    kind: 'memory',
    async appendTrialRow(row) {
      const seq = nextSeq++;
      trials.push({ seq, row });
      return seq;
    },
    async getAllTrialRows() {
      return trials.map(({ seq, row }) => ({ seq, ...row }));
    },
    async getTrialRowsAfter(after) {
      return trials.filter((t) => t.seq > after).map(({ seq, row }) => ({ seq, ...row }));
    },
    async getMeta(key) {
      return meta.get(key);
    },
    async setMeta(key, value) {
      meta.set(key, value);
    },
  };
}

/* ---------- IndexedDB backend (production) ---------- */

async function IndexedDBBackend() {
  const db = await openDb();
  return {
    kind: 'indexeddb',
    async appendTrialRow(row) {
      return await idbRun(db, STORE_TRIALS, 'readwrite', (store) => store.add({ row }));
    },
    async getAllTrialRows() {
      return await idbRun(db, STORE_TRIALS, 'readonly', (store) => store.getAll(), {
        mapResult: (records) =>
          records.map((rec, idx) => ({ seq: rec.seq ?? idx + 1, ...rec.row })),
      });
    },
    async getTrialRowsAfter(after) {
      const all = await this.getAllTrialRows();
      return all.filter((r) => r.seq > after);
    },
    async getMeta(key) {
      const result = await idbRun(db, STORE_META, 'readonly', (store) => store.get(key));
      return result?.value;
    },
    async setMeta(key, value) {
      await idbRun(db, STORE_META, 'readwrite', (store) => store.put({ key, value }));
    },
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_TRIALS)) {
        db.createObjectStore(STORE_TRIALS, { keyPath: 'seq', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error(`storage: failed to open IndexedDB '${DB_NAME}': ${request.error?.message}`)
      );
  });
}

function idbRun(db, storeName, mode, op, { mapResult } = {}) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = op(store);
    tx.oncomplete = () => {
      const out = request.result;
      resolve(mapResult ? mapResult(out) : out);
    };
    tx.onabort = tx.onerror = () =>
      reject(new Error(`storage: IDB transaction failed on '${storeName}': ${tx.error?.message}`));
  });
}
