// @vitest-environment jsdom
/**
 * The rest between the two blocks: at most 600 s (config), m:ss countdown, urgent last minute,
 * ended early by BOTH arrow keys (2 s guard, simultaneous rule; Space does nothing), timeout ->
 * exit to Prolific, rest_* fields on the data row. The 30 s intra-block rests are unchanged.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/uploader.js', () => ({
  uploadConsentAndPractice: vi.fn(() => Promise.resolve({})),
  uploadCheckpoint: vi.fn(() => Promise.resolve({})),
  buildScreenOutUrl: () => 'https://app.prolific.com/submissions/complete?cc=REALCODE',
  isPlaceholderScreenOutUrl: () => false,
  setUploadConsent: vi.fn(),
  uploadPendingData: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../src/storage.js', () => ({ getSessionObject: vi.fn(() => Promise.resolve(null)) }));

import { config } from '../src/config.js';
import {
  intraBlockRestNode,
  restNode,
  interBlockRestTimeoutExit,
  interBlockRestMessage,
  SKIP_GUARD_MS,
  URGENT_LINE_TEXT,
} from '../src/conditions/rest.js';
import { BOTH_KEYS_WINDOW_MS } from '../src/conditions/shared.js';
import { restLengthPhrase, restDurationText } from '../src/conditions/rest-text.js';
import { mainAIntroNode, mainBIntroNode } from '../src/runner-intros.js';

const key = (type, k, opts = {}) =>
  document.dispatchEvent(new KeyboardEvent(type, { key: k, code: k, ...opts }));
const down = (k, opts) => key('keydown', k, opts);
const up = (k) => key('keyup', k);
const space = () => down(' ');
const plain = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
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
  it('inter_block_rest_max_s is 600 in both, the old key is gone, intra-block still 30', () => {
    const pre = JSON.parse(readFileSync('pre-reg/pre-reg.json', 'utf8'));
    expect(config.blocks.inter_block_rest_max_s).toBe(600);
    expect(pre.config_locked.blocks.inter_block_rest_max_s).toBe(600);
    expect(config.blocks.inter_block_rest_duration_s).toBeUndefined();
    expect(pre.config_locked.blocks.inter_block_rest_duration_s).toBeUndefined();
    expect(config.blocks.rest_duration_s).toBe(30);
    expect(pre.config_locked.blocks.rest_duration_s).toBe(30);
    expect(pre._doc).toContain('inter_block_rest_max_s');
    const rule = pre.collection_time_screen_outs.rules.find(
      (r) => r.id === 'inter_block_rest_timeout'
    );
    expect(rule).toMatchObject({ threshold_s: 600, source: 'src/conditions/rest.js' });
    const md = readFileSync('pre-reg/AMENDMENT-inter-block-rest.md', 'utf8');
    expect(md).toContain('600');
    expect(md).toContain('inter_block_rest_timeout');
  });
});

describe('texts are derived from the config', () => {
  it('phrase helpers', () => {
    expect(restLengthPhrase(600)).toBe('10-minute');
    expect(restLengthPhrase(30)).toBe('30-second');
    expect(restDurationText(600)).toBe('10 minutes');
    expect(restDurationText(60)).toBe('1 minute');
    expect(restDurationText(90)).toBe('90 seconds');
  });
  it('main_a_intro states the 10-minute maximum, the Prolific return and the both-arrows end', () => {
    const a = plain(mainAIntroNode().stimulus);
    const t = restDurationText(config.blocks.inter_block_rest_max_s);
    expect(t).toBe('10 minutes');
    expect(a).toContain(`a rest of up to ${t}`);
    expect(a).toContain(
      `If you are not back in the experiment within ${t}, you will be sent back to Prolific`
    );
    expect(a).toContain(
      'If you want a shorter rest, press the Left and Right arrow keys together when you are ready'
    );
    expect(a).not.toMatch(/skip/i);
    expect(a).toContain('a 30-second rest after trials 20 and 40');
    expect(plain(mainBIntroNode().stimulus)).toContain(
      '30-second rests after trials 15, 30 and 45'
    );
  });
});

describe('inter-block rest screen', () => {
  it('is 600 s, shows 10:00, counts down in m:ss and states the three facts at its start', () => {
    const node = restNode();
    expect(node.trial_duration).toBe(600_000);
    expect(node.data).toMatchObject({ phase: 'rest', block_label: 'inter_block' });
    document.body.innerHTML = node.stimulus;
    expect(document.getElementById('rest-countdown').textContent).toBe('10:00');
    const t = plain(node.stimulus);
    expect(t).toContain(
      'Take a break of up to 10 minutes. When you are ready to continue, press the Left and Right arrow keys together. If you are not back within 10 minutes, you will be sent back to Prolific.'
    );
    expect(t).not.toMatch(/Space|skip/);
    expect(interBlockRestMessage(600)).toContain('up to 10 minutes');
    node.on_load();
    vi.advanceTimersByTime(1000);
    expect(document.getElementById('rest-countdown').textContent).toBe('9:59');
    vi.advanceTimersByTime(60_000);
    expect(document.getElementById('rest-countdown').textContent).toBe('8:59');
    node.on_finish({});
  });

  it('the last 60 s are urgent: bold red countdown and the urgent line; before that neither', () => {
    const node = restNode();
    document.body.innerHTML = node.stimulus;
    node.on_load();
    const count = document.getElementById('rest-countdown');
    const line = document.getElementById('rest-urgent');
    expect(line.textContent).toBe(URGENT_LINE_TEXT);
    expect(URGENT_LINE_TEXT).toBe(
      'Press both arrow keys now to continue, or you will be sent back to Prolific.'
    );
    vi.advanceTimersByTime(539_000);
    expect(count.textContent).toBe('1:01');
    expect(line.style.visibility).toBe('hidden');
    expect(count.style.fontWeight).toBe('');
    vi.advanceTimersByTime(1000);
    expect(count.textContent).toBe('1:00');
    expect(line.style.visibility).toBe('visible');
    expect(count.style.fontWeight).toBe('700');
    expect(count.style.color).not.toBe('');
    node.on_finish({});
  });

  it('a single arrow, Space and other keys never end the rest', () => {
    const node = restNode();
    document.body.innerHTML = node.stimulus;
    node.on_load();
    vi.advanceTimersByTime(SKIP_GUARD_MS + 1000);
    space();
    down('Enter');
    down('ArrowLeft');
    up('ArrowLeft');
    down('ArrowRight');
    up('ArrowRight');
    down('ArrowLeft');
    vi.advanceTimersByTime(BOTH_KEYS_WINDOW_MS + 100);
    down('ArrowRight'); /* left still held but pressed too long ago */
    vi.advanceTimersByTime(10);
    expect(js.finishTrial).not.toHaveBeenCalled();
    node.on_finish({});
  });

  it('both arrows are ignored during the first 2 s; after that both together end the rest', () => {
    const node = restNode();
    document.body.innerHTML = node.stimulus;
    node.on_load();
    vi.advanceTimersByTime(SKIP_GUARD_MS - 100);
    down('ArrowLeft');
    down('ArrowRight');
    vi.advanceTimersByTime(50);
    expect(js.finishTrial).not.toHaveBeenCalled();
    up('ArrowLeft');
    up('ArrowRight');
    vi.advanceTimersByTime(300);
    down('ArrowLeft', { repeat: true });
    down('ArrowRight', { repeat: true });
    expect(js.finishTrial).not.toHaveBeenCalled();
    down('ArrowRight');
    vi.advanceTimersByTime(BOTH_KEYS_WINDOW_MS - 50);
    const ev = new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(js.finishTrial).not.toHaveBeenCalled(); /* deferred past the keydown dispatch */
    vi.advanceTimersByTime(1);
    expect(js.finishTrial).toHaveBeenCalledTimes(1);
    expect(js.pluginAPI.cancelAllKeyboardResponses.mock.invocationCallOrder[0]).toBeLessThan(
      js.finishTrial.mock.invocationCallOrder[0]
    );
    const data = { ...js.finishTrial.mock.calls[0][0] };
    node.on_finish(data);
    expect(data).toMatchObject({
      rest_planned_s: 600,
      rest_skipped: true,
      rest_timed_out: false,
      rest_actual_ms: 2500,
    });
    vi.advanceTimersByTime(700_000);
    down('ArrowLeft');
    down('ArrowRight');
    expect(js.finishTrial).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  });

  it('a key released before the other is pressed does not count (keyup clears)', () => {
    const node = restNode();
    document.body.innerHTML = node.stimulus;
    node.on_load();
    vi.advanceTimersByTime(SKIP_GUARD_MS + 100);
    down('ArrowLeft');
    vi.advanceTimersByTime(50);
    up('ArrowLeft');
    down('ArrowRight');
    vi.advanceTimersByTime(10);
    expect(js.finishTrial).not.toHaveBeenCalled();
    down('ArrowLeft');
    vi.advanceTimersByTime(1);
    expect(js.finishTrial).toHaveBeenCalledTimes(1);
    node.on_finish({});
  });

  it('natural end records the full length, rest_timed_out true, rest_skipped false; listeners gone', () => {
    const node = restNode();
    document.body.innerHTML = node.stimulus;
    node.on_load();
    vi.advanceTimersByTime(600_000);
    expect(document.getElementById('rest-countdown').textContent).toBe('0:00');
    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({
      rest_planned_s: 600,
      rest_skipped: false,
      rest_timed_out: true,
      rest_actual_ms: 600_000,
    });
    down('ArrowLeft');
    down('ArrowRight');
    expect(js.finishTrial).not.toHaveBeenCalled();
  });

  it('an external finish before the full time (debug skip) is neither skipped nor timed out', () => {
    const node = restNode();
    document.body.innerHTML = node.stimulus;
    node.on_load();
    vi.advanceTimersByTime(5000);
    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({
      rest_skipped: false,
      rest_timed_out: false,
      rest_actual_ms: 5000,
    });
  });
});

