// @vitest-environment jsdom
/**
 * The console trace: silent when off, correct formatting and balanced groups when on, never throws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  trace,
  isTraceOn,
  _setTraceEnabled,
  _resetTraceState,
  _setTraceClock,
  _openGroupDepth,
} from '../src/debug/trace.js';
import { TRIAL_TYPE_TAG_COLOURS } from '../src/conditions/trial-counter.js';

const METHODS = ['log', 'info', 'warn', 'error', 'group', 'groupCollapsed', 'groupEnd', 'table'];
let spies;
let clock;

function install() {
  spies = {};
  for (const m of METHODS) spies[m] = vi.spyOn(console, m).mockImplementation(() => {});
}
const text = (call) => String(call[0]).replace(/%c/g, '');
const lines = (m) => spies[m].mock.calls.map(text);
const allText = () => METHODS.flatMap((m) => lines(m)).join('\n');
const balanced = () => spies.group.mock.calls.length === spies.groupEnd.mock.calls.length;

const ALL_CALLS = () => {
  trace.banner({ seed: 's' });
  trace.trialStart({ trial_type: 'i_d', trial_no: 17, trial_total: 120 });
  trace.setup('gate', 'x');
  trace.encodingPlan([{ slot: 1, kind: 'dot', cell: 3 }]);
  trace.encodingEvent(1, { kind: 'dot', cell: 3 });
  trace.star({ event: 'open', slot: 2, cell: 4 });
  trace.recallStart();
  trace.probe({ kind: 'dot', cell: 3, is_target: true });
  trace.probeResponse({ key: 'ArrowRight', said_yes: true, expected_yes: true, correct: true });
  trace.recallSummary();
  trace.trialEnd({});
  trace.abort('x');
  trace.marker('m');
  trace.warn('w', { a: 1 });
  trace.mute(true);
  trace.mute(false);
};

beforeEach(() => {
  clock = 1000;
  _setTraceClock(() => clock);
  _resetTraceState();
  install();
});
afterEach(() => {
  _setTraceEnabled(false);
  vi.restoreAllMocks();
});

describe('trace is silent when off', () => {
  it('prints nothing, adds no listeners, and does not touch the DOM', () => {
    _setTraceEnabled(false);
    expect(isTraceOn()).toBe(false);
    const add = vi.spyOn(window, 'addEventListener');
    const html = document.body.innerHTML;
    ALL_CALLS();
    for (const m of METHODS) expect(spies[m], m).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(document.body.innerHTML).toBe(html);
  });
  it('does not even read its arguments (no string building)', () => {
    _setTraceEnabled(false);
    const boom = new Proxy(
      {},
      {
        get: () => {
          throw new Error('read');
        },
      }
    );
    expect(() => trace.probe(boom)).not.toThrow();
    expect(() => trace.setup('x', boom)).not.toThrow();
  });
  it('is off by default in this environment (no debug=1 in the URL)', () => {
    expect(isTraceOn()).toBe(false);
  });
});

describe('trace formatting (on)', () => {
  beforeEach(() => _setTraceEnabled(true));

  it('banner is one balanced group with legend, flags, build and seed', () => {
    trace.banner({ seed: 'abc' });
    const t = allText();
    expect(t).toContain('DEBUG TRACE ON');
    expect(t).toContain('● dot');
    expect(t).toContain('✔ correct');
    expect(t).toContain('G twice');
    expect(t).toContain('seed');
    expect(t).toContain('abc');
    expect(balanced()).toBe(true);
  });

  it('trial header: one group, task badge in the task colour, all header fields', () => {
    trace.trialStart({
      trial_type: 'i_d',
      trial_no: 17,
      trial_total: 120,
      block_label: 'main_a',
      presentation_index: 17,
      pool_index: 5,
      background_shade: 'gray',
      rotation_deg: 37,
      pattern_reminder: true,
    });
    expect(spies.group).toHaveBeenCalledTimes(1);
    const call = spies.group.mock.calls[0];
    const head = text(call);
    expect(head).toContain('TRIAL 17/120');
    expect(head).toContain('Stars + Dots');
    expect(head).toContain('main_a #17');
    expect(head).toContain('pool 5');
    expect(head).toContain('shade=gray');
    expect(head).toContain('rotation=+37° (clockwise)');
    expect(head).toContain('reminder=yes');
    expect(call.some((a) => String(a).includes(TRIAL_TYPE_TAG_COLOURS.i_d))).toBe(true);
    expect(head).not.toContain('PRACTICE');
  });

  it('practice, counter-clockwise and no rotation wording', () => {
    trace.trialStart({
      trial_type: 'd_only',
      block_label: 'practice',
      is_practice: true,
      rotation_deg: -20,
    });
    trace.trialStart({ trial_type: 'd_only', rotation_deg: 0 });
    expect(lines('group')[0]).toContain('PRACTICE');
    expect(lines('group')[0]).toContain('(counter-clockwise)');
    expect(lines('group')[1]).toContain('(none)');
  });

  it('setup lines: degrees, ms, booleans, directions, relative seconds', () => {
    trace.trialStart({ trial_type: 'i_only' });
    clock += 1500;
    trace.setup('arrow_cue', { arrow_deg: 90, rotation_deg: -45, duration_ms: 1000, shown: true });
    const l = lines('log').pop();
    expect(l).toContain('+1.50 s');
    expect(l).toContain('ARROW CUE');
    expect(l).toContain('arrow=+90°');
    expect(l).toContain('rotation=-45° (counter-clockwise)');
    expect(l).toContain('duration=1000 ms');
    expect(l).toContain('shown=yes');
  });

  it('encoding plan table, live events and tones', () => {
    trace.trialStart({ trial_type: 'i_t' });
    trace.encodingPlan([
      { slot: 1, serial_pos: 1, kind: 'dot', cell: 7, on_pattern: true, onset_ms: 0, tested_as: 2 },
      {
        slot: 2,
        serial_pos: 2,
        kind: 'tone',
        cell: 18,
        on_pattern: false,
        tone_index: 4,
        freq_hz: 523.25,
        onset_ms: 1000,
      },
      { slot: 3, kind: 'hidden' },
      { slot: 4, kind: 'star', cell: 5, on_pattern: true },
    ]);
    expect(spies.group).toHaveBeenCalledTimes(2);
    expect(lines('group')[1]).toContain('ENCODING');
    const rows = spies.table.mock.calls[0][0];
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      slot: 1,
      cell: 7,
      'row,col': 'r1,c2',
      tag: 'ON',
      tested: 'test #2',
    });
    expect(rows[1]).toMatchObject({ tag: 'OFF', tone: 'tone #4 523.3 Hz', tested: 'not tested' });
    expect(rows[2].kind).toContain('HIDDEN');
    expect(rows[2].cell).toBe('');
    clock += 3000;
    trace.encodingEvent(3, { kind: 'dot', cell: 7, on_pattern: true });
    expect(lines('log').pop()).toMatch(/\+3\.00 s\s+slot 3\s+● DOT\s+cell 7 \(r1,c2\)\s+ON/);
    trace.encodingEvent(2, {
      kind: 'tone',
      cell: 18,
      on_pattern: false,
      tone_index: 4,
      freq_hz: 440,
    });
    expect(lines('log').pop()).toMatch(/♪ TONE\s+cell 18 \(r3,c3\)\s+OFF\s+tone #4 440 Hz/);
    trace.encodingEvent(5, { kind: 'hidden' });
    expect(lines('log').pop()).toContain('▢ HIDDEN');
  });

  it('encoding times are relative to the encoding start, not the trial start', () => {
    trace.trialStart({ trial_type: 'd_only' });
    clock += 2000;
    trace.encodingPlan([]);
    clock += 1000;
    trace.encodingEvent(1, { kind: 'dot', cell: 1 });
    expect(lines('log').pop()).toContain('+1.00 s');
    trace.encodingEvent(1, { kind: 'dot', cell: 1, rel_ms: 4250 });
    expect(lines('log').pop()).toContain('+4.25 s');
  });

  it('star events: open, response, closed, feedback, no response, early/late/extra warn', () => {
    trace.trialStart({ trial_type: 'i_only' });
    trace.star({ event: 'open', slot: 2, cell: 9, on_pattern: true });
    expect(lines('log').pop()).toMatch(/slot 2\s+★ STAR\s+cell 9 \(r1,c4\)\s+ON\s+window OPEN/);
    trace.star({
      event: 'response',
      key: 'ArrowRight',
      said_on: true,
      on_pattern: true,
      correct: true,
      rt_ms: 523.4,
    });
    expect(lines('log').pop()).toContain(
      'key ArrowRight → says ON · truth ON → ✔ CORRECT · rt 523 ms'
    );
    trace.star({
      event: 'response',
      key: 'ArrowLeft',
      said_on: false,
      on_pattern: true,
      correct: false,
      rt_ms: 100,
    });
    expect(lines('log').pop()).toContain('says NOT-on · truth ON → ✘ INCORRECT');
    trace.star({ event: 'feedback', feedback: 'green', correct: true });
    expect(lines('log').pop()).toContain('feedback GREEN');
    trace.star({ event: 'closed', responded: false });
    expect(lines('warn').pop()).toContain('star: no response');
    for (const ev of ['early', 'late', 'extra']) {
      trace.star({ event: ev, key: 'ArrowLeft' });
      expect(lines('warn').pop()).toContain(`${ev} key ArrowLeft`);
    }
  });

  it('recall: probe line, response line, summary table from the collected rows', () => {
    trace.trialStart({ trial_type: 'd_only' });
    trace.encodingPlan([]);
    trace.recallStart();
    expect(lines('group').pop()).toContain('RECALL');
    expect(spies.groupEnd).toHaveBeenCalledTimes(1); /* ENCODING closed */
    trace.probe({
      test_no: 2,
      test_total: 3,
      label: 'T_off',
      kind: 'dot',
      cell: 18,
      on_pattern: false,
      is_target: true,
      encoded_pos: 1,
    });
    expect(lines('log').pop()).toMatch(
      /TEST 2\/3\s+T_off\s+● DOT\s+cell 18 \(r3,c3\)\s+OFF\s+TARGET \(encoded at position 1\)/
    );
    trace.probeResponse({
      key: 'ArrowRight',
      said_yes: true,
      expected_yes: false,
      correct: false,
      rt_ms: 1034,
      feedback: 'red',
    });
    expect(lines('log').pop()).toContain(
      'key ArrowRight → YES · correct answer NO → ✘ INCORRECT · rt 1034 ms · feedback RED'
    );
    trace.probe({
      test_no: 3,
      test_total: 3,
      kind: 'tone',
      cell: 7,
      tone_index: 2,
      freq_hz: 330,
      is_target: false,
    });
    expect(lines('log').pop()).toContain('FOIL');
    trace.probeResponse({ no_response: true });
    expect(lines('warn').pop()).toContain('NO RESPONSE');
    trace.recallSummary();
    const rows = spies.table.mock.calls.pop()[0];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      test: 2,
      tag: 'OFF',
      role: 'T',
      correct_answer: 'NO',
      key: 'ArrowRight',
      response: 'YES',
      result: '✘',
      rt_ms: 1034,
      feedback: 'RED',
    });
    expect(rows[1]).toMatchObject({ role: 'F', key: '(none)', result: '-' });
    const custom = [{ a: 1 }];
    trace.recallSummary(custom);
    expect(spies.table.mock.calls.pop()[0]).toBe(custom);
  });

  it('trial end summary uses the tally by default and explicit values when given', () => {
    trace.trialStart({ trial_type: 'i_d' });
    trace.star({ event: 'open', slot: 1, cell: 1 });
    trace.star({ event: 'response', correct: true, rt_ms: 200 });
    trace.probe({ kind: 'dot', cell: 1, is_target: true });
    trace.probeResponse({ key: 'ArrowRight', correct: true, rt_ms: 800 });
    trace.star({ event: 'late', key: 'ArrowRight' });
    trace.trialEnd();
    const s = lines('log').pop();
    expect(s).toContain('memory 1/1');
    expect(s).toContain('stars 1/1');
    expect(s).toContain('anticipatory (<250 ms) 1');
    expect(s).toContain('early/late/extra keys 0/1/0');
    trace.trialStart({ trial_type: 'i_d' });
    trace.trialEnd({
      memory_correct: 2,
      memory_total: 3,
      stars_correct: 3,
      stars_total: 3,
      no_responses: 1,
    });
    expect(lines('log').pop()).toContain('memory 2/3');
    expect(lines('log').pop()).toContain('no-response 1');
  });

  it('markers and warnings', () => {
    trace.marker('REST 30 s');
    expect(lines('log').pop()).toContain('REST 30 s');
    trace.warn('hidden page', { at: 1 });
    expect(lines('warn').pop()).toContain('hidden page');
    expect(
      spies.warn.mock.calls.pop()[spies.warn.mock.calls.at(-1)?.length - 1 || 0]
    ).toBeDefined();
  });

  it('percent signs in text cannot break the format string', () => {
    trace.marker('100% sure');
    expect(String(spies.log.mock.calls.pop()[0])).toContain('100%% sure');
  });
});

