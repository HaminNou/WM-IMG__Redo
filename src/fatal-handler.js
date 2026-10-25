/**
 * What happens when the session cannot continue: classify the failure, write
 * one row about it where storage still works, release the "leave this page?"
 * prompt (leaving is now the expected next step) and show the right screen.
 *
 * Kept out of `runner.js` so it can be tested: the runner runs the whole study
 * on import. Every dependency can be replaced through `deps`.
 */
import { renderFatalScreen, errorReference } from './fatal-screens.js';
import { appendTrialRow, getAllTrialRows } from './storage.js';
import { uploadPendingData, downloadAsJson } from './uploader.js';
import { markUploadDone } from './session-guard.js';
import { rowClock } from './clock.js';

const SAVED = ['uploaded', 'nothing_to_upload'];

/**
 * Send everything not yet uploaded (all runs in this browser); if the server
 * cannot be reached, save a JSON copy to the device instead.
 *
 * @returns {Promise<{ok: boolean, text: string}>} the sentence to show the participant
 */
export async function saveSessionData({ session, deps = {} } = {}) {
  const upload = deps.uploadPendingData ?? uploadPendingData;
  const download = deps.downloadAsJson ?? downloadAsJson;
  const allRows = deps.getAllTrialRows ?? getAllTrialRows;
  try {
    const result = await upload({ session, allRuns: true });
    if (SAVED.includes(result?.status)) {
      return {
        ok: true,
        text: 'Your saved data were sent to us. Thank you. Please also message the researcher through Prolific.',
      };
    }
  } catch {
    /* fall through to the download */
  }
  try {
    const rows = await allRows();
    const dl = download({ session, rows });
    return {
      ok: false,
      text: `We could not reach our server, so a copy of your data was saved to your device as ${dl.filename}. Please send that file to the researcher through Prolific messaging.`,
    };
  } catch {
    return {
      ok: false,
      text: 'We could not save your data automatically. Please message the researcher through Prolific and describe what happened.',
    };
  }
}

/**
 * @param {object} opts
 * @param {'storage'|'startup'|'running'} opts.stage   where the failure happened
 * @param {unknown} opts.error
 * @param {object} [opts.session]
 * @param {object} [opts.deps]
 * @returns {HTMLElement} the mounted screen
 */
export function handleFatal({ stage, error, session, deps = {} }) {
  const log = deps.appendTrialRow ?? appendTrialRow;
  const render = deps.renderFatalScreen ?? renderFatalScreen;
  const release = deps.markUploadDone ?? markUploadDone;
  try {
    console.error(`[runner] fatal failure during ${stage}`, error);
  } catch {
    /* the console may be unavailable */
  }
  /* Once the task has stopped, leaving the page is what the participant has
   * to do next (recovery page, new tab, or a closed browser): the "leave site?"
   * prompt would only get in the way. */
  if (stage === 'running') {
    try {
      release();
    } catch {
      /* ignore */
    }
  }
  /* A storage failure means the row cannot be written either. */
  if (stage !== 'storage') {
    try {
      let clock = {};
      try {
        clock = (deps.rowClock ?? rowClock)();
      } catch {
        clock = {};
      }
      const written = log({
        phase: 'runtime_error_fatal',
        stage,
        message: errorReference(error),
        ...clock,
      });
      if (written && typeof written.catch === 'function') written.catch(() => {});
    } catch {
      /* ignore */
    }
  }
  return render({
    stage,
    error,
    saveData: stage === 'running' ? () => saveSessionData({ session, deps }) : undefined,
  });
}