describe('timeout exit', () => {
  const rowsFor = (timedOut) => [
    { phase: 'rest', block_label: 'main_a', rest_timed_out: false },
    { phase: 'rest', block_label: 'inter_block', rest_timed_out: timedOut },
  ];
  const withRows = (rows) => {
    window.jsPsych = {
      data: {
        get: () => ({
          filter: (q) => ({
            last: () => ({
              values: () =>
                rows.filter((r) => Object.entries(q).every(([k, v]) => r[k] === v)).slice(-1),
            }),
          }),
        }),
      },
    };
  };

  it('is a conditional screen-out node with the new exit_reason, flush, text from the config', () => {
    const exit = interBlockRestTimeoutExit();
    const trial = exit.timeline[0];
    expect(trial.data).toEqual({
      phase: 'inter_block_rest_timeout',
      exit_reason: 'inter_block_rest_timeout',
    });
    expect(trial.trial_duration).toBeGreaterThan(0); /* redirects by itself */
    expect(plain(trial.stimulus())).toContain(
      'You did not return to the experiment within 10 minutes, so the session has ended. You will now be sent back to Prolific.'
    );
    withRows(rowsFor(true));
    expect(exit.conditional_function()).toBe(true);
    withRows(rowsFor(false));
    expect(exit.conditional_function()).toBe(false);
    withRows([{ phase: 'rest', block_label: 'main_a', rest_timed_out: true }]);
    expect(exit.conditional_function()).toBe(false);
  });

  it('placed after the rest and before the Block 2 intro in the runner timeline', () => {
    const src = readFileSync('src/runner.js', 'utf8');
    expect(src).toMatch(
      /restNode\(\{ session \}\),\s*interBlockRestTimeoutExit\(\),\s*mainBIntroNode\(\)/
    );
  });
});