describe('group balance (on)', () => {
  beforeEach(() => _setTraceEnabled(true));

  it('a normal trial opens and closes every group', () => {
    trace.trialStart({ trial_type: 'i_d' });
    trace.encodingPlan([]);
    trace.recallStart();
    trace.trialEnd();
    expect(balanced()).toBe(true);
    expect(spies.group).toHaveBeenCalledTimes(3);
    expect(_openGroupDepth()).toBe(0);
  });

  it('abort closes everything', () => {
    trace.trialStart({ trial_type: 'i_d' });
    trace.encodingPlan([]);
    trace.abort('skipped');
    expect(balanced()).toBe(true);
    expect(lines('warn').pop()).toContain('TRIAL ABORTED: skipped');
    expect(_openGroupDepth()).toBe(0);
  });

  it('the next trialStart closes a trial that never ended', () => {
    trace.trialStart({ trial_type: 'i_d' });
    trace.recallStart();
    trace.trialStart({ trial_type: 'd_only' });
    expect(spies.groupEnd).toHaveBeenCalledTimes(2);
    trace.trialEnd();
    expect(balanced()).toBe(true);
  });

  it('warns when the next trial starts before the previous one ended, and stays balanced', () => {
    trace.trialStart({ trial_type: 'i_d' });
    trace.encodingPlan([]);
    trace.trialStart({ trial_type: 'd_only' });
    expect(lines('warn').some((l) => l.includes('TRIAL ABORTED: next trial started before'))).toBe(
      true
    );
    trace.trialEnd();
    expect(balanced()).toBe(true);
    expect(_openGroupDepth()).toBe(0);
  });

  it('no warning when the previous trial ended normally', () => {
    trace.trialStart({ trial_type: 'i_d' });
    trace.trialEnd();
    trace.trialStart({ trial_type: 'd_only' });
    trace.trialEnd();
    expect(spies.warn).not.toHaveBeenCalled();
  });

  it('out-of-order calls never leave dangling groups', () => {
    trace.probe({ kind: 'dot', cell: 1 }); /* no trial open: flat lines */
    trace.encodingEvent(1, { kind: 'dot', cell: 1 });
    trace.recallStart();
    trace.trialEnd();
    trace.trialEnd();
    trace.abort();
    expect(balanced()).toBe(true);
    expect(spies.group).not.toHaveBeenCalled();
    trace.trialStart({ trial_type: 'i_d' });
    trace.probe({ kind: 'dot', cell: 1 }); /* RECALL opened implicitly */
    trace.encodingEvent(1, { kind: 'dot', cell: 1 }); /* back to ENCODING */
    trace.recallStart();
    trace.recallStart();
    trace.setup('retention', {});
    trace.trialEnd();
    expect(balanced()).toBe(true);
    expect(_openGroupDepth()).toBe(0);
  });

  it('marker with closeTrial ends the open trial', () => {
    trace.trialStart({ trial_type: 'i_d' });
    trace.encodingPlan([]);
    trace.marker('REST', { closeTrial: true });
    expect(balanced()).toBe(true);
  });

  it('switching the trace off closes open groups', () => {
    trace.trialStart({ trial_type: 'i_d' });
    trace.encodingPlan([]);
    _setTraceEnabled(false);
    expect(balanced()).toBe(true);
  });
});

