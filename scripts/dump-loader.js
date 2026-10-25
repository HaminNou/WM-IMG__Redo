/**
 * Dump loader shared by `csv-export.js` and `pilot-summary.js`.
 *
 * Reads the JSON files a study folder holds (download-fallback exports and
 * DataPipe bucket / checkpoint / tail envelopes), pools the rows of every file
 * of one participant, drops rows repeated across files and splits the result by
 * run. Keeping one implementation means the batch-decision tool and the
 * exporter cannot disagree about who a participant is.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Load + flatten a list of dump JSON paths into a per-participant rows map
 * and a per-participant session-meta map. Handles both download-fallback and
 * bucket-envelope shapes (matching pilot-summary.js).
 *
 * Bucket, checkpoint and tail files of one session overlap, so the rows of
 * all files of a participant are pooled and duplicates are dropped on
 * (run_id, seq). The remaining rows are ordered by seq within each run. A
 * participant whose rows come from more than one run (a reload in the same
 * browser) is split into one entry per run, named `<pid>__run_<run_id>`.
 */
export function loadAndFlattenDumps(paths, opts = {}) {
  const fs = opts.fs ?? { readFileSync };
  const perParticipant = [];
  const errors = [];
  const byPid = new Map();
  const fileSha256ByPath = {};
  for (const p of paths) {
    let parsed;
    try {
      const contents = fs.readFileSync(p, 'utf-8');
      fileSha256ByPath[p] = sha256(contents);
      parsed = JSON.parse(contents);
    } catch (err) {
      errors.push({ path: p, error: err.message });
      continue;
    }
    const session = parsed.session ?? extractSessionFromEnvelope(parsed);
    /* A session without a Prolific PID (a LOCAL_ id, a preview, an old dump) is
     * keyed by its session id, so that all of its files (checkpoint, buckets, tail)
     * are ONE participant; only a file with neither id stands alone. */
    const sessionId = session?.params?.session_id ?? parsed.session_id ?? null;
    const pid =
      session?.params?.prolific_pid ??
      parsed.prolific_pid ??
      (sessionId ? `nopid_${sessionId}` : `unknown_${basename(p)}`);
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    if (!byPid.has(pid))
      byPid.set(pid, { participant_id: pid, session, rows: [], source_paths: [] });
    const slot = byPid.get(pid);
    slot.rows.push(...rows);
    slot.source_paths.push(p);
    slot.session = mergeSessionMeta(slot.session, session);
  }
  const report = { rows_read: 0, duplicates_dropped: 0 };
  for (const slot of byPid.values()) {
    const { rows, duplicates } = dedupeRows(slot.rows);
    report.rows_read += slot.rows.length;
    report.duplicates_dropped += duplicates;
    const runs = splitByRun(rows);
    for (const [runId, runRows] of runs) {
      perParticipant.push({
        participant_id:
          runs.size > 1 ? `${slot.participant_id}__run_${runId}` : slot.participant_id,
        source_pid: slot.participant_id,
        run_id: runId,
        session: slot.session,
        rows: runRows,
        source_paths: slot.source_paths,
      });
    }
  }
  return { perParticipant, errors, fileSha256ByPath, report };
}

const NO_RUN = 'none';

/** Drop rows repeated across files; rows without a seq cannot be matched and are kept. */
export function dedupeRows(rows) {
  const seen = new Set();
  const kept = [];
  for (const r of rows) {
    if (Number.isFinite(r?.seq)) {
      const key = `${r.run_id ?? NO_RUN}:${r.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(r);
  }
  return { rows: kept, duplicates: rows.length - kept.length };
}

/** Rows by run, runs in order of first appearance, rows in seq order when every row has one. */
export function splitByRun(rows) {
  const runs = new Map([[NO_RUN, []]]);
  for (const r of rows) {
    const id = r?.run_id ?? NO_RUN;
    if (!runs.has(id)) runs.set(id, []);
    runs.get(id).push(r);
  }
  if (runs.get(NO_RUN).length === 0 && runs.size > 1) runs.delete(NO_RUN);
  for (const list of runs.values()) {
    if (list.every((r) => Number.isFinite(r.seq))) list.sort((a, b) => a.seq - b.seq);
  }
  return runs;
}

function mergeSessionMeta(a, b) {
  if (!a) return b;
  if (!b) return a;
  const merged = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (merged[k] === undefined || merged[k] === null) merged[k] = v;
  }
  if (a.params || b.params) {
    merged.params = { ...(b.params ?? {}), ...(a.params ?? {}) };
  }
  return merged;
}

function extractSessionFromEnvelope(env) {
  if (!env || env.session) return env?.session ?? null;
  return {
    params: {
      session_id: env.session_id,
      prolific_pid: env.prolific_pid,
      study_id: env.study_id,
      is_preview: env.is_preview,
    },
    build_id: env.build_id,
    schema_version: env.schema_version,
    prng_seed_uint32: env.prng_seed_uint32,
    is_pilot_run: env.is_pilot_run,
    pilot_label: env.pilot_label,
    started_at_iso: env.started_at_iso,
    user_agent: env.user_agent,
  };
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

/* ---------- Export driver ---------- */
