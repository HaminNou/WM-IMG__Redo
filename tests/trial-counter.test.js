/**
 * @vitest-environment jsdom
 *
 * Tests for the small gray "X/120" top-left overlay (`trial-counter.js`)
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
  COUNTER_COLOUR,
} from '../src/conditions/trial-counter.js';
import { generateMainBlockPair } from '../src/scheduler/main-blocks.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { setSessionPRNG } from '../src/prng.js';

const COUNTER_ID = 'overall-trial-counter';

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  setSessionPRNG('trial-counter-test-seed');
  resetSequencePools();
});

describe('trial-counter overlay primitives', () => {
  it('setTrialCounter mounts exactly one overlay that reads "7/120"', () => {
    setTrialCounter(7, 120);
    const els = document.querySelectorAll(`#${COUNTER_ID}`);
    expect(els.length).toBe(1);
    expect(els[0].textContent).toBe('7/120');
  });

  it('overlay sits fixed at the top-left in small text, with no coloured square', () => {
    setTrialCounter(1, 120);
    const el = document.getElementById(COUNTER_ID);
    const style = (el?.getAttribute('style') ?? '').toLowerCase();
    expect(style).toContain('position: fixed');
    expect(style).toContain('top: 12px');
    expect(style).toContain('left: 16px');
    expect(style).toContain('font-size: 13px');
    expect(style).toContain('pointer-events: none');
    expect(el.children.length).toBe(0);
    expect(document.querySelector('#overall-trial-counter-tag')).toBeNull();
  });

  it('is one neutral gray, set inline, and readable on the white and light-gray pages', () => {
    setTrialCounter(1, 120);
    const style = document.getElementById(COUNTER_ID).getAttribute('style') ?? '';
    expect(style).toContain(`color: ${COUNTER_COLOUR}`);
    expect(COUNTER_COLOUR).toMatch(/^#([0-9a-f]{2})\1\1$/i);
    const lum = (hex) => {
      const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2]);
    };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    /* White trial page, light-gray trial page and the light-gray rest / block screens. */
    expect(ratio(COUNTER_COLOUR, '#ffffff')).toBeGreaterThan(4.5);
    expect(ratio(COUNTER_COLOUR, '#d3d3d3')).toBeGreaterThan(4.5);
  });

  it('repeated setTrialCounter calls update the same node, not duplicate it', () => {
    setTrialCounter(1, 120);
    setTrialCounter(2, 120);
    setTrialCounter(60, 120);
    setTrialCounter(61, 120);
    setTrialCounter(120, 120);
    const els = document.querySelectorAll(`#${COUNTER_ID}`);
    expect(els.length).toBe(1);
    expect(els[0].textContent).toBe('120/120');
  });

  it('the trial-type colour table is still exported for the tag pills (five unique colours)', () => {
    expect(Object.keys(TRIAL_TYPE_TAG_COLOURS)).toEqual(
      expect.arrayContaining(['d_only', 't_only', 'i_only', 'i_d', 'i_t'])
    );
    expect(new Set(Object.values(TRIAL_TYPE_TAG_COLOURS)).size).toBe(5);
  });

  it('unmountTrialCounter removes the overlay and is safe to call twice', () => {
    setTrialCounter(5, 120);
    expect(document.getElementById(COUNTER_ID)).not.toBeNull();
    unmountTrialCounter();
    expect(document.getElementById(COUNTER_ID)).toBeNull();
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

describe('the counter mounts from the LIVE trial data (regression: main-blocks replaces node.data)', () => {
  it('a real stamped main gate shows N/120 when jsPsych runs it', async () => {
    const { trialStartGateNode } = await import('../src/conditions/shared.js');
    /* The factory is called WITHOUT the number; the stamping later replaces node.data. */
    const gate = trialStartGateNode({ trial_index_in_block: 0, phase: 'd_only_trial_start' });
    expect(gate.data.main_trial_number_overall).toBeUndefined();
    gate.data = { ...gate.data, main_trial_number_overall: 42, main_trial_total: 120 };
    const div = document.createElement('div');
    div.id = gate.stimulus.match(/id="([^"]+)"/)[1];
    document.body.appendChild(div);
    Object.defineProperty(window, 'jsPsych', {
      value: { getCurrentTrial: () => gate, finishTrial: () => {} },
      configurable: true,
      writable: true,
    });
    gate.on_load();
    expect(document.getElementById(COUNTER_ID)?.textContent).toBe('42/120');
    gate.on_finish?.();
  });

  it('every gate of the generated plan carries its number on node.data (what the live trial reads)', () => {
    const pair = generateMainBlockPair();
    const gates = [...pair.mainA.nodes, ...pair.mainB.nodes].filter((n) =>
      /_trial_start$/.test(n?.data?.phase ?? '')
    );
    expect(gates.map((g) => g.data.main_trial_number_overall)).toEqual(
      Array.from({ length: 120 }, (_, i) => i + 1)
    );
  });
});
