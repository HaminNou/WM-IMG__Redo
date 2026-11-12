/**
 * scripts/raw-to-csv.js: the raw data of every participant in ONE CSV.
 *
 * Unit level: the derivations (stage, task, run status), the cell format, the independent CSV
 * reader and the verification pass (with deliberate corruptions), and the table built from files
 * laid out as Google Drive holds them (one subfolder per participant, the same rows in
 * checkpoint and bucket files, an abandoned first attempt, a screen-out). The command line is
 * tested separately in raw-to-csv-cli.test.js.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  CORE_RAW_COLUMNS,
  LEAD_COLUMNS,
  assignSubjects,
  readSubjectRegistry,
  DERIVED_COLUMNS,
  IDENTITY_COLUMNS,
  annotateSources,
  buildRawTable,
  cellValue,
  composeRawCsv,
  parseCsv,
  parseRawArgs,
  runStatusOf,
  seqGaps,
  serializeCsv,
  stageOf,
  taskOf,
  verifyCsv,
} from '../scripts/raw-to-csv.js';
import { expandInputPaths } from '../scripts/csv-export.js';
import { loadAndFlattenDumps } from '../scripts/dump-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('stageOf and taskOf', () => {
  const cases = [
    [{ phase: 'consent' }, 'setup', null],
    [{ phase: 'session_start' }, 'setup', null],
    [{ phase: 'screen_calibration_outcome' }, 'setup', null],
    [{ phase: 'timing_probe' }, 'setup', null],
    [{ phase: 'instructions_overview' }, 'instructions', null],
    [{ phase: 'practice_readiness' }, 'instructions', null],
    [{ phase: 'demo_i_d' }, 'instructions', null],
    [{ phase: 'attention_check' }, 'instructions', null],
    [{ phase: 'practice_iteration_start' }, 'practice', null],
    [{ phase: 'practice_feedback' }, 'practice', null],
    [
      { phase: 'd_only_probe', block_label: 'practice', is_practice: true, condition: 'd_only' },
      'practice',
      'd_only',
    ],
    [{ phase: 'i_t_star', block_label: 'main_a', condition: 'i_t' }, 'main', 'i_t'],
    [{ phase: 'i_only_encoding', block_label: 'main_b' }, 'main', 'i_only'],
    [{ phase: 'rest', block_label: 'intra_main_a' }, 'main', null],
    [{ phase: 'rest_resume_gate' }, 'main', null],
    [{ phase: 'main_a_intro' }, 'main', null],
    [{ phase: 'main_b_intro' }, 'main', null],
    [{ phase: 'pattern_phase', block_label: 'main_a' }, 'main', null],
    [{ phase: 'pattern_phase', block_label: 'practice' }, 'practice', null],
    [{ phase: 'strategy_i_d' }, 'questionnaire', null],
    [{ phase: 'music_experience' }, 'questionnaire', null],
    [{ phase: 'questionnaire_intro' }, 'questionnaire', null],
    [{ phase: 'end_of_task_intro' }, 'end', null],
    [{ phase: 'upload_session_end' }, 'end', null],
    [{ phase: 'completion_redirect' }, 'end', null],
    [{ phase: 'timing_probe_fail', exit_reason: 'timing_check_failed' }, 'end', null],
    [{ phase: 'display_guard_event' }, 'session_event', null],
    [{ phase: 'visibility_event' }, 'session_event', null],
    [{ phase: 'audio_state_change' }, 'session_event', null],
    [{ phase: 'unload_attempt' }, 'session_event', null],
    [{}, 'setup', null],
  ];
  it.each(cases)('%j -> stage %s, task %s', (row, stage, task) => {
    expect(stageOf(row)).toBe(stage);
    expect(taskOf(row)).toBe(task);
  });

  it('a condition field wins over the phase name for the task', () => {
    expect(taskOf({ phase: 'rest', condition: 'i_d' })).toBe('i_d');
    expect(taskOf({ phase: 'x', condition: 'not_a_task' })).toBeNull();
  });
});

describe('runStatusOf', () => {
  it('completed: a completion row and no screen-out exit', () => {
    expect(runStatusOf([{ phase: 'consent' }, { phase: 'completion_redirect' }])).toBe('completed');
  });
  it('screened_out: an exit row, even if a redirect row follows', () => {
    expect(
      runStatusOf([
        { phase: 'x', exit_reason: 'timing_check_failed' },
        { phase: 'completion_redirect' },
      ])
    ).toBe('screened_out');
  });
  it('incomplete: neither', () => {
    expect(runStatusOf([{ phase: 'consent' }, { phase: 'rest' }])).toBe('incomplete');
    expect(runStatusOf([])).toBe('incomplete');
  });
});

describe('seqGaps', () => {
  it('lists the missing ranges between the smallest and largest seq', () => {
    expect(seqGaps([{ seq: 1 }, { seq: 2 }, { seq: 5 }, { seq: 9 }, { seq: 10 }])).toEqual([
      [3, 4],
      [6, 8],
    ]);
    expect(seqGaps([{ seq: 4 }, { seq: 5 }])).toEqual([]);
    expect(seqGaps([{ seq: 7 }, { seq: 7 }])).toEqual([]);
    expect(seqGaps([{ phase: 'no seq' }])).toEqual([]);
  });
});

describe('CSV cells', () => {
  const tricky = [
    'plain',
    'with, comma',
    'say "quoted" twice ""',
    'line one\nline two',
    'carriage\r\nreturn',
    '=SUM(A1:A9)',
    '+1',
    '-1',
    '@cmd',
    '\tTAB',
    '',
    '  spaces  ',
    'ünï·cödé ✓ 漢字',
    'NA',
    '{"looks":"like json"}',
  ];
  const mk = () =>
    tricky.map((s, i) => ({
      row_key: `p|r|${i}`,
      text: s,
      n: [0, 1, -1, 0.1, 1e21, 123456789012345, -0.000001, 16.60000000000582, 3, 4, 5, 6, 7, 8, 9][
        i
      ],
      flag: i % 2 === 0,
      nothing: null,
      list: [1, [2, 3], { a: 'x,y' }],
      obj: { k: 'v\nw', n: null },
    }));
  const cols = ['row_key', 'text', 'n', 'flag', 'nothing', 'list', 'obj', 'absent'];

  it('writes numbers bare, booleans TRUE/FALSE, missing as bare NA, text quoted, JSON compact', () => {
    const csv = serializeCsv([mk()[0]], cols);
    const [header, line] = csv.trimEnd().split('\n');
    expect(header).toBe('"row_key","text","n","flag","nothing","list","obj","absent"');
    expect(line).toBe(
      '"p|r|0","plain",0,TRUE,NA,"[1,[2,3],{""a"":""x,y""}]","{""k"":""v\\nw"",""n"":null}",NA'
    );
  });

  it('every tricky value survives a write and an independent re-read', () => {
    const rows = mk();
    const csv = serializeCsv(rows, cols);
    expect(verifyCsv(csv, cols, rows)).toEqual([]);
    const records = parseCsv(csv);
    expect(records).toHaveLength(rows.length + 1);
    /* the text with a line break and the one with quotes come back byte for byte */
    expect(records[4][1]).toEqual({ text: 'line one\nline two', quoted: true });
    expect(records[3][1].text).toBe('say "quoted" twice ""');
  });

  it('protects text that a spreadsheet would run as a formula, and only text', () => {
    const rows = mk();
    const csv = serializeCsv(rows, cols);
    const rec = parseCsv(csv);
    const textOf = (i) => rec[i + 1][1].text;
    expect(textOf(5)).toBe("'=SUM(A1:A9)");
    expect(textOf(6)).toBe("'+1");
    expect(textOf(7)).toBe("'-1");
    expect(textOf(8)).toBe("'@cmd");
    expect(textOf(9)).toBe("'\tTAB");
    expect(rec[3][2]).toEqual({ text: '-1', quoted: false }); /* the number -1 is untouched */
    const raw = serializeCsv(rows, cols, { neutralise: false });
    expect(parseCsv(raw)[6][1].text).toBe('=SUM(A1:A9)');
    expect(verifyCsv(raw, cols, rows, { neutralise: false })).toEqual([]);
  });

  it('non-finite numbers become NA', () => {
    const rows = [
      { row_key: 'a', n: Number.NaN },
      { row_key: 'b', n: Number.POSITIVE_INFINITY },
    ];
    const csv = serializeCsv(rows, ['row_key', 'n']);
    expect(
      parseCsv(csv)
        .slice(1)
        .map((r) => r[1].text)
    ).toEqual(['NA', 'NA']);
  });

  it('cellValue turns lists and objects into JSON and leaves scalars alone', () => {
    expect(cellValue({ a: [1] })).toBe('{"a":[1]}');
    expect(cellValue([1, 2])).toBe('[1,2]');
    expect(cellValue(3)).toBe(3);
    expect(cellValue(null)).toBeNull();
    expect(cellValue('s')).toBe('s');
  });

  it('parseCsv reads CRLF files and rejects an unterminated quote', () => {
    expect(parseCsv('"a","b"\r\n1,"x"\r\n').map((r) => r.map((c) => c.text))).toEqual([
      ['a', 'b'],
      ['1', 'x'],
    ]);
    expect(() => parseCsv('"a","b\n')).toThrow(/unterminated/);
  });

  describe('verification catches corruption (negative controls)', () => {
    const rows = mk().slice(0, 4);
    const csv = serializeCsv(rows, cols);
    it('a changed number', () => {
      expect(verifyCsv(csv.replace(',0,TRUE', ',9,TRUE'), cols, rows).join()).toMatch(/column n/);
    });
    it('a changed text cell', () => {
      expect(verifyCsv(csv.replace('"plain"', '"plainX"'), cols, rows).join()).toMatch(
        /column text/
      );
    });
    it('a boolean flipped', () => {
      expect(verifyCsv(csv.replace(',TRUE,', ',FALSE,'), cols, rows).join()).toMatch(/column flag/);
    });
    it('NA turned into a quoted string', () => {
      expect(verifyCsv(csv.replace(',NA,"[', ',"NA","['), cols, rows).join()).toMatch(
        /column nothing/
      );
    });
    it('a missing line', () => {
      expect(verifyCsv(csv.split('\n').slice(0, 3).join('\n') + '\n', cols, rows).join()).toMatch(
        /CSV lines/
      );
    });
    it('a renamed header cell', () => {
      expect(verifyCsv(csv.replace('"flag"', '"flagx"'), cols, rows).join()).toMatch(/header/);
    });
    it('a duplicated row key', () => {
      const dup = [...rows, { ...rows[0] }];
      expect(verifyCsv(serializeCsv(dup, cols), cols, dup).join()).toMatch(/duplicate row_key/);
    });
    it('a truncated JSON cell', () => {
      expect(
        verifyCsv(csv.replace('{""a"":""x,y""}]', '{""a"":""x,y""}'), cols, rows).join()
      ).toMatch(/column list/);
    });
  });
});

