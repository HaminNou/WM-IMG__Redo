// @vitest-environment jsdom
/**
 * scripts/trials-to-csv.js: ONE LINE PER TRIAL.
 *
 * The rows are real: the real condition nodes (src/conditions/*) run through jsPsych on a fake clock
 * (tests/helpers/real-rows.js), all five tasks, three seeds, both shades, rotations 0, negative and
 * positive. Every expectation is recomputed here from the trial's own specification (`trial_spec`
 * on the encoding row) and the raw probe and star rows, not from the exporter's helpers.
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
import { realSessionRows, REAL_FAKE_TIMERS } from './helpers/real-rows.js';
import {
  EVENTS_COLUMNS,
  PROBES_COLUMNS,
  STARS_COLUMNS,
  TRIALS_COLUMNS,
  composeTidyTables,
} from '../scripts/tidy-tables.js';
import { parseCsv, serializeCsv, verifyCsv } from '../scripts/raw-to-csv.js';
import {
  BLOCKS_FOR_TESTS,
  LEAD_COLUMNS,
  N_PROBES,
  N_SLOTS,
  N_STARS,
  TRIAL_CONTEXT_COLUMNS,
  blockColumns,
  buildTrialTable,
  composeTrialCsv,
  parseTrialArgs,
  trialColumns,
} from '../scripts/trials-to-csv.js';

const SEEDS = [
  ['tr-seed-a', 'white'],
  ['tr-seed-b', 'gray'],
  ['tr-seed-c', 'white'],
];
const ANGLES = [0, -45, 77];
const TASKS = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];

const participants = [];
let table;
let byUid;

beforeAll(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: REAL_FAKE_TIMERS });
  for (const [seed, shade] of SEEDS) {
    const rows = await realSessionRows({
      seed,
      shade,
      perCondition: 3,
      override: (cond, params, i) => {
        const angle = ANGLES[i % ANGLES.length];
        if (cond === 'd_only') return { ...params, display_rotation_deg: angle };
        if (cond === 't_only') return params;
        return { ...params, rotation_deg: angle };
      },
    });
    participants.push({
      participant_id: `P_${seed}`,
      source_pid: `P_${seed}`,
      run_id: `run_${seed}`,
      subject: participants.length + 1,
      session: { params: { prolific_pid: `P_${seed}`, study_id: 'S', session_id: `SESS_${seed}` } },
      rows,
    });
  }
  vi.useRealTimers();
  table = buildTrialTable(participants);
  byUid = new Map(table.rows.map((r) => [`${r.participant_id}|${r.trial_uid}`, r]));
}, 120_000);

/** Ordinal among the visible stimuli of a trial, from the sequence string alone. */
const overall = (cond, sequence, slot) => {
  const visible = cond === 'i_d' || cond === 'i_t' ? 'MS' : cond === 'i_only' ? 'S' : 'M';
  if (!visible.includes(sequence[slot])) return null;
  let n = 0;
  for (let i = 0; i <= slot; i++) if (visible.includes(sequence[i])) n += 1;
  return n;
};

describe('column layout', () => {
  it('starts with the subject and run columns, then every column of the tidy trials table', () => {
    const cols = trialColumns();
    expect(cols.slice(0, LEAD_COLUMNS.length)).toEqual([...LEAD_COLUMNS]);
    expect(LEAD_COLUMNS[0]).toBe('subject');
    const own = TRIALS_COLUMNS.filter((c) => c !== 'participant_id');
    expect(cols.slice(LEAD_COLUMNS.length, LEAD_COLUMNS.length + own.length)).toEqual(own);
  });

  it('has 6 slot, 3 probe and 3 star blocks with the documented prefixes and no duplicate name', () => {
    const cols = trialColumns();
    expect(new Set(cols).size).toBe(cols.length);
    expect(N_SLOTS).toBe(6);
    expect(N_PROBES).toBe(3);
    expect(N_STARS).toBe(3);
    for (let s = 1; s <= 6; s++) expect(cols).toContain(`slot${s}_serial_position_overall`);
    for (let k = 1; k <= 3; k++) {
      expect(cols).toContain(`probe${k}_rt_ms`);
      expect(cols).toContain(`star${k}_rt_ms`);
    }
    expect(cols).not.toContain('slot7_cell');
    expect(cols).not.toContain('probe4_cell');
    expect(cols).not.toContain('star4_cell');
  });

  it('each block carries every column of its tidy table except the repeated trial facts and its position', () => {
    const [slots, probes, stars] = BLOCKS_FOR_TESTS;
    const expectFor = (block, all, position) => {
      const cols = blockColumns(block);
      expect(cols).toEqual(all.filter((c) => !TRIAL_CONTEXT_COLUMNS.includes(c) && c !== position));
      for (const dropped of [...TRIAL_CONTEXT_COLUMNS, position])
        expect(cols).not.toContain(dropped);
    };
    expectFor(slots, EVENTS_COLUMNS, 'slot_in_stream');
    expectFor(probes, PROBES_COLUMNS, 'probe_position');
    expectFor(stars, STARS_COLUMNS, 'star_serial_position');
    /* what a researcher looks for is there */
    expect(blockColumns(slots)).toEqual(
      expect.arrayContaining([
        'serial_position_overall',
        'cell',
        'pattern_label',
        'onset_ms',
        'offset_ms',
        'silence_after_ms',
      ])
    );
    expect(blockColumns(probes)).toEqual(
      expect.arrayContaining([
        'probe_type',
        'is_target',
        'target_serial_position_overall',
        'rt_ms',
        'probe_correct',
      ])
    );
    expect(blockColumns(stars)).toEqual(
      expect.arrayContaining(['slot_in_stream', 'serial_position_overall', 'star_correct', 'rt_ms'])
    );
  });
});

