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

function readProlificParams(search = window.location.search) {
  const params = new URLSearchParams(search);
  const out = {};
  for (const key of REQUIRED_PARAMS) {
    out[key.toLowerCase()] = params.get(key);
  }
  out.is_preview = REQUIRED_PARAMS.some((k) => !params.get(k));
  return out;
}

export function initSession(params = readProlificParams(), pilotMode = readPilotMode()) {
  const overrideSeed = config.prng.deterministic_override;
  const seedString =
    overrideSeed ??
    (params.is_preview
      ? `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
