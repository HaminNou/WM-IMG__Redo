// @vitest-environment jsdom
/**
 * Timing of the encoding stream: raw offsets, planned times and the derived columns of the
 * events table (duration, onset error, silence before / after) for all five trial types,
 * placeholders included.
 *
 * The raw rows are the real ones (real condition nodes through jsPsych on a fake clock,
 * tests/helpers/real-rows.js). The numbers are checked against the design constants
 * (dot 1000 ms + 500 ms, star 3000 ms + 500 ms, tone 350 ms in a 1500 ms slot, 1500 ms
 * before the first slot) and recomputed here from the raw arrays, not from the exporter's
 * own helper. Real-Chrome numbers: see the report of the change; the fake clock only proves
 * the bookkeeping (alignment, nulls, definitions), not browser jitter.
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
import { realSessionRows, runTrial, plannedTrials, REAL_FAKE_TIMERS } from './helpers/real-rows.js';
import { composeTidyTables, slotTiming } from '../scripts/tidy-tables.js';

const CONDS = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];
const FRAME_TOLERANCE_MS = 40; /* the fake clock steps 10 ms and delivers frames every 16 ms */

let rows = [];
let tidy;

beforeAll(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: REAL_FAKE_TIMERS });
  const a = await realSessionRows({ seed: 'timing-a', shade: 'white', perCondition: 3 });
  const b = await realSessionRows({ seed: 'timing-b', shade: 'gray', perCondition: 3 });
  vi.useRealTimers();
  rows = [
    { pid: 'A', rows: a },
    { pid: 'B', rows: b },
  ];
  tidy = composeTidyTables(rows.map((p) => ({ participant_id: p.pid, rows: p.rows })));
}, 600000);

const encodingRows = (cond) =>
  rows.flatMap((p) => p.rows.filter((r) => r.phase === `${cond}_encoding`));