describe('parseRawArgs', () => {
  const p = (...a) => parseRawArgs(['node', 'raw-to-csv.js', ...a]);
  it('reads every option and the input paths', () => {
    const o = p(
      '--out',
      'o.csv',
      '--analysed-runs-only',
      '--excel-bom',
      '--no-neutralise-formulas',
      '--salt-file',
      's',
      '--private-dir',
      'k',
      'dirA',
      'f.json'
    );
    expect(o).toMatchObject({
      out: 'o.csv',
      analysedRunsOnly: true,
      excelBom: true,
      neutralise: false,
      saltFile: 's',
      privateDir: 'k',
      keepPid: false,
    });
    expect(o.inputs).toEqual(['dirA', 'f.json']);
  });
  it('refuses unknown flags and --keep-pid with --share', () => {
    expect(() => p('--nope')).toThrow(/unknown flag/);
    expect(() => p('--keep-pid', '--share')).toThrow(/cannot be combined/);
  });
});

/* ---------- A folder laid out as Drive holds it ---------- */

const env = (who, run, bucket, rows, extra = {}) => ({
  session_id: who.session,
  prolific_pid: who.pid,
  study_id: 'STUDYX',
  is_preview: false,
  is_pilot_run: false,
  pilot_label: null,
  build_id: 'v1',
  schema_version: '1.2.0',
  run_id: run,
  bucket_id: bucket,
  bucket_label: bucket,
  rows: rows.map((r) => ({ run_id: run, wall_ms: 1_794_000_000_000 + (r.seq ?? 0) * 1000, ...r })),
  ...extra,
});
const A = { pid: 'PID_AAAAAAAAAAAA', session: 'SESS_AAAAAAAAAAAA' };
const B = { pid: 'PID_BBBBBBBBBBBB', session: 'SESS_BBBBBBBBBBBB' };
const C = { pid: 'PID_CCCCCCCCCCCC', session: 'SESS_CCCCCCCCCCCC' };

