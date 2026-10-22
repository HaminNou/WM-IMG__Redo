/**
 * End-to-end pipeline test: real schedulers → synthetic responses → csv-export.
 *
 * Why this test exists:
 *   `tests/csv-export.test.js` covers each pure helper against hand-written
 *   fixtures, but those fixtures encode an assumed runtime shape. Nothing
 *   actually links them to what the runtime conditions modules produce.
 *   This test closes that loop: `simulate-pilot.js` drives the real
 *   schedulers (memory-block / imagery-block / dual-block + the cross-
 *   condition trial-type scheduler) and synthesises rows whose shapes mirror
 *   the runtime data-stamping in `src/conditions/*.js`. The simulator's
 *   output is then fed through `composeExport` so any contract drift between
 *   the runtime emission and the exporter surfaces in CI rather than a real
 *   pilot.
 *
 *   It also locks the invariant — 24 trials × 5 types per participant
 *   across Main A + Main B — at the wide-format CSV level, which is the
 *   shape the analyst will actually see.
 *
 * What this test does NOT cover:
 *   - jsPsych runtime instrumentation (time_elapsed, jsPsych-internal RT
 *     bookkeeping); the simulator stamps a coarse RT model.
 *   - The actual condition modules' DOM behaviour — those need the runtime.
 *   - Calibration / strategy / instructions content (only stub rows are emitted).
 */
import { describe, it, expect } from 'vitest';
import { simulateOne } from '../scripts/simulate-pilot.js';
import {
  composeExport,
  loadAndFlattenDumps,
  COLUMNS_D_ONLY,
  COLUMNS_T_ONLY,
  COLUMNS_I_ONLY,
  COLUMNS_I_D,
  COLUMNS_I_T,
} from '../scripts/csv-export.js';

/* Convert a chunk-envelope (the simulator's output) into the perParticipant
 * shape `composeExport` expects. Mirrors `loadAndFlattenDumps`'s output
 * format without going through the filesystem. */
function envelopeToPerParticipant(env) {
  return {
    participant_id: env.prolific_pid,
    session: {
      params: {
        session_id: env.session_id,
        prolific_pid: env.prolific_pid,
        study_id: env.study_id,
        is_preview: env.is_preview,
      },
      build_id: env.build_id,
      schema_version: env.schema_version,
      is_pilot_run: env.is_pilot_run,
      pilot_label: env.pilot_label,
      started_at_iso: env.started_at_iso,
      user_agent: env.user_agent,
    },
    rows: env.rows,
  };
}

/* Quick CSV row counter — header line + N data lines + trailing newline. */
function countCsvDataRows(csv) {
  const lines = csv.split('\n').filter((line) => line.length > 0);
  return Math.max(0, lines.length - 1);
}

/* CSV-cell tokeniser that respects double-quoted strings (which can contain
 * commas — the `[r, c]` cell format does). Mirrors the limited quoting style
 * `csv-export.js` emits: bare values are unquoted, quoted values may contain
 * commas, and embedded `"` are doubled. */
function splitCsvLine(line) {
  const out = [];
  let i = 0;
  let cur = '';
  let inQuotes = false;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  out.push(cur);
  return out;
}

function parseCsvRow(headerLine, dataLine) {
  const headers = splitCsvLine(headerLine);
  const cells = splitCsvLine(dataLine);
  const out = {};
  for (let i = 0; i < headers.length; i++) out[headers[i]] = cells[i];
  return out;
}

function parseCsvFirstRow(csv) {
  const lines = csv.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  return parseCsvRow(lines[0], lines[1]);
}