describe('intra-block rests are unchanged', () => {
  it('30 s, no urgent line, neither Space nor both arrows end it, rest_skipped/rest_timed_out false', () => {
    const node = intraBlockRestNode({ blockLabel: 'main_a' });
    expect(node.trial_duration).toBe(30_000);
    document.body.innerHTML = node.stimulus;
    expect(document.getElementById('rest-urgent')).toBeNull();
    expect(document.getElementById('rest-countdown').textContent).toBe('0:30');
    node.on_load();
    vi.advanceTimersByTime(10_000);
    space();
    down('ArrowLeft');
    down('ArrowRight');
    expect(js.finishTrial).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20_000);
    const data = {};
    node.on_finish(data);
    expect(data).toMatchObject({
      rest_planned_s: 30,
      rest_skipped: false,
      rest_timed_out: false,
      rest_actual_ms: 30_000,
    });
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
        rest_planned_s: 600,
        rest_actual_ms: 2004,
        rest_skipped: true,
        rest_timed_out: false,
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
      'rest_timed_out',
      'space_enabled_after_ms',
      'narration_finished',
      'gate_reason',
    ])
      expect(cols).toContain(c);
    const restRow = (table.rows ?? []).find((r) => r.phase === 'rest');
    expect(restRow).toMatchObject({
      rest_planned_s: 600,
      rest_actual_ms: 2004,
      rest_skipped: true,
    });
  });
});