/* A: an abandoned first run r1 (3 rows), then the completed run r2 whose rows 3-6 appear in a
 * checkpoint AND in a bucket file. B: one run that stopped. C: screened out. */
const a1 = [
  { seq: 1, phase: 'session_start' },
  { seq: 2, phase: 'consent' },
  { seq: 3, phase: 'screen_calibration_start' },
];
const a2 = [
  { seq: 4, phase: 'session_start', prior_rows: 3, prior_run_ids: ['r1'] },
  {
    seq: 5,
    phase: 'd_only_trial_start',
    trial_uid: 'main_a-001-d_only',
    condition: 'd_only',
    block_label: 'main_a',
    is_practice: false,
  },
  {
    seq: 6,
    phase: 'd_only_probe',
    trial_uid: 'main_a-001-d_only',
    condition: 'd_only',
    block_label: 'main_a',
    rt: 812,
    response: 'arrowright',
    probe_correct: true,
    probed_cell: 7,
    note: 'say "hi", ok\nnext',
    flag: null,
    trial_spec: { probes: [{ cell: 7, is_target: true }], memory_items: [] },
    key_log: [
      [1, 'a'],
      [2, 'b'],
    ],
  },
  { seq: 7, phase: 'strategy_i_d', response: { q1: 3, q2: 5 } },
  { seq: 8, phase: 'completion_redirect', task: 'a raw column that is named like a derived one' },
];
const layout = {
  [`${A.session}/${A.session}__r1__partial_1-3.json`]: env(A, 'r1', 'partial', a1),
  [`${A.session}/${A.session}__r2__ckpt_4-7.json`]: env(A, 'r2', 'checkpoint', a2.slice(0, 4)),
  [`${A.session}/${A.session}__r2__03_d_only_s5-8.json`]: env(A, 'r2', 'd_only', a2.slice(1)),
  [`${B.session}/${B.session}__rb__ckpt_1-2.json`]: env(B, 'rb', 'checkpoint', [
    { seq: 1, phase: 'session_start' },
    { seq: 2, phase: 'consent' },
  ]),
  [`${C.session}/${C.session}__rc__10_meta_s1-3.json`]: env(C, 'rc', 'meta', [
    { seq: 1, phase: 'session_start' },
    { seq: 2, phase: 'timing_probe_fail', exit_reason: 'timing_check_failed' },
    { seq: 3, phase: 'completion_redirect' },
  ]),
};