describe('raw encoding row: offsets, planned times, kinds', () => {
  for (const cond of CONDS) {
    it(`${cond}: six aligned arrays, every event has an onset and an offset`, () => {
      const enc = encodingRows(cond);
      expect(enc.length).toBe(6);
      for (const e of enc) {
        for (const k of [
          'slot_onsets_ts_ms',
          'slot_offsets_ts_ms',
          'slot_offset_sources',
          'slot_planned_onsets_ts_ms',
          'slot_planned_offsets_ts_ms',
          'slot_event_kinds',
        ]) {
          expect(e[k], k).toHaveLength(6);
        }
        /* kinds agree with the plan (trial_spec) and with the sequence string */
        e.slot_event_kinds.forEach((kind, slot) => {
          expect(kind).toBe(e.slot_positions_mm[slot].kind);
          const inSpec = (list) => (list ?? []).some((x) => x.slot === slot);
          if (inSpec(e.trial_spec.memory_items)) {
            expect(kind).toBe(cond === 't_only' || cond === 'i_t' ? 'tone' : 'dot');
          } else if (inSpec(e.trial_spec.stars) && cond !== 'd_only' && cond !== 't_only') {
            expect(kind).toBe('star');
          } else {
            expect(kind).toBe('dummy');
          }
        });
        for (let s = 0; s < 6; s++) {
          expect(Number.isFinite(e.slot_onsets_ts_ms[s]), `onset ${s}`).toBe(true);
          expect(Number.isFinite(e.slot_offsets_ts_ms[s]), `offset ${s}`).toBe(true);
          const tone = e.slot_event_kinds[s] === 'tone';
          expect(e.slot_offset_sources[s]).toBe(tone ? 'scheduled' : 'frame');
        }
      }
    });

    it(`${cond}: planned times are the design constants on the scale of the onsets`, () => {
      for (const e of encodingRows(cond)) {
        let t = 1500;
        const t0 = e.key_log_t0_ms; /* run origin of the plan, rounded */
        for (let s = 0; s < 6; s++) {
          const isM = e.sequence[s] === 'M';
          const kind = e.slot_event_kinds[s];
          const dur = kind === 'tone' ? 350 : isM ? 1000 : 3000;
          expect(
            Math.abs(e.slot_planned_onsets_ts_ms[s] - (t0 + t)),
            `planned onset ${s}`
          ).toBeLessThanOrEqual(1);
          expect(e.slot_planned_offsets_ts_ms[s] - e.slot_planned_onsets_ts_ms[s]).toBe(dur);
          t += isM ? 1500 : 3500;
        }
        /* the plan origin is the encoding onset to within a millisecond */
        expect(Math.abs(t0 - e.encoding_onset_ts_ms)).toBeLessThanOrEqual(1);
      }
    });

    it(`${cond}: measured durations match the plan (dot 1000, star 3000, placeholder as the event it replaces, tone 350 scheduled)`, () => {
      for (const e of encodingRows(cond)) {
        for (let s = 0; s < 6; s++) {
          const dur = e.slot_offsets_ts_ms[s] - e.slot_onsets_ts_ms[s];
          const planned = e.slot_planned_offsets_ts_ms[s] - e.slot_planned_onsets_ts_ms[s];
          if (e.slot_event_kinds[s] === 'tone') expect(dur).toBe(350);
          else expect(Math.abs(dur - planned)).toBeLessThanOrEqual(FRAME_TOLERANCE_MS);
          expect(e.slot_onsets_ts_ms[s] - e.slot_planned_onsets_ts_ms[s]).toBeLessThanOrEqual(
            FRAME_TOLERANCE_MS
          );
        }
      }
    });
  }

  it('tone events carry the nominal duration and a scheduled offset next to the scheduled onset', () => {
    for (const cond of ['t_only', 'i_t']) {
      for (const e of encodingRows(cond)) {
        expect(e.slot_tone_events).toHaveLength(3);
        for (const te of e.slot_tone_events) {
          expect(te.nominal_duration_ms).toBe(350);
          if (te.scheduled_onset_perf_ms === null) expect(te.scheduled_offset_perf_ms).toBeNull();
          else expect(te.scheduled_offset_perf_ms).toBeCloseTo(te.scheduled_onset_perf_ms + 350, 1);
          /* the tone's offset in the slot array is its planned onset plus 350, flagged scheduled */
          expect(e.slot_offsets_ts_ms[te.slot] - e.slot_onsets_ts_ms[te.slot]).toBe(350);
          expect(e.slot_offset_sources[te.slot]).toBe('scheduled');
        }
      }
    }
  });

  it('a star row and the slot arrays agree: same onset, offset a frame after the window closed', () => {
    for (const cond of ['i_only', 'i_d', 'i_t']) {
      for (const p of rows) {
        for (const e of p.rows.filter((r) => r.phase === `${cond}_encoding`)) {
          const stars = p.rows.filter(
            (r) =>
              r.phase === `${cond}_star` &&
              r.trial_index_in_block === e.trial_index_in_block &&
              r.seq < e.seq &&
              r.seq > e.seq - 5
          );
          expect(stars).toHaveLength(3);
          for (const s of stars) {
            const slot = s.slot_index_in_seq;
            expect(Math.abs(s.star_onset_ts_ms - e.slot_onsets_ts_ms[slot])).toBeLessThanOrEqual(1);
            const off = e.slot_offsets_ts_ms[slot];
            expect(off).toBeGreaterThanOrEqual(s.window_closed_ts_ms - 20);
            expect(off - s.window_closed_ts_ms).toBeLessThanOrEqual(FRAME_TOLERANCE_MS);
            expect(off - s.star_onset_ts_ms).toBeGreaterThanOrEqual(2980);
          }
        }
      }
    }
  });
});

describe('aborted encoding: null, never a wrong value', () => {
  const ABORT_AT = [100, 1700, 2800, 4300, 8000];
  it('leaves null for events that never started and for events cut short, in all five types', async () => {
    vi.useFakeTimers({ toFake: REAL_FAKE_TIMERS });
    const want = plannedTrials('timing-abort');
    for (const cond of CONDS) {
      for (const [i, at] of ABORT_AT.entries()) {
        const params = want[cond][i];
        const { rows: out } = await runTrial(cond, params, { abortEncodingAtMs: at });
        const e = out.find((r) => r.phase === `${cond}_encoding`);
        expect(e.slot_planned_onsets_ts_ms.every(Number.isFinite), `${cond}@${at} planned`).toBe(
          true
        );
        const abortedAt = e.encoding_onset_ts_ms + at;
        for (let s = 0; s < 6; s++) {
          const on = e.slot_onsets_ts_ms[s];
          const off = e.slot_offsets_ts_ms[s];
          const src = e.slot_offset_sources[s];
          const tag = `${cond}@${at} slot ${s}`;
          if (on === null) {
            expect(off, tag).toBeNull();
            expect(src, tag).toBeNull();
          } else if (off === null) {
            /* started but not finished: no offset, flagged */
            expect(src, tag).toBe('aborted');
            expect(e.slot_planned_offsets_ts_ms[s], tag).toBeGreaterThanOrEqual(abortedAt - 50);
          } else {
            expect(off, tag).toBeGreaterThan(on);
            expect(['frame', 'removal_call', 'scheduled']).toContain(src);
            /* a measured offset is never later than the abort */
            if (src !== 'scheduled') expect(off, tag).toBeLessThanOrEqual(abortedAt + 20);
            else expect(off, tag).toBeLessThanOrEqual(e.slot_planned_offsets_ts_ms[s]);
          }
        }
        /* the table derives null for those slots, not numbers */
        const t = composeTidyTables([{ participant_id: 'X', rows: out }]);
        for (const ev of t.events) {
          if (ev.offset_source === 'aborted' || ev.onset_ms === null) {
            expect(ev.offset_ms).toBeNull();
            expect(ev.duration_ms).toBeNull();
            expect(ev.silence_after_ms).toBeNull();
          }
          if (ev.onset_ms === null) {
            expect(ev.onset_error_ms).toBeNull();
            expect(ev.silence_before_ms).toBeNull();
          }
          expect(ev.planned_onset_ms).not.toBeNull();
          expect(ev.planned_duration_ms).toBeGreaterThan(0);
        }
        for (const st of t.stars) {
          if (st.truncated === true || st.displayed === false) expect(st.star_offset_ms).toBeNull();
        }
      }
    }
    vi.useRealTimers();
  }, 600000);
});

