/**
 * Secret stage skip (experimenter debug mode only).
 *
 * Pressing `N` twice (two non-repeat keydowns within 450 ms; same filters as the G G reveal)
 * skips forward ONE stage of the session:
 *
 *   stage 1  instructions / demos / intro slides / practice-readiness  ->  the next practice
 *            trial gate (Task 1's on the first pass), practice then runs normally
 *   stage 2  practice (trial, feedback, notice, attention check)       ->  main_a_intro
 *   stage 3  Main A (gate, trial, rest, resume gate, tag reminder)     ->  main_b_intro
 *   stage 4  Main B                                                    ->  end_of_task_intro
 *
 * Consent, demographics, calibration, volume, tone check and the timing probe are never
 * skipped (they measure the screen and sound that the geometry needs): only a console note.
 * After `end_of_task_intro` there is nothing to skip.
 *
 * Mechanism (built on the hidden-nav primitives, but independent of `?devnav=1`):
 *  - the keypress finishes the live trial (like `U`), silences audio, closes the trace group
 *    (`trace.abort`), writes ONE `debug_skip` row and records a TARGET;
 *  - `hidden-nav.js` calls `onTrialStart` for every trial; until the target trial starts, each
 *    trial is neutralised (`trial_duration: 0`, `choices: 'NO_KEYS'` for keyboard trials; a
 *    synthetic finish for instruction / button / survey trials; call-function trials just run).
 *    The neutralised trials still run their own `on_load` / `on_finish`, so their cleanup
 *    (key listeners, timers, background, trial counter) happens exactly as for a timeout;
 *  - the target trial is not neutralised: the audio gate and the trace are released there;
 *  - stage 2 also arms the developer-skip latch (the practice loop exits whatever the accuracy)
 *    and bypasses the practice-disqualification check (`isPracticeBypassed`) until the target;
 *  - trial numbering (`N/120`) is static in the plan, so skipped trials leave it consistent.
 *
 * The keydown listener and the hook exist ONLY when debug mode is on (`installSkip`). The
 * listener is capture-phase and passive except that the SECOND press of a pair is stopped from
 * reaching the page (the trial it ends is already finished). N is not an allowed key of any
 * response handler, so it is never counted as a response or an extra key.
 */
import { isDebugMode } from './debug-mode.js';
import { trace } from './trace.js';
import { stopAllScheduledAudio, setAudioMuted } from '../audio/dsp.js';
import { setDebugTrialStartHook, armDeveloperSkip, consumeDeveloperSkip } from '../hidden-nav.js';

/** Maximum gap between the two presses, ms (same as the G G reveal). */
export const SKIP_WINDOW_MS = 450;
/** Phase of the data row written for each skip. */
export const SKIP_ROW_PHASE = 'debug_skip';

export const STAGES = Object.freeze({
  instructions: 1,
  practice: 2,
  main_a: 3,
  main_b: 4,
});
const STAGE_NAMES = Object.freeze({
  1: 'instructions',
  2: 'practice',
  3: 'main_a',
  4: 'main_b',
});
const TARGET_NAMES = Object.freeze({
  1: 'practice_gate',
  2: 'main_a_intro',
  3: 'main_b_intro',
  4: 'end_of_task_intro',
});

let installed = false;
let listenerTarget = null;
let keyHandler = null;
let emitRow = null;
let nowFn = () => performance.now();
let getJsPsych = () => (typeof window !== 'undefined' ? window.jsPsych : undefined);

let lastNAt = null;
/** @type {null | {stage: number, name: string}} the target being skipped to; null when idle */
let pending = null;
let practiceBypass = false;
/** 'main_a' | 'main_b' | null: the main block the session is in (for rests, which carry no uid) */
let mainBlock = null;
let endReached = false;

