/**
 * @vitest-environment jsdom
 *
 * Tests for the dim "Trial X / 120" top-left overlay (`trial-counter.js`)
 * and the main-blocks stamping that drives it.
 *
 * Test scope:
 *   - `setTrialCounter` mounts a single overlay element with the right
 *     style + text, and updates rather than duplicating on subsequent calls.
 *   - `unmountTrialCounter` removes the overlay and is idempotent.
 *   - `generateMainBlockPair` stamps `main_trial_number_overall` 1..120 and
 *     `main_trial_total = 120` onto every gate node across Main A + Main B,
 *     in the exact order the gates appear in the assembled timeline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setTrialCounter,
  unmountTrialCounter,
  TRIAL_TYPE_TAG_COLOURS,
} from '../src/conditions/trial-counter.js';
import { generateMainBlockPair } from '../src/scheduler/main-blocks.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { setSessionPRNG } from '../src/prng.js';

const COUNTER_ID = 'overall-trial-counter';

beforeEach(() => {
  document.body.innerHTML = '';
  setSessionPRNG('trial-counter-test-seed');
  resetSequencePools();
});

describe('trial-counter overlay primitives', () => {
  it('setTrialCounter mounts exactly one overlay carrying the expected trial number text', () => {
    setTrialCounter(7, 120, 'd_only');
    const els = document.querySelectorAll(`#${COUNTER_ID}`);
    expect(els.length).toBe(1);
    expect(els[0].textContent).toContain('Trial 7 / 120');
  });

  it('overlay sits fixed at top-left in dim small text', () => {
    setTrialCounter(1, 120, 'd_only');
    const el = document.getElementById(COUNTER_ID);
    const style = (el?.getAttribute('style') ?? '').toLowerCase();
    expect(style).toContain('position: fixed');
    expect(style).toContain('top: 12px');
    expect(style).toContain('left: 16px');
    expect(style).toContain('font-size: 13px');
    /* Dim white — alpha bumped slightly (0.4 → 0.6) when the colour tag
     * was added so the small tag sits readably against the dark task
     * background; the text is still well below full-contrast. */
    expect(style).toMatch(/color:\s*rgba\(255,\s*255,\s*255,\s*0\.6\)/);
  });

  it('repeated setTrialCounter calls update the same node, not duplicate it', () => {
    setTrialCounter(1, 120, 'd_only');
    setTrialCounter(2, 120, 't_only');
    setTrialCounter(60, 120, 'i_t');
    const els = document.querySelectorAll(`#${COUNTER_ID}`);
    expect(els.length).toBe(1);
    expect(els[0].textContent).toContain('Trial 60 / 120');
  });

  it('renders a colour tag for the trial type using a colourblind-safe palette', () => {
    /* All five trial-type colours come from the Okabe–Ito palette and must
     * be visually distinguishable from each other AND from the dark task
     * background. */
    const types = Object.keys(TRIAL_TYPE_TAG_COLOURS);
    expect(types).toEqual(expect.arrayContaining(['d_only', 't_only', 'i_only', 'i_d', 'i_t']));
    /* All five colours unique. */
    const values = Object.values(TRIAL_TYPE_TAG_COLOURS);
    expect(new Set(values).size).toBe(5);

    setTrialCounter(3, 120, 'i_d');
    const tag = document.querySelector('#overall-trial-counter-tag');
    expect(tag).not.toBeNull();
    const tagStyle = (tag.getAttribute('style') ?? '').toLowerCase();
    expect(tagStyle).toContain(TRIAL_TYPE_TAG_COLOURS.i_d.toLowerCase());
  });

  it('hides the colour tag when no trial type is supplied', () => {
    setTrialCounter(5, 120);
    const tag = document.querySelector('#overall-trial-counter-tag');
    expect(tag).not.toBeNull();
    expect(tag.style.display).toBe('none');
  });

  it('unmountTrialCounter removes the overlay and is safe to call twice', () => {
    setTrialCounter(5, 120);
    expect(document.getElementById(COUNTER_ID)).not.toBeNull();
    unmountTrialCounter();
    expect(document.getElementById(COUNTER_ID)).toBeNull();
    /* Idempotent — no throw on a second call when nothing is mounted. */
    expect(() => unmountTrialCounter()).not.toThrow();
  });
});

describe('main-blocks gate-node stamping', () => {
  it('every gate in mainA + mainB carries main_trial_number_overall 1..120 and main_trial_total 120', () => {
    const pair = generateMainBlockPair();
    const allNodes = [...pair.mainA.nodes, ...pair.mainB.nodes];
    const gateData = allNodes
      .map((n) => n?.data)
      .filter((d) => d?.phase && /_trial_start$/.test(d.phase));

    expect(gateData.length).toBe(120);

    const numbers = gateData.map((d) => d.main_trial_number_overall);
    expect(numbers).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));

    for (const d of gateData) {
      expect(d.main_trial_total).toBe(120);
    }
  });

  it('mainA gates carry 1..60 and mainB gates carry 61..120 (block boundaries)', () => {
    const pair = generateMainBlockPair();
    const aNumbers = pair.mainA.nodes
      .filter((n) => n?.data?.phase && /_trial_start$/.test(n.data.phase))
      .map((n) => n.data.main_trial_number_overall);
    const bNumbers = pair.mainB.nodes
      .filter((n) => n?.data?.phase && /_trial_start$/.test(n.data.phase))
      .map((n) => n.data.main_trial_number_overall);

    expect(aNumbers).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(bNumbers).toEqual(Array.from({ length: 60 }, (_, i) => i + 61));
  });

  it('every gate also carries main_trial_type derived from its phase prefix', () => {
    const pair = generateMainBlockPair();
    const allNodes = [...pair.mainA.nodes, ...pair.mainB.nodes];
    const gates = allNodes.filter((n) => n?.data?.phase && /_trial_start$/.test(n.data.phase));
    const validTypes = new Set(['d_only', 't_only', 'i_only', 'i_d', 'i_t']);
    for (const g of gates) {
      const expected = g.data.phase.replace(/_trial_start$/, '');
      expect(g.data.main_trial_type).toBe(expected);
      expect(validTypes.has(g.data.main_trial_type)).toBe(true);
    }
  });

  it('non-gate nodes (encoding, retention, probe, ITI, pattern-phase) are NOT stamped', () => {
    const pair = generateMainBlockPair();
    const nonGate = pair.mainA.nodes.filter(
      (n) => !(n?.data?.phase && /_trial_start$/.test(n.data.phase))
    );
    expect(nonGate.length).toBeGreaterThan(0);
    for (const node of nonGate) {
      expect(node?.data?.main_trial_number_overall).toBeUndefined();
      expect(node?.data?.main_trial_total).toBeUndefined();
    }
  });
});