describe('the table built from a Drive-style folder', () => {
  let dir;
  let loaded;
  let paths;
  let table;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'raw-to-csv-'));
    for (const [rel, body] of Object.entries(layout)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), JSON.stringify(body), 'utf-8');
    }
    paths = expandInputPaths([dir]);
    loaded = loadAndFlattenDumps(paths);
    annotateSources(loaded.perParticipant, paths);
    assignSubjects(loaded.perParticipant, join(dir, 'subjects.csv'));
    table = buildRawTable(loaded.perParticipant);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const byKey = (k) => table.rows.find((r) => r.row_key === k);

  it('finds the files in the subfolders and drops only the rows repeated across files', () => {
    expect(paths).toHaveLength(5);
    expect(loaded.errors).toEqual([]);
    expect(loaded.report.rows_read).toBe(3 + 4 + 4 + 2 + 3);
    expect(loaded.report.duplicates_dropped).toBe(3); /* rows 5-7 of run r2 are in two files */
    expect(table.rows).toHaveLength(3 + 5 + 2 + 3);
  });

  it('has one line per (participant, run, seq), each exactly once and in a stable order', () => {
    expect(new Set(table.rows.map((r) => r.row_key)).size).toBe(table.rows.length);
    expect(table.rows.map((r) => r.row_key)).toEqual([
      `${A.pid}|r1|1`,
      `${A.pid}|r1|2`,
      `${A.pid}|r1|3`,
      `${A.pid}|r2|4`,
      `${A.pid}|r2|5`,
      `${A.pid}|r2|6`,
      `${A.pid}|r2|7`,
      `${A.pid}|r2|8`,
      `${B.pid}|rb|1`,
      `${B.pid}|rb|2`,
      `${C.pid}|rc|1`,
      `${C.pid}|rc|2`,
      `${C.pid}|rc|3`,
    ]);
  });

  it('lays the columns out as documented: identity, derived, core raw, then the rest alphabetically', () => {
    const cols = table.columns;
    const lead = LEAD_COLUMNS.length;
    expect(cols.slice(0, lead)).toEqual(['subject']);
    expect(cols.slice(lead, lead + IDENTITY_COLUMNS.length)).toEqual([...IDENTITY_COLUMNS]);
    const dStart = lead + IDENTITY_COLUMNS.length;
    expect(cols.slice(dStart, dStart + DERIVED_COLUMNS.length)).toEqual([...DERIVED_COLUMNS]);
    const afterDerived = cols.slice(dStart + DERIVED_COLUMNS.length);
    const core = CORE_RAW_COLUMNS.filter((c) => afterDerived.includes(c));
    expect(afterDerived.slice(0, core.length)).toEqual(core);
    const rest = afterDerived.slice(core.length);
    expect(rest).toEqual([...rest].sort());
    expect(new Set(cols).size).toBe(cols.length);
    for (const c of ['rt', 'probe_correct', 'trial_spec', 'key_log', 'prior_rows', 'exit_reason']) {
      expect(cols).toContain(c);
    }
  });

  it('keeps every value of every raw row, and a column a row never carried is missing there', () => {
    const r = byKey(`${A.pid}|r2|6`);
    expect(r).toMatchObject({
      phase: 'd_only_probe',
      rt: 812,
      probe_correct: true,
      probed_cell: 7,
      response: 'arrowright',
    });
    expect(r.note).toBe('say "hi", ok\nnext');
    expect(r.trial_spec).toEqual({ probes: [{ cell: 7, is_target: true }], memory_items: [] });
    expect(r.key_log).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(r.flag).toBeNull();
    expect(byKey(`${A.pid}|r1|2`).rt).toBeUndefined();
    expect(byKey(`${C.pid}|rc|2`).exit_reason).toBe('timing_check_failed');
  });

  it('puts the subject number first on every row: participants numbered in order of first appearance', () => {
    expect(table.columns[0]).toBe('subject');
    const subjectOf = (pid) => [
      ...new Set(table.rows.filter((r) => r.participant_id === pid).map((r) => r.subject)),
    ];
    /* first rows: A at t=1000s (seq 1), B at 1000s (seq 1), C at 1000s: ties are broken by id */
    expect(subjectOf(A.pid)).toEqual([1]);
    expect(subjectOf(B.pid)).toEqual([2]);
    expect(subjectOf(C.pid)).toEqual([3]);
  });

  it('fills the identity columns on every row from the file envelope', () => {
    for (const r of table.rows) {
      expect(r.participant_id).toBe(r.prolific_pid);
      expect(r.study_id).toBe('STUDYX');
      expect(r.schema_version).toBe('1.2.0');
      expect(r.build_id).toBe('v1');
      expect(r.is_preview).toBe(false);
    }
    expect(byKey(`${B.pid}|rb|1`).session_id).toBe(B.session);
    expect(table.summary.identity_conflicts).toBe(0);
  });

  it('derives run status, the analysed run, task, stage and time per row', () => {
    const status = (k) => [byKey(k).run_status, byKey(k).is_analysed_run];
    expect(status(`${A.pid}|r1|1`)).toEqual(['incomplete', false]);
    expect(status(`${A.pid}|r2|5`)).toEqual(['completed', true]);
    expect(status(`${B.pid}|rb|1`)).toEqual(['incomplete', false]);
    expect(status(`${C.pid}|rc|1`)).toEqual(['screened_out', false]);
    expect(byKey(`${A.pid}|r2|6`)).toMatchObject({ task: 'd_only', session_stage: 'main' });
    expect(byKey(`${A.pid}|r2|7`)).toMatchObject({ task: null, session_stage: 'questionnaire' });
    expect(byKey(`${A.pid}|r2|8`)).toMatchObject({ session_stage: 'end' });
    expect(byKey(`${A.pid}|r1|2`)).toMatchObject({ session_stage: 'setup' });
    expect(byKey(`${A.pid}|r1|1`).wall_time_utc).toBe(new Date(1_794_000_001_000).toISOString());
  });

  it('records how many files held each row and of which kind', () => {
    expect(byKey(`${A.pid}|r1|1`)).toMatchObject({ n_source_files: 1, source_buckets: 'partial' });
    expect(byKey(`${A.pid}|r2|4`)).toMatchObject({
      n_source_files: 1,
      source_buckets: 'checkpoint',
    });
    expect(byKey(`${A.pid}|r2|5`)).toMatchObject({
      n_source_files: 2,
      source_buckets: 'checkpoint+d_only',
    });
    expect(byKey(`${A.pid}|r2|8`)).toMatchObject({ n_source_files: 1, source_buckets: 'd_only' });
    expect(table.summary.rows_without_source).toBe(0);
  });

  it('a raw column named like a derived one is kept as raw_<name> and reported', () => {
    expect(byKey(`${A.pid}|r2|8`).raw_task).toBe('a raw column that is named like a derived one');
    expect(byKey(`${A.pid}|r2|8`).task).toBeNull();
    expect(table.summary.renamed_raw_columns).toEqual(['task']);
  });

  it('reports sequence ranges and gaps per run', () => {
    const run = (id) => table.summary.runs.find((r) => r.run_id === id);
    expect(run('r2')).toMatchObject({
      n_rows: 5,
      seq_min: 4,
      seq_max: 8,
      run_status: 'completed',
      is_analysed_run: true,
    });
    expect(run('r2').seq_gaps).toEqual([]);
    expect(table.summary.participants).toBe(3);
    expect(table.summary.runs).toHaveLength(4);
  });

  it('--analysed-runs-only keeps the analysed run of each participant, and nothing for those who never completed', () => {
    const only = buildRawTable(loaded.perParticipant, { analysedRunsOnly: true });
    expect(only.rows.map((r) => r.run_id)).toEqual(['r2', 'r2', 'r2', 'r2', 'r2']);
    expect(only.summary.runs).toHaveLength(1);
  });

  it('counts a disagreement between a row and the envelope', () => {
    const copy = structuredClone(loaded.perParticipant);
    copy[0].rows[0].study_id = 'A_DIFFERENT_STUDY';
    const t = buildRawTable(copy);
    expect(t.summary.identity_conflicts).toBe(1);
    expect(
      t.rows.find((r) => r.study_id === 'A_DIFFERENT_STUDY')
    ).toBeDefined(); /* the raw value is kept */
  });

  it('composes a CSV whose manifest describes it and whose every cell re-reads correctly', () => {
    const { csv, manifest } = composeRawCsv(loaded.perParticipant, {
      inputPaths: paths,
      fileSha256ByPath: loaded.fileSha256ByPath,
      loadReport: loaded.report,
    });
    expect(verifyCsv(csv, table.columns, table.rows)).toEqual([]);
    expect(manifest.output).toMatchObject({ n_rows: 13, n_participants: 3, n_runs: 4 });
    expect(manifest.output.n_columns).toBe(table.columns.length);
    expect(manifest.input).toMatchObject({ n_files: 5, rows_read: 16, duplicate_rows_dropped: 3 });
    expect(manifest.input.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(manifest.checks).toMatchObject({
      csv_round_trip_ok: true,
      identity_conflicts: 0,
      rows_without_source: 0,
    });
    expect(manifest.json_columns).toEqual(
      expect.arrayContaining(['key_log', 'trial_spec', 'response', 'prior_run_ids'])
    );
    expect(manifest.json_columns).not.toContain('rt');
    const dict = Object.fromEntries(manifest.columns.map((c) => [c.name, c]));
    expect(dict.rt).toMatchObject({ group: 'raw', n_non_missing: 1, types: ['number'] });
    expect(dict.participant_id.group).toBe('identity');
    expect(dict.session_stage.group).toBe('derived');
    expect(manifest.rows_by_task).toEqual({ d_only: 2 });
    expect(manifest.phases_by_stage.questionnaire).toEqual(['strategy_i_d']);
  });
});

