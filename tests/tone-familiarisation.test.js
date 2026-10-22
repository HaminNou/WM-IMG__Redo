// @vitest-environment jsdom

/**
 * Combined tone audibility + comfort calibration tests.
 *
 * Layout under test:
 *   - 24 numbered boxes in a CSS grid, no Hz labels.
 *   - In-page volume slider (0..100, default 50) below the boxes.
 *   - Each tone is scheduled via `playToneByIndex(i, { when })` so the
 *     bank's per-tone 70-phon equal-loudness gain is applied byte-
 *     identically to the trial-time playback path.
 *   - Each box gets a `.playing` class while its tone is sounding.
 *   - The slider's `input` event drives `setUserPlaybackGain` so
 *     subsequent tones reflect the new level.
 *   - Pressing "I'm comfortable — continue" sets `tones_audible: true`
 *     in `on_finish`; cycling 10 sweeps without a press sets
 *     `tones_audible: false` and synthesises a click to advance the
 *     timeline (which falls through to `toneAudibilityExit`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let elapsedMs = 0;

const { playToneByIndex, getToneBank, registerHiddenNavStep, setUserPlaybackGain } = vi.hoisted(
  () => ({
    playToneByIndex: vi.fn(() => Promise.resolve()),
    getToneBank: vi.fn(() => [
      { index: 0, freq_hz: 220, gain_compensation_db: 5.5 },
      { index: 1, freq_hz: 440, gain_compensation_db: 2.1 },
      { index: 2, freq_hz: 880, gain_compensation_db: -0.4 },
    ]),
    registerHiddenNavStep: vi.fn(),
    setUserPlaybackGain: vi.fn(),
  })
);

vi.mock('../src/audio/tones.js', () => ({
  playToneByIndex,
  getToneBank,
}));

vi.mock('../src/audio/context.js', () => ({
  getAudioContext: () => ({
    get currentTime() {
      return elapsedMs / 1000;
    },
  }),
}));

vi.mock('../src/audio/dsp.js', () => ({
  setUserPlaybackGain,
  stopAllScheduledAudio: vi.fn(),
}));

vi.mock('../src/hidden-nav.js', () => ({
  registerHiddenNavStep,
  trackHiddenNavNode: (node) => node,
}));

/* Voiceover engine — the production trial gates its tone sweep behind
 * narration completion (`await narrationDone`), so the test needs a stub
 * that returns an already-resolved controller. We also stub the slide
 * helpers since the test does not exercise the toggle pill or spacebar
 * binding. */
vi.mock('../src/visuals/voiceover.js', () => ({
  getVoiceover: () => ({
    current: null,
    muted: true,
    narrateInPlace: () => ({
      done: Promise.resolve('completed'),
      skip: () => {},
      cancel: () => {},
      _state: { finished: true },
    }),
  }),
}));

vi.mock('../src/visuals/voiceover-slide.js', () => ({
  ensureToggleMounted: vi.fn(),
  bindSkipOnSpace: vi.fn(() => () => {}),
}));

import { toneAudibilityAndComfortTrial } from '../src/calibration/tone-familiarisation.js';

/* Mount the combined trial node into jsdom — both the stimulus and the
 * Yes button so DOM lookups by id resolve as they would under jsPsych. */
function mountTrial(node) {
  document.body.innerHTML = `${node.stimulus}\n${node.button_html("I'm comfortable — continue")}`;
}

