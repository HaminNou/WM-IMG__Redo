/**
 * @vitest-environment jsdom
 *
 * Tests for the hidden experimenter navigation keys (`U` = forward,
 * `R` = back), implemented in `src/hidden-nav.js`.
 *
 * The module installs a single document-level `keydown` listener that:
 *   - acts only on `u` / `r` keys,
 *   - acts only when the live trial is explicitly registered as a
 *     hidden-nav step,
 *   - calls `jsPsych.finishTrial(...)` to advance,
 *   - on `R`, splices fresh copies of the previous and current steps
 *     directly after the live step in the current timeline.
 *
 * Because the module is a side-effecting installer (binds a global
 * listener), the test suite resets module state via the
 * `__resetHiddenNavForTests` test hook between cases.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installHiddenNav,
  registerHiddenNavStep,
  trackHiddenNavNode,
  getHiddenNavTrialStartHook,
  consumeDeveloperSkip,
  __resetHiddenNavForTests,
} from '../src/hidden-nav.js';
import { isAudioMuted, setAudioMuted } from '../src/audio/dsp.js';

function makeTrackedNode(stepId, phase = stepId) {
  const timeline = [];
  const node = trackHiddenNavNode(
    {
      data: { phase },
      on_load: vi.fn(),
    },
    stepId
  );
  timeline.push(node);
  node.on_load();
  return {
    node,
    timeline,
  };
}

function makeStubJsPsych({ node }) {
  const getData = () => (typeof node.data === 'function' ? node.data() : node.data);
  const currentNode = {
    description: node,
    parent: { description: { timeline: [node] } },
    getDataParameter: getData,
  };
  return {
    timeline: {
      getLatestNode: () => currentNode,
    },
    finishTrial: vi.fn(),
    _currentNode: currentNode,
  };
}

function dispatchKey(key, { target } = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  (target ?? document).dispatchEvent(event);
  return event;
}

describe('installHiddenNav', () => {
  beforeEach(() => {
    __resetHiddenNavForTests();
  });

  afterEach(() => {
    __resetHiddenNavForTests();
  });

  it('U on a registered step calls finishTrial with hidden_nav=forward', () => {
    registerHiddenNavStep('consent', () => ({ type: 'mock', data: { phase: 'consent' } }));
    const { node } = makeTrackedNode('consent');
    node.type = { info: { name: 'html-button-response' } };
    const jsp = makeStubJsPsych({ node });
    installHiddenNav(jsp);
    dispatchKey('u');
    expect(jsp.finishTrial).toHaveBeenCalledTimes(1);
    expect(jsp.finishTrial).toHaveBeenCalledWith(
      expect.objectContaining({ hidden_nav: 'forward', hidden_nav_step: 'consent', response: 0 })
    );
  });

  it('R on a registered step finishes the current trial', () => {
    registerHiddenNavStep('demographics', () => ({
      type: 'mock',
      data: { phase: 'demographics' },
    }));
    const { node } = makeTrackedNode('demographics');
    const jsp = makeStubJsPsych({ node });
    installHiddenNav(jsp);
    dispatchKey('r');
    expect(jsp.finishTrial).not.toHaveBeenCalled();
  });

  it('U on a non-checkpoint trial finishes it AND arms the skip-forward token', () => {
    /* From inside a trial, U should end the live trial AND set up the
     * on_trial_start hook to neutralise every subsequent non-checkpoint
     * trial until the next registered checkpoint. The hook itself is
     * exercised in the dedicated `getHiddenNavTrialStartHook` block below;
     * here we just verify the keydown path sets things up. */
    const trialNode = {
      data: () => ({ phase: 'd_only_main' }),
    };
    const jsp = {
      timeline: {
        getLatestNode: () => ({
          description: trialNode,
          parent: { description: { timeline: [trialNode] } },
          getDataParameter: () => trialNode.data(),
        }),
      },
      finishTrial: vi.fn(),
    };
    installHiddenNav(jsp);
    dispatchKey('u');
    expect(jsp.finishTrial).toHaveBeenCalledTimes(1);
    expect(jsp.finishTrial).toHaveBeenCalledWith(
      expect.objectContaining({
        hidden_nav: 'forward',
        hidden_nav_step: null,
        phase: 'd_only_main',
      })
    );
    /* Token armed: the next non-checkpoint trial that the hook sees should
     * be neutralised. Probe this via a fresh hook-in-call. */
    const hook = getHiddenNavTrialStartHook();
    const trialAfter = { trial_duration: 5000 };
    hook(trialAfter);
    expect(trialAfter.trial_duration).toBe(0);
    /* Then a checkpoint clears the token. */
    const checkpointTrial = { _hidden_nav_checkpoint: true, trial_duration: 5000 };
    hook(checkpointTrial);
    expect(checkpointTrial.trial_duration).toBe(5000);
    /* And subsequent non-checkpoint trials are no longer neutralised. */
    const trialAfterCheckpoint = { trial_duration: 5000 };
    hook(trialAfterCheckpoint);
    expect(trialAfterCheckpoint.trial_duration).toBe(5000);
  });

  it('R on a non-checkpoint trial splices the previous checkpoint right after the live trial', () => {
    /* History walk: visit consent, then visit a trial. R from the trial
     * should splice the consent factory output after the trial. */
    const consentNode = {
      type: 'mock-plugin',
      stimulus: 'consent slide',
      data: { phase: 'consent' },
    };
    registerHiddenNavStep('consent', () => consentNode);
    /* Walk the consent step so it lands in visit history. */
    makeTrackedNode('consent');

    const trialNode = {
      data: () => ({ phase: 'd_only_main' }),
    };
    const parentTimeline = [trialNode];
    const jsp = {
      timeline: {
        getLatestNode: () => ({
          description: trialNode,
          parent: { description: { timeline: parentTimeline } },
          getDataParameter: () => trialNode.data(),
        }),
      },
      finishTrial: vi.fn(),
    };
    installHiddenNav(jsp);
    dispatchKey('r');
    expect(parentTimeline).toHaveLength(2);
    expect(parentTimeline[0]).toBe(trialNode);
    expect(parentTimeline[1]).toBe(consentNode);
    expect(jsp.finishTrial).toHaveBeenCalledWith(
      expect.objectContaining({
        hidden_nav: 'back',
        hidden_nav_step: null,
        hidden_nav_target_step: 'consent',
        phase: 'd_only_main',
      })
    );
  });

  it('R on a trial with no prior checkpoint is a no-op (no history → no splice)', () => {
    const trialNode = {
      data: () => ({ phase: 'd_only_main' }),
    };
    const parentTimeline = [trialNode];
    const jsp = {
      timeline: {
        getLatestNode: () => ({
          description: trialNode,
          parent: { description: { timeline: parentTimeline } },
          getDataParameter: () => trialNode.data(),
        }),
      },
      finishTrial: vi.fn(),
    };
    installHiddenNav(jsp);
    dispatchKey('r');
    expect(parentTimeline).toHaveLength(1);
    expect(jsp.finishTrial).not.toHaveBeenCalled();
  });

  it('R on a trial clears any pending skip token (so the spliced prev step actually runs)', () => {
    /* If the experimenter pressed U inside a trial (arming the skip
     * token) and then changes their mind and presses R, the spliced
     * prev step is itself a checkpoint and would clear the token on its
     * own. But guard against the edge case where the parent's structure
     * means an earlier non-checkpoint trial would otherwise eat the token
     * first — so R explicitly clears it. */
    const consentNode = {
      type: 'mock-plugin',
      data: { phase: 'consent' },
    };
    registerHiddenNavStep('consent', () => consentNode);
    makeTrackedNode('consent');

    const trialNode = { data: () => ({ phase: 'd_only_main' }) };
    const parentTimeline = [trialNode];
    const jsp = {
      timeline: {
        getLatestNode: () => ({
          description: trialNode,
          parent: { description: { timeline: parentTimeline } },
          getDataParameter: () => trialNode.data(),
        }),
      },
      finishTrial: vi.fn(),
    };
    installHiddenNav(jsp);
    dispatchKey('u');
    /* Token is now armed. */
    dispatchKey('r');
    /* R should have cleared it; the hook should leave a fresh
     * non-checkpoint trial untouched now. */
    const hook = getHiddenNavTrialStartHook();
    const probe = { trial_duration: 5000 };
    hook(probe);
    expect(probe.trial_duration).toBe(5000);
  });

  it('keys other than u/r are ignored', () => {
    registerHiddenNavStep('instructions_dual_i_d', () => ({
      type: 'mock',
      data: { phase: 'instructions_dual_i_d' },
    }));
    const { node } = makeTrackedNode('instructions_dual_i_d');
    const jsp = makeStubJsPsych({ node });
    installHiddenNav(jsp);
    dispatchKey('a');
    dispatchKey(' ');
    dispatchKey('ArrowRight');
    expect(jsp.finishTrial).not.toHaveBeenCalled();
  });

  it('U/R inside an INPUT/TEXTAREA target are ignored (typed AC compatibility)', () => {
    registerHiddenNavStep('attention_check_ac1', () => ({
      type: 'mock',
      data: { phase: 'attention_check' },
    }));
    const { node } = makeTrackedNode('attention_check_ac1', 'attention_check');
    const jsp = makeStubJsPsych({ node });
    installHiddenNav(jsp);
    const input = document.createElement('input');
    document.body.appendChild(input);
    dispatchKey('u', { target: input });
    dispatchKey('r', { target: input });
    expect(jsp.finishTrial).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it('install is idempotent — repeated calls do not double-bind', () => {
    registerHiddenNavStep('instructions_overview', () => ({
      type: 'mock',
      data: { phase: 'instructions_overview' },
    }));
    const { node } = makeTrackedNode('instructions_overview');
    const jsp = makeStubJsPsych({ node });
    installHiddenNav(jsp);
    installHiddenNav(jsp);
    installHiddenNav(jsp);
    dispatchKey('u');
    expect(jsp.finishTrial).toHaveBeenCalledTimes(1);
  });

  it('R reinserts the previous and current steps immediately after the live step', () => {
    const prevNode = {
      type: 'mock-plugin',
      stimulus: 'previous slide',
      data: { phase: 'demographics' },
    };
    const currentNode = {
      type: 'mock-plugin',
      stimulus: 'current slide',
      data: { phase: 'screen_calibration' },
    };
    registerHiddenNavStep('demographics', () => prevNode);
    registerHiddenNavStep('screen_calibration', () => currentNode);

    const prev = makeTrackedNode('demographics').node;
    void prev;
    const current = makeTrackedNode('screen_calibration').node;
    const jsp = makeStubJsPsych({ node: current });
    installHiddenNav(jsp);
    dispatchKey('r');
    expect(jsp._currentNode.parent.description.timeline).toHaveLength(3);
    expect(jsp._currentNode.parent.description.timeline[1]).toBe(prevNode);
    expect(jsp._currentNode.parent.description.timeline[2]).toBe(currentNode);
    expect(jsp.finishTrial).toHaveBeenCalledWith(
      expect.objectContaining({
        hidden_nav: 'back',
        hidden_nav_step: 'screen_calibration',
        hidden_nav_target_step: 'demographics',
      })
    );
  });
});

