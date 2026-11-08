// @vitest-environment jsdom
/**
 * Encoding-event table (encoding_events.csv), serial positions in the stars and probes
 * tables, and the 1-based companions in EVENTS.csv.
 *
 * The rows are the real ones: the real condition nodes (src/conditions/*) run through
 * jsPsych on a fake clock (tests/helpers/real-rows.js), five trial types, three seeds,
 * both background shades, rotations 0, negative and positive. Every expectation is
 * recomputed here from the raw rows, the sequence string and the grid geometry, not
 * from the exporter's own helpers.
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
import { patternLabel } from '../src/grid.js';
import { realSessionRows, REAL_FAKE_TIMERS } from './helpers/real-rows.js';
import {
  composeTidyTables,
  duplicateKeys,
  buildTidySchema,
  TIDY_KEYS,
  TIDY_VERSION,
  TIDY_FILES,
  TRIALS_COLUMNS,
  STARS_COLUMNS,
  PROBES_COLUMNS,
  EVENTS_COLUMNS,
} from '../scripts/tidy-tables.js';
import { composeExport } from '../scripts/csv-export.js';
import { simulateOne } from '../scripts/simulate-pilot.js';

const DUAL = new Set(['i_d', 'i_t']);
const ANGLES = [0, -45, 77]; // zero, negative, positive, cycled over the trials of a condition
const SEEDS = [
  ['ev-seed-a', 'white'],
  ['ev-seed-b', 'gray'],
  ['ev-seed-c', 'white'],
];

/* ---- independent geometry: 5x5 grid, 10 mm cells, centre (cell 12) at fixation ---- */
const CELL_MM = 10;
const upright = (cell) => ({
  x: ((cell % 5) - 2) * CELL_MM,
  y: (Math.floor(cell / 5) - 2) * CELL_MM,
});
/* y points down, so a positive angle is clockwise on screen */
function rotated(cell, deg) {
  const a = (deg * Math.PI) / 180;
  const { x, y } = upright(cell);
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
}
const near = (a, b) => Math.abs(a - b) < 0.002;

/** Ordinal among the visible stimuli of a trial, from the sequence string alone. */
function overallFromSequence(cond, sequence, slot) {
  const visible = DUAL.has(cond) ? 'MS' : cond === 'i_only' ? 'S' : 'M';
  let n = 0;
  for (let i = 0; i <= slot; i++) if (visible.includes(sequence[i])) n += 1;
  return visible.includes(sequence[slot]) ? n : null;
}

/** Minimal CSV reader (quoted fields, doubled quotes). */
function parseCsv(text) {
  const rows = [];
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
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const participants = [];
let tidy;

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
    participants.push({ participant_id: `P_${seed}`, session: {}, rows });
  }
  vi.useRealTimers();
  tidy = composeTidyTables(participants);
}, 600000);

const trialKey = (r) => `${r.participant_id}|${r.trial_seq_session}`;
function groupBy(rows, fn) {
  const m = new Map();
  for (const r of rows) m.set(fn(r), [...(m.get(fn(r)) ?? []), r]);
  return m;
}

describe('realistic input', () => {
  it('covers all five trial types, both shades, rotations 0, negative and positive', () => {
    expect(tidy.trials).toHaveLength(SEEDS.length * 5 * 3);
    expect(new Set(tidy.trials.map((t) => t.condition)).size).toBe(5);
    expect(new Set(tidy.trials.map((t) => t.background_shade))).toEqual(new Set(['white', 'gray']));
    const angles = tidy.trials.map((t) => t.rotation_deg).filter((a) => a !== null);
    expect(angles).toContain(0);
    expect(angles.some((a) => a < 0)).toBe(true);
    expect(angles.some((a) => a > 0)).toBe(true);
    /* the harness runs the first trials of each condition, not the whole schedule, so the
     * stamped presentation index differs from the count: that is the only issue expected */
    expect(new Set(tidy.issues.map((i) => i.issue))).toEqual(
      new Set(['presentation_index_mismatch'])
    );
  });
});

