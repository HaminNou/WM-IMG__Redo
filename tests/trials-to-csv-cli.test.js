/**
 * The trials-to-csv command line: a folder of participant files in, ONE CSV with one line per trial
 * out. Real subprocesses against simulator-produced participants.
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
const SCRIPT = join(REPO, 'scripts/trials-to-csv.js');
const SALT = 'trials-to-csv-cli-test-salt-0123456789';
let SUBJECTS = null;
const run = (args, env = {}) =>
  spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf-8',
    cwd: REPO,
    env: { ...process.env, CSV_EXPORT_SALT: SALT, WM_IMG_SUBJECT_FILE: SUBJECTS, ...env },
  });
const table = (path) => {
  const [header, ...body] = parseCsv(readFileSync(path, 'utf-8').replace(/^\uFEFF/, ''));
  const cols = header.map((h) => h.text);
  return { cols, rows: body.map((r) => Object.fromEntries(r.map((c, i) => [cols[i], c.text]))) };
};

describe('trials-to-csv CLI', () => {
  let work;
  let flat;
  let nested;
  let envelopes;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'trials-to-csv-cli-'));
    SUBJECTS = join(work, 'subjects.csv');
    flat = join(work, 'flat');
    nested = join(work, 'nested');
    mkdirSync(flat, { recursive: true });
    envelopes = [
      simulateOne({ seed: 'tc-1', pid: 'TRIALCSV_P001', accuracy: 0.9, responseRate: 1 }),
      simulateOne({ seed: 'tc-2', pid: 'TRIALCSV_P002', accuracy: 0.7, responseRate: 0.95 }),
    ];
    for (const e of envelopes) {
      writeFileSync(join(flat, `${e.prolific_pid}.json`), JSON.stringify(e), 'utf-8');
      mkdirSync(join(nested, `s_${e.prolific_pid}`), { recursive: true });
      writeFileSync(
        join(nested, `s_${e.prolific_pid}`, 'x__y__z.json'),
        JSON.stringify(e),
        'utf-8'
      );
    }
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('writes ONE csv with one line per trial of every task and subject, and a manifest', () => {
    const out = join(work, 'o1', 'ALL_TRIALS.csv');
    const r = run(['--keep-pid', '--out', out, flat]);
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(work, 'o1')).sort()).toEqual([
      'ALL_TRIALS.csv',
      'ALL_TRIALS.csv.manifest.json',
    ]);
    const { cols, rows } = table(out);
    expect(cols[0]).toBe('subject');
    const m = JSON.parse(readFileSync(`${out}.manifest.json`, 'utf-8'));
    expect(rows).toHaveLength(m.output.n_trials);
    expect(rows.length).toBeGreaterThan(200);
    const subjects = new Set(rows.map((x) => x.subject));
    expect(subjects).toEqual(new Set(['1', '2']));
    for (const t of ['d_only', 't_only', 'i_only', 'i_d', 'i_t']) {
      expect(
        rows.some((x) => x.condition === t),
        t
      ).toBe(true);
    }
    expect(m.checks).toMatchObject({
      csv_round_trip_ok: true,
      context_mismatches: 0,
      unplaced_child_rows: 0,
    });
    /* one line per trial: no (participant, trial_uid, attempt) twice */
    const keys = rows.map((x) => `${x.participant_id}|${x.trial_uid}|${x.attempt}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has the same number of lines as the tidy trials table of csv-export', () => {
    const out = join(work, 'o1', 'ALL_TRIALS.csv');
    const exp = join(work, 'tidy_export');
    const r = spawnSync(
      'node',
      [join(REPO, 'scripts/csv-export.js'), '--keep-pid', '--out', exp, flat],
      {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, CSV_EXPORT_SALT: SALT },
      }
    );
    expect(r.status, r.stderr).toBe(0);
    expect(table(out).rows).toHaveLength(table(join(exp, 'trials.csv')).rows.length);
  });

  it('gives the same file for a flat folder and for one subfolder per participant, run after run', () => {
    const a = join(work, 'o_flat', 'ALL_TRIALS.csv');
    const b = join(work, 'o_nested', 'ALL_TRIALS.csv');
    const c = join(work, 'o_flat2', 'ALL_TRIALS.csv');
    expect(run(['--keep-pid', '--out', a, flat]).status).toBe(0);
    expect(run(['--keep-pid', '--out', b, nested]).status).toBe(0);
    expect(run(['--keep-pid', '--out', c, flat]).status).toBe(0);
    expect(readFileSync(b, 'utf-8')).toBe(readFileSync(a, 'utf-8'));
    expect(readFileSync(c, 'utf-8')).toBe(readFileSync(a, 'utf-8'));
  });

  it('--main-trials-only leaves out the practice trials', () => {
    /* the simulator has no practice, so one trial is turned into a practice trial here */
    const dir = join(work, 'with_practice');
    mkdirSync(dir, { recursive: true });
    const e = structuredClone(envelopes[0]);
    const uid = e.rows.find((r) => r.trial_uid)?.trial_uid;
    for (const r of e.rows) {
      if (r.trial_uid === uid) {
        r.is_practice = true;
        r.block_label = 'practice';
      }
    }
    writeFileSync(join(dir, 'p.json'), JSON.stringify(e), 'utf-8');
    const all = join(work, 'm_all', 'ALL_TRIALS.csv');
    const main = join(work, 'm_main', 'ALL_TRIALS.csv');
    expect(run(['--keep-pid', '--out', all, dir]).status).toBe(0);
    expect(run(['--keep-pid', '--main-trials-only', '--out', main, dir]).status).toBe(0);
    const a = table(all).rows;
    const mrows = table(main).rows;
    expect(a.filter((x) => x.is_practice === 'TRUE')).toHaveLength(1);
    expect(mrows.every((x) => x.is_practice === 'FALSE')).toBe(true);
    expect(mrows).toHaveLength(a.length - 1);
  });

  it('by default replaces ids by codes, writes the key outside the output folder and leaks nothing', () => {
    const out = join(work, 'coded', 'ALL_TRIALS.csv');
    const r = run(['--out', out, flat]);
    expect(r.status, r.stderr).toBe(0);
    for (const id of ['TRIALCSV_P001', 'TRIALCSV_P002']) {
      expect(readFileSync(out, 'utf-8')).not.toContain(id);
      expect(readFileSync(`${out}.manifest.json`, 'utf-8')).not.toContain(id);
    }
    const { rows } = table(out);
    expect(rows.every((x) => /^P[0-9a-f]{12}$/.test(x.participant_id))).toBe(true);
    expect(new Set(rows.map((x) => x.subject))).toEqual(
      new Set(['1', '2'])
    ); /* same numbers as before */
    expect(existsSync(join(work, 'coded_PRIVATE', 'PID_KEY.csv'))).toBe(true);
    expect(readdirSync(join(work, 'coded'))).not.toContain('PID_KEY.csv');
  });

  it('usage errors exit 2 and an unreadable file exits 3, writing nothing', () => {
    const x = join(work, 'x.csv');
    expect(run(['--keep-pid', flat]).status).toBe(2);
    expect(run(['--keep-pid', '--out', x]).status).toBe(2);
    expect(run(['--keep-pid', '--share', '--out', x, flat]).status).toBe(2);
    expect(run(['--bogus', '--out', x, flat]).status).toBe(2);
    const bad = join(work, 'bad');
    mkdirSync(bad);
    writeFileSync(join(bad, 'good.json'), JSON.stringify(envelopes[0]), 'utf-8');
    writeFileSync(join(bad, 'broken.json'), '{ nope', 'utf-8');
    const r = run(['--keep-pid', '--out', x, bad]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/broken\.json/);
    expect(existsSync(x)).toBe(false);
  });
});
