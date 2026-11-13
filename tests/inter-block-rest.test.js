// @vitest-environment jsdom
/**
 * The rest between the two blocks: 120 s (config), m:ss countdown, skippable with Space after a 2 s
 * guard, rest_* fields on the data row. The 30 s intra-block rests are unchanged and not skippable.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/uploader.js', () => ({
  uploadConsentAndPractice: vi.fn(() => Promise.resolve({})),
  uploadCheckpoint: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../src/storage.js', () => ({ getSessionObject: vi.fn(() => Promise.resolve(null)) }));

import { config } from '../src/config.js';
import { intraBlockRestNode, restNode, SKIP_GUARD_MS } from '../src/conditions/rest.js';
import { restLengthPhrase } from '../src/conditions/rest-text.js';
import { mainAIntroNode, mainBIntroNode } from '../src/runner-intros.js';

const space = (opts = {}) =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ...opts }));
let js;
let errors;
const onErr = (e) => errors.push(e);
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
  });
  js = {
    finishTrial: vi.fn(),
    pluginAPI: { cancelAllKeyboardResponses: vi.fn() },
    getCurrentTrial: () => ({ data: {} }),
  };
  window.jsPsych = js;
  errors = [];
  window.addEventListener('error', onErr);
});
afterEach(() => {
  window.removeEventListener('error', onErr);
  vi.useRealTimers();
  delete window.jsPsych;
  document.body.innerHTML = '';
});

describe('config and pre-registration agree', () => {
  it('inter_block_rest_duration_s is 120 in both and the intra-block rest is still 30', () => {
    const pre = JSON.parse(readFileSync('pre-reg/pre-reg.json', 'utf8'));
    expect(config.blocks.inter_block_rest_duration_s).toBe(120);
    expect(pre.config_locked.blocks.inter_block_rest_duration_s).toBe(120);
    expect(config.blocks.rest_duration_s).toBe(30);
    expect(pre.config_locked.blocks.rest_duration_s).toBe(30);
    expect(pre._doc).toContain('inter_block_rest_duration_s');
    expect(readFileSync('pre-reg/AMENDMENT-inter-block-rest.md', 'utf8')).toContain('120');
  });
});

describe('texts are derived from the config', () => {
  it('phrase helper', () => {
    expect(restLengthPhrase(120)).toBe('2-minute');
    expect(restLengthPhrase(30)).toBe('30-second');
    expect(restLengthPhrase(90)).toBe('90-second');
  });
  it('main_a_intro states the 2-minute skippable rest; main_b_intro keeps the 30-second rests', () => {
    const a = mainAIntroNode()
      .stimulus.replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    expect(a).toContain(
      `${config.blocks.inter_block_rest_duration_s / 60}-minute rest between the two blocks, which you can skip if you do not want to wait`
    );
    expect(a).toContain('a 30-second rest after trials 20 and 40');
    const b = mainBIntroNode()
      .stimulus.replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    expect(b).toContain('30-second rests after trials 15, 30 and 45');
  });
});

describe('inter-block rest', () => {
  it('is 120 s, shows 2:00 and counts down in m:ss with a visible skip hint', () => {
    const node = restNode();
    expect(node.trial_duration).toBe(120_000);
    expect(node.data).toMatchObject({ phase: 'rest', block_label: 'inter_block' });
    document.body.innerHTML = node.stimulus;
    expect(document.getElementById('rest-countdown').textContent).toBe('2:00');
    expect(document.getElementById('rest-skip-hint').textContent).toContain(
      'You can skip the rest by pressing Space when you are ready'
    );
    expect(document.getElementById('rest-skip-hint').closest('[data-voiceover-target]')).toBeNull();
    node.on_load();
    vi.advanceTimersByTime(1000);
    expect(document.getElementById('rest-countdown').textContent).toBe('1:59');
    vi.advanceTimersByTime(60_000);
    expect(document.getElementById('rest-countdown').textContent).toBe('0:59');
    node.on_finish({});
  });

  it('Space is ignored during the first 2 s, then ends the rest early', () => {
    const node = restNode();
    document.body.innerHTML = node.stimulus;
    node.on_load();
    vi.advanceTimersByTime(SKIP_GUARD_MS - 100);
    space();
    expect(js.finishTrial).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    space({ repeat: true });
    expect(js.finishTrial).not.toHaveBeenCalled();
    space();
    space();
    expect(js.finishTrial).not.toHaveBeenCalled(); /* deferred past the keydown dispatch */
    vi.advanceTimersByTime(1);
    expect(js.finishTrial).toHaveBeenCalledTimes(1);
    expect(js.pluginAPI.cancelAllKeyboardResponses.mock.invocationCallOrder[0]).toBeLessThan(
      js.finishTrial.mock.invocationCallOrder[0]
    );
    const data = { ...js.finishTrial.mock.calls[0][0] };
    node.on_finish(data);
    expect(data).toMatchObject({
      rest_planned_s: 120,
      rest_skipped: true,
      rest_actual_ms: 2200,
    });
    expect(data).toMatchObject({});
    vi.advanceTimersByTime(130_000);
    space();
    expect(js.finishTrial).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it('natural end records the full length and rest_skipped false; the listener is gone', () => {
    const node = restNode();
    document.body.innerHTML = node.stimulus;
    node.on_load();
    vi.advanceTimersByTime(120_000);
    expect(document.getElementById('rest-countdown').textContent).toBe('0:00');
    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({
      rest_planned_s: 120,
      rest_skipped: false,
      rest_actual_ms: 120_000,
    });
    space();
    expect(js.finishTrial).not.toHaveBeenCalled();
  });
});

describe('intra-block rests are unchanged', () => {
  it('30 s, no hint, Space never skips, fields recorded with rest_skipped false', () => {
    const node = intraBlockRestNode({ blockLabel: 'main_a' });
    expect(node.trial_duration).toBe(30_000);
    document.body.innerHTML = node.stimulus;
    expect(document.getElementById('rest-skip-hint')).toBeNull();
    expect(document.getElementById('rest-countdown').textContent).toBe('0:30');
    node.on_load();
    vi.advanceTimersByTime(10_000);
    space();
    expect(js.finishTrial).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({ rest_planned_s: 30, rest_skipped: false, rest_actual_ms: 30_000 });
  });
});

describe('the raw export carries the rest and gate fields unchanged', () => {
  it('rest_planned_s, rest_actual_ms, rest_skipped and the main_a_intro gate fields are raw columns', async () => {
    const { buildRawTable } = await import('../scripts/raw-to-csv.js');
    const rows = [
      {
        phase: 'rest',
        block_label: 'inter_block',
        seq: 1,
        rest_planned_s: 120,
        rest_actual_ms: 2004,
        rest_skipped: true,
      },
      {
        phase: 'main_a_intro',
        seq: 2,
        space_enabled_after_ms: null,
        narration_finished: true,
        gate_reason: 'narration_end',
      },
    ];
    const table = buildRawTable([{ participant_id: 'p1', run_id: 'r1', rows, session: {} }]);
    const cols = JSON.stringify(table.columns ?? table);
    for (const c of [
      'rest_planned_s',
      'rest_actual_ms',
      'rest_skipped',
      'space_enabled_after_ms',
      'narration_finished',
      'gate_reason',
    ])
      expect(cols).toContain(c);
    const restRow = (table.rows ?? []).find((r) => r.phase === 'rest');
    expect(restRow).toMatchObject({
      rest_planned_s: 120,
      rest_actual_ms: 2004,
      rest_skipped: true,
    });
  });
});