describe('events table: derived timing columns', () => {
  const trialsOf = () => {
    const m = new Map();
    for (const e of tidy.events) {
      const k = `${e.participant_id}|${e.trial_seq_session}`;
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.values()].map((v) => v.sort((a, b) => a.slot_in_stream - b.slot_in_stream));
  };

  it('every slot, placeholders included, has onset, offset and duration; sources match the kind', () => {
    for (const ev of tidy.events) {
      expect(Number.isFinite(ev.onset_ms)).toBe(true);
      expect(Number.isFinite(ev.offset_ms)).toBe(true);
      expect(ev.duration_ms).toBe(ev.offset_ms - ev.onset_ms);
      expect(ev.planned_duration_ms).toBe(ev.planned_offset_ms - ev.planned_onset_ms);
      expect(ev.onset_error_ms).toBe(ev.onset_ms - ev.planned_onset_ms);
      expect(ev.offset_error_ms).toBe(ev.offset_ms - ev.planned_offset_ms);
      expect(ev.offset_source).toBe(ev.event_modality === 'tone' ? 'scheduled' : 'frame');
      if (ev.event_modality === 'tone') {
        expect(ev.duration_ms).toBe(350);
        expect(ev.onset_error_ms).toBe(0);
      }
      if (ev.event_modality === 'dot')
        expect(Math.abs(ev.duration_ms - 1000)).toBeLessThanOrEqual(FRAME_TOLERANCE_MS);
      if (ev.event_modality === 'star')
        expect(Math.abs(ev.duration_ms - 3000)).toBeLessThanOrEqual(FRAME_TOLERANCE_MS);
      if (ev.event_modality === 'placeholder') {
        const planned = ev.slot_plan_kind === 'M' ? 1000 : 3000;
        expect(Math.abs(ev.duration_ms - planned)).toBeLessThanOrEqual(FRAME_TOLERANCE_MS);
        expect(ev.is_visible_stimulus).toBe(false);
      }
    }
  });

  it('silence_before / silence_after follow the definition (perceptible = dot, star, tone only)', () => {
    for (const evs of trialsOf()) {
      const perceptible = evs.filter((e) => e.is_visible_stimulus);
      for (const e of evs) {
        const before = perceptible.filter((p) => p.slot_in_stream < e.slot_in_stream).at(-1);
        const after = perceptible.find((p) => p.slot_in_stream > e.slot_in_stream);
        if (before) {
          expect(e.silence_before_ref).toBe('previous_event_offset');
          expect(e.silence_before_ms).toBe(e.onset_ms - before.offset_ms);
        } else {
          expect(e.silence_before_ref).toBe('encoding_start');
          expect(e.silence_before_ms).toBe(e.onset_ms);
        }
        if (after) expect(e.silence_after_ms).toBe(after.onset_ms - e.offset_ms);
        else expect(e.silence_after_ms).toBeNull();
        expect(e.silence_before_ms).toBeGreaterThanOrEqual(0);
      }
      /* between two consecutive perceptible events both sides report the same silence */
      for (let i = 0; i + 1 < perceptible.length; i++) {
        expect(perceptible[i].silence_after_ms).toBe(perceptible[i + 1].silence_before_ms);
      }
      /* the first perceptible event is preceded by the pre-encoding pad plus placeholders */
      expect(perceptible[0].silence_before_ms).toBeGreaterThanOrEqual(1500 - FRAME_TOLERANCE_MS);
    }
  });

  it('dual trials: dot or star 500 ms of silence, tone 1150 ms, to the next stimulus', () => {
    for (const evs of trialsOf()) {
      if (evs.every((e) => e.is_visible_stimulus) === false) continue;
      for (let i = 0; i + 1 < evs.length; i++) {
        const e = evs[i];
        const expected = e.event_modality === 'tone' ? 1150 : 500;
        expect(Math.abs(e.silence_after_ms - expected)).toBeLessThanOrEqual(FRAME_TOLERANCE_MS);
      }
    }
  });

  it('single-task trials: a placeholder interval is silence, so gaps are longer than in dual trials', () => {
    let sawGap = false;
    for (const evs of trialsOf()) {
      if (evs.every((e) => e.is_visible_stimulus)) continue;
      const perceptible = evs.filter((e) => e.is_visible_stimulus);
      for (let i = 0; i + 1 < perceptible.length; i++) {
        const a = perceptible[i];
        const b = perceptible[i + 1];
        if (b.slot_in_stream - a.slot_in_stream > 1) {
          sawGap = true;
          const between = evs.filter(
            (e) => e.slot_in_stream > a.slot_in_stream && e.slot_in_stream < b.slot_in_stream
          );
          /* silence = a's tail + the placeholders' slots, each as long as the slot it fills */
          expect(a.silence_after_ms).toBeGreaterThan(between[0].duration_ms - FRAME_TOLERANCE_MS);
          expect(a.silence_after_ms).toBe(b.onset_ms - a.offset_ms);
        }
      }
    }
    expect(sawGap).toBe(true);
  });

  it('onset_gap_ms is still the slot-to-slot onset interval (1500 after M, 3500 after S)', () => {
    for (const evs of trialsOf()) {
      evs.forEach((e, i) => {
        if (i === 0) return expect(e.onset_gap_ms).toBeNull();
        expect(e.onset_gap_ms).toBe(e.onset_ms - evs[i - 1].onset_ms);
        const exp = evs[i - 1].slot_plan_kind === 'M' ? 1500 : 3500;
        expect(Math.abs(e.onset_gap_ms - exp)).toBeLessThanOrEqual(FRAME_TOLERANCE_MS);
      });
    }
  });

  it('stars table: star_offset_ms is the events offset; response_ms re-derives rt_ms', () => {
    for (const s of tidy.stars) {
      const ev = tidy.events.find(
        (e) =>
          e.participant_id === s.participant_id &&
          e.trial_seq_session === s.trial_seq_session &&
          e.slot_in_stream === s.slot_in_stream
      );
      expect(s.star_offset_ms).toBe(ev.offset_ms);
      expect(s.star_onset_ms).toBe(ev.onset_ms);
      if (s.responded) {
        expect(Math.abs(s.rt_ms - (s.response_ms - s.star_onset_ms))).toBeLessThanOrEqual(1);
      } else {
        expect(s.response_ms).toBeNull();
      }
    }
  });
});

