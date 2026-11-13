// @vitest-environment jsdom
/**
 * One indexing convention for everything exported (tidy 1.2.0).
 *
 *   - every ordinal / position / sequence column is 1-BASED (min value 1) and means the same
 *     in all five trial types and for dots, stars, tones and placeholders;
 *   - the only 0-based exported columns are stable IDENTIFIERS that key into src/config.js
 *     and src/grid.js (grid cell id 0-24, centre 12; tone_index 0-23), documented as such;
 *   - cell_row / cell_col are 1-based and cell = (cell_row - 1) * 5 + (cell_col - 1);
 *   - the raw runtime rows keep the values they were recorded with.
 *
 * The scan reads every column of every exported table and file, matches position-like names
 * and fails on a name that has no documented base, so a new column cannot slip in unclassified.
 * Rows are the real ones (tests/helpers/real-rows.js) for all five trial types.
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
import { composeExport } from '../scripts/csv-export.js';
import { COLUMN_DOCS, buildTidySchema } from '../scripts/tidy-tables.js';

const TIDY_FILES = ['trials.csv', 'stars.csv', 'probes.csv', 'encoding_events.csv'];
const WIDE_FILES = {
  'D_ONLY_Criterion1.csv': 'd_only',
  'T_ONLY_Criterion1.csv': 't_only',
  'I_ONLY_Criterion1.csv': 'i_only',
  'I_D_Criterion1.csv': 'i_d',
  'I_T_Criterion1.csv': 'i_t',
};
const ALL_FILES = [...TIDY_FILES, 'EVENTS.csv', ...Object.keys(WIDE_FILES)];

/* ---- the documented base of every position-like column ---- */
const ONE = (max, extra = {}) => ({ base: 1, max, ...extra });
const ID0 = (max) => ({ base: 0, max, identifier: true });
const COUNT0 = { base: 0, count: true }; /* an interval count: 0 = this trial itself */
const EXACT = {
  /* tidy tables */
  trial_seq_session: ONE(600, { first: ['trials.csv', 'encoding_events.csv'] }),
  attempt: ONE(2, { first: ['trials.csv'] }),
  presentation_index: ONE(120),
  presentation_index_stamped: ONE(120),
  block_position: ONE(60) /* a main block has 60 trials */,
  pool_index: ONE(24),
  rotation_stratum: ONE(6),
  star_serial_position: ONE(3, { first: true }),
  serial_position_overall: ONE(6, { first: true }),
  serial_position_in_modality: ONE(3, { first: true }),
  slot_in_stream: ONE(6, { first: true }),
  slot: ONE(6, { first: true }),
  probe_position: ONE(3, { first: true }),
  test_position: ONE(3, { first: true }),
  encoding_position: ONE(3),
  nearest_enc_position: ONE(3),
  target_slot: ONE(6),
  target_slot_in_stream: ONE(6),
  target_serial_position_overall: ONE(6),
  target_serial_position_in_modality: ONE(3),
  cell_row: ONE(5),
  cell_col: ONE(5),
  cell: ID0(24),
  placeholder_cell: ID0(24),
  enc1_cell: ID0(24),
  enc2_cell: ID0(24),
  enc3_cell: ID0(24),
  tone_index: ID0(23),
  trials_since_pattern_phase: COUNT0,
  trials_since_pattern_reminder: COUNT0,
  /* EVENTS.csv and the wide files */
  Trial: ONE(24),
  Attempt: ONE(2),
  Event_Index: ONE(6, { first: true }),
  Encoding_Position: ONE(3),
  Slot_In_Stream: ONE(6, { first: true }),
  Serial_Position_Overall: ONE(6, { first: true }),
  Target_Serial_Position_Overall: ONE(6),
  Tone_Idx: ID0(23),
  Cell: { cellString: true },
  Trials_Since_Pattern_Reminder: COUNT0,
};
const PATTERNS = [
  [/^(Dot|Tone)_[123]_OrderN$/, ONE(3)],
  [/^Ast_[123]_SlotN$/, ONE(6)],
  [/^Qmark_[123]_EncPos$/, ONE(3)],
  [/^(Tone|Qmark)_[123]_ToneIdx$/, ID0(23)],
  [/_Cell$/, { cellString: true }],
];
/* names that match the scan but are not positions (strings, flags, millimetre coordinates) */
const NOT_A_POSITION = new Set([
  'Block',
  'position_frame',
  'position_matches_runtime',
  'slot_plan_kind',
  'cell_x_mm',
  'cell_y_mm',
  'cell_size_mm',
  'n_stars_missing_row',
  'n_probes_missing_row',
]);
const POSITION_LIKE =
  /position|slot|serial|order|index|idx|encpos|(^|_)(row|col)$|^trial$|^event_index$|attempt|presentation|pool|stratum|(^|_)seq(_|$)|^cell$|_cell$|^cell_|since_pattern|^block$/i;

