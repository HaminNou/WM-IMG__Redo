// @vitest-environment jsdom
/**
 * main_a_intro: Space stays inactive until the voiceover has finished.
 * `gateUntilNarrationEnds` (helper) and the real node wiring, with a fake engine controller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fake } = vi.hoisted(() => ({ fake: { muted: false, controller: null } }));

vi.mock('../src/visuals/voiceover.js', () => ({
  getVoiceover: () => ({ muted: fake.muted, cancel: () => {} }),
}));
vi.mock('../src/visuals/voiceover-slide.js', () => ({
  narrateNowIfPresent: () => fake.controller,
  unmountToggle: () => {},
}));

import { gateUntilNarrationEnds, NARRATION_GATE_MAX_MS } from '../src/visuals/narration-gate.js';
import { mainAIntroNode } from '../src/runner-intros.js';

function makeController(state = {}) {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const st = { finished: false, audioEl: {}, audioLimitMs: 10_000, ...state };
  return {
    _state: st,
    _started: Promise.resolve(),
    done,
    end(how = 'completed', extra = {}) {
      Object.assign(st, { finished: true }, extra);
      resolveDone(how);
    },
  };
}
const tick = () => Promise.resolve().then(() => Promise.resolve());
const space = (opts = {}) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ...opts }));

let errors;
const onErr = (e) => errors.push(e);
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
  });
  fake.muted = false;
  fake.controller = null;
  errors = [];
  window.addEventListener('error', onErr);
});
afterEach(() => {
  window.removeEventListener('error', onErr);
  vi.useRealTimers();
  delete window.jsPsych;
  document.body.innerHTML = '';
});

describe('gateUntilNarrationEnds', () => {
  it('opens on the end of the recording, never before', async () => {
    const c = makeController();
    const onOpen = vi.fn();
    gateUntilNarrationEnds(c, onOpen);
    await tick();
    vi.advanceTimersByTime(5000);
    expect(onOpen).not.toHaveBeenCalled();
    c.end('completed', { audioEnded: true });
    await tick();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0]).toMatchObject({
      gate_reason: 'narration_end',
      narration_finished: true,
      space_enabled_after_ms: 5000,
    });
  });

  it('opens at once (null delay) when the voice is off or there is no controller', () => {
    fake.muted = true;
    const a = vi.fn();
    gateUntilNarrationEnds(makeController(), a);
    expect(a.mock.calls[0][0]).toMatchObject({
      gate_reason: 'voice_off',
      space_enabled_after_ms: null,
    });
    fake.muted = false;
    const b = vi.fn();
    gateUntilNarrationEnds(null, b);
    expect(b.mock.calls[0][0]).toMatchObject({
      gate_reason: 'no_audio',
      space_enabled_after_ms: null,
      narration_finished: false,
    });
  });

  it('opens with voice_off when the participant switches the voice off mid-way', async () => {
    const c = makeController();
    const onOpen = vi.fn();
    gateUntilNarrationEnds(c, onOpen);
    await tick();
    fake.muted = true;
    c.end('skipped');
    await tick();
    expect(onOpen.mock.calls[0][0].gate_reason).toBe('voice_off');
  });

  it('blocked or failed playback (finished without playing) opens as no_audio', async () => {
    const c = makeController();
    const onOpen = vi.fn();
    gateUntilNarrationEnds(c, onOpen);
    await tick();
    c.end('completed');
    await tick();
    expect(onOpen.mock.calls[0][0].gate_reason).toBe('no_audio');
  });

  it('a silent typing-speed reveal (no recording) opens as no_audio', async () => {
    const c = makeController({ audioEl: null });
    const onOpen = vi.fn();
    gateUntilNarrationEnds(c, onOpen);
    await tick();
    expect(onOpen.mock.calls[0][0].gate_reason).toBe('no_audio');
  });

  it('safety timeout: recording limit + 2 s, capped at 2 minutes', async () => {
    const c = makeController({ audioLimitMs: 10_000 });
    const onOpen = vi.fn();
    gateUntilNarrationEnds(c, onOpen);
    await tick();
    vi.advanceTimersByTime(11_900);
    expect(onOpen).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onOpen.mock.calls[0][0]).toMatchObject({ gate_reason: 'timeout' });

    const long = makeController({ audioLimitMs: 10 * 60_000 });
    const o2 = vi.fn();
    gateUntilNarrationEnds(long, o2);
    await tick();
    vi.advanceTimersByTime(NARRATION_GATE_MAX_MS + 10);
    expect(o2.mock.calls[0][0].gate_reason).toBe('timeout');
  });

  it('dispose stops every later callback', async () => {
    const c = makeController();
    const onOpen = vi.fn();
    const g = gateUntilNarrationEnds(c, onOpen);
    g.dispose();
    c.end('completed', { audioEnded: true });
    await tick();
    vi.advanceTimersByTime(NARRATION_GATE_MAX_MS * 2);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('main_a_intro node', () => {
  function mount() {
    const node = mainAIntroNode();
    document.body.innerHTML = node.stimulus;
    const js = {
      finishTrial: vi.fn(),
      pluginAPI: { cancelAllKeyboardResponses: vi.fn() },
      getCurrentTrial: () => ({ data: {} }),
    };
    window.jsPsych = js;
    return { node, js };
  }

  it('uses NO_KEYS and shows the locked line and a dimmed pill while narrating', async () => {
    fake.controller = makeController();
    const { node } = mount();
    expect(node.choices).toBe('NO_KEYS');
    node.on_load();
    const line = document.getElementById('narration-locked-line');
    expect(line.textContent).toContain('Please listen to the instructions');
    expect(line.closest('[data-voiceover-target]')).toBeNull();
    expect(document.querySelector('.continue-hint').style.opacity).toBe('0.35');
    node.on_finish({});
  });

  it('ignores Space while locked; after the end Space finishes once and cleans up', async () => {
    const c = (fake.controller = makeController());
    const { node, js } = mount();
    node.on_load();
    await tick();
    vi.advanceTimersByTime(3000);
    space();
    space();
    expect(js.finishTrial).not.toHaveBeenCalled();
    c.end('completed', { audioEnded: true });
    await tick();
    expect(document.getElementById('narration-locked-line')).toBeNull();
    expect(document.querySelector('.continue-hint').style.opacity).toBe('');
    space({ repeat: true });
    expect(js.finishTrial).not.toHaveBeenCalled();
    space();
    space();
    expect(js.finishTrial).not.toHaveBeenCalled(); /* deferred past the keydown dispatch */
    vi.advanceTimersByTime(1);
    expect(js.finishTrial).toHaveBeenCalledTimes(1);
    expect(js.finishTrial.mock.calls[0][0]).toMatchObject({ response: ' ' });
    expect(js.pluginAPI.cancelAllKeyboardResponses.mock.invocationCallOrder[0]).toBeLessThan(
      js.finishTrial.mock.invocationCallOrder[0]
    );
    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({
      gate_reason: 'narration_end',
      narration_finished: true,
      space_enabled_after_ms: 3000,
    });
    space();
    expect(js.finishTrial).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it('voice off: Space works at once and the row says so', () => {
    fake.muted = true;
    fake.controller = makeController();
    const { node, js } = mount();
    node.on_load();
    expect(document.getElementById('narration-locked-line')).toBeNull();
    space();
    vi.advanceTimersByTime(1);
    expect(js.finishTrial).toHaveBeenCalledTimes(1);
    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({
      gate_reason: 'voice_off',
      narration_finished: false,
      space_enabled_after_ms: null,
    });
  });

  it('timeout fallback opens the gate', async () => {
    fake.controller = makeController({ audioLimitMs: 5000 });
    const { node, js } = mount();
    node.on_load();
    await tick();
    vi.advanceTimersByTime(7100);
    space();
    vi.advanceTimersByTime(1);
    expect(js.finishTrial).toHaveBeenCalledTimes(1);
    const data = {};
    node.on_finish(data);
    expect(data.gate_reason).toBe('timeout');
    expect(data.space_enabled_after_ms).toBe(7000);
  });

  it('an external exit (U/R, N N) while locked removes the listener and timers, no error', async () => {
    const c = (fake.controller = makeController());
    const { node, js } = mount();
    node.on_load();
    await tick();
    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({ gate_reason: 'locked_exit', narration_finished: false });
    c.end('cancelled');
    await tick();
    vi.advanceTimersByTime(NARRATION_GATE_MAX_MS * 2);
    space();
    expect(js.finishTrial).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });
});
