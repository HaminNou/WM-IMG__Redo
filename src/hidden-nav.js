/**
 * Hidden experimenter navigation keys — `U` (forward) and `R` (back).
 *
 * The experiment runs as one jsPsych timeline, so hidden navigation cannot
 * change `window.location.href`; instead we register the experimenter-facing
 * screens that should participate in hidden navigation as "checkpoints".
 *
 * Two contexts:
 *
 *   - On a registered checkpoint (instructions, demo, calibration, intro):
 *       U  →  Finish the live trial. Natural advance to whatever the next
 *             timeline entry is (typically the next checkpoint).
 *       R  →  Splice [prev_factory(), currentFactory()] immediately after
 *             the live trial, then finish it. The previous step then runs,
 *             followed by a fresh copy of the current step, then the
 *             original timeline continues. This is the "detour" pattern
 *             that lets the experimenter peek backward without leaving
 *             the flow.
 *
 *   - Inside a non-registered trial (encoding/probe/practice/main):
 *       U  →  Finish the live trial AND set a skip token. The global
 *             `on_trial_start` hook neutralises every subsequent
 *             non-checkpoint trial (zero duration, no input, empty
 *             stimulus) until the next checkpoint, which clears the token
 *             and runs normally. Net effect: from inside any trial, U
 *             advances to the next instructions / demo / intro screen.
 *       R  →  Find the most recent checkpoint visited (from history) and
 *             splice that factory's output immediately after the live
 *             trial in its parent timeline, then finish the live trial.
 *             The previous checkpoint then runs as the very next thing.
 *
 * The skip-forward token is consumed exclusively by the
 * `on_trial_start` hook returned from `getHiddenNavTrialStartHook`, which
 * the runner wires into `initJsPsych`. Without that hook, U from inside a
 * trial would advance only one trial instead of skipping to the next
 * checkpoint.
 *
 * The keys are intentionally undocumented in participant-facing copy and
 * are intended for pre-launch experimenter checks.
 */

import { stopAllScheduledAudio, setAudioMuted } from './audio/dsp.js';

let installed = false;
let installedHandler = null;
let visitHistory = [];
const stepFactories = new Map();
let skipUntilNextCheckpoint = false;
/* Developer-skip latch: any U press arms it. The instructions+practice and
 * stand-alone practice `loop_function`s call `consumeDeveloperSkip()` once at
 * the iteration boundary; if the latch is armed, the loop returns `false`
 * regardless of computed accuracy, so the experimenter can blast through
 * practice straight into the main task without being stopped by a
 * "low-accuracy, retry" gate driven by neutralised (zero-duration) trials.
 * The latch survives across trials by design — `skipUntilNextCheckpoint`
 * clears at the next checkpoint and would not survive long enough to reach
 * the loop boundary. The latch is consumed (cleared) at read time so
 * subsequent legitimate iterations are unaffected. */
let developerSkipArmed = false;

function noteStepVisit(stepId) {
  if (!stepId || typeof stepId !== 'string') return;
  if (visitHistory[visitHistory.length - 1] === stepId) return;
  visitHistory.push(stepId);
  if (visitHistory.length > 32) visitHistory.shift();
}

function getStaticPhase(node) {
  const data = typeof node?.data === 'function' ? null : (node?.data ?? null);
  return typeof data?.phase === 'string' ? data.phase : null;
}

function withHiddenNavData(data, stepId) {
  if (data && typeof data === 'object' && typeof data !== 'function') {
    return {
      ...data,
      hidden_nav_step: stepId,
    };
  }
  return (...args) => {
    const base = typeof data === 'function' ? data(...args) : {};
    return {
      ...base,
      hidden_nav_step: stepId,
    };
  };
}

export function registerHiddenNavStep(stepId, factory) {
  if (!stepId || typeof stepId !== 'string' || typeof factory !== 'function') return;
  stepFactories.set(stepId, factory);
}

export function trackHiddenNavNode(node, stepId = getStaticPhase(node)) {
  if (!stepId || typeof stepId !== 'string') return node;
  const prevOnLoad = node?.on_load;
  node.data = withHiddenNavData(node?.data, stepId);
  /* Top-level marker so the on_trial_start hook can identify checkpoints
   * synchronously without resolving a function-form `data`. `deepCopy` in
   * jsPsych preserves own enumerable properties, so this survives the
   * description→trialObject copy that runs before `on_trial_start` fires. */
  node._hidden_nav_checkpoint = true;
  node.on_load = (...args) => {
    noteStepVisit(stepId);
    prevOnLoad?.(...args);
  };
  return node;
}

