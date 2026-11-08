// @vitest-environment jsdom
/**
 * Memory-probe response times, end to end, for the four conditions that have probes
 * (d_only, t_only, i_d, i_t): every one of the three probes of a trial, targets and foils.
 *
 * The real nodes run through jsPsych on a fake clock with a scripted participant whose
 * presses are logged with the clock reading at the press: that log is the oracle. Checked:
 * the raw probe row (rt measured from that probe's own onset stamp, the response timestamp
 * stored so the RT can be re-derived, timeouts explicit), the tidy probes table (rt_ms,
 * response_ms, the 250 ms anticipation flag) and the events table (test_rt_ms of the tested
 * item). The real-Chrome run of the same checks is in the report of the change.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

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
import { composeTidyTables, RT_FLOOR_MS } from '../scripts/tidy-tables.js';

const CONDS = ['d_only', 't_only', 'i_d', 'i_t'];
/* policy, label: a response in the first frames, one just inside the 3000 ms window, none,
 * and a double press (the first counts, the second is an extra press). */
const POLICIES = [
  { label: 'first frames', policy: { probeRtMs: 20 } },
  { label: 'about 2950 ms', policy: { probeRtMs: 2950 } },
  { label: 'none', policy: { probeRtMs: null } },
  { label: 'double', policy: { probeRtMs: 600, probeExtraPressMs: 300, probeKey: 'ArrowLeft' } },
];

const runs = []; /* {cond, label, policy, rows, presses, tidy} */

beforeAll(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: REAL_FAKE_TIMERS });
  const want = plannedTrials('probe-rt');
  for (const cond of CONDS) {
    for (const [i, { label, policy }] of POLICIES.entries()) {
      const { rows, probePresses } = await runTrial(cond, want[cond][i], policy);
      const stamped = rows.map((r, k) => ({ ...r, seq: k + 1, block_label: 'main_a' }));
      runs.push({
        cond,
        label,
        policy,
        rows: stamped,
        presses: probePresses,
        tidy: composeTidyTables([{ participant_id: 'P', rows: stamped }]),
      });
    }
  }
  vi.useRealTimers();
}, 600000);

describe('raw probe rows', () => {
  it('every probe of every trial has an own onset stamp and, if answered, a response stamp', () => {
    for (const run of runs) {
      const probes = run.rows.filter((r) => r.phase === `${run.cond}_probe`);
      expect(
        probes.map((p) => p.probe_position),
        `${run.cond} ${run.label}`
      ).toEqual([0, 1, 2]);
      for (const p of probes) {
        expect(Number.isFinite(p.probe_onset_ts_ms)).toBe(true);
        expect('response_ts_ms' in p).toBe(true);
        expect(typeof p.responded).toBe('boolean');
      }
      /* each probe has its own onset: strictly increasing, one probe window apart */
      for (let k = 1; k < 3; k++) {
        expect(probes[k].probe_onset_ts_ms - probes[k - 1].probe_onset_ts_ms).toBeGreaterThan(3000);
      }
    }
  });

  it('rt is measured from the probe onset and equals the key log (first press only)', () => {
    for (const run of runs) {
      const probes = run.rows.filter((r) => r.phase === `${run.cond}_probe`);
      probes.forEach((p, k) => {
        const tag = `${run.cond} ${run.label} probe ${k + 1}`;
        const mine = run.presses.filter((x) => x.probe === k);
        if (run.policy.probeRtMs === null) {
          expect(mine, tag).toHaveLength(0);
          expect(p.responded, tag).toBe(false);
          expect(p.rt, tag).toBeNull();
          expect(p.response, tag).toBeNull();
          expect(p.response_ts_ms, tag).toBeNull();
          expect(p.probe_correct, tag).toBe(false);
          expect(p.said_yes ?? null, tag).toBeNull();
          return;
        }
        const first = mine[0];
        expect(p.responded, tag).toBe(true);
        expect(Math.abs(p.rt - (first.t - p.probe_onset_ts_ms)), tag).toBeLessThanOrEqual(1.5);
        expect(p.rt, tag).toBeGreaterThanOrEqual(1);
        expect(p.rt, tag).toBeLessThan(3000);
        expect(Math.abs(p.response_ts_ms - first.t), tag).toBeLessThanOrEqual(1);
        /* re-derivable from the two stamps */
        expect(Math.abs(p.rt - (p.response_ts_ms - p.probe_onset_ts_ms)), tag).toBeLessThanOrEqual(
          1
        );
        expect(p.response, tag).toBe(first.key.toLowerCase());
        expect(p.extra_keypresses, tag).toBe(mine.length - 1);
        expect(p.early_keypresses + p.late_keypresses, tag).toBe(0);
      });
    }
  });

  it('covers a response in the first frames, near the end of the window, none and a double press', () => {
    const rt = (label, cond = 'd_only') => {
      const run = runs.find((r) => r.cond === cond && r.label === label);
      return run.rows.filter((r) => r.phase === `${cond}_probe`).map((p) => p.rt);
    };
    for (const cond of CONDS) {
      expect(Math.max(...rt('first frames', cond))).toBeLessThan(60);
      expect(Math.min(...rt('about 2950 ms', cond))).toBeGreaterThan(2900);
      expect(rt('none', cond)).toEqual([null, null, null]);
      expect(Math.min(...rt('double', cond))).toBeGreaterThan(500);
    }
  });

  it('the targets and the foils are both in the data', () => {
    for (const cond of CONDS) {
      const probes = runs
        .filter((r) => r.cond === cond)
        .flatMap((r) => r.rows.filter((p) => p.phase === `${cond}_probe`));
      expect(
        probes.some((p) => p.is_target === true),
        cond
      ).toBe(true);
      expect(
        probes.some((p) => p.is_target === false),
        cond
      ).toBe(true);
    }
  });
});