describe('getHiddenNavTrialStartHook', () => {
  beforeEach(() => {
    __resetHiddenNavForTests();
  });

  afterEach(() => {
    __resetHiddenNavForTests();
  });

  it('is a no-op when no skip is pending', () => {
    const hook = getHiddenNavTrialStartHook();
    const trial = {
      trial_duration: 5000,
      choices: ['ArrowLeft', 'ArrowRight'],
      stimulus: '<p>real stimulus</p>',
    };
    hook(trial);
    expect(trial.trial_duration).toBe(5000);
    expect(trial.choices).toEqual(['ArrowLeft', 'ArrowRight']);
    expect(trial.stimulus).toBe('<p>real stimulus</p>');
  });

  it('neutralises a non-checkpoint trial by setting trial_duration=0 and choices=NO_KEYS, leaving stimulus / on_load / on_finish alone', () => {
    /* The hook deliberately does NOT touch `stimulus`, `on_load`, or
     * `on_finish`: jsPsych v8 caches `on_load` and `on_finish` against the
     * node *description* (see `ParameterObjectPathCache.initialize` at
     * `node_modules/jspsych/dist/index.js` line 1672), so mutating them on
     * the trialObject after `processParameters()` is a no-op. Worse, if we
     * blank `stimulus` the original cached `on_load` still runs and
     * crashes when it tries to `getElementById(...).appendChild(...)` for
     * a mount div that was never rendered. The plugin DOES read
     * `trial_duration` and `choices` directly from the trialObject, so
     * those mutations are effective: the plugin schedules
     * `setTimeout(end_trial, 0)` and skips its keyboard listener, ending
     * the trial right after the original (untouched) on_load completes.
     * That cached on_finish then runs per-node cleanup as if the trial
     * had timed out. */
    const trialNode = { data: () => ({ phase: 'd_only_main' }) };
    const jsp = {
      timeline: {
        getLatestNode: () => ({
          description: trialNode,
          parent: { description: { timeline: [trialNode] } },
          getDataParameter: () => trialNode.data(),
        }),
      },
      finishTrial: vi.fn(),
    };
    installHiddenNav(jsp);
    dispatchKey('u');

    const hook = getHiddenNavTrialStartHook();
    const realOnLoad = vi.fn();
    const realOnFinish = vi.fn();
    const trial = {
      trial_duration: 5000,
      choices: ['ArrowLeft', 'ArrowRight'],
      stimulus: '<p>real stimulus</p>',
      on_load: realOnLoad,
      on_finish: realOnFinish,
    };
    hook(trial);
    expect(trial.trial_duration).toBe(0);
    expect(trial.choices).toBe('NO_KEYS');
    /* Stimulus, on_load, on_finish must remain untouched so the original
     * render + on_load + on_finish still run (cached or read-direct). */
    expect(trial.stimulus).toBe('<p>real stimulus</p>');
    expect(trial.on_load).toBe(realOnLoad);
    expect(trial.on_finish).toBe(realOnFinish);
  });

  it('clears the skip token when it sees a checkpoint, leaving subsequent trials untouched', () => {
    const trialNode = { data: () => ({ phase: 'd_only_main' }) };
    const jsp = {
      timeline: {
        getLatestNode: () => ({
          description: trialNode,
          parent: { description: { timeline: [trialNode] } },
          getDataParameter: () => trialNode.data(),
        }),
      },
      finishTrial: vi.fn(),
    };
    installHiddenNav(jsp);
    dispatchKey('u');

    const hook = getHiddenNavTrialStartHook();
    /* First non-checkpoint: neutralised. */
    const t1 = { trial_duration: 5000 };
    hook(t1);
    expect(t1.trial_duration).toBe(0);
    /* Then a checkpoint: untouched, token cleared. */
    const checkpoint = { _hidden_nav_checkpoint: true, trial_duration: 5000, stimulus: 'C' };
    hook(checkpoint);
    expect(checkpoint.trial_duration).toBe(5000);
    expect(checkpoint.stimulus).toBe('C');
    /* Subsequent non-checkpoint: now passes through untouched. */
    const t2 = { trial_duration: 4321 };
    hook(t2);
    expect(t2.trial_duration).toBe(4321);
  });
});