describe('slotTiming: definitions on hand-made rows', () => {
  /* d_only, sequence MSMSMS: dots in slots 1, 3, 5, placeholders in 2, 4, 6. Times below are
   * relative to the encoding onset; the raw arrays hold them plus t0 = 1000. The actual
   * times differ a little from the plan on purpose: the actuals must come from the recorded
   * arrays and the plan only from the planned arrays. */
  const t0 = 1000;
  const abs = (list) => list.map((x) => (x === null ? null : t0 + x));
  const enc = {
    sequence: 'MSMSMS',
    slot_offsets_ts_ms: abs([2500, 6010, 7490, 11000, 12510, 16000]),
    slot_offset_sources: ['frame', 'frame', 'frame', 'frame', 'frame', 'frame'],
    slot_planned_onsets_ts_ms: abs([1500, 3000, 6500, 8000, 11500, 13000]),
    slot_planned_offsets_ts_ms: abs([2500, 6000, 7500, 11000, 12500, 16000]),
  };
  const mod = ['dot', 'placeholder', 'dot', 'placeholder', 'dot', 'placeholder'];
  const onsets = [1500, 3010, 6490, 8000, 11510, 13000];

  it('computes duration, errors and silences with placeholders counted as silence', () => {
    const r = slotTiming({ enc, modalities: mod, onsets, t0 });
    expect(r.map((x) => x.duration_ms)).toEqual([1000, 3000, 1000, 3000, 1000, 3000]);
    expect(r.map((x) => x.onset_error_ms)).toEqual([0, 10, -10, 0, 10, 0]);
    expect(r.map((x) => x.offset_error_ms)).toEqual([0, 10, -10, 0, 10, 0]);
    /* first dot: before = from the encoding start; after = next DOT onset - own offset,
     * the placeholder in between is silence */
    expect(r[0].silence_before_ms).toBe(1500);
    expect(r[0].silence_before_ref).toBe('encoding_start');
    expect(r[0].silence_after_ms).toBe(6490 - 2500);
    /* second dot */
    expect(r[2].silence_before_ms).toBe(6490 - 2500);
    expect(r[2].silence_before_ref).toBe('previous_event_offset');
    expect(r[2].silence_after_ms).toBe(11510 - 7490);
    /* last dot: nothing perceptible follows */
    expect(r[4].silence_before_ms).toBe(11510 - 7490);
    expect(r[4].silence_after_ms).toBeNull();
    /* a placeholder between dots: from the previous dot's offset to its own start, and from
     * its own end to the next dot's onset */
    expect(r[1].silence_before_ms).toBe(3010 - 2500);
    expect(r[1].silence_after_ms).toBe(6490 - 6010);
    expect(r[3].silence_before_ms).toBe(8000 - 7490);
    expect(r[3].silence_after_ms).toBe(11510 - 11000);
    /* placeholder after the last dot */
    expect(r[5].silence_before_ms).toBe(13000 - 12510);
    expect(r[5].silence_after_ms).toBeNull();
  });

  it('a placeholder before any perceptible event is measured from the encoding start', () => {
    const e2 = { ...enc, slot_offsets_ts_ms: abs([4500, 6000, 6500, 7000, 8000, 9000]) };
    const m2 = ['placeholder', 'dot', 'placeholder', 'dot', 'dot', 'placeholder'];
    const r = slotTiming({
      enc: e2,
      modalities: m2,
      onsets: [1500, 5000, 6000, 6500, 7500, 8500],
      t0,
    });
    expect(r[0].silence_before_ref).toBe('encoding_start');
    expect(r[0].silence_before_ms).toBe(1500);
    expect(r[0].silence_after_ms).toBe(5000 - 4500);
    expect(r[1].silence_before_ref).toBe('encoding_start'); /* first perceptible event */
    expect(r[1].silence_before_ms).toBe(5000);
    expect(r[1].silence_after_ms).toBe(6500 - 6000);
  });

  it('aborted offsets and missing onsets give null silences, not numbers', () => {
    const e3 = {
      ...enc,
      slot_offsets_ts_ms: abs([2500, null, null, null, null, null]),
      slot_offset_sources: ['frame', 'aborted', null, null, null, null],
    };
    const r = slotTiming({
      enc: e3,
      modalities: mod,
      onsets: [1500, 3010, null, null, null, null],
      t0,
    });
    expect(r[1].offset_ms).toBeNull();
    expect(r[1].duration_ms).toBeNull();
    expect(r[1].offset_source).toBe('aborted');
    expect(r[0].silence_after_ms).toBeNull(); /* the next dot never started */
    expect(r[2].onset_error_ms).toBeNull();
    expect(r[2].silence_before_ms).toBeNull();
  });

  it('rows from before offsets were recorded: planned from the constants, offsets empty', () => {
    const r = slotTiming({ enc: { sequence: 'MSMSMS' }, modalities: mod, onsets, t0 });
    expect(r.map((x) => x.planned_onset_ms)).toEqual([1500, 3000, 6500, 8000, 11500, 13000]);
    expect(r.map((x) => x.planned_duration_ms)).toEqual([1000, 3000, 1000, 3000, 1000, 3000]);
    expect(r.every((x) => x.offset_ms === null && x.duration_ms === null)).toBe(true);
    expect(r[0].onset_error_ms).toBe(0);
  });

  it('a tone slot is planned at 350 ms and a tone is perceptible for the silence rule', () => {
    const seq = 'MMMSSS';
    const modT = ['tone', 'tone', 'tone', 'placeholder', 'placeholder', 'placeholder'];
    const r = slotTiming({
      enc: { sequence: seq },
      modalities: modT,
      onsets: [1500, 3000, 4500, 6000, 9500, 13000],
      t0,
    });
    expect(r.map((x) => x.planned_duration_ms)).toEqual([350, 350, 350, 3000, 3000, 3000]);
  });
});