describe('tidy probes table and events table', () => {
  it('rt_ms, responded and the anticipation flag follow the raw row for every probe', () => {
    for (const run of runs) {
      const raw = run.rows.filter((r) => r.phase === `${run.cond}_probe`);
      expect(run.tidy.probes).toHaveLength(3);
      run.tidy.probes.forEach((t, k) => {
        const tag = `${run.cond} ${run.label} probe ${k + 1}`;
        const r = raw[k];
        expect(t.probe_position, tag).toBe(k + 1);
        expect(t.row_recorded, tag).toBe(true);
        expect(t.responded, tag).toBe(r.responded);
        expect(t.rt_ms, tag).toBe(r.rt);
        if (r.responded) {
          expect(t.excluded_anticipatory, tag).toBe(r.rt < RT_FLOOR_MS);
          expect(Math.abs(t.rt_ms - (t.response_ms - t.probe_onset_ms)), tag).toBeLessThanOrEqual(
            1
          );
        } else {
          expect(t.excluded_anticipatory, tag).toBe(false);
          expect(t.response_ms, tag).toBeNull();
        }
      });
    }
    expect(RT_FLOOR_MS).toBe(250);
    const fast = runs.find((r) => r.label === 'first frames').tidy.probes;
    expect(fast.every((p) => p.excluded_anticipatory === true)).toBe(true);
    const slow = runs.find((r) => r.label === 'about 2950 ms').tidy.probes;
    expect(slow.every((p) => p.excluded_anticipatory === false)).toBe(true);
  });

  it('events table: test_rt_ms of a tested item is the rt of its target probe; timeouts are explicit', () => {
    let tested = 0;
    for (const run of runs) {
      const probes = run.tidy.probes;
      for (const e of run.tidy.events) {
        if (e.event_modality !== 'dot' && e.event_modality !== 'tone') continue;
        const target = probes.find(
          (p) => p.is_target === true && p.target_slot_in_stream === e.slot_in_stream
        );
        if (!target) {
          expect(e.tested_later).toBe(false);
          expect(e.test_rt_ms).toBeNull();
          expect(e.test_responded).toBeNull();
          continue;
        }
        tested += 1;
        expect(e.tested_later).toBe(true);
        expect(e.test_position).toBe(target.probe_position);
        expect(e.test_row_recorded).toBe(true);
        expect(e.test_responded).toBe(target.responded);
        expect(e.test_rt_ms).toBe(target.rt_ms);
        if (run.label === 'none') {
          expect(e.test_responded).toBe(false);
          expect(e.test_rt_ms).toBeNull();
        } else {
          expect(e.test_rt_ms).toBeGreaterThanOrEqual(1);
        }
        expect(e.test_excluded_anticipatory).toBe(target.excluded_anticipatory);
      }
      /* foils are not items of the encoding stream: their RT is in probes.csv only */
      for (const p of probes.filter((x) => x.is_target === false)) {
        expect(p.target_slot_in_stream).toBeNull();
        expect(p.row_recorded).toBe(true);
      }
    }
    expect(tested).toBeGreaterThan(0);
  });
});
