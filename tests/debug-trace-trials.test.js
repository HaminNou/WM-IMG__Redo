// @vitest-environment jsdom
/**
 * The experimenter trace on real trials of all five tasks, run through the real jsPsych timeline on a
 * fake clock: what is printed (groups, encoding plan, one line per event, recall lines, summary) and
 * that it agrees with the recorded data rows; and that with debug OFF the console is never touched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/audio/context.js', () => ({
  getAudioContext: () => ({ currentTime: performance.now() / 1000, state: 'running' }),
  audioContextInfo: () => ({
    sample_rate_hz: 48000,
    state: 'running',
    base_latency_ms: 10,
    output_latency_ms: 20,
  }),
  ensureRunning: async () => {},
  unlockAudio: async () => {},
}));
vi.mock('../src/audio/tones.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, playToneByCell: vi.fn(() => Promise.resolve()) };
});

import { _resetStorageForTests, initStorage } from '../src/storage.js';
import { runTrial, plannedTrials, REAL_FAKE_TIMERS } from './helpers/real-rows.js';
import { _setTraceEnabled, _openGroupDepth, _resetTraceState } from '../src/debug/trace.js';
import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { singleTypePractice } from '../src/scheduler/practice.js';

const TASKS = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];
const METHODS = ['log', 'info', 'warn', 'error', 'group', 'groupCollapsed', 'groupEnd', 'table'];

afterEach(() => {
  _setTraceEnabled(false);
  _resetTraceState();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** console.* spies; `text(call)` is the printed text with the %c style arguments removed. */
function spyConsole() {
  const calls = [];
  for (const m of METHODS) {
    vi.spyOn(console, m).mockImplementation((...args) => calls.push({ m, args }));
  }
  const text = (c) => (typeof c.args[0] === 'string' ? c.args[0].replace(/%c/g, '') : '');
  return { calls, text, lines: () => calls.map((c) => ({ m: c.m, t: text(c), c })) };
}

async function runWith(cond, params, { debug, policy } = {}) {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: REAL_FAKE_TIMERS });
  const spy = spyConsole();
  _resetTraceState();
  _setTraceEnabled(debug === true);
  const { rows } = await runTrial(cond, params, policy ?? { starRtMs: 700, probeRtMs: 600 });
  _setTraceEnabled(false);
  vi.useRealTimers();
  return { rows, spy, calls: spy.calls };
}

function mainParams(cond, no = 7) {
  const p = plannedTrials('trace-trials')[cond][0];
  return {
    ...p,
    trial_meta: { ...p.trial_meta, main_trial_number_overall: no, main_trial_total: 120 },
  };
}
function practiceParams(cond) {
  setSessionPRNG(`trace-practice-${cond}`);
  resetSequencePools();
  return singleTypePractice({ trialType: cond, trialsPerType: 2 }).trialParams[1];
}

const probeRowsOf = (rows) =>
  rows
    .filter((r) => /_probe$/.test(r.phase ?? ''))
    .sort((a, b) => a.probe_position - b.probe_position);
const starRowsOf = (rows) => rows.filter((r) => /_star$/.test(r.phase ?? ''));
const tagOf = (on) => (on ? 'ON' : 'OFF');