export function registerInstructionFactory(phase, factory) {
  registerHiddenNavStep(phase, factory);
}

export function trackInstructionNode(node) {
  return trackHiddenNavNode(node, getStaticPhase(node));
}

/**
 * Read-and-clear the developer-skip latch. Returns `true` if a U press has
 * occurred since the last consume call. Loop scheduler `loop_function`s call
 * this at the iteration boundary to decide whether to honour their normal
 * accuracy / attempt-count gating or to short-circuit and exit (the
 * experimenter is skipping the block).
 */
export function consumeDeveloperSkip() {
  const v = developerSkipArmed;
  developerSkipArmed = false;
  return v;
}

function getCurrentTrialNode(jsPsych) {
  const node = jsPsych?.timeline?.getLatestNode?.();
  return node && typeof node.getDataParameter === 'function' ? node : null;
}

function getCurrentStepMeta(jsPsych) {
  try {
    const node = getCurrentTrialNode(jsPsych);
    if (!node) return null;
    const data = node.getDataParameter?.() ?? {};
    const stepId = typeof data.hidden_nav_step === 'string' ? data.hidden_nav_step : null;
    return {
      node,
      stepId,
      phase: typeof data.phase === 'string' ? data.phase : null,
    };
  } catch {
    return null;
  }
}

function getSyntheticResult(node) {
  const pluginName = node?.description?.type?.info?.name ?? null;
  if (pluginName === 'html-button-response') {
    return { response: 0 };
  }
  if (pluginName === 'survey-html-form') {
    return { response: {} };
  }
  return {};
}

function findPreviousStepId(currentStepId) {
  const trimmedHistory = visitHistory.slice();
  if (currentStepId) {
    while (trimmedHistory[trimmedHistory.length - 1] === currentStepId) {
      trimmedHistory.pop();
    }
  }
  return {
    trimmedHistory,
    prevStepId: trimmedHistory[trimmedHistory.length - 1] ?? null,
  };
}

function insertAfterCurrentStep(currentNode, descriptions) {
  const timeline = currentNode?.parent?.description?.timeline;
  if (!Array.isArray(timeline)) return false;
  const index = timeline.indexOf(currentNode.description);
  if (index < 0) return false;
  timeline.splice(index + 1, 0, ...descriptions);
  return true;
}

/**
 * Build the global `on_trial_start` hook that consumes the skip-forward
 * token. The runner passes this into `initJsPsych({ on_trial_start: ... })`
 * once at boot.
 *
 * Behaviour:
 *   - If no skip is pending, do nothing.
 *   - If the trial about to run is a registered checkpoint, clear the
 *     skip flag and let the trial run normally.
 *   - Otherwise, neutralise the trial by setting `trial_duration: 0` and
 *     `choices: 'NO_KEYS'`. The plugin (`html-keyboard-response` for every
 *     trial type used here) reads both fields directly from `trialObject`
 *     in its `trial(display_element, trial)` body, so these mutations
 *     take effect immediately. The trial renders its real stimulus and
 *     calls its own `on_load` exactly as it would normally — we make no
 *     attempt to silence those, because jsPsych v8 caches `on_load` /
 *     `on_finish` / `data` against the node *description* (see
 *     `ParameterObjectPathCache.initialize` at
 *     `node_modules/jspsych/dist/index.js` line 1672), so mutating the
 *     trialObject after `processParameters()` does NOT divert those
 *     callbacks. Trying to blank `stimulus` while the original `on_load`
 *     still ran was what produced the `Cannot read properties of null
 *     (reading 'appendChild')` crash on every neutralised trial.
 *
 * The trial therefore briefly mounts its real DOM (≪16 ms typically)
 * and ends as soon as the plugin's `setTimeout(end_trial, 0)` fires.
 * `end_trial` calls `jsPsych.finishTrial`, which in turn invokes the
 * cached original `on_finish` — so per-node cleanup (e.g.
 * `timedResponseWindowNode`'s removal of its keydown handler / onset
 * timer) runs as if the participant had simply timed out.
 */
