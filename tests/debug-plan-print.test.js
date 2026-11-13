// @vitest-environment jsdom
/**
 * The session-plan print (debug mode only): silent when debug is off; for >= 10 seeds and all five tasks
 * what is printed equals the generated trial params (the same objects), the balance tables equal an
 * independent recomputation, the verdict, practice sharing through the plan store, window.__WM_PLAN__
 * and the download helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/debug/debug-mode.js', () => ({
  isDebugMode: () => globalThis.__planTestDebug === true,
  debugSessionStamp: () => ({ debug_mode: globalThis.__planTestDebug === true }),
  _resetDebugModeForTests: () => {},
}));

import { _setTraceEnabled } from '../src/debug/trace.js';
import { printSessionPlan } from '../src/debug/plan-print.js';
import { getPracticePlan, _resetPlanStoreForTests } from '../src/debug/plan-store.js';
import { TASKS, TASK_DIGIT, longestRun } from '../src/debug/plan-model.js';
import { generateMainBlockPair } from '../src/scheduler/main-blocks.js';
import { singleTypePractice } from '../src/scheduler/practice.js';
import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';

const SEEDS = Array.from({ length: 10 }, (_, i) => `PLAN${i}|STUDY|SESS${i * 7}`);
const METHODS = ['log', 'info', 'warn', 'error', 'group', 'groupCollapsed', 'groupEnd', 'table'];

function spyConsole() {
  const calls = [];
  for (const m of METHODS)
    vi.spyOn(console, m).mockImplementation((...args) => calls.push({ m, args }));
  const text = (c) => (typeof c.args[0] === 'string' ? c.args[0].replace(/%c/g, '') : '');
  return { calls, text };
}

function pairFor(seed) {
  setSessionPRNG(seed);
  resetSequencePools();
  return generateMainBlockPair();
}

beforeEach(() => {
  globalThis.__planTestDebug = false;
  _resetPlanStoreForTests();
  delete window.__WM_PLAN__;
  delete window.__WM_PLAN_DOWNLOAD__;
});
afterEach(() => {
  _setTraceEnabled(false);
  globalThis.__planTestDebug = false;
  vi.restoreAllMocks();
});

describe('debug off', () => {
  it('prints nothing, exposes nothing, records no practice plan', () => {
    const pair = pairFor(SEEDS[0]);
    singleTypePractice({ trialType: 'd_only', trialsPerType: 2 });
    const spy = spyConsole();
    expect(printSessionPlan({ seed: SEEDS[0], mainPair: pair })).toBeNull();
    expect(spy.calls).toHaveLength(0);
    expect(window.__WM_PLAN__).toBeUndefined();
    expect(window.__WM_PLAN_DOWNLOAD__).toBeUndefined();
    expect(getPracticePlan()).toEqual([]);
  });
});

describe('debug on', () => {
  it('records the practice params the timeline runs (same objects), in task order', () => {
    globalThis.__planTestDebug = true;
    setSessionPRNG(SEEDS[1]);
    resetSequencePools();
    const made = {};
    for (const t of ['d_only', 't_only', 'i_only', 'i_d', 'i_t'])
      made[t] = singleTypePractice({ trialType: t, trialsPerType: 2 });
    const plan = getPracticePlan();
    expect(plan).toHaveLength(10);
    expect(plan.slice(0, 2)).toEqual(made.d_only.trialParams);
    plan.forEach((p, i) => expect(p).toBe(made[TASKS[Math.floor(i / 2)]].trialParams[i % 2]));
  });

  it.each(SEEDS)('prints exactly the generated plan, seed %s', (seed) => {
    const pair = pairFor(seed);
    globalThis.__planTestDebug = true;
    singleTypePractice({ trialType: 'i_d', trialsPerType: 2 });
    const spy = spyConsole();
    _setTraceEnabled(true);
    const plan = printSessionPlan({ seed, mainPair: pair });
    _setTraceEnabled(false);

    /* the exposed plan holds the very objects the nodes use */
    expect(window.__WM_PLAN__).toBe(plan);
    expect(plan.mainA.trialParams).toBe(pair.mainA.trialParams);
    expect(plan.mainB.trialParams[59]).toBe(pair.mainB.trialParams[59]);
    expect(plan.practice).toHaveLength(2);
    expect(typeof window.__WM_PLAN_DOWNLOAD__).toBe('function');

    /* one collapsed group per trial, titled with the plan's own numbers */
    const groups = spy.calls.filter((c) => c.m === 'groupCollapsed').map((c) => spy.text(c));
    expect(groups.filter((t) => t.startsWith('TRIAL '))).toHaveLength(120);
    const all = [...pair.mainA.trialParams, ...pair.mainB.trialParams];
    const recs = [...plan.summaries.records.main_a, ...plan.summaries.records.main_b];
    all.forEach((p, i) => {
      const r = recs[i];
      expect(groups).toContain(
        `TRIAL ${i + 1}/120  ${r.task_label}  ${i < 60 ? 'main_a' : 'main_b'} #${(i % 60) + 1}  rot ${r.rotation}  shade=${p.background_shade}  seq ${p.sequence.join('')}`
      );
      expect(r.uid).toBe(p.trial_meta.trial_uid);
      expect(r.task).toBe(p.trial_type);
      /* encoding: every slot's cell is the cell of the entry in that slot */
      const entries = new Map(
        [...(p.memory_items ?? []), ...(p.stars ?? []), ...(p.dummies ?? [])].map((e) => [
          e.slot_index_in_seq,
          e,
        ])
      );
      expect(r.encoding).toHaveLength(6);
      r.encoding.forEach((s, k) => {
        expect(s.slot).toBe(k + 1);
        expect(s.cell).toBe(entries.get(k).cell);
        expect(s.onset_ms).toBe(
          1500 + k * 0 + p.sequence.slice(0, k).reduce((a, c) => a + (c === 'M' ? 1500 : 3500), 0)
        );
      });
      /* recall: test order, type, cell, answer */
      expect(r.recall.map((q) => [q.probe, q.cell])).toEqual(
        (p.probes ?? []).map((q) => [q.type, q.cell])
      );
      r.recall.forEach((q, k) => {
        expect(q.test).toBe(k + 1);
        expect(q.answer).toBe(p.probes[k].is_target ? 'YES' : 'NO');
      });
      if (p.trial_type.endsWith('t_only') || p.trial_type === 'i_t' || p.trial_type === 't_only')
        r.encoding
          .filter((s) => s.kind === 'tone')
          .forEach((s) => expect(s.freq_hz).toBeGreaterThan(100));
    });
    expect(plan.summaries.failures).toEqual([]);
    expect(spy.calls.some((c) => spy.text(c).includes('ALL EXACT BALANCES PASS'))).toBe(true);
    expect(spy.calls.some((c) => c.m === 'error')).toBe(false);
    /* console groups are balanced */
    const opened = spy.calls.filter((c) => c.m === 'group' || c.m === 'groupCollapsed').length;
    expect(spy.calls.filter((c) => c.m === 'groupEnd').length).toBe(opened);
  });

  it.each(SEEDS.slice(0, 4))(
    'balance tables equal an independent recomputation, seed %s',
    (seed) => {
      const pair = pairFor(seed);
      _setTraceEnabled(true);
      spyConsole();
      const plan = printSessionPlan({ seed, mainPair: pair });
      for (const type of TASKS) {
        const half = {
          main_a: pair.mainA.trialParams.filter((t) => t.trial_type === type),
          main_b: pair.mainB.trialParams.filter((t) => t.trial_type === type),
        };
        half.pool = [...half.main_a, ...half.main_b];
        for (const [scope, trials] of Object.entries(half)) {
          const c = plan.summaries.perTask[type][scope].counts;
          expect(c.n).toBe(trials.length);
          for (let s = 0; s < 6; s++) {
            expect(c.slots.M[s]).toBe(trials.filter((t) => t.sequence[s] === 'M').length);
            const items = trials
              .flatMap((t) => t.memory_items ?? [])
              .filter((m) => m.slot_index_in_seq === s);
            expect(c.slots.memOn[s]).toBe(items.filter((m) => m.pattern_label === 'on').length);
            const stars = trials
              .flatMap((t) => t.stars ?? [])
              .filter((m) => m.slot_index_in_seq === s);
            expect(c.slots.starOn[s]).toBe(stars.filter((m) => m.is_on_pattern).length);
            const tgt = trials.filter((t) =>
              (t.probes ?? []).some(
                (p) =>
                  p.is_target &&
                  t.memory_items[p.encoding_position].slot_index_in_seq === s &&
                  p.type === 'T_on'
              )
            );
            expect(c.slots.T_on[s]).toBe(tgt.length);
          }
          for (const pt of ['T_on', 'T_off', 'F_on', 'F_off'])
            for (let k = 0; k < 3; k++)
              expect(c.probeByPos[pt][k]).toBe(
                trials.filter((t) =>
                  (t.probes ?? []).some((p) => p.probe_position === k && p.type === pt)
                ).length
              );
          const nTargets = (t) => (t.probes ?? []).filter((p) => p.is_target).length;
          for (let k = 0; k <= 3; k++)
            expect(c.hist.targets[k]).toBe(trials.filter((t) => nTargets(t) === k).length);
          expect(c.shade.white).toBe(trials.filter((t) => t.background_shade === 'white').length);
        }
        /* pinned histograms of the memory tasks */
        if (type !== 'i_only') {
          expect(plan.summaries.perTask[type].pool.counts.hist.targets).toEqual([3, 9, 9, 3]);
          expect(['2,4,4,2', '1,5,5,1']).toContain(
            plan.summaries.perTask[type].main_a.counts.hist.targets.join()
          );
        }
      }
      const digits = (b) => b.schedule.map((t) => TASK_DIGIT[t]).join('');
      expect(plan.summaries.sequence.main_a).toBe(digits(pair.mainA));
      expect(longestRun([...pair.mainA.schedule, ...pair.mainB.schedule])).toBeLessThanOrEqual(2);
      expect(plan.summaries.rests.main_b_after_block_trial).toEqual([15, 30, 45]);
    }
  );

  it('a broken plan prints the exact violations loudly and no PASS verdict', () => {
    const pair = pairFor(SEEDS[2]);
    const bad = structuredClone({
      mainA: { schedule: pair.mainA.schedule, trialParams: pair.mainA.trialParams },
      mainB: { schedule: pair.mainB.schedule, trialParams: pair.mainB.trialParams },
      trialParamsByType: pair.trialParamsByType,
    });
    const t = bad.mainA.trialParams.find((x) => x.trial_type === 'd_only');
    t.memory_items[0].pattern_label = t.memory_items[0].pattern_label === 'on' ? 'off' : 'on';
    const spy = spyConsole();
    _setTraceEnabled(true);
    const plan = printSessionPlan({ seed: 'x', mainPair: bad });
    expect(plan.summaries.failures.length).toBeGreaterThan(0);
    expect(spy.calls.some((c) => spy.text(c).includes('ALL EXACT BALANCES PASS'))).toBe(false);
    expect(spy.calls.filter((c) => c.m === 'error').length).toBeGreaterThan(1);
  });

  it('download helper saves the plan as a JSON file', async () => {
    const pair = pairFor(SEEDS[3]);
    spyConsole();
    _setTraceEnabled(true);
    const plan = printSessionPlan({ seed: 'P|S|1', mainPair: pair });
    let blob = null;
    URL.createObjectURL = vi.fn((b) => ((blob = b), 'blob:x'));
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      expect(this.download).toBe('wm-plan_P_S_1.json');
    });
    window.__WM_PLAN_DOWNLOAD__();
    expect(click).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(
      await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsText(blob);
      })
    );
    expect(parsed.seed).toBe('P|S|1');
    expect(parsed.mainB.trialParams).toHaveLength(60);
    expect(parsed.summaries.verdict).toBe(plan.summaries.verdict);
  });
});