describe('tone audibility + comfort layout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    elapsedMs = 0;
    playToneByIndex.mockClear();
    getToneBank.mockClear();
    setUserPlaybackGain.mockClear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders one numbered box per tone and a 0..100 slider with default 50', () => {
    const node = toneAudibilityAndComfortTrial();
    mountTrial(node);
    /* The page is configured for the locked 24-tone bank, so the box grid
     * is rendered to that count regardless of what the mock returns. */
    const boxes = document.querySelectorAll('.tac-box');
    expect(boxes.length).toBe(24);
    /* Box content is the 1-indexed tone number — no Hz, no frequency. */
    expect(boxes[0].textContent.trim()).toBe('1');
    expect(boxes[23].textContent.trim()).toBe('24');
    expect(/\bhz\b/i.test(boxes[0].textContent)).toBe(false);

    const slider = document.getElementById('tac-slider');
    expect(slider).not.toBeNull();
    expect(slider.getAttribute('min')).toBe('0');
    expect(slider.getAttribute('max')).toBe('100');
    expect(slider.value).toBe('50');
  });

  it('exposes a Yes button (no force-end button visible)', () => {
    const node = toneAudibilityAndComfortTrial();
    mountTrial(node);
    const btn = document.getElementById('tac-yes-btn');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toMatch(/comfortable/i);
  });
});

describe('tone audibility + comfort sweep behaviour', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    elapsedMs = 0;
    playToneByIndex.mockClear();
    getToneBank.mockClear();
    setUserPlaybackGain.mockClear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules tones via playToneByIndex (so bank gain compensation applies) and highlights the playing box', async () => {
    /* Mocked 3-tone bank: tone duration 350 ms + inter-tone silence
     * 200 ms ⇒ 550 ms per slot; 50 ms audio lead-in. */
    const node = toneAudibilityAndComfortTrial();
    mountTrial(node);
    const loadPromise = node.on_load();

    /* Drain the narration `await` so `on_load` reaches the sweep prelude
     * (`ctx.currentTime + lead_in`) while the audio clock is still at 0.
     * Without this, the post-narration resume reads currentTime AFTER
     * `elapsedMs` is bumped, shifting `cursorSec` by the bump amount. */
    await vi.advanceTimersByTimeAsync(0);

    /* Advance the audio clock to just after the first tone's onset. */
    elapsedMs = 60;
    await vi.advanceTimersByTimeAsync(60);
    expect(playToneByIndex).toHaveBeenCalled();
    const firstCall = playToneByIndex.mock.calls[0];
    expect(firstCall[0]).toBe(0);
    expect(firstCall[1].when).toBeCloseTo(0.05, 8);
    expect(document.getElementById('tac-box-0').classList.contains('playing')).toBe(true);

    /* Pressing Yes mid-sweep aborts the loop. The runtime's listener
     * gates `userPressedYes` on `!timedOut`, so any click that arrives
     * before the 10-sweep cap counts as a participant press —
     * regardless of `isTrusted`. */
    const btn = document.getElementById('tac-yes-btn');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    /* Drain any pending waiters then resolve. */
    elapsedMs = 1_000_000;
    await vi.advanceTimersByTimeAsync(2000);
    await loadPromise;

    /* Yes-press path: closure is sealed via on_finish in the real
     * runtime; we simulate that by invoking on_finish with a fresh
     * data object. */
    const data = {};
    node.on_finish(data);
    expect(data.tones_audible).toBe(true);
    expect(data.user_playback_pct).toBe(50);
    expect(data.user_playback_gain).toBeCloseTo(0.5);
    expect(data.sweeps_completed).toBeGreaterThanOrEqual(1);
  });

  it('slider input drives setUserPlaybackGain in real time (linear 0..100 → 0..1)', async () => {
    const node = toneAudibilityAndComfortTrial();
    mountTrial(node);
    /* Kick off on_load so the slider listener is wired. We don't need
     * the loop to make progress for this assertion. */
    const loadPromise = node.on_load();

    setUserPlaybackGain.mockClear();
    const slider = document.getElementById('tac-slider');
    slider.value = '75';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(setUserPlaybackGain).toHaveBeenLastCalledWith(0.75);
    expect(document.getElementById('tac-slider-readout').textContent).toBe('75%');

    slider.value = '0';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(setUserPlaybackGain).toHaveBeenLastCalledWith(0);

    /* Tear down the loop so it doesn't dangle into the next test. */
    const btn = document.getElementById('tac-yes-btn');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    elapsedMs = 1_000_000;
    await vi.advanceTimersByTimeAsync(2000);
    await loadPromise;
  });

  it('captures the Yes press BEFORE htmlButtonResponse fires its bubble-phase finishTrial', async () => {
    /* Regression: htmlButtonResponse registers its own
     * click listener on the Yes button during plugin setup (i.e. before
     * `on_load` runs), and that listener synchronously calls
     * `finishTrial`, which synchronously runs `on_finish` — meaning
     * any bubble-phase user listener registered later loses the race
     * and `userPressedYes` reads false. Our listener uses
     * `{ capture: true }` so it fires BEFORE any bubble-phase listener
     * regardless of registration order. */
    const node = toneAudibilityAndComfortTrial();
    mountTrial(node);

    /* Simulate htmlButtonResponse's listener: registered FIRST (before
     * on_load), bubble-phase, and synchronously runs on_finish on
     * click — exactly mirroring the plugin's after_response → end_trial
     * → finishTrial path. */
    const btn = document.getElementById('tac-yes-btn');
    const observed = {};
    btn.addEventListener('click', () => {
      node.on_finish(observed);
    });

    const loadPromise = node.on_load();
    /* User clicks Yes. */
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    /* on_finish must have observed userPressedYes === true even though
     * our listener was registered AFTER the simulated plugin listener.
     * This only holds if our listener runs in capture phase. */
    expect(observed.tones_audible).toBe(true);

    /* Drain. */
    elapsedMs = 1_000_000;
    await vi.advanceTimersByTimeAsync(2000);
    await loadPromise;
  });

  it('on_load applies the default slider gain (0.5) at mount before any tone plays', async () => {
    const node = toneAudibilityAndComfortTrial();
    mountTrial(node);
    setUserPlaybackGain.mockClear();
    const loadPromise = node.on_load();
    /* Default slider is 50 % → expect a 0.5 push to the audio module
     * before any sweep work has progressed. */
    expect(setUserPlaybackGain).toHaveBeenCalledWith(0.5);

    /* Tear down. */
    const btn = document.getElementById('tac-yes-btn');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    elapsedMs = 1_000_000;
    await vi.advanceTimersByTimeAsync(2000);
    await loadPromise;
  });
});

