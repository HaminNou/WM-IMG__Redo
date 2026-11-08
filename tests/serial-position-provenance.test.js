/**
 * Serial-position provenance: every dual trial lists six encoding events at
 * slots 1-6, every target probe points at the slot that really showed its item,
 * test positions are a permutation of 1-3, and runtime tone-event errors
 * (field `error`, as written by encoding-schedule.js) reach the exports.
 */
import { describe, it, expect } from 'vitest';
import { simulateOne } from '../scripts/simulate-pilot.js';
import { composeTidyTables } from '../scripts/tidy-tables.js';
import { composeExport } from '../scripts/csv-export.js';

const ps = [0, 1].map((i) => {
  const env = simulateOne({ seed: `serial-${i}`, pid: `S${i}`, accuracy: 0.8, responseRate: 1 });
  return { participant_id: env.prolific_pid, session: env, rows: env.rows };
});
const tidy = composeTidyTables(ps);
const key = (r) => `${r.participant_id}|${r.trial_seq_session}`;

describe('serial positions in the tidy tables', () => {
  const byTrial = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  const stars = byTrial(tidy.stars);
  const probes = byTrial(tidy.probes);

  it('stars sit exactly on the S slots of the sequence', () => {
    for (const t of tidy.trials.filter((x) => x.trial_has_stars)) {
      const want = [...t.sequence].flatMap((c, i) => (c === 'S' ? [i + 1] : []));
      expect(stars.get(key(t)).map((s) => s.slot)).toEqual(want);
    }
  });

  it('test positions are 1..3 and each target points at the slot that showed it', () => {
    for (const t of tidy.trials.filter((x) => x.n_probes_planned > 0)) {
      const pr = probes.get(key(t)).sort((a, b) => a.probe_position - b.probe_position);
      expect(pr.map((p) => p.probe_position)).toEqual([1, 2, 3]);
      const mSlots = [...t.sequence].flatMap((c, i) => (c === 'M' ? [i + 1] : []));
      for (const p of pr.filter((x) => x.is_target)) {
        expect(p[`enc${p.encoding_position}_cell`]).toBe(p.cell);
        expect(p.target_slot).toBe(mSlots[p.encoding_position - 1]);
      }
      for (const p of pr.filter((x) => !x.is_target)) expect(p.target_slot).toBeNull();
    }
  });
});

describe('tone playback errors recorded by the runtime reach the exports', () => {
  const rows = [
    {
      phase: 'i_t_trial_start',
      block_label: 'main_a',
      trial_index_in_block: 0,
      trial_uid: 'u',
      seq: 1,
    },
    {
      phase: 'i_t_encoding',
      block_label: 'main_a',
      trial_index_in_block: 0,
      seq: 2,
      encoding_onset_ts_ms: 1000,
      sequence: 'MSMSMS',
      trial_spec: { memory_items: [], stars: [], probes: [] },
      memory_items: [
        { slot: 0, encoding_position: 0, cell: 6, pattern_label: 'on' },
        { slot: 2, encoding_position: 1, cell: 7, pattern_label: 'on' },
      ],
      /* shape written by src/conditions/encoding-schedule.js */
      slot_tone_events: [
        { slot: 0, late: false, late_ms: 0, error: 'context closed' },
        { slot: 2, late: false, late_ms: 0, error: null },
      ],
    },
  ];
  it('counts them in trials.csv and flags them in EVENTS.csv', () => {
    const t = composeTidyTables([{ participant_id: 'P', session: {}, rows }]).trials[0];
    expect(t.n_tone_errors).toBe(1);
    const files = composeExport([
      { participant_id: 'P', session: {}, rows, source_paths: [] },
    ]).files;
    const [header, ...lines] = files['EVENTS.csv'].split('\n').filter(Boolean);
    const split = (line) => line.match(/"(?:[^"]|"")*"|[^,]+/g);
    const cols = split(header).map((c) => c.replace(/"/g, ''));
    const tones = lines.filter((l) => l.includes('"tone"'));
    expect(tones.map((l) => split(l)[cols.indexOf('Tone_Error')])).toEqual(['1', '0']);
  });
});