describe.each(TASKS)('trace content, %s (main trial)', (cond) => {
  it('prints a balanced, complete trial that agrees with the recorded rows', async () => {
    const params = mainParams(cond);
    const { rows, spy } = await runWith(cond, params, { debug: true });
    const L = spy.lines();
    const all = L.map((l) => l.t).join('\n');

    /* balanced groups, one trial group */
    expect(L.filter((l) => l.m === 'group').length).toBe(
      L.filter((l) => l.m === 'groupEnd').length
    );
    expect(_openGroupDepth()).toBe(0);
    const heads = L.filter((l) => l.m === 'group' && l.t.startsWith('TRIAL'));
    expect(heads).toHaveLength(1);
    expect(heads[0].t).toContain('TRIAL 7/120');
    expect(heads[0].t).not.toContain('PRACTICE');
    expect(all).toContain('ENCODING');

    /* setup lines */
    expect(all).toContain('GATE');
    expect(all).toContain('ITI');
    const imagery = cond === 'i_only' || cond === 'i_d' || cond === 'i_t';
    if (imagery) {
      expect(all).toMatch(/ARROW CUE\s+arrow=[-+]?\d+°\s+rotation=/);
      expect(all).toContain('IMAGINATION');
      expect(all).toContain('ROTATION TURN');
      expect(all).toContain('ROTATION HOLD');
    }

    /* the encoding plan: 6 slots with the planned kinds, cells and tags */
    const tables = L.filter((l) => l.m === 'table').map((l) => l.c.args[0]);
    const plan = tables[0];
    expect(plan).toHaveLength(6);
    const enc = rows.find((r) => /_encoding$/.test(r.phase));
    plan.forEach((row, i) => {
      const kind = enc.slot_event_kinds[i];
      expect(row.kind).toContain(kind === 'dummy' ? 'HIDDEN' : kind.toUpperCase());
      if (kind === 'dummy') {
        expect(row.cell).toBe('');
        expect(row.tag).toBe('');
      } else {
        expect(row.cell).toBe(enc.slot_positions_mm[i].cell);
      }
    });
    for (const m of params.memory_items ?? []) {
      const row = plan[m.slot_index_in_seq];
      expect(row.cell).toBe(m.cell);
      expect(row.tag).toBe(tagOf(m.pattern_label === 'on'));
      if (cond === 't_only' || cond === 'i_t') expect(row.tone).toMatch(/tone #\d+ [\d.]+ Hz/);
      else expect(row.tone).toBe('');
    }
    for (const s of params.stars ?? []) {
      const row = plan[s.slot_index_in_seq];
      expect(row.cell).toBe(s.cell);
      expect(row.tag).toBe(tagOf(s.is_on_pattern));
    }
    const planned = enc.slot_planned_onsets_ts_ms;
    expect(plan.map((r) => r.onset_ms)).toEqual(planned.map((t) => t - planned[0] + 1500));

    /* one live line per visible/hidden event */
    const slotLines = L.filter((l) => /^\s*[+-]\d+\.\d\d s\s+slot \d/.test(l.t));
    expect(slotLines.filter((l) => /DOT|TONE|HIDDEN/.test(l.t))).toHaveLength(
      6 - (params.stars ?? []).length
    );
    expect(slotLines.filter((l) => l.t.includes('STAR'))).toHaveLength((params.stars ?? []).length);

    /* stars: response lines, truth value and correctness equal the rows */
    const starRows = starRowsOf(rows);
    const respLines = L.filter((l) => /key ArrowRight → says ON/.test(l.t));
    expect(respLines).toHaveLength(starRows.length);
    for (const r of starRows) {
      const mine = respLines.find((l) => l.t.includes(`rt ${r.response_rt_ms} ms`));
      expect(mine, `star rt ${r.response_rt_ms}`).toBeTruthy();
      expect(mine.t).toContain(`truth ${r.is_on_pattern ? 'ON' : 'NOT-on'}`);
      expect(mine.t).toContain(r.star_correct ? 'CORRECT' : 'INCORRECT');
      expect(mine.t.includes('INCORRECT')).toBe(!r.star_correct);
    }
    expect(L.filter((l) => /⤷ feedback (GREEN|RED)$/.test(l.t))).toHaveLength(starRows.length);

    /* recall: one TEST line per probe with target/foil, response line, summary table */
    const probeRows = probeRowsOf(rows);
    const testLines = L.filter((l) => /TEST \d\/3/.test(l.t));
    expect(testLines).toHaveLength(probeRows.length);
    probeRows.forEach((r, i) => {
      const t = testLines[i].t;
      expect(t).toContain(`TEST ${i + 1}/3`);
      expect(t).toContain(r.probe_type);
      expect(t).toContain(`cell ${r.probed_cell} `);
      expect(t).toContain(tagOf(r.probe_pattern_label === 'on'));
      expect(t).toContain(r.is_target ? 'TARGET' : 'FOIL');
    });
    const answers = L.filter((l) => /correct answer (YES|NO)/.test(l.t));
    expect(answers).toHaveLength(probeRows.length);
    probeRows.forEach((r, i) => {
      expect(answers[i].t).toContain(`correct answer ${r.is_target ? 'YES' : 'NO'}`);
      expect(answers[i].t).toContain(r.probe_correct ? '✔ CORRECT' : '✘ INCORRECT');
      expect(answers[i].t).toContain(`rt ${r.rt} ms`);
      expect(answers[i].t).toContain(r.probe_correct ? 'GREEN' : 'RED');
    });
    if (probeRows.length) {
      expect(tables).toHaveLength(2);
      expect(tables[1]).toHaveLength(probeRows.length);
      tables[1].forEach((row, i) => {
        expect(row.result).toBe(probeRows[i].probe_correct ? '✔' : '✘');
        expect(row.role).toBe(probeRows[i].is_target ? 'T' : 'F');
      });
    } else {
      expect(tables).toHaveLength(1);
    }

    /* summary numbers equal the recorded correct counts */
    const summary = L.find((l) => l.t.startsWith('SUMMARY')).t;
    const mc = probeRows.filter((r) => r.probe_correct).length;
    const sc = starRows.filter((r) => r.star_correct).length;
    expect(summary).toContain(`memory ${mc}/${probeRows.length}`);
    expect(summary).toContain(`stars ${sc}/${starRows.length}`);
    expect(summary).toContain('early/late/extra keys 0/0/0');
  }, 120000);
});

describe.each(TASKS)('trace, %s practice trial', (cond) => {
  it('labels the group PRACTICE and stays balanced', async () => {
    const { spy } = await runWith(cond, practiceParams(cond), { debug: true });
    const L = spy.lines();
    const head = L.find((l) => l.m === 'group' && l.t.startsWith('TRIAL'));
    expect(head.t).toContain('PRACTICE');
    expect(head.t).toContain('practice');
    expect(L.filter((l) => l.m === 'group').length).toBe(
      L.filter((l) => l.m === 'groupEnd').length
    );
    expect(_openGroupDepth()).toBe(0);
    expect(L.some((l) => l.t.startsWith('SUMMARY'))).toBe(true);
  }, 120000);
});

describe.each(TASKS)('debug OFF, %s', (cond) => {
  it('never touches the console during a full trial', async () => {
    const { rows, calls } = await runWith(cond, mainParams(cond), { debug: false });
    expect(rows.length).toBeGreaterThan(5);
    expect(calls).toEqual([]);
  }, 120000);
});

describe('trace anomalies match the recorded counters', () => {
  const sum = (rs, k) => rs.reduce((a, r) => a + (r[k] ?? 0), 0);

  it('no response on a probe: a warning per probe, zero correct', async () => {
    const { rows, spy } = await runWith('i_d', mainParams('i_d'), {
      debug: true,
      policy: { starRtMs: 700, probeRtMs: null },
    });
    const L = spy.lines();
    const probeRows = probeRowsOf(rows);
    expect(probeRows.every((r) => r.responded === false)).toBe(true);
    expect(L.filter((l) => l.m === 'warn' && l.t.includes('probe: NO RESPONSE'))).toHaveLength(3);
    const summary = L.find((l) => l.t.startsWith('SUMMARY')).t;
    expect(summary).toContain('memory 0/3');
    expect(summary).toContain('no-response 3');
    const table = L.filter((l) => l.m === 'table')[1].c.args[0];
    expect(table.every((r) => r.key === '(none)' && r.result === '-')).toBe(true);
  }, 120000);

  it('extra probe key: a warning and the summary count equals the rows', async () => {
    const { rows, spy } = await runWith('t_only', mainParams('t_only'), {
      debug: true,
      policy: { probeRtMs: 600, probeExtraPressMs: 200 },
    });
    const L = spy.lines();
    const extra = sum(probeRowsOf(rows), 'extra_keypresses');
    expect(extra).toBe(3);
    expect(L.filter((l) => l.m === 'warn' && /extra key ArrowRight/.test(l.t))).toHaveLength(extra);
    expect(L.find((l) => l.t.startsWith('SUMMARY')).t).toContain(`/${extra}`);
  }, 120000);

  it('early / late / extra star keys: counts equal the star rows', async () => {
    const { rows, spy } = await runWith('i_only', mainParams('i_only'), {
      debug: true,
      policy: { starRtMs: 700, spamKeys: true },
    });
    const L = spy.lines();
    const stars = starRowsOf(rows);
    const e = sum(stars, 'early_keypresses');
    const l = sum(stars, 'late_keypresses');
    const x = sum(stars, 'extra_keypresses');
    expect(e + l + x).toBeGreaterThan(0);
    expect(L.find((c) => c.t.startsWith('SUMMARY')).t).toContain(
      `early/late/extra keys ${e}/${l}/${x}`
    );
    expect(L.filter((c) => c.m === 'warn' && /early key/.test(c.t))).toHaveLength(e);
    expect(L.filter((c) => c.m === 'warn' && /late key/.test(c.t))).toHaveLength(l);
    expect(L.filter((c) => c.m === 'warn' && /extra key/.test(c.t))).toHaveLength(x);
  }, 120000);

  it('an encoding cut short closes cleanly and warns', async () => {
    const { spy } = await runWith('i_d', mainParams('i_d'), {
      debug: true,
      policy: { starRtMs: 700, probeRtMs: 600, abortEncodingAtMs: 6000 },
    });
    const L = spy.lines();
    expect(L.some((l) => l.m === 'warn' && l.t.includes('encoding cut short'))).toBe(true);
    expect(L.filter((l) => l.m === 'group').length).toBe(
      L.filter((l) => l.m === 'groupEnd').length
    );
    expect(_openGroupDepth()).toBe(0);
  }, 120000);
});