describe('tone audibility + comfort Yes button and slider record', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    elapsedMs = 0;
    playToneByIndex.mockClear();
    getToneBank.mockClear();
    setUserPlaybackGain.mockClear();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the Yes button disabled until one full sweep has played', async () => {
    const node = toneAudibilityAndComfortTrial();
    mountTrial(node);
    const btn = document.getElementById('tac-yes-btn');
    expect(btn.disabled).toBe(true);

    const loadPromise = node.on_load();
    await vi.advanceTimersByTimeAsync(0);
    /* Mid-sweep: first tone sounding, sweep not finished. */
    elapsedMs = 60;
    await vi.advanceTimersByTimeAsync(60);
    expect(btn.disabled).toBe(true);

    /* Past the end of the first sweep (3 mocked tones at 550 ms each). */
    elapsedMs = 2000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(btn.disabled).toBe(false);

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    elapsedMs = 1_000_000;
    await vi.advanceTimersByTimeAsync(2000);
    await loadPromise;
  });

  it('records how the participant used the slider', async () => {
    const node = toneAudibilityAndComfortTrial();
    mountTrial(node);
    const loadPromise = node.on_load();
    await vi.advanceTimersByTimeAsync(0);

    const slider = document.getElementById('tac-slider');
    for (const v of ['30', '80', '40']) {
      slider.value = v;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document
      .getElementById('tac-yes-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    elapsedMs = 1_000_000;
    await vi.advanceTimersByTimeAsync(2000);
    await loadPromise;

    const data = {};
    node.on_finish(data);
    expect(data.n_slider_inputs).toBe(3);
    expect(data.slider_min_pct).toBe(30);
    expect(data.slider_max_pct).toBe(80);
    expect(data.user_playback_pct).toBe(40);
    expect(data.t_first_slider_input_ms).not.toBeNull();
    expect(data.applied_peak_dbfs).toBeCloseTo(20 * Math.log10(0.25 * 0.4), 8);
  });
});