/** Is the skip installed (debug mode on)? */
export function isSkipInstalled() {
  return installed;
}
/** Is a skip under way (trials are being neutralised)? */
export function isSkipping() {
  return pending !== null;
}
/** True from an N N out of practice until main_a_intro: the practice criterion / retry / disqualification must not act. */
export function isPracticeBypassed() {
  return practiceBypass;
}

const isPracticeUid = (d) =>
  d?.block_label === 'practice' ||
  (typeof d?.trial_uid === 'string' && /^practice-/.test(d.trial_uid));

/** Block of a trial/row: 'practice' | 'main_a' | 'main_b' | null. */
function blockOf(d) {
  if (isPracticeUid(d)) return 'practice';
  const uid = typeof d?.trial_uid === 'string' ? d.trial_uid : '';
  if (d?.block_label === 'main_a' || /^main_a-/.test(uid)) return 'main_a';
  if (d?.block_label === 'main_b' || /^main_b-/.test(uid)) return 'main_b';
  return null;
}

/**
 * Which stage a node belongs to. Pure (exported for tests).
 * @param {object} data resolved data of the live trial (phase, trial_uid, block_label)
 * @param {{mainBlock?: string|null, endReached?: boolean}} [memory] block the session is in / end seen
 * @returns {{stage: number|null, kind: 'stage'|'setup'|'end'}}
 */
export function classifyStage(data, memory = {}) {
  const phase = typeof data?.phase === 'string' ? data.phase : '';
  if (phase === 'end_of_task_intro' || memory.endReached === true)
    return { stage: null, kind: 'end' };
  const block = blockOf(data);
  if (block === 'practice') return { stage: STAGES.practice, kind: 'stage' };
  if (block === 'main_a') return { stage: STAGES.main_a, kind: 'stage' };
  if (block === 'main_b') return { stage: STAGES.main_b, kind: 'stage' };
  if (phase === 'main_a_intro' || phase === 'main_a_tag_reminder')
    return { stage: STAGES.main_a, kind: 'stage' };
  if (phase === 'main_b_intro' || phase === 'display_guard_stop')
    return { stage: STAGES.main_b, kind: 'stage' };
  if (phase === 'rest' || phase === 'rest_resume_gate') {
    /* rests carry block_label main_a / main_b (in-block) or inter_block (between the blocks) */
    if (memory.mainBlock === 'main_b') return { stage: STAGES.main_b, kind: 'stage' };
    return { stage: STAGES.main_a, kind: 'stage' };
  }
  if (
    phase === 'practice_feedback' ||
    phase === 'practice_buttons_notice' ||
    phase === 'practice_disqualification' ||
    phase === 'attention_check' ||
    phase === 'attention_check_summary' ||
    phase === 'session_info'
  )
    return { stage: STAGES.practice, kind: 'stage' };
  if (
    phase === 'instructions_overview' ||
    phase === 'practice_readiness' ||
    phase === 'practice_iteration_start' ||
    /^instructions_/.test(phase) ||
    /^demo_/.test(phase)
  )
    return { stage: STAGES.instructions, kind: 'stage' };
  return { stage: null, kind: 'setup' };
}

/** Is this trial the target of the skip to `stage`? */
function isTarget(stage, d) {
  const phase = typeof d?.phase === 'string' ? d.phase : '';
  switch (stage) {
    case STAGES.instructions:
      return /_trial_start$/.test(phase) && isPracticeUid(d);
    case STAGES.practice:
      return phase === 'main_a_intro';
    case STAGES.main_a:
      return phase === 'main_b_intro';
    case STAGES.main_b:
      return phase === 'end_of_task_intro';
    default:
      return false;
  }
}

/* Screens at or after the end of the task: a skip must never run into them (safety net). */
const END_SCREEN = /^(end_of_task_intro|questionnaire_|strategy_|music|upload_|completion_)/;