export function getHiddenNavTrialStartHook() {
  return function hiddenNavOnTrialStart(trial) {
    /* Always release the audio gate when a checkpoint runs, regardless of
     * whether the skip-forward token is armed. Both U-from-trial and
     * R-from-trial raise the gate so any fire-and-forget scheduler from
     * the trial they left can't queue tones into the next screen, and we
     * rely on this single line to drop the gate again as soon as the
     * legitimate checkpoint takes over (volume tone, tone-familiarisation
     * sweep, etc.). */
    if (trial?._hidden_nav_checkpoint === true) {
      if (skipUntilNextCheckpoint) skipUntilNextCheckpoint = false;
      setAudioMuted(false);
      return;
    }
    if (!skipUntilNextCheckpoint) {
      /* Non-checkpoint trial AND no skip is armed. Drop any leftover mute
       * (e.g. raised by a U press on a registered demo whose successor is
       * a non-checkpoint practice trial — the practice trial owns its own
       * audio and must not inherit the demo's silencer). The
       * fire-and-forget loop on the demo we just left has already had its
       * `state.cancelled` flipped synchronously in on_finish; it bails on
       * its next `await ctl.wait(…)` resolution without firing further
       * tones, regardless of what the gate is doing now. */
      setAudioMuted(false);
      return;
    }
    if (!trial || typeof trial !== 'object') return;
    trial.trial_duration = 0;
    trial.choices = 'NO_KEYS';
  };
}

/**
 * Install the global keydown listener. Idempotent — repeated calls are
 * no-ops so multiple imports during HMR / tests don't double-bind.
 *
 * @param {object} jsPsych  The jsPsych instance returned by `initJsPsych`.
 */