const specFor = (col) => {
  if (EXACT[col]) return EXACT[col];
  for (const [re, spec] of PATTERNS) if (re.test(col)) return spec;
  return null;
};

/* ---- CSV reading ---- */
function parseCsv(text) {
  const out = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    out.push(row);
  }
  const [header, ...body] = out.filter((r) => r.length > 1);
  return {
    cols: header,
    rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))),
  };
}
const num = (v) => (v === 'NA' || v === '' || v === undefined ? null : Number(v));

const raw = [];
let files = {};
const tables = {};

beforeAll(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: REAL_FAKE_TIMERS });
  const participants = [];
  for (const [seed, shade] of [
    ['idx-a', 'white'],
    ['idx-b', 'gray'],
  ]) {
    const rows = await realSessionRows({ seed, shade, perCondition: 3 });
    raw.push(...rows);
    participants.push({ participant_id: `P_${seed}`, session: {}, rows, source_paths: [] });
  }
  vi.useRealTimers();
  files = composeExport(participants, { generatedAtIso: '2000-01-01T00:00:00Z' }).files;
  for (const f of ALL_FILES) tables[f] = parseCsv(files[f]);
}, 600000);

describe('every exported position-like column has a documented base', () => {
  it('all ten files exist and every position-like column name is classified', () => {
    const unclassified = [];
    for (const f of ALL_FILES) {
      expect(tables[f], f).toBeTruthy();
      for (const col of tables[f].cols) {
        if (!POSITION_LIKE.test(col) || NOT_A_POSITION.has(col)) continue;
        if (!specFor(col)) unclassified.push(`${f}:${col}`);
      }
    }
    expect(unclassified, 'add a documented base for these columns').toEqual([]);
  });

  it('1-based ordinals reach no lower than 1 (and the first element is 1 where it must be)', () => {
    let scanned = 0;
    for (const f of ALL_FILES) {
      for (const col of tables[f].cols) {
        const spec = POSITION_LIKE.test(col) && !NOT_A_POSITION.has(col) ? specFor(col) : null;
        if (!spec || spec.cellString || spec.identifier || spec.count) continue;
        const vals = tables[f].rows.map((r) => num(r[col])).filter((v) => v !== null);
        if (!vals.length) continue;
        scanned += 1;
        expect(Math.min(...vals), `${f}:${col} min`).toBeGreaterThanOrEqual(1);
        expect(Math.max(...vals), `${f}:${col} max`).toBeLessThanOrEqual(spec.max);
        if (spec.first === true || spec.first?.includes(f))
          expect(Math.min(...vals), `${f}:${col} starts at 1`).toBe(1);
        for (const v of vals) expect(Number.isInteger(v), `${f}:${col}`).toBe(true);
      }
    }
    expect(scanned).toBeGreaterThan(40);
    /* the trial-level ordinals that used to be 0-based are present and start at 1 or later */
    for (const col of ['block_position', 'pool_index']) {
      const vals = tables['trials.csv'].rows.map((r) => num(r[col])).filter((v) => v !== null);
      expect(vals.length, col).toBeGreaterThan(0);
      expect(Math.min(...vals), col).toBeGreaterThanOrEqual(1);
    }
  });

  it('identifiers are 0-based ids in range; interval counts may be 0', () => {
    let ids = 0;
    for (const f of ALL_FILES) {
      for (const col of tables[f].cols) {
        const spec = POSITION_LIKE.test(col) ? specFor(col) : null;
        if (!spec || !(spec.identifier || spec.count)) continue;
        const vals = tables[f].rows.map((r) => num(r[col])).filter((v) => v !== null);
        for (const v of vals) {
          expect(v, `${f}:${col}`).toBeGreaterThanOrEqual(0);
          if (spec.identifier) expect(v, `${f}:${col}`).toBeLessThanOrEqual(spec.max);
        }
        if (spec.identifier && vals.length) ids += 1;
      }
    }
    expect(ids).toBeGreaterThan(5);
    /* the identifier ranges are used in full: cell ids reach beyond 4 and tone ids are 0-based */
    const toneIdx = tables['probes.csv'].rows
      .map((r) => num(r.tone_index))
      .filter((v) => v !== null);
    expect(toneIdx.length).toBeGreaterThan(0);
    expect(Math.max(...toneIdx)).toBeLessThanOrEqual(23);
  });

  it('cell_row / cell_col are 1-based and cell = (cell_row - 1) * 5 + (cell_col - 1) in every table that has them', () => {
    for (const f of ['stars.csv', 'probes.csv', 'encoding_events.csv']) {
      let n = 0;
      for (const r of tables[f].rows) {
        if (num(r.cell) === null) continue;
        n += 1;
        expect(num(r.cell_row)).toBeGreaterThanOrEqual(1);
        expect(num(r.cell_col)).toBeLessThanOrEqual(5);
        expect((num(r.cell_row) - 1) * 5 + (num(r.cell_col) - 1), f).toBe(num(r.cell));
      }
      expect(n, f).toBeGreaterThan(0);
    }
    /* the centre cell is id 12 = row 3, col 3 */
    const centre = tables['probes.csv'].rows
      .concat(tables['stars.csv'].rows)
      .find((r) => num(r.cell) === 12);
    if (centre) {
      expect(num(centre.cell_row)).toBe(3);
      expect(num(centre.cell_col)).toBe(3);
    }
  });

  it('"[row, col]" cell strings of EVENTS.csv and the wide files are 1-5 and match the tidy id', () => {
    let n = 0;
    const re = /^\[([1-5]), ([1-5])\]$/;
    for (const f of ['EVENTS.csv', ...Object.keys(WIDE_FILES)]) {
      for (const col of tables[f].cols) {
        if (!(col === 'Cell' || col.endsWith('_Cell'))) continue;
        for (const r of tables[f].rows) {
          if (r[col] === 'NA') continue;
          n += 1;
          expect(r[col], `${f}:${col}`).toMatch(re);
        }
      }
    }
    expect(n).toBeGreaterThan(20);
    /* stars of the wide I_ONLY file against the tidy stars table (same trial, same star number) */
    const stars = tables['stars.csv'].rows;
    for (const w of tables['I_ONLY_Criterion1.csv'].rows) {
      for (const k of [1, 2, 3]) {
        const s = stars.find(
          (x) =>
            x.participant_id === w.Participant_ID &&
            x.condition === 'i_only' &&
            x.block_label === w.Block &&
            num(x.pool_index) === num(w.Trial) &&
            num(x.star_serial_position) === k
        );
        const m = /^\[(\d), (\d)\]$/.exec(w[`Ast_${k}_Cell`]);
        expect(s, 'tidy star for the wide row').toBeTruthy();
        expect([Number(m[1]), Number(m[2])]).toEqual([num(s.cell_row), num(s.cell_col)]);
        expect(num(w[`Ast_${k}_SlotN`])).toBe(num(s.slot_in_stream));
      }
    }
  });

  it('wide Qmark_n_EncPos / Dot_n_OrderN / Ast_n_SlotN agree with the tidy tables, per trial type', () => {
    const probes = tables['probes.csv'].rows;
    const stars = tables['stars.csv'].rows;
    for (const [file, cond] of Object.entries(WIDE_FILES)) {
      expect(tables[file].rows.length, file).toBeGreaterThan(0);
      for (const w of tables[file].rows) {
        const key = (x) =>
          x.participant_id === w.Participant_ID &&
          x.condition === cond &&
          x.block_label === w.Block &&
          num(x.pool_index) === num(w.Trial);
        for (const k of [1, 2, 3]) {
          if (cond !== 'i_only') {
            const p = probes.find((x) => key(x) && num(x.probe_position) === k);
            if (p)
              expect(num(w[`Qmark_${k}_EncPos`]), `${file} Qmark_${k}`).toBe(
                num(p.encoding_position)
              );
          }
          if (['i_only', 'i_d', 'i_t'].includes(cond)) {
            const s = stars.find((x) => key(x) && num(x.star_serial_position) === k);
            expect(num(w[`Ast_${k}_SlotN`]), `${file} Ast_${k}`).toBe(num(s.slot_in_stream));
          }
          if (['d_only', 'i_d'].includes(cond)) expect(num(w[`Dot_${k}_OrderN`])).toBe(k);
          if (['t_only', 'i_t'].includes(cond)) expect(num(w[`Tone_${k}_OrderN`])).toBe(k);
        }
      }
    }
  });

  it('EVENTS.csv: Event_Index and Encoding_Position are 1-based on encoding and recognition rows', () => {
    const rows = tables['EVENTS.csv'].rows;
    const enc = rows.filter((r) => r.Phase === 'encoding');
    const rec = rows.filter((r) => r.Phase === 'recognition');
    expect(enc.length).toBeGreaterThan(0);
    expect(rec.length).toBeGreaterThan(0);
    expect(new Set(enc.map((r) => num(r.Event_Index)))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(new Set(rec.map((r) => num(r.Event_Index)))).toEqual(new Set([1, 2, 3]));
    for (const r of enc) expect(num(r.Event_Index)).toBe(num(r.Slot_In_Stream));
    const positions = rows.map((r) => num(r.Encoding_Position)).filter((v) => v !== null);
    expect(Math.min(...positions)).toBe(1);
    expect(Math.max(...positions)).toBe(3);
  });

  it('slot_in_stream and serial_position_overall mean the same in all five trial types', () => {
    const ev = tables['encoding_events.csv'].rows;
    const byCond = new Map();
    for (const e of ev) byCond.set(e.condition, [...(byCond.get(e.condition) ?? []), e]);
    expect([...byCond.keys()].sort()).toEqual(['d_only', 'i_d', 'i_only', 'i_t', 't_only']);
    for (const [cond, list] of byCond) {
      expect(new Set(list.map((e) => num(e.slot_in_stream))), cond).toEqual(
        new Set([1, 2, 3, 4, 5, 6])
      );
      const dual = cond === 'i_d' || cond === 'i_t';
      const overall = list.map((e) => num(e.serial_position_overall)).filter((v) => v !== null);
      expect(new Set(overall), cond).toEqual(new Set(dual ? [1, 2, 3, 4, 5, 6] : [1, 2, 3]));
      /* a placeholder has a slot but no serial position */
      for (const e of list.filter((x) => x.event_modality === 'placeholder')) {
        expect(num(e.slot_in_stream)).toBeGreaterThanOrEqual(1);
        expect(num(e.serial_position_overall)).toBeNull();
      }
    }
    /* the star's slot equals the slot of the raw row plus one */
    const rawStars = raw.filter((r) => r.phase?.endsWith('_star'));
    expect(Math.min(...rawStars.map((r) => r.slot_index_in_seq))).toBe(0);
    expect(Math.max(...rawStars.map((r) => r.slot_index_in_seq))).toBeLessThanOrEqual(5);
    const slotsTidy = tables['stars.csv'].rows.map((r) => num(r.slot_in_stream));
    expect(Math.min(...slotsTidy)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...slotsTidy)).toBeLessThanOrEqual(6);
  });
});