describe('events table: structure', () => {
  const byTrial = () => groupBy(tidy.events, trialKey);

  it('has 6 rows per trial, slots 1-6, unique keys, and the declared version', () => {
    expect(TIDY_VERSION).toBe('1.1.0');
    expect(tidy.events).toHaveLength(tidy.trials.length * 6);
    for (const t of tidy.trials) {
      const ev = byTrial().get(trialKey(t));
      expect(ev.map((e) => e.slot_in_stream).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    }
    expect(duplicateKeys(tidy.events, TIDY_KEYS.events)).toEqual([]);
  });

  it('serial_position_overall is a permutation of 1-6 (dual) or 1-3 (single), visible only', () => {
    for (const t of tidy.trials) {
      const ev = byTrial().get(trialKey(t));
      const vis = ev.filter((e) => e.is_visible_stimulus);
      const n = DUAL.has(t.condition) ? 6 : 3;
      expect(vis.map((e) => e.serial_position_overall).sort()).toEqual(
        Array.from({ length: n }, (_, i) => i + 1)
      );
      for (const e of ev) {
        expect(e.n_visible_stimuli).toBe(n);
        if (e.event_modality === 'placeholder') {
          expect(e.is_visible_stimulus).toBe(false);
          expect(e.serial_position_overall).toBeNull();
          expect(e.serial_position_in_modality).toBeNull();
          expect(e.cell).toBeNull();
          expect(e.x_mm).toBeNull();
          expect(e.pattern_label).toBeNull();
          expect(e.position_frame).toBe('invisible');
        }
      }
      /* the order in the stream is the order of the serial positions */
      const bySlot = [...vis].sort((a, b) => a.slot_in_stream - b.slot_in_stream);
      expect(bySlot.map((e) => e.serial_position_overall)).toEqual(
        Array.from({ length: n }, (_, i) => i + 1)
      );
      /* modalities as designed */
      const mods = ev.map((e) => e.event_modality).sort();
      const memory = t.condition.endsWith('_d') || t.condition === 'd_only' ? 'dot' : 'tone';
      const want =
        t.condition === 'i_only'
          ? ['placeholder', 'placeholder', 'placeholder', 'star', 'star', 'star']
          : DUAL.has(t.condition)
            ? [memory, memory, memory, 'star', 'star', 'star']
            : ['placeholder', 'placeholder', 'placeholder', memory, memory, memory];
      expect(mods).toEqual(want.sort());
    }
  });

  it('modality ranks are 1-3 within each kind, in stream order', () => {
    for (const ev of byTrial().values()) {
      for (const m of ['dot', 'tone', 'star']) {
        const rows = ev
          .filter((e) => e.event_modality === m)
          .sort((a, b) => a.slot_in_stream - b.slot_in_stream);
        if (rows.length) expect(rows.map((e) => e.serial_position_in_modality)).toEqual([1, 2, 3]);
      }
    }
  });

  it('slot kinds follow the sequence string', () => {
    for (const t of tidy.trials) {
      for (const e of byTrial().get(trialKey(t))) {
        expect(e.slot_plan_kind).toBe(t.sequence[e.slot_in_stream - 1]);
        expect(e.serial_position_overall).toBe(
          overallFromSequence(t.condition, t.sequence, e.slot_in_stream - 1)
        );
      }
    }
  });
});

describe('stars table: serial positions', () => {
  it('overall position is the rank among all visible stimuli, recomputed from the sequence', () => {
    const stars = tidy.stars;
    expect(stars.length).toBe(SEEDS.length * 3 * 3 * 3); // 3 star conditions x 3 trials x 3 stars
    for (const s of stars) {
      const seq = s.sequence;
      expect(seq[s.slot_in_stream - 1]).toBe('S');
      expect(s.serial_position_overall).toBe(
        overallFromSequence(s.condition, seq, s.slot_in_stream - 1)
      );
      expect(s.slot_in_stream).toBe(s.slot);
      expect(s.serial_position_in_modality).toBe(s.star_serial_position);
      const rankAmongStars = [...seq.slice(0, s.slot_in_stream)].filter((c) => c === 'S').length;
      expect(s.star_serial_position).toBe(rankAmongStars);
    }
    /* the case the researcher warned about: a star that is not first among the stimuli */
    expect(
      stars.some((s) => DUAL.has(s.condition) && s.serial_position_overall > s.star_serial_position)
    ).toBe(true);
  });
});

describe('hand-written sequences', () => {
  /* a trial_spec written by hand, to pin the definition independent of the scheduler */
  function trialRows(sequence, cond = 'i_d') {
    const mem = [];
    const stars = [];
    const dummies = [];
    let mi = 0;
    let si = 0;
    [...sequence].forEach((c, slot) => {
      if (c === 'M') mem.push({ slot, encoding_position: mi++, cell: 6 + mi, pattern_label: 'on' });
      else stars.push({ slot, probe_position: si++, cell: 16 + si, pattern_label: 'off' });
    });
    return [
      { phase: `${cond}_trial_start`, block_label: 'main_a', pool_index: 0, seq: 1 },
      {
        phase: `${cond}_encoding`,
        block_label: 'main_a',
        seq: 2,
        encoding_onset_ts_ms: 1000,
        sequence,
        rotation_deg: 0,
        slot_onsets_ts_ms: [1000, 2500, 4000, 5500, 7000, 8500],
        trial_spec: {
          condition: cond,
          rotation_deg: 0,
          sequence,
          memory_items: mem,
          stars,
          dummies,
          probes: [
            {
              probe_position: 0,
              encoding_position: 2,
              type: 'T_on',
              cell: 9,
              is_target: true,
              pattern_label: 'on',
            },
          ],
        },
      },
    ];
  }
  it("'SMMSMS': the 2nd star is the 4th stimulus; 'MMMSSS': the 1st star is the 4th", () => {
    let t = composeTidyTables([{ participant_id: 'H', session: {}, rows: trialRows('SMMSMS') }]);
    expect(t.stars.map((s) => [s.star_serial_position, s.serial_position_overall])).toEqual([
      [1, 1],
      [2, 4],
      [3, 6],
    ]);
    t = composeTidyTables([{ participant_id: 'H', session: {}, rows: trialRows('MMMSSS') }]);
    expect(t.stars.map((s) => [s.star_serial_position, s.serial_position_overall])).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
    /* the target of the hand-written probe is memory item 3 = the 3rd dot = slot 5 of 'SMMSMS' */
    t = composeTidyTables([{ participant_id: 'H', session: {}, rows: trialRows('SMMSMS') }]);
    const p = t.probes[0];
    expect([p.target_slot_in_stream, p.target_serial_position_overall]).toEqual([5, 5]);
    expect(p.target_serial_position_in_modality).toBe(3);
    expect(p.target_event_key).toBe('H|1|5');
  });
  it('a runtime tone error (field `error`) is flagged on the tone event', () => {
    const rows = trialRows('MSMSMS', 'i_t');
    rows[1].slot_tone_events = [
      { slot: 0, planned_ts_ms: 1000, late: true, late_ms: 12, error: 'ctx closed' },
      { slot: 2, planned_ts_ms: 4000, late: false, late_ms: 0, error: null },
    ];
    const ev = composeTidyTables([{ participant_id: 'H', session: {}, rows }]).events;
    expect(ev.find((e) => e.slot_in_stream === 1)).toMatchObject({
      event_modality: 'tone',
      tone_error: true,
      tone_late: true,
      tone_late_ms: 12,
      tone_planned_onset_ms: 0,
    });
    expect(ev.find((e) => e.slot_in_stream === 3).tone_error).toBe(false);
    expect(ev.find((e) => e.slot_in_stream === 5).tone_event_recorded).toBe(false);
    expect(ev.find((e) => e.slot_in_stream === 5).tone_error).toBeNull();
  });
});

describe('probes table: target columns', () => {
  const events = () => groupBy(tidy.events, trialKey);

  it('every target points at the events row of the item with the same cell', () => {
    const targets = tidy.probes.filter((p) => p.is_target);
    expect(targets.length).toBeGreaterThan(0);
    for (const p of targets) {
      const ev = events().get(trialKey(p));
      const match = ev.filter((e) => e.is_visible_stimulus && e.cell === p.cell);
      const item = match.find((e) => e.event_modality === p.modality);
      expect(item, `${trialKey(p)} cell ${p.cell}`).toBeTruthy();
      expect(match.filter((e) => e.event_modality === p.modality)).toHaveLength(1);
      expect(p.target_slot_in_stream).toBe(item.slot_in_stream);
      expect(p.target_slot).toBe(item.slot_in_stream);
      expect(p.target_serial_position_overall).toBe(item.serial_position_overall);
      expect(p.target_serial_position_overall).toBe(
        overallFromSequence(p.condition, p.sequence, item.slot_in_stream - 1)
      );
      expect(p.target_serial_position_in_modality).toBe(item.serial_position_in_modality);
      expect(p.target_serial_position_in_modality).toBe(p.encoding_position);
      expect(p.target_event_key).toBe(
        `${p.participant_id}|${p.trial_seq_session}|${item.slot_in_stream}`
      );
      /* and the item row carries this test */
      expect(item.tested_later).toBe(true);
      expect(item.test_position).toBe(p.test_position);
      expect(item.test_probe_type).toBe(p.probe_type);
      expect(item.test_correct).toBe(p.probe_correct);
      expect(item.test_rt_ms).toBe(p.rt_ms);
      expect(item.test_said_yes).toBe(p.said_yes);
    }
  });

  it('foils have NA target_* columns; the design label stays on encoding_position', () => {
    const foils = tidy.probes.filter((p) => !p.is_target);
    expect(foils.length).toBeGreaterThan(0);
    for (const p of foils) {
      for (const c of [
        'target_slot',
        'target_slot_in_stream',
        'target_serial_position_overall',
        'target_serial_position_in_modality',
        'target_event_key',
      ])
        expect(p[c], c).toBeNull();
      expect([1, 2, 3]).toContain(p.encoding_position);
    }
  });

  it('test_position is a permutation of 1-3, equals probe_position, and is not the encoding order', () => {
    const probes = groupBy(tidy.probes, trialKey);
    for (const pr of probes.values()) {
      expect(pr.map((p) => p.test_position).sort()).toEqual([1, 2, 3]);
      for (const p of pr) expect(p.test_position).toBe(p.probe_position);
    }
    const targets = tidy.probes.filter((p) => p.is_target);
    /* tests come in random order: some target's test position differs from its encoding position */
    expect(targets.some((p) => p.test_position !== p.target_serial_position_in_modality)).toBe(
      true
    );
    expect(targets.some((p) => p.test_position !== p.target_serial_position_overall)).toBe(true);
  });

  it('items never tested are marked so, with empty test columns; tested items = target probes', () => {
    const nTargets = tidy.probes.filter((p) => p.is_target).length;
    const memory = tidy.events.filter(
      (e) => e.event_modality === 'dot' || e.event_modality === 'tone'
    );
    expect(memory.filter((e) => e.tested_later === true)).toHaveLength(nTargets);
    const untested = memory.filter((e) => e.tested_later === false);
    expect(untested.length).toBeGreaterThan(0); // the design has foil tests, so not every item is tested
    for (const e of untested) {
      expect(e.test_position).toBeNull();
      expect(e.test_correct).toBeNull();
    }
    for (const e of tidy.events.filter(
      (x) => x.event_modality === 'star' || !x.is_visible_stimulus
    ))
      expect(e.tested_later).toBeNull();
  });
});

describe('positions and on/off labels recomputed from geometry', () => {
  it('dots and stars: x/y, upright cell position, rotation and pattern label', () => {
    let n = 0;
    for (const e of tidy.events.filter(
      (x) => x.event_modality === 'dot' || x.event_modality === 'star'
    )) {
      const rot = e.rotation_deg ?? 0;
      const u = upright(e.cell);
      const r = rotated(e.cell, rot);
      expect(near(e.cell_x_mm, u.x) && near(e.cell_y_mm, u.y), 'upright').toBe(true);
      expect(near(e.x_mm, r.x) && near(e.y_mm, r.y), `rot ${rot}`).toBe(true);
      expect(e.stimulus_rotation_deg).toBe(rot);
      expect(e.position_frame).toBe('rotated_screen');
      expect(e.pattern_label).toBe(patternLabel(e.cell));
      expect(e.is_on_pattern).toBe(patternLabel(e.cell) === 'on');
      expect(e.position_matches_runtime).toBe(true);
      n += 1;
    }
    /* dots are in d_only, i_d; stars in i_only, i_d, i_t: 5 condition-slots x 3 trials x 3 items */
    expect(n).toBe(SEEDS.length * 5 * 3 * 3);
  });

  it('tones have no screen position; the cell label is the upright cell, rotation is not applied', () => {
    const tones = tidy.events.filter((e) => e.event_modality === 'tone');
    expect(tones.length).toBe(SEEDS.length * 2 * 3 * 3);
    for (const e of tones) {
      expect(e.x_mm).toBeNull();
      expect(e.y_mm).toBeNull();
      expect(e.position_frame).toBe('none');
      expect(e.stimulus_rotation_deg).toBeNull();
      const u = upright(e.cell);
      expect(near(e.cell_x_mm, u.x) && near(e.cell_y_mm, u.y)).toBe(true);
      expect(e.pattern_label).toBe(patternLabel(e.cell));
      expect(Number.isInteger(e.tone_index)).toBe(true);
      expect(e.tone_freq_hz).toBeGreaterThan(0);
      expect(e.onset_source).toBe('tone_planned');
      expect(e.tone_event_recorded).toBe(true);
      expect(e.tone_error).toBe(false);
    }
  });

  it('probe screen positions (dots) also agree with the independent geometry', () => {
    for (const p of tidy.probes.filter((x) => x.modality === 'dot')) {
      const r = rotated(p.cell, p.probe_frame_rotation_deg);
      expect(near(p.x_mm, r.x) && near(p.y_mm, r.y)).toBe(true);
    }
  });
});

describe('onsets', () => {
  it('onset_ms is relative to encoding onset and onset_gap_ms is the difference to the previous slot', () => {
    for (const ev of groupBy(tidy.events, trialKey).values()) {
      ev.sort((a, b) => a.slot_in_stream - b.slot_in_stream);
      ev.forEach((e, i) => {
        expect(Number.isInteger(e.onset_ms)).toBe(true);
        if (i === 0) expect(e.onset_gap_ms).toBeNull();
        else expect(e.onset_gap_ms).toBe(e.onset_ms - ev[i - 1].onset_ms);
        if (i > 0) expect(e.onset_ms).toBeGreaterThan(ev[i - 1].onset_ms);
      });
    }
  });

  it('a star event takes its onset and response from the star row', () => {
    const stars = new Map(tidy.stars.map((s) => [`${trialKey(s)}|${s.slot_in_stream}`, s]));
    for (const e of tidy.events.filter((x) => x.event_modality === 'star')) {
      const s = stars.get(`${trialKey(e)}|${e.slot_in_stream}`);
      expect(e.onset_ms).toBe(s.star_onset_ms);
      expect(e.onset_source).toBe('star_row_frame');
      expect(e.star_row_recorded).toBe(true);
      expect(e.star_correct).toBe(s.star_correct);
      expect(e.star_said_on).toBe(s.said_on);
      expect(e.star_rt_ms).toBe(s.rt_ms);
      expect(e.star_displayed).toBe(true);
      expect(e.star_truncated).toBe(false);
      expect(e.cell).toBe(s.cell);
    }
  });
});

describe('joins: events <-> probes <-> stars', () => {
  it('no orphan and no duplicate keys', () => {
    for (const name of Object.keys(TIDY_KEYS))
      expect(duplicateKeys(tidy[name], TIDY_KEYS[name]), name).toEqual([]);
    const evKey = (e) => `${trialKey(e)}|${e.slot_in_stream}`;
    const events = new Map(tidy.events.map((e) => [evKey(e), e]));
    const trialKeys = new Set(tidy.trials.map(trialKey));
    for (const e of tidy.events) expect(trialKeys.has(trialKey(e))).toBe(true);
    for (const s of tidy.stars) {
      const e = events.get(`${trialKey(s)}|${s.slot_in_stream}`);
      expect(e?.event_modality).toBe('star');
      expect(e.serial_position_overall).toBe(s.serial_position_overall);
    }
    const starEvents = tidy.events.filter((e) => e.event_modality === 'star');
    expect(starEvents).toHaveLength(tidy.stars.length);
    const targets = tidy.probes.filter((p) => p.is_target);
    const joined = new Set();
    for (const p of targets) {
      expect(events.has(p.target_event_key)).toBe(true);
      expect(joined.has(p.target_event_key)).toBe(false); // one test per item
      joined.add(p.target_event_key);
    }
    expect(tidy.events.filter((e) => e.tested_later === true)).toHaveLength(joined.size);
  });
});

describe('export: files, schema and EVENTS.csv companions', () => {
  let exported;
  beforeAll(() => {
    exported = composeExport(participants, { generatedAtIso: '2000-01-01T00:00:00Z' });
  });

  it('writes encoding_events.csv next to (not over) EVENTS.csv; headers equal the schema', () => {
    expect(TIDY_FILES.events).toBe('encoding_events.csv');
    expect(exported.files['encoding_events.csv']).toBeTruthy();
    expect(exported.files['EVENTS.csv']).toBeTruthy();
    expect(new Set(Object.keys(exported.files).map((f) => f.toLowerCase())).size).toBe(
      Object.keys(exported.files).length
    );
    const schema = buildTidySchema();
    for (const [file, cols, def] of [
      ['trials.csv', TRIALS_COLUMNS, 'trial'],
      ['stars.csv', STARS_COLUMNS, 'star'],
      ['probes.csv', PROBES_COLUMNS, 'probe'],
      ['encoding_events.csv', EVENTS_COLUMNS, 'event'],
    ]) {
      const header = parseCsv(exported.files[file])[0];
      expect(header, file).toEqual(cols);
      expect(Object.keys(schema.$defs[def].properties), file).toEqual(cols);
      for (const c of cols) expect(schema.$defs[def].properties[c].description, c).not.toBe('');
    }
    expect(schema.version).toBe(TIDY_VERSION);
    expect(exported.manifest.tidy_tables.duplicate_keys.events).toEqual([]);
    const rows = parseCsv(exported.files['encoding_events.csv']);
    expect(rows.length - 1).toBe(tidy.events.length + (rows.at(-1).length === 1 ? -1 : 0));
  });

  it('EVENTS.csv keeps its 0-based Encoding_Position and gains 1-based companions', () => {
    const [header, ...body] = parseCsv(exported.files['EVENTS.csv']).filter((r) => r.length > 1);
    const col = (r, name) => r[header.indexOf(name)];
    expect(header).toEqual(
      expect.arrayContaining([
        'Slot_In_Stream',
        'Serial_Position_Overall',
        'Target_Serial_Position_Overall',
        'Pos_Frame',
      ])
    );
    /* EVENTS.csv is sorted by trial type, the tidy tables by session order: join on the
     * trial (Participant_ID, Block, Trial_Type, Trial = pool index + 1) and the slot. */
    const evKey = (e) =>
      `${e.participant_id}|${e.block_label}|${e.condition}|${e.pool_index + 1}|${e.slot_in_stream}`;
    const tidyEvents = new Map(tidy.events.map((e) => [evKey(e), e]));
    const enc = body.filter((r) => col(r, 'Phase') === 'encoding');
    expect(enc.length).toBe(tidy.events.length);
    for (const r of enc) {
      const e = tidyEvents.get(
        `${col(r, 'Participant_ID')}|${col(r, 'Block')}|${col(r, 'Trial_Type')}|${col(r, 'Trial')}|${col(r, 'Event_Index')}`
      );
      expect(e, 'joined to the tidy event').toBeTruthy();
      expect(Number(col(r, 'Slot_In_Stream'))).toBe(e.slot_in_stream);
      const sp = col(r, 'Serial_Position_Overall');
      expect(sp === 'NA' ? null : Number(sp)).toBe(e.serial_position_overall);
      const kind = col(r, 'Event_Kind');
      expect(kind === 'dummy_S' ? 'placeholder' : kind).toBe(e.event_modality);
      if (e.event_modality === 'dot' || e.event_modality === 'tone') {
        expect(Number(col(r, 'Encoding_Position'))).toBe(e.serial_position_in_modality - 1);
      }
      expect(col(r, 'Pos_Frame')).toBe(
        e.event_modality === 'tone'
          ? 'upright_cell'
          : e.event_modality === 'placeholder'
            ? 'placeholder'
            : 'rotated_screen'
      );
    }
    const probeKey = (p) =>
      `${p.participant_id}|${p.block_label}|${p.condition}|${p.pool_index + 1}|${p.probe_position}`;
    const tidyProbes = new Map(tidy.probes.map((p) => [probeKey(p), p]));
    const rec = body.filter((r) => col(r, 'Phase') === 'recognition');
    expect(rec.length).toBe(tidy.probes.length);
    for (const r of rec) {
      const p = tidyProbes.get(
        `${col(r, 'Participant_ID')}|${col(r, 'Block')}|${col(r, 'Trial_Type')}|${col(r, 'Trial')}|${col(r, 'Event_Index')}`
      );
      expect(p).toBeTruthy();
      const t = col(r, 'Target_Serial_Position_Overall');
      expect(t === 'NA' ? null : Number(t)).toBe(p.target_serial_position_overall);
      expect(col(r, 'Slot_In_Stream')).toBe('NA');
    }
  });
});

describe('a full simulated session', () => {
  it('has 6 events per trial (720), unique keys, and permutation checks hold', () => {
    const env = simulateOne({ seed: 'ev-full', pid: 'F1', accuracy: 0.8, responseRate: 1 });
    const t = composeTidyTables([{ participant_id: 'F1', session: env, rows: env.rows }]);
    expect(t.trials).toHaveLength(120);
    expect(t.events).toHaveLength(720);
    expect(duplicateKeys(t.events, TIDY_KEYS.events)).toEqual([]);
    for (const [, ev] of groupBy(t.events, trialKey)) {
      const vis = ev.filter((e) => e.is_visible_stimulus).map((e) => e.serial_position_overall);
      expect(vis.sort()).toEqual(vis.length === 6 ? [1, 2, 3, 4, 5, 6] : [1, 2, 3]);
    }
    expect(t.probes.filter((p) => p.is_target).every((p) => p.target_event_key !== null)).toBe(
      true
    );
  });
});