export function installHiddenNav(jsPsych) {
  if (installed) return;
  if (typeof document === 'undefined') return;

  const handler = (event) => {
    const tag = (event.target && event.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) {
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key?.toLowerCase?.();
    if (key !== 'u' && key !== 'r') return;

    const meta = getCurrentStepMeta(jsPsych);
    if (!meta) return;

    event.preventDefault();
    event.stopPropagation();

    /* Silence any audio scheduled before the experimenter pressed the
     * skip key. Tones are scheduled against the AudioContext clock and
     * keep ringing (or fire on time, for queued-but-not-yet-started
     * tones) regardless of jsPsych's trial advance, so without this the
     * 24-tone familiarisation sweep or a trial probe tone would continue
     * audibly into the next screen. The registry walked here covers every
     * scheduling path in this codebase (`playSineTone`); the volume-calibration loop manages its own
     * teardown via its `on_finish` which `jsPsych.finishTrial` triggers
     * below. */
    stopAllScheduledAudio();

    const syntheticResult = getSyntheticResult(meta.node);
    const onRegisteredStep = !!meta.stepId;

    if (key === 'u') {
      /* Arm the developer-skip latch on EVERY U press, regardless of
       * whether we're on a registered checkpoint. The practice and
       * instructions+practice `loop_function`s consume this latch at the
       * iteration boundary so a single U press from anywhere in the
       * practice arc terminates the loop instead of re-running it on the
       * 0% accuracy that neutralised trials produce. */
      developerSkipArmed = true;
      if (!onRegisteredStep) {
        /* Trial context: arm the skip token so the on_trial_start hook
         * neutralises every following non-checkpoint trial until the next
         * checkpoint. Without this, finishTrial would just advance to the
         * next individual trial. */
        skipUntilNextCheckpoint = true;
      }
      /* Engage the audio mute gate unconditionally — both trial context
       * AND registered-checkpoint context have fire-and-forget `async`
       * schedulers running at U-press time:
       *
       *   - Trial context — `runEncodingSchedule` in `t_only.js` /
       *     `i_t.js` ticks through `await sleep(M_SLOT_MS)` long after the
       *     trial it belongs to has ended. Without the gate it would
       *     re-populate the AudioContext scheduler with fresh tones on
       *     each iteration, AND each neutralised practice trial's cached
       *     `on_load` would spawn a brand-new copy of the same loop, so
       *     the silencers stack: a single U press at slot 2 of a t_only
       *     practice trial leaves up to five concurrent encoding loops
       *     running — and once a checkpoint clears the gate, every one
       *     of them resumes scheduling tones, producing the observed
       *     "tones play all together" symptom.
       *
       *   - Registered-checkpoint context — the demo `loopify` schedule
       *     in `instructions/demos.js` is fire-and-forget too. The demo
       *     bails on its `state.cancelled` flag (set synchronously by
       *     on_finish), but the gate is a belt-and-braces guarantee that
       *     a stray `playToneByCell(...)` between the cancellation flip
       *     and the next `await ctl.wait(...)` boundary cannot leak into
       *     the next screen.
       *
       * `on_trial_start` drops the gate at the next trial start —
       * checkpoint or not, as long as the skip token isn't armed — so the
       * gate stays UP exactly through the neutralisation zone (or until
       * the next demo / instruction takes over, in the registered case),
       * and DOWN before any normally-running successor trial starts. */
      setAudioMuted(true);
      jsPsych.finishTrial({
        ...syntheticResult,
        phase: meta.phase,
        hidden_nav: 'forward',
        hidden_nav_step: meta.stepId ?? null,
      });
      return;
    }

    /* key === 'r' */
    const { trimmedHistory, prevStepId } = findPreviousStepId(meta.stepId);
    const prevFactory = prevStepId ? stepFactories.get(prevStepId) : null;
    if (!prevFactory) return;

    let inserted = false;
    if (onRegisteredStep) {
      /* Registered-step R: detour pattern — run prev, then re-run current,
       * then continue. Requires both factories. */
      const currentFactory = stepFactories.get(meta.stepId);
      if (!currentFactory) return;
      inserted = insertAfterCurrentStep(meta.node, [prevFactory(), currentFactory()]);
    } else {
      /* Trial-context R: splice prev right after the current trial.
       * No `currentFactory` (trials aren't registered), so prev runs as
       * the very next trial; remaining trials of the current block follow
       * naturally. */
      inserted = insertAfterCurrentStep(meta.node, [prevFactory()]);
    }

    if (!inserted) return;

    visitHistory = trimmedHistory;
    /* Clear any pending forward skip — the user explicitly asked to go
     * back, so we don't want a stale skip token from an earlier U press
     * to neutralise the spliced prev step. */
    skipUntilNextCheckpoint = false;
    if (!onRegisteredStep) {
      /* Trial-context R: keep the gate up so any in-flight fire-and-
       * forget scheduler from the trial we're leaving (encoding loop,
       * demo loop) can't queue tones into the spliced prev checkpoint's
       * screen. The checkpoint hook above clears the gate when the
       * spliced step actually runs. */
      setAudioMuted(true);
    } else {
      /* Registered-step R: no fire-and-forget scheduler to suppress;
       * just make sure no stale gate from a prior `U` is hanging over
       * the upcoming spliced steps. */
      setAudioMuted(false);
    }
    jsPsych.finishTrial({
      ...syntheticResult,
      phase: meta.phase,
      hidden_nav: 'back',
      hidden_nav_step: meta.stepId ?? null,
      hidden_nav_target_step: prevStepId,
    });
  };

  document.addEventListener('keydown', handler, true);
  installedHandler = handler;
  installed = true;
}

/* Test hook — reset module state between tests. Not part of the public
 * runtime API. */
export function __resetHiddenNavForTests() {
  /* Detach the previously-installed listener so a fresh `installHiddenNav`
   * in the next test binds a single handler to the live `jsPsych` stub.
   * Without this, every test that calls `installHiddenNav` leaves a stale
   * listener on `document` bound to a now-dead stub, and a `dispatchKey`
   * in a later test fires every accumulated handler — which polluted the
   * audio-mute gate state across tests. */
  if (installedHandler && typeof document !== 'undefined') {
    document.removeEventListener('keydown', installedHandler, true);
  }
  installedHandler = null;
  installed = false;
  visitHistory = [];
  stepFactories.clear();
  skipUntilNextCheckpoint = false;
  developerSkipArmed = false;
  /* Drop the audio gate too — otherwise a test that arms the skip token
   * via a `U` keypress leaves audio globally muted for every subsequent
   * test in the file. */
  setAudioMuted(false);
}