describe('trackHiddenNavNode', () => {
  beforeEach(() => {
    __resetHiddenNavForTests();
  });

  afterEach(() => {
    __resetHiddenNavForTests();
  });

  it('stamps _hidden_nav_checkpoint=true so the on_trial_start hook can identify checkpoints synchronously', () => {
    const node = trackHiddenNavNode(
      {
        data: { phase: 'consent' },
      },
      'consent'
    );
    expect(node._hidden_nav_checkpoint).toBe(true);
  });

  it('does not stamp the checkpoint flag when no stepId is supplied', () => {
    const node = trackHiddenNavNode({ data: () => ({ phase: 'd_only_main' }) });
    expect(node._hidden_nav_checkpoint).toBeUndefined();
  });
});

describe('developer-skip latch around hidden-nav skip', () => {
  /* The latch is the contract that lets the practice / instructions+
   * practice `loop_function`s short-circuit their accuracy-criterion
   * gating when the experimenter skips through the block. Without it,
   * neutralised trials produce 0% accuracy and the loop_function would
   * re-loop indefinitely (capped only by `max_loops`). */

  beforeEach(() => {
    __resetHiddenNavForTests();
  });

  afterEach(() => {
    __resetHiddenNavForTests();
  });

  it('starts disarmed (false)', () => {
    expect(consumeDeveloperSkip()).toBe(false);
  });

  it('U from a trial-context arms the latch', () => {
    const trialNode = { data: () => ({ phase: 'd_only_main' }) };
    const jsp = {
      timeline: {
        getLatestNode: () => ({
          description: trialNode,
          parent: { description: { timeline: [trialNode] } },
          getDataParameter: () => trialNode.data(),
        }),
      },
      finishTrial: vi.fn(),
    };
    installHiddenNav(jsp);
    dispatchKey('u');
    expect(consumeDeveloperSkip()).toBe(true);
  });

  it('U from a registered checkpoint also arms the latch (so skipping from a feedback screen still terminates the loop)', () => {
    registerHiddenNavStep('practice_feedback', () => ({
      type: 'mock',
      data: { phase: 'practice_feedback' },
    }));
    const { node } = makeTrackedNode('practice_feedback');
    node.type = { info: { name: 'html-keyboard-response' } };
    const jsp = makeStubJsPsych({ node });
    installHiddenNav(jsp);
    dispatchKey('u');
    expect(consumeDeveloperSkip()).toBe(true);
  });

  it('R does NOT arm the latch (R is a "go back", not a "skip forward")', () => {
    registerHiddenNavStep('demographics', () => ({
      type: 'mock',
      data: { phase: 'demographics' },
    }));
    registerHiddenNavStep('screen_calibration', () => ({
      type: 'mock',
      data: { phase: 'screen_calibration' },
    }));
    makeTrackedNode('demographics');
    const { node } = makeTrackedNode('screen_calibration');
    const jsp = makeStubJsPsych({ node });
    installHiddenNav(jsp);
    dispatchKey('r');
    expect(consumeDeveloperSkip()).toBe(false);
  });

  it('consume reads-and-clears: a second consume returns false', () => {
    const trialNode = { data: () => ({ phase: 'd_only_main' }) };
    const jsp = {
      timeline: {
        getLatestNode: () => ({
          description: trialNode,
          parent: { description: { timeline: [trialNode] } },
          getDataParameter: () => trialNode.data(),
        }),
      },
      finishTrial: vi.fn(),
    };
    installHiddenNav(jsp);
    dispatchKey('u');
    expect(consumeDeveloperSkip()).toBe(true);
    expect(consumeDeveloperSkip()).toBe(false);
  });
});