describe('one line per trial (real task rows)', () => {
  it('has exactly one line per trial: 3 seeds x 5 tasks x 3 trials, unique keys', () => {
    expect(table.rows).toHaveLength(SEEDS.length * 5 * 3);
    expect(new Set(table.rows.map((r) => r.row_key)).size).toBe(table.rows.length);
    for (const t of TASKS)
      expect(table.rows.filter((r) => r.condition === t)).toHaveLength(SEEDS.length * 3);
    expect(table.summary.context_mismatches).toBe(0);
    expect(table.summary.unplaced_child_rows).toBe(0);
    expect(table.summary.duplicate_positions).toBe(0);
  });

  it('every trial line matches its own tidy trial row and the participant meta', () => {
    const tidy = composeTidyTables(participants);
    for (const t of tidy.trials) {
      const line = table.rows.find(
        (r) =>
          r.row_key ===
          `${t.participant_id}|run_${t.participant_id.slice(2)}|${t.trial_seq_session}`
      );
      expect(line, t.trial_uid).toBeDefined();
      for (const c of TRIALS_COLUMNS)
        if (c !== 'participant_id') expect(line[c] ?? null).toEqual(t[c] ?? null);
      expect(line.participant_id).toBe(t.participant_id);
      expect(line.subject).toBe(
        participants.findIndex((p) => p.participant_id === t.participant_id) + 1
      );
    }
  });

  it('the six slots hold the right stimulus, cell, label and serial position', () => {
    for (const p of participants) {
      for (const enc of p.rows.filter((r) => r.phase.endsWith('_encoding'))) {
        const line = byUid.get(`${p.participant_id}|${enc.trial_uid}`);
        expect(line, enc.trial_uid).toBeDefined();
        const spec = enc.trial_spec;
        const kinds = enc.slot_event_kinds;
        for (let s = 0; s < 6; s++) {
          const P = `slot${s + 1}_`;
          const want = kinds[s] === 'dummy' ? 'placeholder' : kinds[s];
          expect(line[`${P}event_modality`], `${enc.trial_uid} slot ${s + 1}`).toBe(want);
          expect(line[`${P}serial_position_overall`] ?? null).toBe(
            overall(enc.condition, enc.sequence, s)
          );
          const item =
            spec.memory_items.find((m) => m.slot === s) ?? spec.stars.find((x) => x.slot === s);
          if (item) {
            expect(line[`${P}cell`]).toBe(item.cell);
            expect(line[`${P}pattern_label`]).toBe(item.pattern_label);
          } else {
            expect(
              line[`${P}cell`] ?? null
            ).toBeNull(); /* a hidden placeholder has no cell label */
            expect(line[`${P}is_visible_stimulus`]).toBe(false);
          }
        }
      }
    }
  });

  it('the placeholders of the single tasks are slots like any other, with their timing', () => {
    const d = table.rows.find((r) => r.condition === 'd_only');
    const placeholders = [1, 2, 3, 4, 5, 6].filter(
      (s) => d[`slot${s}_event_modality`] === 'placeholder'
    );
    expect(placeholders).toHaveLength(3);
    for (const s of placeholders) {
      expect(d[`slot${s}_is_visible_stimulus`]).toBe(false);
      expect(d[`slot${s}_serial_position_overall`] ?? null).toBeNull();
    }
  });

  it('the three tests are in presentation order, with their response, RT and the target link', () => {
    for (const p of participants) {
      for (const enc of p.rows.filter(
        (r) => r.phase.endsWith('_encoding') && r.condition !== 'i_only'
      )) {
        const line = byUid.get(`${p.participant_id}|${enc.trial_uid}`);
        const probes = p.rows.filter(
          (r) => r.phase.endsWith('_probe') && r.trial_uid === enc.trial_uid
        );
        expect(probes).toHaveLength(3);
        for (const r of probes) {
          const k = r.probe_position + 1;
          const P = `probe${k}_`;
          expect(line[`${P}probe_type`]).toBe(r.probe_type);
          expect(line[`${P}cell`]).toBe(r.probed_cell);
          expect(line[`${P}is_target`]).toBe(r.is_target);
          expect(line[`${P}responded`]).toBe(r.responded);
          expect(line[`${P}rt_ms`] ?? null).toBe(r.rt ?? null);
          expect(line[`${P}probe_correct`]).toBe(r.probe_correct);
          expect(line[`${P}test_position`]).toBe(k);
          if (r.is_target) {
            const item = enc.trial_spec.memory_items.find(
              (m) => m.encoding_position === r.encoding_position
            );
            expect(line[`${P}target_slot_in_stream`]).toBe(item.slot + 1);
            expect(line[`${P}target_serial_position_overall`]).toBe(
              overall(enc.condition, enc.sequence, item.slot)
            );
          } else {
            expect(line[`${P}target_serial_position_overall`] ?? null).toBeNull();
          }
        }
      }
    }
  });

  it('the three stars carry slot, serial position among ALL stimuli, response, RT and correctness', () => {
    for (const p of participants) {
      for (const enc of p.rows.filter(
        (r) => r.phase.endsWith('_encoding') && /^(i_only|i_d|i_t)$/.test(r.condition)
      )) {
        const line = byUid.get(`${p.participant_id}|${enc.trial_uid}`);
        const stars = p.rows.filter(
          (r) => r.phase.endsWith('_star') && r.trial_uid === enc.trial_uid
        );
        expect(stars).toHaveLength(3);
        for (const r of stars) {
          const P = `star${r.probe_position + 1}_`;
          expect(line[`${P}cell`]).toBe(r.probed_cell);
          expect(line[`${P}slot_in_stream`]).toBe(r.slot_index_in_seq + 1);
          expect(line[`${P}serial_position_overall`]).toBe(
            overall(enc.condition, enc.sequence, r.slot_index_in_seq)
          );
          expect(line[`${P}pattern_label`]).toBe(r.pattern_label);
          expect(line[`${P}responded`]).toBe(r.responded);
          expect(line[`${P}star_correct`] ?? null).toBe(r.star_correct ?? null);
        }
      }
    }
  });

  it('a position a trial does not have is missing: no stars in the single tasks, no tests in imagery-only', () => {
    for (const r of table.rows) {
      for (let k = 1; k <= 3; k++) {
        if (r.condition === 'd_only' || r.condition === 't_only')
          expect(r[`star${k}_cell`] ?? null).toBeNull();
        if (r.condition === 'i_only') expect(r[`probe${k}_probe_type`] ?? null).toBeNull();
      }
    }
    const dual = table.rows.find((r) => r.condition === 'i_d');
    expect(
      [1, 2, 3].every((k) => dual[`star${k}_cell`] !== null && dual[`probe${k}_cell`] !== null)
    ).toBe(true);
  });

  it('the whole table writes to CSV and every cell re-reads correctly', () => {
    const { csv, manifest } = composeTrialCsv(participants);
    expect(verifyCsv(csv, table.columns, table.rows)).toEqual([]);
    const records = parseCsv(csv);
    expect(records).toHaveLength(table.rows.length + 1);
    expect(records[0][0]).toEqual({ text: 'subject', quoted: true });
    expect(manifest.output).toMatchObject({ n_trials: 45, n_columns: table.columns.length });
    expect(manifest.trials_by_task).toEqual({ d_only: 9, t_only: 9, i_only: 9, i_d: 9, i_t: 9 });
    expect(manifest.checks).toMatchObject({
      csv_round_trip_ok: true,
      context_mismatches: 0,
      unplaced_child_rows: 0,
      duplicate_positions: 0,
    });
    expect(manifest.layout).toMatchObject({
      slots_per_trial: 6,
      probes_per_trial: 3,
      stars_per_trial: 3,
    });
  });
});