function resolveData(trial) {
  try {
    const node = getJsPsych()?.timeline?.getLatestNode?.();
    if (node && typeof node.getDataParameter === 'function') {
      const d = node.getDataParameter();
      if (d && typeof d === 'object') return d;
    }
  } catch {
    /* fall through to the static data */
  }
  const d = trial?.data;
  return d && typeof d === 'object' ? d : {};
}

function syntheticResult(pluginName) {
  if (pluginName === 'html-button-response') return { response: 0 };
  if (pluginName === 'survey-html-form') return { response: {} };
  return {};
}

function neutralise(trial) {
  trace.mute(true);
  setAudioMuted(true);
  const name = trial?.type?.info?.name ?? null;
  if (name === 'html-keyboard-response') {
    trial.trial_duration = 0;
    trial.choices = 'NO_KEYS';
    return;
  }
  if (name === 'call-function') return; /* runs and ends by itself */
  /* instructions / button / survey trials: finish them like `U` does, once the plugin has mounted */
  const js = getJsPsych();
  const node = js?.timeline?.getLatestNode?.();
  setTimeout(() => {
    try {
      if (js?.timeline?.getLatestNode?.() === node) {
        /* jsPsych does not cancel a plugin's key listener when a trial is finished from outside */
        js.pluginAPI?.cancelAllKeyboardResponses?.();
        js.finishTrial(syntheticResult(name));
      }
    } catch {
      /* never break the session */
    }
  }, 0);
}

/**
 * The trial-start hook (registered with hidden-nav.js). Returns true when it handled the trial.
 * Also tracks which main block the session is in (rests carry no uid).
 * @param {object} trial the jsPsych trial object about to run
 */
export function onTrialStart(trial) {
  try {
    const d = resolveData(trial);
    const phase = typeof d.phase === 'string' ? d.phase : '';
    const block = blockOf(d);
    if (block === 'main_a' || block === 'main_b') mainBlock = block;
    if (phase === 'main_a_intro') mainBlock = 'main_a';
    if (phase === 'main_b_intro') mainBlock = 'main_b';
    if (phase === 'end_of_task_intro') endReached = true;
    if (pending === null) return false;
    if (isTarget(pending.stage, d)) {
      /* Arrived: release everything the skip held down. */
      pending = null;
      practiceBypass = false;
      consumeDeveloperSkip();
      setAudioMuted(false);
      trace.mute(false);
      return true;
    }
    if (END_SCREEN.test(phase)) {
      /* The target was never found: stop here instead of skipping the end of the session. */
      pending = null;
      practiceBypass = false;
      consumeDeveloperSkip();
      setAudioMuted(false);
      trace.mute(false);
      console.warn(`[debug] stage skip target not found; stopped at ${phase}`);
      return true;
    }
    neutralise(trial);
    return true;
  } catch {
    return false;
  }
}

function note(text, warn = false) {
  try {
    if (warn) console.warn(`[debug] ${text}`);
    else console.log(`[debug] ${text}`);
  } catch {
    /* ignore */
  }
}

function isEditable(t) {
  if (!t || typeof t.tagName !== 'string') return false;
  const tag = t.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}