describe('audio mute gate around hidden-nav skip', () => {
  /* These tests pin the contract that the audio mute gate is engaged
   * whenever the experimenter leaves a trial-context screen via U or R,
   * and is dropped again by the on_trial_start hook the moment the next
   * registered checkpoint runs. Without the gate, fire-and-forget async
   * schedulers (e.g. `runEncodingSchedule` in `t_only.js` / `i_t.js`,
   * the demo loops in `instructions/demos.js`) would keep ticking through
   * `await sleep(M_SLOT_MS)` after the trial they belong to has ended
   * and would re-populate the AudioContext scheduler with fresh tones,
   * which the user reported as "tones keep playing when I skip them". */

  beforeEach(() => {
    __resetHiddenNavForTests();
    setAudioMuted(false);
  });

  afterEach(() => {
    __resetHiddenNavForTests();
  });

  it('U from a trial-context engages the audio mute gate', () => {
    const trialNode = { data: () => ({ phase: 'd_only_main' }) };
    const jsp = {
      timeline: {
        getLatestNode: () => ({
          description: trialNode,
          parent: { description: { timeline: [trialNode] } },
          getDataParameter: () => trialNode.data(),
        }),
      },
      finishTrial: vi.fn(),
    };
    installHiddenNav(jsp);
    expect(isAudioMuted()).toBe(false);
    dispatchKey('u');
    expect(isAudioMuted()).toBe(true);
  });

  it('U on a registered checkpoint ALSO engages the gate (demo loops are fire-and-forget too)', () => {
    /* Originally we exempted registered checkpoints from the mute gate
     * on the assumption that no checkpoint had a fire-and-forget audio
     * scheduler. That is wrong: the per-condition demo loops in
     * `instructions/demos.js` are themselves checkpoints AND keep
     * scheduling tones from their fire-and-forget `loopify` chain until
     * `state.cancelled` lands. Always raising the gate gives belt-and-
     * braces silence; the on_trial_start hook drops it again at the next
     * trial start (checkpoint or not), so no normally-running successor
     * trial inherits the silence. */
    registerHiddenNavStep('demo_t_only', () => ({
      type: 'mock',
      data: { phase: 'demo_t_only' },
    }));
    const { node } = makeTrackedNode('demo_t_only');
    node.type = { info: { name: 'html-keyboard-response' } };
    const jsp = makeStubJsPsych({ node });
    installHiddenNav(jsp);
    expect(isAudioMuted()).toBe(false);
    dispatchKey('u');
    expect(isAudioMuted()).toBe(true);
  });

  it('the on_trial_start hook drops the gate on a non-checkpoint when no skip is armed', () => {
    /* Companion to the above: U on a registered demo raises the gate
     * but does NOT arm `skipUntilNextCheckpoint` (we are not skipping
     * through trials). When the next trial — which may be a non-
     * checkpoint practice trial — starts, the gate must drop so the
     * practice trial's own audio is not silenced. */
    registerHiddenNavStep('demo_t_only', () => ({
      type: 'mock',
      data: { phase: 'demo_t_only' },
    }));
    const { node } = makeTrackedNode('demo_t_only');
    node.type = { info: { name: 'html-keyboard-response' } };
    const jsp = makeStubJsPsych({ node });
    installHiddenNav(jsp);
    dispatchKey('u');
    expect(isAudioMuted()).toBe(true);

    const hook = getHiddenNavTrialStartHook();
    const practiceTrial = { trial_duration: 5000 };
    hook(practiceTrial);
    expect(isAudioMuted()).toBe(false);
    /* And nothing was neutralised — the practice trial runs normally. */
    expect(practiceTrial.trial_duration).toBe(5000);
  });

  it('the on_trial_start hook drops the gate when it sees a checkpoint, regardless of the skip token', () => {
    /* Two sub-cases: (1) gate engaged via U (skip token armed) → checkpoint
     * drops both. (2) gate engaged via R (skip token NOT armed) → checkpoint
     * still drops the gate. */
    const trialNode = { data: () => ({ phase: 'd_only_main' }) };
    const jsp = {
      timeline: {
        getLatestNode: () => ({
          description: trialNode,
          parent: { description: { timeline: [trialNode] } },
          getDataParameter: () => trialNode.data(),
        }),
      },
      finishTrial: vi.fn(),
    };
    installHiddenNav(jsp);
    dispatchKey('u');
    expect(isAudioMuted()).toBe(true);

    const hook = getHiddenNavTrialStartHook();
    const checkpoint = { _hidden_nav_checkpoint: true, trial_duration: 5000 };
    hook(checkpoint);
    expect(isAudioMuted()).toBe(false);
    expect(checkpoint.trial_duration).toBe(5000);

    /* Sub-case 2: gate raised manually (as if R from a trial set it). */
    setAudioMuted(true);
    expect(isAudioMuted()).toBe(true);
    const checkpoint2 = { _hidden_nav_checkpoint: true, trial_duration: 1234 };
    hook(checkpoint2);
    expect(isAudioMuted()).toBe(false);
  });

  it('R from a trial-context KEEPS the gate up so any in-flight scheduler is silenced through the splice', () => {
    /* The spliced prev step is itself a checkpoint and will drop the gate
     * when the on_trial_start hook fires; until then, the gate must stay
     * up so a still-running encoding loop can't queue tones into it. */
    const consentNode = {
      type: 'mock-plugin',
      data: { phase: 'consent' },
    };
    registerHiddenNavStep('consent', () => consentNode);
    makeTrackedNode('consent');

    const trialNode = { data: () => ({ phase: 't_only_encoding' }) };
    const parentTimeline = [trialNode];
    const jsp = {
      timeline: {
        getLatestNode: () => ({
          description: trialNode,
          parent: { description: { timeline: parentTimeline } },
          getDataParameter: () => trialNode.data(),
        }),
      },
      finishTrial: vi.fn(),
    };
    installHiddenNav(jsp);
    dispatchKey('r');
    expect(isAudioMuted()).toBe(true);
  });

  it('R from a registered checkpoint clears the gate (defensive — no async loops to suppress)', () => {
    /* Belt-and-braces: a stale `audioMuted=true` left over from any
     * earlier path should not survive an R press from a checkpoint. */
    const prevNode = { type: 'mock-plugin', data: { phase: 'demographics' } };
    const currentNode = { type: 'mock-plugin', data: { phase: 'screen_calibration' } };
    registerHiddenNavStep('demographics', () => prevNode);
    registerHiddenNavStep('screen_calibration', () => currentNode);

    makeTrackedNode('demographics');
    const current = makeTrackedNode('screen_calibration').node;
    const jsp = makeStubJsPsych({ node: current });
    installHiddenNav(jsp);

    setAudioMuted(true);
    dispatchKey('r');
    expect(isAudioMuted()).toBe(false);
  });
});