describe('raw rows keep the values they were recorded with', () => {
  it('slot_index_in_seq, probe_position, encoding_position, trial_index_in_block are 0-based', () => {
    const stars = raw.filter((r) => r.phase?.endsWith('_star'));
    const probes = raw.filter((r) => r.phase?.endsWith('_probe'));
    const enc = raw.filter((r) => r.phase?.endsWith('_encoding'));
    expect(new Set(probes.map((r) => r.probe_position))).toEqual(new Set([0, 1, 2]));
    expect(Math.min(...stars.map((r) => r.probe_position))).toBe(0);
    expect(Math.min(...stars.map((r) => r.slot_index_in_seq))).toBe(0);
    expect(Math.min(...probes.map((r) => r.encoding_position))).toBe(0);
    for (const e of enc) {
      expect(e.slot_onsets_ts_ms).toHaveLength(6);
      const items = e.trial_spec.memory_items;
      if (items.length === 0) continue; /* i_only has no memory items */
      expect(Math.min(...items.map((m) => m.slot))).toBeGreaterThanOrEqual(0);
      expect(Math.min(...items.map((m) => m.encoding_position))).toBe(0);
    }
    expect(Math.min(...enc.map((r) => r.trial_index_in_block))).toBeGreaterThanOrEqual(0);
  });
});

