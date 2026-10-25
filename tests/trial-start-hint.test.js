/**
 * @vitest-environment jsdom
 *
 * Verifies the "Press both arrow keys to start the trial." hint that
 * trialStartGateNode mounts at the bottom of the viewport. Rendered as a
 * high-contrast pill (black text on a white rectangle with a thin black
 * border) so the cue stays legible across the dark UI surface and
 * any light-trial page background.
 *
 * Test scope:
 *   - on_load injects exactly one .trial-start-hint node into <body>
 *   - the node is positioned fixed at the bottom, black-on-white pill, 18px
 *   - on_finish (timeout / unmount path) removes any stale hint nodes
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  trialStartGateNode,
  POST_GATE_DELAY_MS,
  HINT_FLASH_AFTER_MS,
  HINT_FLASH_PERIOD_MS,
  TRIAL_TYPE_LABELS,
} from '../src/conditions/shared.js';

beforeEach(() => {
  document.body.innerHTML = '';
  /* The gate's stimulus mount needs to exist in the DOM before on_load runs;
   * jsPsych normally writes the stimulus into .jspsych-content. The trial
   * object must persist across on_load → on_finish so the gate-pass probe
   * closure stashed in on_load is readable in on_finish. */
  const liveTrial = {};
  Object.defineProperty(window, 'jsPsych', {
    value: {
      getCurrentTrial: () => liveTrial,
      finishTrial: () => {},
    },
    configurable: true,
    writable: true,
  });
});

function mountGateStimulus(node) {
  /* Recreate jsPsych's stimulus injection by extracting the mount id from
   * the stimulus HTML and creating that container. */
  const m = node.stimulus.match(/id="([^"]+)"/);
  expect(m).toBeTruthy();
  const div = document.createElement('div');
  div.id = m[1];
  document.body.appendChild(div);
}

