/**
 * The raw-to-csv command line, as an operator runs it: a folder of participant files in, ONE CSV
 * out. Real subprocesses against simulator-produced participants (`simulateOne`), checking the
 * files on disk, the exit codes, the privacy handling and that the folder layout (flat, or one
 * subfolder per participant as Drive holds it) does not change the result.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { simulateOne } from '../scripts/simulate-pilot.js';
import { parseCsv } from '../scripts/raw-to-csv.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SCRIPT = join(REPO, 'scripts/raw-to-csv.js');
const SALT = 'raw-to-csv-cli-test-salt-0123456789';
const run = (args, env = {}) =>
  spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf-8',
    cwd: REPO,
    env: { ...process.env, CSV_EXPORT_SALT: SALT, ...env },
  });

const table = (csvPath) => {
  const [header, ...body] = parseCsv(readFileSync(csvPath, 'utf-8').replace(/^\uFEFF/, ''));
  const cols = header.map((h) => h.text);
  return {
    cols,
    rows: body.map((r) => Object.fromEntries(r.map((c, i) => [cols[i], c.text]))),
  };
};

describe('raw-to-csv CLI', () => {
  let work;
  let flat;
  let nested;
  let envelopes;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'raw-to-csv-cli-'));
    flat = join(work, 'flat');
    nested = join(work, 'nested');
    mkdirSync(flat, { recursive: true });
    envelopes = [
      simulateOne({ seed: 'rc-1', pid: 'RAWCSV_P001', accuracy: 0.9, responseRate: 1 }),
      simulateOne({ seed: 'rc-2', pid: 'RAWCSV_P002', accuracy: 0.7, responseRate: 0.95 }),
    ];
    for (const e of envelopes) {
      writeFileSync(join(flat, `${e.prolific_pid}.json`), JSON.stringify(e), 'utf-8');
      mkdirSync(join(nested, `sess_${e.prolific_pid}`), { recursive: true });
      writeFileSync(
        join(nested, `sess_${e.prolific_pid}`, 'x__y__z.json'),
        JSON.stringify(e),
        'utf-8'
      );
    }
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('writes ONE csv with every row of every participant and every raw column, and a manifest', () => {
    const out = join(work, 'out1', 'RAW.csv');
    const r = run(['--keep-pid', '--out', out, flat]);
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(work, 'out1')).sort()).toEqual(['RAW.csv', 'RAW.csv.manifest.json']);
    const { cols, rows } = table(out);
    const expectedRows = envelopes.reduce((n, e) => n + e.rows.length, 0);
    expect(rows).toHaveLength(expectedRows);
    const rawKeys = new Set(envelopes.flatMap((e) => e.rows.flatMap((x) => Object.keys(x))));
    for (const k of rawKeys) expect(cols, `raw column ${k}`).toContain(k);
    const m = JSON.parse(readFileSync(`${out}.manifest.json`, 'utf-8'));
    expect(m.output).toMatchObject({
      n_rows: expectedRows,
      n_columns: cols.length,
      n_participants: 2,
    });
    expect(m.checks.csv_round_trip_ok).toBe(true);
    expect(m.output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(rows.map((x) => x.participant_id))).toEqual(
      new Set(['RAWCSV_P001', 'RAWCSV_P002'])
    );
    for (const t of ['d_only', 't_only', 'i_only', 'i_d', 'i_t']) {
      expect(
        rows.some((x) => x.task === t),
        `task ${t}`
      ).toBe(true);
    }
  });

  it('every row of the source appears once, with its values', () => {
    const out = join(work, 'out1', 'RAW.csv');
    const { rows } = table(out);
    const byKey = new Map(rows.map((x) => [`${x.participant_id}|${x.run_id}|${x.seq}`, x]));
    for (const e of envelopes) {
      for (const src of e.rows) {
        const got = byKey.get(`${e.prolific_pid}|${src.run_id}|${src.seq}`);
        expect(got, `row ${src.seq} of ${e.prolific_pid}`).toBeDefined();
        expect(got.phase).toBe(src.phase);
      }
    }
  });

  it('gives the same file for a flat folder and for one subfolder per participant', () => {
    const a = join(work, 'out_flat', 'RAW.csv');
    const b = join(work, 'out_nested', 'RAW.csv');
    expect(run(['--keep-pid', '--out', a, flat]).status).toBe(0);
    expect(run(['--keep-pid', '--out', b, nested]).status).toBe(0);
    expect(readFileSync(b, 'utf-8')).toBe(readFileSync(a, 'utf-8'));
  });

  it('is deterministic: two runs give byte-identical CSVs', () => {
    const a = join(work, 'o_a', 'RAW.csv');
    const b = join(work, 'o_b', 'RAW.csv');
    run(['--keep-pid', '--out', a, flat]);
    run(['--keep-pid', '--out', b, flat]);
    expect(readFileSync(a)).toEqual(readFileSync(b));
  });

  it('by default replaces ids by codes, writes the key outside the output folder, and leaks nothing', () => {
    const out = join(work, 'coded', 'RAW.csv');
    const r = run(['--out', out, flat]);
    expect(r.status, r.stderr).toBe(0);
    const csv = readFileSync(out, 'utf-8');
    const manifest = readFileSync(`${out}.manifest.json`, 'utf-8');
    for (const id of ['RAWCSV_P001', 'RAWCSV_P002']) {
      expect(csv).not.toContain(id);
      expect(manifest).not.toContain(id);
    }
    const { rows } = table(out);
    expect(rows.every((x) => /^P[0-9a-f]{12}$/.test(x.participant_id))).toBe(true);
    const keyFile = join(work, 'coded_PRIVATE', 'PID_KEY.csv');
    expect(existsSync(keyFile)).toBe(true);
    expect(readFileSync(keyFile, 'utf-8')).toContain('RAWCSV_P001');
    expect(readdirSync(join(work, 'coded'))).not.toContain('PID_KEY.csv');
  });

  it('--analysed-runs-only keeps only the analysed run of each participant', () => {
    const out = join(work, 'only', 'RAW.csv');
    expect(run(['--keep-pid', '--analysed-runs-only', '--out', out, flat]).status).toBe(0);
    const { rows } = table(out);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((x) => x.is_analysed_run))).toEqual(new Set(['TRUE']));
  });

  it('--excel-bom adds a byte-order mark and the same content', () => {
    const plain = join(work, 'bom0', 'RAW.csv');
    const bom = join(work, 'bom1', 'RAW.csv');
    run(['--keep-pid', '--out', plain, flat]);
    run(['--keep-pid', '--excel-bom', '--out', bom, flat]);
    const b = readFileSync(bom, 'utf-8');
    expect(b.charCodeAt(0)).toBe(0xfeff);
    expect(b.slice(1)).toBe(readFileSync(plain, 'utf-8'));
  });

  it('usage errors exit 2 and write nothing', () => {
    expect(run(['--keep-pid', flat]).status).toBe(2); /* no --out */
    expect(run(['--keep-pid', '--out', join(work, 'x.csv')]).status).toBe(2); /* no inputs */
    expect(run(['--keep-pid', '--share', '--out', join(work, 'x.csv'), flat]).status).toBe(2);
    expect(run(['--nonsense', '--out', join(work, 'x.csv'), flat]).status).toBe(2);
    const empty = join(work, 'empty');
    mkdirSync(empty);
    expect(run(['--keep-pid', '--out', join(work, 'x.csv'), empty]).status).toBe(2);
    expect(existsSync(join(work, 'x.csv'))).toBe(false);
  });

  it('refuses a private key folder inside the output folder', () => {
    const out = join(work, 'inside', 'RAW.csv');
    const r = run(['--private-dir', join(work, 'inside', 'keys'), '--out', out, flat]);
    expect(r.status).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  it('an unreadable input file stops the run (exit 3) and writes nothing', () => {
    const bad = join(work, 'bad');
    mkdirSync(bad);
    writeFileSync(join(bad, 'good.json'), JSON.stringify(envelopes[0]), 'utf-8');
    writeFileSync(join(bad, 'broken.json'), '{ this is not json', 'utf-8');
    const out = join(work, 'bad_out', 'RAW.csv');
    const r = run(['--keep-pid', '--out', out, bad]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/broken\.json/);
    expect(existsSync(out)).toBe(false);
  });
});
