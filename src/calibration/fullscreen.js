/**
 * Fullscreen-lock + tab-visibility listener.
 *
 * Online participants will Alt-Tab away if we don't make leaving the page
 * a deliberate act. We:
 *   1. enter fullscreen via the official jsPsych plugin (allowed inside the
 *      consent-button user gesture chain that started the audio context),
 *   2. attach a `visibilitychange` listener that records every tab-blur and
 *      tab-focus event with timestamps,
 *   3. record fullscreen exits the same way.
 *
 * Each event is persisted via `appendTrialRow({phase: 'visibility_event'})`
 * so it rides the standard IDB → uploader pipeline rather than living only
 * in an in-memory array (which is lost if the tab is killed before the
 * upload phase). The in-memory `events` array is kept in addition for
 * debug-time inspection via `getVisibilityEvents()`.
 *
 * These events are recorded only; no exclusion is applied at collection.
 */
import fullscreenPlugin from '@jspsych/plugin-fullscreen';
import callFunction from '@jspsych/plugin-call-function';
import { appendTrialRow, recordWriteFailure } from '../storage.js';
import { registerHiddenNavStep, trackHiddenNavNode } from '../hidden-nav.js';
import { requireFullscreenFromNow } from './display-guard.js';

let unsubscribe = null;
const events = [];

function persistEvent(event) {
  events.push(event);
  /* Fire-and-forget — same pattern as runner.js on_data_update. If the
   * write fails (transient quota error, locked DB), the in-memory copy
   * survives and the failure is counted on the upload-summary row. */
  appendTrialRow({ phase: 'visibility_event', ...event }).catch((err) => {
    console.error('[visibility] storage append failed', err);
    recordWriteFailure(err);
  });
}

function startVisibilityRecorder() {
  if (unsubscribe) return;
  const onVisibility = () => {
    persistEvent({
      kind: 'visibilitychange',
      hidden: document.hidden,
      ts: performance.now(),
      iso: new Date().toISOString(),
    });
  };
  const onFsChange = () => {
    persistEvent({
      kind: 'fullscreenchange',
      in_fullscreen: !!document.fullscreenElement,
      ts: performance.now(),
      iso: new Date().toISOString(),
    });
  };
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('fullscreenchange', onFsChange);
  unsubscribe = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('fullscreenchange', onFsChange);
  };
}

export function getVisibilityEvents() {
  return events.slice();
}

export function enterFullscreenTrial() {
  const stepId = 'enter_fullscreen';
  const node = {
    type: fullscreenPlugin,
    fullscreen_mode: true,
    message: `
      <h2>Enter fullscreen</h2>
      <p>The experiment must run in fullscreen. Click below to continue.</p>
    `,
    button_label: 'Enter fullscreen',
    data: { phase: 'enter_fullscreen' },
  };
  registerHiddenNavStep(stepId, enterFullscreenTrial);
  return trackHiddenNavNode(node, stepId);
}

export function attachVisibilityRecorder() {
  return {
    type: callFunction,
    async: false,
    func: () => {
      startVisibilityRecorder();
      requireFullscreenFromNow();
      return { recording: true, in_fullscreen: !!document.fullscreenElement };
    },
    data: { phase: 'visibility_recorder_start' },
  };
}