describe('trialStartGateNode end-of-trial hint overlay', () => {
  it('on_load injects a .trial-start-hint element into <body>', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      showArrow: false,
      phase: 'd_only_trial_start',
    });
    mountGateStimulus(node);
    node.on_load();
    const hints = document.querySelectorAll('.trial-start-hint');
    expect(hints.length).toBe(1);
  });

  it('hint text matches the participant-facing copy', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      showArrow: false,
      phase: 'd_only_trial_start',
    });
    mountGateStimulus(node);
    node.on_load();
    const hint = document.querySelector('.trial-start-hint');
    expect(hint?.textContent).toMatch(/left and right arrow keys at the same time/i);
  });

  it('hint is positioned fixed at the bottom as a black-on-white pill', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      showArrow: false,
      phase: 'd_only_trial_start',
    });
    mountGateStimulus(node);
    node.on_load();
    const hint = document.querySelector('.trial-start-hint');
    /* jsdom does not run getComputedStyle full layout, but it does parse the
     * inline `style` attribute. Inspect it as a string. */
    const style = (hint?.getAttribute('style') ?? '').toLowerCase();
    expect(style).toContain('position: fixed');
    expect(style).toContain('bottom: 30px');
    expect(style).toContain('font-size: 18px');
    /* Pill treatment: white background, black text, thin
     * black border, and `white-space: nowrap` so the rectangle hugs
     * the one-line sentence. */
    expect(style).toContain('background: #ffffff');
    expect(style).toContain('color: #000000');
    expect(style).toContain('border: 1.5px solid #000000');
    expect(style).toContain('border-radius');
    expect(style).toContain('white-space: nowrap');
  });

  it('on_finish removes any stale hint elements (timeout-path failsafe)', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      showArrow: false,
      phase: 'd_only_trial_start',
    });
    mountGateStimulus(node);
    node.on_load();
    expect(document.querySelectorAll('.trial-start-hint').length).toBe(1);
    node.on_finish();
    expect(document.querySelectorAll('.trial-start-hint').length).toBe(0);
  });

  it('hint does not survive across two consecutive gate mounts', () => {
    const node1 = trialStartGateNode({ trial_index_in_block: 0, phase: 'd_only_trial_start' });
    mountGateStimulus(node1);
    node1.on_load();
    node1.on_finish();
    expect(document.querySelectorAll('.trial-start-hint').length).toBe(0);

    const node2 = trialStartGateNode({ trial_index_in_block: 1, phase: 'd_only_trial_start' });
    mountGateStimulus(node2);
    node2.on_load();
    expect(document.querySelectorAll('.trial-start-hint').length).toBe(1);
  });

  it('mounts the dim trial counter when data.main_trial_number_overall is set', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'd_only_trial_start',
      data: { main_trial_number_overall: 17, main_trial_total: 120 },
    });
    mountGateStimulus(node);
    node.on_load();
    const counter = document.getElementById('overall-trial-counter');
    expect(counter).not.toBeNull();
    expect(counter.textContent).toBe('Trial 17 / 120');
  });

  it('mounts a .trial-type-label when trialType is provided', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'i_d_trial_start',
      trialType: 'i_d',
    });
    mountGateStimulus(node);
    node.on_load();
    const labels = document.querySelectorAll('.trial-type-label');
    expect(labels.length).toBe(1);
    expect(labels[0].textContent).toBe('Stars + Dots');
  });

  it('trial-type label is a frosted-glass pill positioned 1 inch above the circle', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'd_only_trial_start',
      trialType: 'd_only',
    });
    mountGateStimulus(node);
    node.on_load();
    const label = document.querySelector('.trial-type-label');
    const style = (label?.getAttribute('style') ?? '').toLowerCase();
    expect(style).toContain('position: fixed');
    expect(style).toMatch(/top:\s*-?\d/);
    expect(style).toContain('translatey(-100%)');
    expect(style).toContain('border-radius: 999px');
    expect(style).toContain('backdrop-filter');
    expect(label?.textContent).toBe('Dots');
  });

  it('trial-type label contains a coloured indicator dot', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 't_only_trial_start',
      trialType: 't_only',
    });
    mountGateStimulus(node);
    node.on_load();
    const label = document.querySelector('.trial-type-label');
    const dot = label?.querySelector('span');
    const dotStyle = (dot?.getAttribute('style') ?? '').toLowerCase();
    expect(dotStyle).toContain('border-radius: 50%');
    expect(dotStyle).toContain('background:');
  });

  it('does NOT mount a trial-type label when trialType is omitted', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'd_only_trial_start',
    });
    mountGateStimulus(node);
    node.on_load();
    expect(document.querySelectorAll('.trial-type-label').length).toBe(0);
  });

  it('on_finish removes stale trial-type labels', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'i_only_trial_start',
      trialType: 'i_only',
    });
    mountGateStimulus(node);
    node.on_load();
    expect(document.querySelectorAll('.trial-type-label').length).toBe(1);
    node.on_finish();
    expect(document.querySelectorAll('.trial-type-label').length).toBe(0);
  });

  it('trial-type label does not persist across consecutive gates', () => {
    const node1 = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'i_t_trial_start',
      trialType: 'i_t',
    });
    mountGateStimulus(node1);
    node1.on_load();
    node1.on_finish();
    expect(document.querySelectorAll('.trial-type-label').length).toBe(0);

    const node2 = trialStartGateNode({
      trial_index_in_block: 1,
      phase: 'd_only_trial_start',
      trialType: 'd_only',
    });
    mountGateStimulus(node2);
    node2.on_load();
    const labels = document.querySelectorAll('.trial-type-label');
    expect(labels.length).toBe(1);
    expect(labels[0].textContent).toBe('Dots');
  });

  it('TRIAL_TYPE_LABELS covers all five conditions', () => {
    expect(Object.keys(TRIAL_TYPE_LABELS).sort()).toEqual([
      'd_only',
      'i_d',
      'i_only',
      'i_t',
      't_only',
    ]);
  });

  it('stamps gate_trial_type on the data row', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'i_d_trial_start',
      trialType: 'i_d',
    });
    expect(node.data.gate_trial_type).toBe('i_d');
  });

  it('gate_trial_type is null when trialType is omitted', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'd_only_trial_start',
    });
    expect(node.data.gate_trial_type).toBeNull();
  });

  it('does NOT mount the trial counter when main-trial fields are absent (e.g. practice gate)', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'd_only_trial_start',
    });
    mountGateStimulus(node);
    node.on_load();
    expect(document.getElementById('overall-trial-counter')).toBeNull();
  });

  it('uses zero post-gate delay by default', () => {
    expect(POST_GATE_DELAY_MS).toBe(0);
  });
});