describe('trace never throws on malformed input', () => {
  beforeEach(() => _setTraceEnabled(true));
  it('survives garbage everywhere', () => {
    const junk = [
      undefined,
      null,
      0,
      NaN,
      'x',
      {},
      [],
      () => {},
      { cell: 'a', kind: 5 },
      { cell: 99 },
      Symbol('s'),
    ];
    for (const j of junk) {
      expect(() => {
        trace.banner(j);
        trace.trialStart(j);
        trace.setup(j, j);
        trace.encodingPlan(j);
        trace.encodingPlan([j, j]);
        trace.encodingEvent(j, j);
        trace.star(j);
        trace.recallStart(j);
        trace.probe(j);
        trace.probeResponse(j);
        trace.recallSummary(j);
        trace.trialEnd(j);
        trace.abort(j);
        trace.marker(j);
        trace.warn(j, j);
      }).not.toThrow();
    }
  });
  it('survives a throwing console', () => {
    spies.group.mockImplementation(() => {
      throw new Error('console broke');
    });
    expect(() => trace.trialStart({ trial_type: 'i_d' })).not.toThrow();
  });
});

describe('sub-groups close at the end of a stage, and mute', () => {
  beforeEach(() => _setTraceEnabled(true));

  it("'iti' and 'encoding_end' close ENCODING / RECALL so the next lines sit at trial level", () => {
    trace.trialStart({ trial_type: 'i_only' });
    trace.encodingEvent(1, { kind: 'star', cell: 3 });
    expect(_openGroupDepth()).toBe(2);
    trace.setup('iti', { duration_ms: 800 });
    expect(_openGroupDepth()).toBe(1);
    trace.probe({ kind: 'dot', cell: 3, is_target: true });
    expect(_openGroupDepth()).toBe(2);
    trace.setup('encoding_end');
    expect(_openGroupDepth()).toBe(1);
    trace.trialEnd({});
    expect(balanced()).toBe(true);
  });

  it('mute(true) closes the trial and silences the trace until mute(false); it is inert when off', () => {
    trace.trialStart({ trial_type: 'i_d' });
    trace.mute(true);
    expect(_openGroupDepth()).toBe(0);
    const before = METHODS.reduce((n, m) => n + spies[m].mock.calls.length, 0);
    trace.trialStart({ trial_type: 'i_d' });
    trace.marker('x');
    expect(METHODS.reduce((n, m) => n + spies[m].mock.calls.length, 0)).toBe(before);
    trace.mute(false);
    trace.marker('x');
    expect(lines('log').some((l) => l.includes('x'))).toBe(true);
    _setTraceEnabled(false);
    const n = METHODS.reduce((k, m) => k + spies[m].mock.calls.length, 0);
    trace.mute(true);
    expect(METHODS.reduce((k, m) => k + spies[m].mock.calls.length, 0)).toBe(n);
  });
});