/** Perform the skip for the node that is on screen now. */
function doSkip() {
  const js = getJsPsych();
  const node = js?.timeline?.getLatestNode?.();
  if (!node || typeof node.getDataParameter !== 'function') {
    note('skip: no screen to skip (press N N while a screen is showing)');
    return;
  }
  if (pending !== null) {
    note('skip: already skipping');
    return;
  }
  const data = resolveData(null);
  const cls = classifyStage(data, { mainBlock, endReached });
  if (cls.kind === 'setup') {
    note(
      'calibration cannot be skipped (consent, demographics, calibration, volume, tone check and timing probe measure the screen and sound)'
    );
    return;
  }
  if (cls.kind === 'end') {
    note('skip: nothing left to skip (end of the task)');
    return;
  }
  const from = cls.stage;
  const row = {
    phase: SKIP_ROW_PHASE,
    from_stage: STAGE_NAMES[from],
    to_stage: TARGET_NAMES[from],
    trial_uid: data.trial_uid ?? null,
    debug_node_phase: data.phase ?? null,
    ts: Math.round(nowFn()),
  };
  try {
    emitRow?.(row);
  } catch (err) {
    console.error('[debug] skip row not written', err);
  }
  pending = { stage: from, name: TARGET_NAMES[from] };
  if (from === STAGES.practice) {
    practiceBypass = true;
    armDeveloperSkip();
  }
  /* Close the trial group (also switches the reveal off), print the line, silence audio. */
  trace.abort('experimenter stage skip (N N)');
  try {
    trace.marker(
      `SKIP  ${row.from_stage} → ${row.to_stage}  (from ${row.debug_node_phase ?? '?'}${row.trial_uid ? ` ${row.trial_uid}` : ''})`,
      { closeTrial: true }
    );
  } catch {
    /* the trace never throws */
  }
  stopAllScheduledAudio();
  setAudioMuted(true);
  let pluginName = null;
  try {
    pluginName = node.description?.type?.info?.name ?? null;
  } catch {
    pluginName = null;
  }
  /* jsPsych does not cancel the plugin's key listener when a trial is finished from outside. */
  js.pluginAPI?.cancelAllKeyboardResponses?.();
  js.finishTrial({
    ...syntheticResult(pluginName),
    phase: data.phase ?? null,
    debug_skipped: true,
  });
}

/**
 * The keydown handler (exported for tests): two non-repeat `n`/`N` keydowns within
 * {@link SKIP_WINDOW_MS} skip one stage. Only the second press of a pair is stopped.
 * @param {KeyboardEvent} e
 */
export function handleSkipKey(e) {
  try {
    if (e.repeat) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'n' && e.key !== 'N') return;
    if (isEditable(e.target) || isEditable(document.activeElement)) return;
    const now = nowFn();
    if (lastNAt !== null && now - lastNAt <= SKIP_WINDOW_MS) {
      lastNAt = null;
      e.stopPropagation();
      doSkip();
    } else {
      lastNAt = now;
    }
  } catch {
    /* ignore */
  }
}

/**
 * Install the skip. Does nothing (no listener, no hook) unless debug mode is on.
 * @param {object} [opts]
 * @param {(row: object) => void} [opts.emitRow] writes a data row (the runner passes emitAuxDataRow)
 * @param {boolean} [opts.enabled] override of isDebugMode() (tests)
 * @param {EventTarget} [opts.target] where to listen (default: window)
 * @param {() => number} [opts.now] clock in ms (tests)
 * @param {() => object} [opts.jsPsych] jsPsych accessor (tests; default window.jsPsych)
 * @returns {boolean} true when installed
 */
export function installSkip({ emitRow: emit, enabled, target, now, jsPsych } = {}) {
  const on = enabled ?? isDebugMode();
  if (!on || installed) return installed;
  emitRow = typeof emit === 'function' ? emit : null;
  nowFn = typeof now === 'function' ? now : () => performance.now();
  if (typeof jsPsych === 'function') getJsPsych = jsPsych;
  listenerTarget = target ?? window;
  keyHandler = handleSkipKey;
  listenerTarget.addEventListener('keydown', keyHandler, { capture: true });
  setDebugTrialStartHook(onTrialStart);
  installed = true;
  return true;
}

/** Remove the listener and hook and forget all state (tests). */
export function uninstallSkip() {
  if (listenerTarget && keyHandler) {
    listenerTarget.removeEventListener('keydown', keyHandler, { capture: true });
  }
  setDebugTrialStartHook(null);
  installed = false;
  listenerTarget = null;
  keyHandler = null;
  emitRow = null;
  lastNAt = null;
  pending = null;
  practiceBypass = false;
  mainBlock = null;
  endReached = false;
  nowFn = () => performance.now();
  getJsPsych = () => (typeof window !== 'undefined' ? window.jsPsych : undefined);
}
