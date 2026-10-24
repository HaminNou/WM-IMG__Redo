/**
 * Reload, back-button and tab-close handling.
 *
 * The task cannot resume mid-session, so a reload restarts it. To keep the
 * data usable:
 *   - rows carry `run_id` (see storage.js), and uploads send only the rows
 *     of the current run;
 *   - at start, rows left from an earlier run in this browser are counted
 *     and written to a `session_start` row (`prior_rows`, `prior_run_ids`)
 *     together with a reading of all clocks;
 *   - `beforeunload` asks for confirmation until the final upload has run;
 *   - the back button is trapped and each press is logged.
 */
import { getAllTrialRows, appendTrialRow } from './storage.js';
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
  await appendTrialRow({
    phase: 'session_start',
    prior_rows: rows.length,
    prior_run_ids: Array.from(prior),
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