describe('the consistency checks catch faults (negative controls)', () => {
  const fresh = () => structuredClone(composeTidyTables(participants));

  it('a probe row that disagrees with its trial about the task', () => {
    const tidy = fresh();
    tidy.probes[0].condition = 'not_the_task';
    expect(buildTrialTable(participants, { tidy }).summary.context_mismatches).toBeGreaterThan(0);
    /* and composing the file from such tables is refused: nothing would be written */
    expect(() => composeTrialCsv(participants, { tidy })).toThrow(/do not fit together/);
  });

  it('a star row with another block or shade', () => {
    const tidy = fresh();
    const star = tidy.stars[0];
    star.background_shade = star.background_shade === 'white' ? 'gray' : 'white';
    expect(buildTrialTable(participants, { tidy }).summary.context_mismatches).toBe(1);
  });

  it('a slot row with a wrong sequence string', () => {
    const tidy = fresh();
    tidy.events[3].sequence = 'XXXXXX';
    expect(buildTrialTable(participants, { tidy }).summary.context_mismatches).toBe(1);
  });

  it('a probe at a position outside 1-3, a duplicated position and an orphan row', () => {
    const tidy = fresh();
    tidy.probes[0].probe_position = 9;
    expect(buildTrialTable(participants, { tidy }).summary.unplaced_child_rows).toBe(1);
    const dup = fresh();
    dup.probes[1].probe_position = dup.probes[0].probe_position;
    expect(buildTrialTable(participants, { tidy: dup }).summary.duplicate_positions).toBe(1);
    const orphan = fresh();
    orphan.stars[0].trial_seq_session = 99999;
    expect(buildTrialTable(participants, { tidy: orphan }).summary.unplaced_child_rows).toBe(1);
  });

  it('the lenient columns (guard flags, volume) are checked only where the child row has a value', () => {
    const tidy = fresh();
    tidy.probes[0].guard_flags = null;
    tidy.probes[0].user_gain = null;
    expect(buildTrialTable(participants, { tidy }).summary.context_mismatches).toBe(0);
    tidy.probes[0].guard_n = 4; /* a value that contradicts the trial line */
    expect(buildTrialTable(participants, { tidy }).summary.context_mismatches).toBe(1);
  });

  it('a corrupted CSV cell is found by the verification', () => {
    const { csv } = composeTrialCsv(participants);
    const bad = csv.replace(/"i_d"/, '"i_x"');
    expect(verifyCsv(bad, table.columns, table.rows).join()).toMatch(/column condition/);
  });
});