describe('trialStartGateNode page-background flip on load', () => {
  /* The gate page now paints in the SAME
   * shade as the upcoming trial body so the participant never sees a
   * dark→light seam between the "Press both arrow keys" cue and the
   * first frame of the trial. The flip is driven by
   * `setTrialPageBackground(background_shade)` in the gate's on_load;
   * when no shade is provided (future non-trial uses of this node) the
   * `clearTrialPageBackground()` path is used. */
  afterEach(() => {
    document.documentElement.removeAttribute('data-trial-bg');
    document.documentElement.style.backgroundColor = '';
    if (document.body) document.body.style.backgroundColor = '';
  });

  it('paints the page in the upcoming trial shade when background_shade=white', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'd_only_trial_start',
      background_shade: 'white',
    });
    mountGateStimulus(node);
    node.on_load();
    expect(document.documentElement.dataset.trialBg).toBe('white');
    expect(document.documentElement.style.backgroundColor.toLowerCase()).toContain('255');
  });

  it('paints the page in the upcoming trial shade when background_shade=gray', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'i_only_trial_start',
      background_shade: 'gray',
    });
    mountGateStimulus(node);
    node.on_load();
    expect(document.documentElement.dataset.trialBg).toBe('gray');
    expect(document.documentElement.style.backgroundColor.toLowerCase()).toContain('211');
  });

  it('reverts to the dark UI surface when background_shade is omitted (no shade)', () => {
    /* Simulate a lingering trial-bg from a previous trial. */
    document.documentElement.dataset.trialBg = 'gray';
    document.documentElement.style.backgroundColor = '#d3d3d3';
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'd_only_trial_start',
    });
    mountGateStimulus(node);
    node.on_load();
    expect(document.documentElement.dataset.trialBg).toBeUndefined();
    expect(document.documentElement.style.backgroundColor).toBe('');
  });

  it('reverts to the dark UI surface when background_shade is an invalid string', () => {
    document.documentElement.dataset.trialBg = 'white';
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'd_only_trial_start',
      background_shade: 'GREY',
    });
    mountGateStimulus(node);
    node.on_load();
    expect(document.documentElement.dataset.trialBg).toBeUndefined();
  });
});

describe('trialStartGateNode no-auto-pass + flash-after-10s', () => {
  /* The gate has no `trial_duration` cap: it
   * waits indefinitely for the both-arrow-keys combo. After 10 s of
   * inactivity the hint message starts opacity-toggling on a 500 ms period
   * to prompt a wandering participant. There is intentionally no
   * `gate_timed_out` path any more — every trial begins only when the
   * participant has explicitly armed it. */

  it('exports the 10 s flash-after threshold and the 500 ms toggle period', () => {
    expect(HINT_FLASH_AFTER_MS).toBe(10_000);
    expect(HINT_FLASH_PERIOD_MS).toBe(500);
  });

  it('trial_duration is null on every gate (no auto-pass)', () => {
    for (const phase of [
      'd_only_trial_start',
      't_only_trial_start',
      'i_only_trial_start',
      'i_d_trial_start',
      'i_t_trial_start',
    ]) {
      const node = trialStartGateNode({ trial_index_in_block: 0, phase });
      expect(node.trial_duration).toBeNull();
    }
  });

  it('does not stamp gate-timeout fields onto the data row', () => {
    const node = trialStartGateNode({
      trial_index_in_block: 0,
      phase: 'i_only_trial_start',
    });
    expect(node.data).not.toHaveProperty('gate_max_ms');
    expect(node.data).not.toHaveProperty('gate_timed_out');
  });

  describe('hint flashes after 10 s of inactivity', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('hint opacity stays steady before HINT_FLASH_AFTER_MS', () => {
      const node = trialStartGateNode({
        trial_index_in_block: 0,
        phase: 'd_only_trial_start',
      });
      mountGateStimulus(node);
      node.on_load();
      const hint = document.querySelector('.trial-start-hint');
      const initialOpacity = hint?.style.opacity;
      vi.advanceTimersByTime(HINT_FLASH_AFTER_MS - 100);
      expect(hint?.style.opacity).toBe(initialOpacity);
    });

    it('hint begins toggling opacity after HINT_FLASH_AFTER_MS', () => {
      const node = trialStartGateNode({
        trial_index_in_block: 0,
        phase: 'd_only_trial_start',
      });
      mountGateStimulus(node);
      node.on_load();
      const hint = document.querySelector('.trial-start-hint');
      const baseline = hint?.style.opacity;
      /* Advance past the 10 s arming threshold + one toggle period; the
       * setInterval callback should have fired at least once and changed
       * opacity. */
      vi.advanceTimersByTime(HINT_FLASH_AFTER_MS + HINT_FLASH_PERIOD_MS + 10);
      expect(hint?.style.opacity).not.toBe(baseline);
      /* And again after another period — should toggle back. */
      const afterFirstToggle = hint?.style.opacity;
      vi.advanceTimersByTime(HINT_FLASH_PERIOD_MS);
      expect(hint?.style.opacity).not.toBe(afterFirstToggle);
    });
  });
});
