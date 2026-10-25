/**
 * Prolific URL parameter ingestion + session-PRNG seeding.
 *
 * Prolific appends `?PROLIFIC_PID=...&STUDY_ID=...&SESSION_ID=...` to the study
 * URL when it sends a participant to us. We capture all three so every uploaded
 * trial can be linked back to the Prolific submission, and we feed their
 * concatenation into the session PRNG so the participant's full counterbalance
 * is replayable from the saved seed.
 *
 * If a participant lands here without those params (developer load, or someone
 * who copy-pasted a stale URL), we still let them in but flag the session as
 * `is_preview: true` so the analysis pipeline can drop them. We never silently
 * fabricate a fake PID — that would let preview data contaminate the main batch.
 * A missing SESSION_ID alone gets a locally generated `LOCAL_…` id
 * (`session_id_source: 'local_fallback'`) so uploads, file names and the
 * download fallback still work; the PID and study id stay as given (or null).
 */
import { setSessionPRNG } from './prng.js';
import { config } from './config.js';
import {
  initStorage,
  setCompletionUrl,
  setSessionId,
  setSessionStartedAt,
  setSessionObject,
} from './storage.js';
import { buildCompletionUrl } from './uploader.js';
import { readPilotMode } from './pilot-mode.js';

const REQUIRED_PARAMS = ['PROLIFIC_PID', 'STUDY_ID', 'SESSION_ID'];

const LOCAL_SESSION_KEY = 'wmimg_local_session_id';
/** Prefix of a locally generated session id. Prolific session ids are 24-digit
 * hex strings, so a `LOCAL_` id can never equal one. */
export const LOCAL_SESSION_ID_PREFIX = 'LOCAL_';
let memoryLocalSessionId = null;

/**
 * Session id used when the URL carries no `SESSION_ID`. Generated once per
 * browser tab and kept in sessionStorage, so a reload of the same tab keeps
 * the same id (and, because the preview seed is derived from it, the same
 * schedule), and every upload of the session uses one file prefix. When
 * sessionStorage is unavailable the id is held in memory for the page's life.
 * It is always recorded as `session_id_source: 'local_fallback'`.
 */
export function localFallbackSessionId() {
  try {
    const store = window.sessionStorage;
    let id = store.getItem(LOCAL_SESSION_KEY);
    if (!id) {
      id = newLocalSessionId();
      store.setItem(LOCAL_SESSION_KEY, id);
    }
    return id;
  } catch {
    memoryLocalSessionId ??= newLocalSessionId();
    return memoryLocalSessionId;
  }
}

function newLocalSessionId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${LOCAL_SESSION_ID_PREFIX}${Date.now().toString(36)}_${rand}`;
}

/** Test hook: forget the cached local id. */
export function _resetLocalSessionIdForTests() {
  memoryLocalSessionId = null;
  try {
    window.sessionStorage.removeItem(LOCAL_SESSION_KEY);
  } catch {
    /* no sessionStorage */
  }
}

function readProlificParams(search = window.location.search) {
  const params = new URLSearchParams(search);
  const out = {};
  for (const key of REQUIRED_PARAMS) {
    out[key.toLowerCase()] = params.get(key);
  }
  out.is_preview = REQUIRED_PARAMS.some((k) => !params.get(k));
  return out;
}

/** Make sure `session_id` is a non-empty string and say where it came from.
 * A missing SESSION_ID gets a local fallback; the PID is never invented. */
function withSessionId(params) {
  if (typeof params.session_id === 'string' && params.session_id !== '') {
    return { ...params, session_id_source: params.session_id_source ?? 'prolific' };
  }
  return { ...params, session_id: localFallbackSessionId(), session_id_source: 'local_fallback' };
}

export function initSession(rawParams = readProlificParams(), pilotMode = readPilotMode()) {
  const params = withSessionId(rawParams);
  const overrideSeed = config.prng.deterministic_override;
  /* Pre-registered seed rule for real sessions: PROLIFIC_PID|STUDY_ID|SESSION_ID.
   * A preview (any of the three missing) is seeded from its local session id,
   * which is stable across reloads of the same tab, never from the clock. */
  const seedString =
    overrideSeed ??
    (params.is_preview
      ? `preview-${params.session_id}`
      : `${params.prolific_pid}|${params.study_id}|${params.session_id}`);

  const prng = setSessionPRNG(seedString);
  const startedAtIso = new Date().toISOString();

  /* Persist the completion URL and session metadata immediately, so even if
   * the network drops mid-session the participant has a valid completion URL
   * available in IndexedDB. Storage init is fire-and-
   * forget here — the runner awaits it explicitly before the first trial via
   * its own initStorage() call. */
  const session = {
    params,
    seed_string: seedString,
    prng_seed_uint32: prng.seed,
    started_at_iso: startedAtIso,
    user_agent: navigator.userAgent,
    schema_version: config.schema_version,
    build_id: config.build_id,
    is_pilot_run: pilotMode.is_pilot_run,
    pilot_label: pilotMode.pilot_label,
    pilot_source: pilotMode.source,
  };

  void initStorage().then(async () => {
    await setCompletionUrl(buildCompletionUrl());
    await setSessionId(params.session_id ?? null);
    await setSessionStartedAt(startedAtIso);
    await setSessionObject(session);
  });

  return session;
}