describe('options', () => {
  it('--main-trials-only leaves out the practice trials, --analysed-runs-only the unfinished runs', () => {
    const withPractice = table.rows.some((r) => r.is_practice === true);
    const only = buildTrialTable(participants, { mainTrialsOnly: true });
    expect(only.rows.every((r) => r.is_practice !== true)).toBe(true);
    expect(only.rows.length).toBe(table.rows.filter((r) => r.is_practice !== true).length);
    expect(withPractice || only.rows.length === table.rows.length).toBe(true);
    /* these runs have no completion row, so none is "analysed" */
    expect(buildTrialTable(participants, { analysedRunsOnly: true }).rows).toHaveLength(0);
  });

  it('parseTrialArgs accepts --main-trials-only together with the shared options', () => {
    const o = parseTrialArgs([
      'node',
      't.js',
      '--out',
      'o.csv',
      '--main-trials-only',
      '--keep-pid',
      'dir',
    ]);
    expect(o).toMatchObject({ out: 'o.csv', mainTrialsOnly: true, keepPid: true });
    expect(o.inputs).toEqual(['dir']);
    expect(() => parseTrialArgs(['node', 't.js', '--nope'])).toThrow(/unknown flag/);
  });
});

describe('cell format sanity', () => {
  it('writes numbers bare, booleans TRUE/FALSE, missing NA', () => {
    const csv = serializeCsv(
      [{ row_key: 'a', n: 1.5, b: true, m: null }],
      ['row_key', 'n', 'b', 'm']
    );
    expect(csv.trimEnd().split('\n')[1]).toBe('"a",1.5,TRUE,NA');
  });
});