describe('derived column names never collide with the study schema', () => {
  it('no raw row property of schemas/trial.schema.json is also a derived column', () => {
    const schema = JSON.parse(
      readFileSync(resolve(HERE, '..', 'schemas', 'trial.schema.json'), 'utf-8')
    );
    const props = new Set(Object.keys(schema.properties ?? {}));
    expect(props.size).toBeGreaterThan(100);
    for (const c of DERIVED_COLUMNS)
      expect(props.has(c), `${c} is also a raw property`).toBe(false);
  });
});

describe('subject registry', () => {
  let dir;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'raw-to-csv-subj-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const entry = (pid, t0, extra = {}) => ({
    source_pid: pid,
    participant_id: pid,
    run_id: 'r',
    session: pid ? { params: { prolific_pid: pid } } : { params: {} },
    rows: [
      { seq: 1, phase: 'session_start', wall_ms: t0 },
      { seq: 2, phase: 'consent', wall_ms: t0 + 5 },
    ],
    ...extra,
  });

  it('numbers new participants in the order of their first recorded row, and stores the numbers', () => {
    const file = join(dir, 'a.csv');
    const list = [
      entry('PID_LATE_0000001', 3000),
      entry('PID_EARLY_000001', 1000),
      entry('PID_MID_00000001', 2000),
    ];
    const { added } = assignSubjects(list, file);
    expect(added.map((a) => [a.subject, a.pid])).toEqual([
      [1, 'PID_EARLY_000001'],
      [2, 'PID_MID_00000001'],
      [3, 'PID_LATE_0000001'],
    ]);
    expect(list.map((e) => e.subject)).toEqual([3, 1, 2]);
    expect([...readSubjectRegistry(file)]).toEqual([
      ['PID_EARLY_000001', 1],
      ['PID_MID_00000001', 2],
      ['PID_LATE_0000001', 3],
    ]);
    expect(readFileSync(file, 'utf-8').split('\n')[0]).toBe('Subject,PROLIFIC_PID,First_Seen_UTC');
  });

  it('keeps every existing number when participants are added later, even one who started earlier', () => {
    const file = join(dir, 'b.csv');
    assignSubjects([entry('PID_ONE_00000001', 5000)], file);
    const later = [
      entry('PID_ONE_00000001', 5000),
      entry('PID_WHO_STARTED_EARLIER', 100),
      entry('PID_NEWEST_000001', 9000),
    ];
    const { added } = assignSubjects(later, file);
    expect(later.map((e) => e.subject)).toEqual([1, 2, 3]); /* the earlier starter gets 2, not 1 */
    expect(added.map((a) => a.subject)).toEqual([2, 3]);
  });

  it('is idempotent: a second run changes neither the numbers nor the file', () => {
    const file = join(dir, 'c.csv');
    const list = () => [entry('PID_AAAA0000001', 1), entry('PID_BBBB0000001', 2)];
    assignSubjects(list(), file);
    const before = readFileSync(file, 'utf-8');
    const again = list();
    const { added } = assignSubjects(again, file);
    expect(added).toEqual([]);
    expect(again.map((e) => e.subject)).toEqual([1, 2]);
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('gives all runs of one participant the same number, and none to a session without a Prolific id', () => {
    const file = join(dir, 'd.csv');
    const list = [
      entry('PID_SAME_0000001', 10, { run_id: 'r1' }),
      entry('PID_SAME_0000001', 20, { run_id: 'r2' }),
      entry(null, 5),
    ];
    assignSubjects(list, file);
    expect(list.map((e) => e.subject)).toEqual([1, 1, null]);
    expect(readSubjectRegistry(file).size).toBe(1);
  });

  it('a preview session without a Prolific id is numbered by its session id; none without either', () => {
    const file = join(dir, 'e.csv');
    const preview = (sid, t0, run_id) => ({
      ...entry(null, t0),
      run_id,
      session: { params: { session_id: sid } },
    });
    const list = [
      entry('PID_ONE_00000001', 10),
      preview('LOCAL_abc_def', 20, 'r1'),
      preview('LOCAL_abc_def', 30, 'r2'),
      entry(null, 5),
    ];
    assignSubjects(list, file);
    expect(list.map((e) => e.subject)).toEqual([1, 2, 2, null]);
    expect(readSubjectRegistry(file).get('LOCAL_abc_def')).toBe(2);
  });

  it('write=false computes the numbers without creating the file', () => {
    const file = join(dir, 'never.csv');
    const list = [entry('PID_DRYRUN_000001', 1)];
    assignSubjects(list, file, { write: false });
    expect(list[0].subject).toBe(1);
    expect(() => readFileSync(file)).toThrow();
  });

  it('refuses a registry with a wrong header, a duplicated number or a duplicated id', () => {
    const f1 = join(dir, 'bad1.csv');
    writeFileSync(f1, 'Number,ID\n1,X\n', 'utf-8');
    expect(() => readSubjectRegistry(f1)).toThrow(/does not start with/);
    const f2 = join(dir, 'bad2.csv');
    writeFileSync(f2, 'Subject,PROLIFIC_PID,First_Seen_UTC\n1,A,\n1,B,\n', 'utf-8');
    expect(() => readSubjectRegistry(f2)).toThrow(/invalid or duplicated/);
    const f3 = join(dir, 'bad3.csv');
    writeFileSync(f3, 'Subject,PROLIFIC_PID,First_Seen_UTC\n1,A,\n2,A,\n', 'utf-8');
    expect(() => readSubjectRegistry(f3)).toThrow(/invalid or duplicated/);
    const f4 = join(dir, 'bad4.csv');
    writeFileSync(f4, 'Subject,PROLIFIC_PID,First_Seen_UTC\n0,A,\n', 'utf-8');
    expect(() => readSubjectRegistry(f4)).toThrow(/invalid or duplicated/);
  });

  it('a missing registry is empty', () => {
    expect(readSubjectRegistry(join(dir, 'does-not-exist.csv')).size).toBe(0);
  });
});
