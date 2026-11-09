/**
 * Reload, back-button and tab-close handling.
 *
 * The task cannot resume mid-session, so a reload restarts it. To keep the
 * data usable:
 *   - rows carry `run_id` (see storage.js), and uploads send only the rows
 *     of the current run;
 *   - at start, rows left from an earlier run in this browser are counted
 *     and written to a `session_start` row (`prior_rows`, `prior_run_ids`)
 *     together with a reading of all clocks; the rows of abandoned earlier
 *     attempts are then removed from the browser (`prior_rows_discarded`,
 *     `prior_run_ids_discarded`), because a restart begins the study again and
 *     they are of no use; earlier runs that reached the end of the task or were
 *     screened out are kept for the recovery page (`prior_run_ids_kept`);
 *   - `beforeunload` asks for confirmation until the final upload has run;
 *   - the back button is trapped and each press is logged.
 */
import { getAllTrialRows, appendTrialRow, discardAbandonedEarlierRuns } from './storage.js';
import { clockAnchor, rowClock } from './clock.js';

let uploadDone = false;

/** Call once the data are uploaded, so leaving the page no longer asks for confirmation. */
export function markUploadDone() {
  uploadDone = true;
}

let removeListeners = null;

/** Test helper. */
export function _resetSessionGuardForTests() {
  uploadDone = false;
  removeListeners?.();
  removeListeners = null;
}

export async function startSessionGuard(session) {
  const rows = await getAllTrialRows();
  const prior = new Set(rows.map((r) => r.run_id ?? 'none'));
  /* A restart begins the study again, so an abandoned earlier attempt is cleared from this
   * browser; what was found is recorded below. A failure here must never stop the session. */
  let cleared = { discarded_rows: 0, discarded_run_ids: [], kept_run_ids: [], error: null };
  try {
    cleared = { ...(await discardAbandonedEarlierRuns()), error: null };
  } catch (err) {
    cleared.error = String(err?.message ?? err);
  }
  await appendTrialRow({
    phase: 'session_start',
    prior_rows: rows.length,
    prior_run_ids: Array.from(prior),
    prior_rows_discarded: cleared.discarded_rows,
    prior_run_ids_discarded: cleared.discarded_run_ids,
    prior_run_ids_kept: cleared.kept_run_ids,
    prior_discard_error: cleared.error,
    is_reload: performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload',
    session_id: session.params.session_id,
    started_at_iso: session.started_at_iso,
    clock_anchor: clockAnchor(),
  });
  if (removeListeners) return;

  const onBeforeUnload = (e) => {
    if (uploadDone) return;
    appendTrialRow({ phase: 'unload_attempt', ts: performance.now(), ...rowClock() }).catch(
      () => {}
    );
    e.preventDefault();
    e.returnValue = '';
  };
  const onPopState = () => {
    history.pushState(null, '', location.href);
    appendTrialRow({ phase: 'back_pressed', ts: performance.now(), ...rowClock() }).catch(() => {});
  };
  history.pushState(null, '', location.href);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('popstate', onPopState);
  removeListeners = () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('popstate', onPopState);
  };
}
