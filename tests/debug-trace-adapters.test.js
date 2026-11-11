// @vitest-environment jsdom
/**
 * The trace adapters (src/debug/trace-adapters.js): pure builders, the guarded wrappers, and the
 * places that open / close trial groups outside a trial (rests, practice attempts, skipping).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/audio/context.js', () => ({
  getAudioContext: () => ({ currentTime: 0, state: 'running' }),
  audioContextInfo: () => ({}),
  ensureRunning: async () => {},
  unlockAudio: async () => {},
}));

import {
  keyName,
  traceMetaFromParams,
  buildEncodingSlots,
  probeTraceInfo,
  traceProbeSpec,
  traceTrialStart,
  traceTrialEnd,
  traceKeyIssue,
  traceMarker,
  traceSlotEvent,
  traceProbeOnset,
  traceProbeAnswer,
  traceProbeClosed,
} from '../src/debug/trace-adapters.js';
import { trace, _setTraceEnabled, _resetTraceState, _openGroupDepth } from '../src/debug/trace.js';
import { toneForCell } from '../src/audio/tones.js';
import { plannedTrials } from './helpers/real-rows.js';
import { restNode, resumeAfterRestGateNode } from '../src/conditions/rest.js';
import { patternPhaseNode } from '../src/conditions/pattern-phase.js';
import {
  installHiddenNav,
  getHiddenNavTrialStartHook,
  __resetHiddenNavForTests,
} from '../src/hidden-nav.js';

const METHODS = ['log', 'info', 'warn', 'error', 'group', 'groupCollapsed', 'groupEnd', 'table'];
let calls;
beforeEach(() => {
  calls = [];
  for (const m of METHODS) {
    vi.spyOn(console, m).mockImplementation((...args) => calls.push({ m, args }));
  }
});
afterEach(() => {
  _setTraceEnabled(false);
  _resetTraceState();
  __resetHiddenNavForTests();
  vi.restoreAllMocks();
});
const text = (c) => (typeof c.args[0] === 'string' ? c.args[0].replace(/%c/g, '') : '');
const groups = () => calls.filter((c) => c.m === 'group').length;
const ends = () => calls.filter((c) => c.m === 'groupEnd').length;

const P = plannedTrials('adapters');

describe('keyName', () => {
  it('shows the key as the participant pressed it', () => {
    expect(keyName('arrowright')).toBe('ArrowRight');
    expect(keyName('arrowleft')).toBe('ArrowLeft');
    expect(keyName(' ')).toBe('Space');
    expect(keyName('x')).toBe('x');
    expect(keyName(null)).toBe('(none)');
  });
});

describe('traceMetaFromParams', () => {
  it('reads the live trial number, shade, angle and reminder flag', () => {
    const p = P.i_d[0];
    const m = traceMetaFromParams(
      { ...p, trial_meta: { ...p.trial_meta, pattern_reminder: true } },
      { main_trial_number_overall: 17, main_trial_total: 120 }
    );
    expect(m).toMatchObject({
      trial_type: 'i_d',
      trial_no: 17,
      trial_total: 120,
      block_label: 'main_a',
      is_practice: false,
      rotation_deg: p.rotation_deg,
      pattern_reminder: true,
      background_shade: p.background_shade,
      pool_index: p.trial_meta.pool_index,
    });
  });
  it('numbers a practice trial by its position and has no total; D-only uses its display angle', () => {
    const p = P.d_only[0];
    const m = traceMetaFromParams(
      {
        ...p,
        trial_meta: {
          ...p.trial_meta,
          is_practice: true,
          block_label: 'practice',
          block_position: 2,
        },
      },
      {}
    );
    expect(m.trial_no).toBe(3);
    expect(m.trial_total).toBeUndefined();
    expect(m.is_practice).toBe(true);
    expect(m.rotation_deg).toBe(p.display_rotation_deg ?? 0);
  });
});

describe('buildEncodingSlots', () => {
  const cfg = {
    d_only: { m_kind: 'dot', s_kind: 'dummy' },
    t_only: { m_kind: 'tone', s_kind: 'dummy' },
    i_only: { m_kind: 'dummy', s_kind: 'star' },
    i_d: { m_kind: 'dot', s_kind: 'star' },
    i_t: { m_kind: 'tone', s_kind: 'star' },
  };
  for (const [cond, kinds] of Object.entries(cfg)) {
    it(`${cond}: six slots with the planned kinds, cells, tags, tones and test numbers`, () => {
      const p = P[cond][0];
      const onsets = [1500, 3000, 4500, 6000, 7500, 9000];
      const slots = buildEncodingSlots(p, { ...kinds, onsets_ms: onsets });
      expect(slots).toHaveLength(6);
      expect(slots.map((s) => s.slot)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(slots.map((s) => s.onset_ms)).toEqual(onsets);
      for (const m of p.memory_items ?? []) {
        const s = slots[m.slot_index_in_seq];
        expect(s.kind).toBe(kinds.m_kind === 'dummy' ? 'hidden' : kinds.m_kind);
        expect(s.cell).toBe(m.cell);
        expect(s.on_pattern).toBe(m.pattern_label === 'on');
        if (kinds.m_kind === 'tone') {
          expect(s.tone_index).toBe(toneForCell(m.cell).index);
          expect(s.freq_hz).toBe(toneForCell(m.cell).freq_hz);
        } else expect(s.tone_index).toBeUndefined();
        const probe = p.probes.find(
          (q) => q.is_target && q.encoding_position === m.encoding_position
        );
        expect(s.tested_as).toBe(probe ? probe.probe_position + 1 : null);
      }
      for (const st of p.stars ?? []) {
        const s = slots[st.slot_index_in_seq];
        expect(s).toMatchObject({ kind: 'star', cell: st.cell, on_pattern: st.is_on_pattern });
      }
      const shown =
        (p.memory_items ?? []).length * (kinds.m_kind === 'dummy' ? 0 : 1) +
        (p.stars ?? []).length * (kinds.s_kind === 'star' ? 1 : 0);
      expect(slots.filter((s) => s.kind !== 'hidden')).toHaveLength(shown);
      for (const s of slots.filter((q) => q.kind === 'hidden')) expect(s.tested_as).toBeNull();
    });
  }
});

describe('probeTraceInfo', () => {
  it('describes a target with its (1-based) encoded position, and a foil without', () => {
    const p = P.i_t[0];
    const tgt = p.probes.find((q) => q.is_target);
    const foil = p.probes.find((q) => !q.is_target);
    const a = probeTraceInfo(p, tgt, 'tone');
    expect(a).toMatchObject({
      test_no: tgt.probe_position + 1,
      test_total: 3,
      label: tgt.type,
      kind: 'tone',
      cell: tgt.cell,
      on_pattern: tgt.pattern_label === 'on',
      is_target: true,
      encoded_pos: tgt.encoding_position + 1,
      tone_index: toneForCell(tgt.cell).index,
    });
    const b = probeTraceInfo(p, foil, 'dot');
    expect(b.is_target).toBe(false);
    expect(b.encoded_pos).toBeNull();
    expect(b.tone_index).toBeUndefined();
  });
  it('traceProbeSpec is null (no work) when the trace is off', () => {
    const p = P.i_d[0];
    expect(traceProbeSpec(p, p.probes[0], 'dot')).toBeNull();
    _setTraceEnabled(true);
    expect(traceProbeSpec(p, p.probes[0], 'dot').cell).toBe(p.probes[0].cell);
  });
});

describe('wrappers with the trace OFF', () => {
  it('never touch the console and never throw', () => {
    traceTrialStart(P.i_d[0]);
    traceSlotEvent([], 0, 1);
    traceKeyIssue('probe', 'early', 'arrowleft');
    traceProbeOnset({}, 1);
    traceProbeAnswer({}, {}, 'arrowleft');
    traceProbeClosed({}, {});
    traceMarker('x');
    traceTrialEnd();
    expect(calls).toEqual([]);
  });
});

describe('wrappers with the trace ON', () => {
  beforeEach(() => _setTraceEnabled(true));

  it('probe answer reads the window state the composer filled', () => {
    traceTrialStart(P.i_d[0]);
    const info = probeTraceInfo(P.i_d[0], P.i_d[0].probes[0], 'dot');
    traceProbeOnset(info, performance.now());
    traceProbeAnswer(
      info,
      { said_yes: true, probe_correct: false, response_rt_ms: 321, response_ts_ms: 1 },
      'arrowright'
    );
    const line = calls.map(text).find((t) => t.includes('key ArrowRight'));
    expect(line).toContain('→ YES');
    expect(line).toContain('✘ INCORRECT');
    expect(line).toContain('rt 321 ms');
    expect(line).toContain('feedback RED');
    traceTrialEnd();
    expect(groups()).toBe(ends());
  });

  it('a window that closes unanswered prints the miss, and the recall table after the last test', () => {
    traceTrialStart(P.i_d[0]);
    const info = { ...probeTraceInfo(P.i_d[0], P.i_d[0].probes[2], 'dot') };
    traceProbeOnset(info, performance.now());
    traceProbeClosed(info, { onset_ts: 5, response_key: null });
    expect(calls.some((c) => c.m === 'warn' && text(c).includes('NO RESPONSE'))).toBe(true);
    expect(calls.some((c) => c.m === 'table')).toBe(true);
    traceTrialEnd();
    expect(_openGroupDepth()).toBe(0);
  });

  it('a window closed before its onset (skipped) prints nothing about a response', () => {
    traceTrialStart(P.i_d[0]);
    const before = calls.length;
    traceProbeClosed(
      { is_target: true, test_no: 1, test_total: 3 },
      { onset_ts: null, response_key: null }
    );
    expect(calls.length).toBe(before);
    traceTrialEnd();
  });

  it('outside-window keys are warned but not counted in the summary', () => {
    traceTrialStart(P.i_d[0]);
    traceKeyIssue('outside', 'extra', 'arrowleft');
    traceKeyIssue('probe', 'late', 'arrowleft');
    traceTrialEnd();
    expect(calls.map(text).find((t) => t.startsWith('SUMMARY'))).toContain('keys 0/1/0');
  });
});

describe('groups never dangle', () => {
  beforeEach(() => _setTraceEnabled(true));

  it('a rest, a block boundary and a practice repeat close the open trial', () => {
    for (const text_ of ['REST 30 s (x)', 'MAIN BLOCK 2 of 2', 'PRACTICE REPEAT: attempt 2']) {
      traceTrialStart(P.d_only[0]);
      expect(_openGroupDepth()).toBe(1);
      traceMarker(text_);
      expect(_openGroupDepth()).toBe(0);
    }
    expect(groups()).toBe(ends());
  });

  it('the rest node and its resume gate print a marker from their real on_load', () => {
    traceTrialStart(P.d_only[0]);
    const rest = restNode({ durationS: 1, blockLabel: 'intra_main_a' });
    document.body.innerHTML = '<span id="rest-countdown"></span>';
    rest.on_load();
    expect(_openGroupDepth()).toBe(0);
    expect(calls.map(text).some((t) => t.includes('REST 1 s (intra_main_a)'))).toBe(true);
    resumeAfterRestGateNode({ blockLabel: 'intra_main_a' }).on_load();
    expect(calls.map(text).some((t) => t.includes('REST over'))).toBe(true);
  });

  it('the pattern reminder prints a setup line inside the trial', () => {
    traceTrialStart(P.i_d[0]);
    document.body.innerHTML = '<div id="pattern-phase-mount"></div>';
    patternPhaseNode({
      block_label: 'main_a',
      trial_index_in_block: 0,
      background_shade: 'white',
    }).on_load();
    expect(calls.map(text).some((t) => t.includes('PATTERN REMINDER'))).toBe(true);
    expect(_openGroupDepth()).toBe(1);
    traceTrialEnd();
    expect(_openGroupDepth()).toBe(0);
  });

  it('the next trial start closes a trial that never ended', () => {
    traceTrialStart(P.d_only[0]);
    traceTrialStart(P.t_only[0]);
    expect(_openGroupDepth()).toBe(1);
    traceTrialEnd();
    expect(groups()).toBe(ends());
  });
});

describe('mute and the experimenter skip (hidden-nav)', () => {
  it('trace.mute(true) closes the open trial with a warning and silences everything until unmuted', () => {
    _setTraceEnabled(true);
    traceTrialStart(P.i_d[0]);
    trace.mute(true);
    expect(_openGroupDepth()).toBe(0);
    expect(
      calls.some((c) => c.m === 'warn' && text(c).includes('skipped by the experimenter'))
    ).toBe(true);
    const n = calls.length;
    traceTrialStart(P.i_d[0]);
    traceMarker('x');
    trace.marker('y');
    traceTrialEnd();
    expect(calls.length).toBe(n);
    trace.mute(false);
    traceTrialStart(P.i_d[0]);
    expect(_openGroupDepth()).toBe(1);
    traceTrialEnd();
    expect(groups()).toBe(ends());
  });

  it('U in a trial: neutralised nodes are silent, the next normal trial prints again', () => {
    _setTraceEnabled(true);
    const trialNode = { data: () => ({ phase: 'i_d_encoding' }) };
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
    traceTrialStart(P.i_d[0]);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'u', bubbles: true, cancelable: true })
    );
    const hook = getHiddenNavTrialStartHook();
    hook({ trial_duration: 800 });
    expect(_openGroupDepth()).toBe(0);
    const n = calls.length;
    traceTrialStart(P.d_only[0]);
    traceTrialEnd();
    expect(calls.length).toBe(n);
    /* A registered checkpoint (a screen between trials) switches the trace back on. */
    hook({ _hidden_nav_checkpoint: true });
    traceTrialStart(P.d_only[0]);
    expect(_openGroupDepth()).toBe(1);
    traceTrialEnd();
    expect(groups()).toBe(ends());
  });

  it('R in a trial aborts the open trial group', () => {
    _setTraceEnabled(true);
    const trialNode = { data: () => ({ phase: 'i_d_encoding' }) };
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
    traceTrialStart(P.i_d[0]);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true })
    );
    expect(_openGroupDepth()).toBe(0);
  });
});