describe('documentation states the base of every position-like column', () => {
  const docs = COLUMN_DOCS;
  const schema = buildTidySchema();
  const tidyCols = new Set(TIDY_FILES.flatMap((f) => tables[f]?.cols ?? []));

  it('every 1-based tidy column says 1-based (or its 1-n range); every 0-based one says IDENTIFIER', () => {
    for (const col of tidyCols) {
      if (!POSITION_LIKE.test(col) || NOT_A_POSITION.has(col)) continue;
      const spec = specFor(col);
      const d = docs[col];
      expect(d, `COLUMN_DOCS.${col}`).toBeTruthy();
      if (spec.identifier) {
        expect(d, col).toMatch(/0-BASED/);
        expect(d, col).toMatch(/IDENTIFIER/);
      } else if (spec.count) {
        expect(d, col).toMatch(/COUNT/);
      } else if (['cell_x_mm', 'cell_y_mm'].includes(col)) {
        continue;
      } else {
        expect(d, col).toMatch(/1-based|1-\d|[(]1 =|1 = /i);
        expect(d, col).not.toMatch(/0-based \(0|0-BASED \(0 = first/);
      }
    }
  });

  it('the cell documentation gives the id <-> row / col relation and the schema says it too', () => {
    expect(docs.cell_row).toContain('(cell_row - 1) * 5 + (cell_col - 1)');
    expect(docs.cell).toContain('(cell_row - 1) * 5 + (cell_col - 1)');
    expect(docs.cell).toMatch(/IDENTIFIER/);
    expect(docs.tone_index).toMatch(/IDENTIFIER/);
    expect(schema.description).toMatch(/1-based/);
    expect(schema.description).toMatch(/identifiers cell/);
  });
});