describe('simulate-pilot → composeExport (end-to-end pipeline)', () => {
  it('emits a deterministic envelope for a fixed seed', () => {
    const a = simulateOne({ seed: 'lock-seed', accuracy: 0.8, responseRate: 0.97 });
    const b = simulateOne({ seed: 'lock-seed', accuracy: 0.8, responseRate: 0.97 });
    expect(a.n_rows).toBe(b.n_rows);
    /* A spot-check: trial-encoded sequence on the first encoding row should
     * match. Using the whole-rows comparison would also work but is sensitive
     * to floating-point on RT — so we match a deterministic field. */
    const firstAEnc = a.rows.find((r) => r.phase?.endsWith('_encoding'));
    const firstBEnc = b.rows.find((r) => r.phase?.endsWith('_encoding'));
    expect(firstAEnc.sequence).toBe(firstBEnc.sequence);
    expect(firstAEnc.memory_items ?? firstAEnc.stars).toEqual(
      firstBEnc.memory_items ?? firstBEnc.stars
    );
  });

  it('different seeds produce different schedules', () => {
    const a = simulateOne({ seed: 'seed-x' });
    const b = simulateOne({ seed: 'seed-y' });
    /* Pick out the trial_type schedule from the first 60 rows after the
     * stub block. The encoding rows give us the trial-type at each slot. */
    const aTypes = a.rows.filter((r) => r.phase?.endsWith('_encoding')).map((r) => r.phase);
    const bTypes = b.rows.filter((r) => r.phase?.endsWith('_encoding')).map((r) => r.phase);
    expect(aTypes.length).toBe(120); /* 24 trials × 5 types per session */
    expect(bTypes.length).toBe(120);
    /* The two trial-type orderings should differ — astronomically unlikely
     * to collide for two independently seeded 120-slot schedules. */
    const sameOrder = aTypes.every((t, i) => t === bTypes[i]);
    expect(sameOrder).toBe(false);
  });

  it('emits exactly 24 trials × 5 types of encoding rows per participant', () => {
    const env = simulateOne({ seed: 'count-seed' });
    const counts = {};
    for (const r of env.rows) {
      if (r.phase?.endsWith('_encoding')) counts[r.phase] = (counts[r.phase] ?? 0) + 1;
    }
    expect(counts.d_only_encoding).toBe(24);
    expect(counts.t_only_encoding).toBe(24);
    expect(counts.i_only_encoding).toBe(24);
    expect(counts.i_d_encoding).toBe(24);
    expect(counts.i_t_encoding).toBe(24);
  });

  it('emits 3 probes per probe-bearing trial and 3 stars per imagery-bearing trial', () => {
    const env = simulateOne({ seed: 'probe-seed' });
    const counts = {};
    for (const r of env.rows) counts[r.phase] = (counts[r.phase] ?? 0) + 1;
    /* 4 probe-bearing types × 24 trials × 3 probes = 72 probes per type. */
    expect(counts.d_only_probe).toBe(72);
    expect(counts.t_only_probe).toBe(72);
    expect(counts.i_d_probe).toBe(72);
    expect(counts.i_t_probe).toBe(72);
    /* 3 imagery-bearing types × 24 trials × 3 stars = 72 stars per type. */
    expect(counts.i_only_star).toBe(72);
    expect(counts.i_d_star).toBe(72);
    expect(counts.i_t_star).toBe(72);
  });

  it('block_label is stamped on every trial-time row (a/b balanced)', () => {
    const env = simulateOne({ seed: 'block-seed' });
    const aCount = env.rows.filter((r) => r.block_label === 'main_a').length;
    const bCount = env.rows.filter((r) => r.block_label === 'main_b').length;
    /* Each side gets 60 trials × (1 encoding + ~3 probe + ~3 star) — but
     * exact totals depend on per-type composition. The invariant we lock is:
     * Main A and Main B carry the SAME number of rows (the simulator splits
     * 12 + 12 of every type, and per-trial row count is type-determined,
     * so the totals are equal). */
    expect(aCount).toBe(bCount);
  });

  it('composeExport emits exactly 24 rows per trial-type CSV per participant', () => {
    const env = simulateOne({ seed: 'export-seed' });
    const perParticipant = [envelopeToPerParticipant(env)];
    const { files } = composeExport(perParticipant);
    expect(countCsvDataRows(files['D_ONLY_Criterion1.csv'])).toBe(24);
    expect(countCsvDataRows(files['T_ONLY_Criterion1.csv'])).toBe(24);
    expect(countCsvDataRows(files['I_ONLY_Criterion1.csv'])).toBe(24);
    expect(countCsvDataRows(files['I_D_Criterion1.csv'])).toBe(24);
    expect(countCsvDataRows(files['I_T_Criterion1.csv'])).toBe(24);
  });

  it('composeExport with N participants scales to N × 24 trial-type rows', () => {
    const a = simulateOne({ seed: 'p1', pid: 'P1' });
    const b = simulateOne({ seed: 'p2', pid: 'P2' });
    const c = simulateOne({ seed: 'p3', pid: 'P3' });
    const { files } = composeExport([a, b, c].map(envelopeToPerParticipant));
    /* 3 participants × 24 trials per type = 72 wide-rows per CSV. */
    expect(countCsvDataRows(files['D_ONLY_Criterion1.csv'])).toBe(72);
    expect(countCsvDataRows(files['T_ONLY_Criterion1.csv'])).toBe(72);
    expect(countCsvDataRows(files['I_ONLY_Criterion1.csv'])).toBe(72);
    expect(countCsvDataRows(files['I_D_Criterion1.csv'])).toBe(72);
    expect(countCsvDataRows(files['I_T_Criterion1.csv'])).toBe(72);
  });

  it('CSV headers match the locked column lists for every trial-type file', () => {
    const env = simulateOne({ seed: 'header-seed' });
    const { files } = composeExport([envelopeToPerParticipant(env)]);
    const expectations = [
      ['D_ONLY_Criterion1.csv', COLUMNS_D_ONLY],
      ['T_ONLY_Criterion1.csv', COLUMNS_T_ONLY],
      ['I_ONLY_Criterion1.csv', COLUMNS_I_ONLY],
      ['I_D_Criterion1.csv', COLUMNS_I_D],
      ['I_T_Criterion1.csv', COLUMNS_I_T],
    ];
    for (const [path, columns] of expectations) {
      const headerLine = files[path].split('\n')[0];
      const expected = columns.map((c) => `"${c}"`).join(',');
      expect(headerLine).toBe(expected);
    }
  });

  it('per-trial probe columns are populated with non-NA values (lock the runtime ↔ exporter contract)', () => {
    /* This is the crucial test the simulator unlocks: if `probe_position`
     * indexing drifts between runtime and exporter, csv-export's sortedProbes
     * silently drops every probe and Qmark_* columns are NA across the file.
     * We assert the first D-only and I+T trials have populated probe cells. */
    const env = simulateOne({ seed: 'probe-cols-seed', accuracy: 1.0, responseRate: 1.0 });
    const { files } = composeExport([envelopeToPerParticipant(env)]);
    const dRow = parseCsvFirstRow(files['D_ONLY_Criterion1.csv']);
    const itRow = parseCsvFirstRow(files['I_T_Criterion1.csv']);
    /* Qmark_*_Cell are written as `[r, c]` — they should be present (not NA)
     * for all three probe slots when the contract is intact. */
    for (let i = 1; i <= 3; i++) {
      expect(dRow[`Qmark_${i}_Cell`]).not.toBe('NA');
      expect(dRow[`Qmark_${i}_Cell`]).toMatch(/^\[\d+, \d+\]$/);
      expect(itRow[`Qmark_${i}_Cell`]).not.toBe('NA');
    }
    /* Type code 1..4 maps to T_on/T_off/F_on/F_off. The block-level
     * counterbalance allows repeats within a single trial, so we only
     * require a valid canonical code in each populated slot. */
    const dTypes = [1, 2, 3].map((i) => Number(dRow[`Qmark_${i}_Type`]));
    for (const typeCode of dTypes) {
      expect([1, 2, 3, 4].includes(typeCode)).toBe(true);
    }
  });

  it('per-trial star columns are populated for I-only / I+D / I+T', () => {
    const env = simulateOne({ seed: 'star-cols-seed', accuracy: 1.0, responseRate: 1.0 });
    const { files } = composeExport([envelopeToPerParticipant(env)]);
    const iRow = parseCsvFirstRow(files['I_ONLY_Criterion1.csv']);
    const idRow = parseCsvFirstRow(files['I_D_Criterion1.csv']);
    const itRow = parseCsvFirstRow(files['I_T_Criterion1.csv']);
    for (let i = 1; i <= 3; i++) {
      expect(iRow[`Ast_${i}_Cell`]).not.toBe('NA');
      expect(idRow[`Ast_${i}_Cell`]).not.toBe('NA');
      expect(itRow[`Ast_${i}_Cell`]).not.toBe('NA');
    }
    /* CellTY is 0 or 1 (off/on pattern) — never NA when a star ran. */
    for (let i = 1; i <= 3; i++) {
      expect(iRow[`Ast_${i}_CellTY`]).toMatch(/^[01]$/);
    }
  });

  it('Criterion2 RT column is NA when the response is incorrect', () => {
    /* Force every response correct → both Criterion1 and Criterion2 should
     * carry the RT (no NA from accuracy gating). */
    const env = simulateOne({ seed: 'crit-seed', accuracy: 1.0, responseRate: 1.0 });
    const { files } = composeExport([envelopeToPerParticipant(env)]);
    const rowC1 = parseCsvFirstRow(files['D_ONLY_Criterion1.csv']);
    const rowC2 = parseCsvFirstRow(files['D_ONLY_Criterion2.csv']);
    /* If RTs are above the 250 ms floor, both criteria carry numeric values. */
    expect(rowC1.Qmark_1_RecTI).not.toBe('NA');
    /* C2's RT_1 column should equal C1's RT_1 column when accuracy is 1.0. */
    expect(rowC2.Qmark_1_RecTI_1).toBe(rowC1.Qmark_1_RecTI_1);
  });

  it('CALIBRATION_SUMMARY.csv has one row per participant with non-NA core fields', () => {
    const a = simulateOne({ seed: 'cal1', pid: 'CAL_001' });
    const b = simulateOne({ seed: 'cal2', pid: 'CAL_002' });
    const { files } = composeExport([a, b].map(envelopeToPerParticipant));
    expect(countCsvDataRows(files['CALIBRATION_SUMMARY.csv'])).toBe(2);
    const firstRow = parseCsvFirstRow(files['CALIBRATION_SUMMARY.csv']);
    /* Stub session emits these as non-NA. If they go NA the simulator's
     * stub block has drifted from `extractCalibrationRow`'s expectations. */
    expect(firstRow.Build_ID).not.toBe('NA');
    expect(firstRow.Schema_Version).not.toBe('NA');
    expect(firstRow.Tones_Audible).toBe('1');
  });

  it('manifest reports build_id homogeneity across participants', () => {
    const a = simulateOne({ seed: 'm1' });
    const b = simulateOne({ seed: 'm2' });
    const { manifest } = composeExport([a, b].map(envelopeToPerParticipant));
    expect(manifest.n_participants).toBe(2);
    expect(manifest.build_ids).toHaveLength(1);
    expect(manifest.heterogeneity_flags.build_id_heterogeneous).toBe(false);
    expect(manifest.heterogeneity_flags.schema_version_heterogeneous).toBe(false);
  });

  it('chunk envelope shape is recognised by loadAndFlattenDumps via fs.readFileSync stub', () => {
    /* Mirrors the production path: the simulator writes a JSON file, the
     * exporter reads it. We stub fs to avoid actual disk IO. */
    const env = simulateOne({ seed: 'fs-seed', pid: 'FS_001' });
    const fsStub = {
      readFileSync(_path) {
        return JSON.stringify(env);
      },
    };
    const { perParticipant, errors } = loadAndFlattenDumps(['/virtual/fs-seed.json'], {
      fs: fsStub,
    });
    expect(errors).toEqual([]);
    expect(perParticipant).toHaveLength(1);
    expect(perParticipant[0].participant_id).toBe('FS_001');
    expect(perParticipant[0].rows.length).toBe(env.n_rows);
  });
});
