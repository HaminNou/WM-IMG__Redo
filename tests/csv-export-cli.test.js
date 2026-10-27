/**
 * End-to-end CLI smoke tests for `scripts/csv-export.js`.
 *
 * The unit tests in `csv-export.test.js` exercise `composeExport` and its
 * helpers in isolation; the integration tests in `simulate-pilot.test.js`
 * pipe simulator output through `composeExport` in-process. Neither suite
 * exercises the CLI entry point itself: argv parsing, directory expansion,
 * `mkdirSync`/`writeFileSync` to disk, manifest serialisation, exit codes
 * for missing-arg / no-input / no-json failure modes.
 *
 * This file closes that gap by spawning `node scripts/csv-export.js` as a
 * real subprocess against a tmpdir of simulator-produced JSON dumps and
 * asserting on the on-disk artifacts. Same operator workflow that runs
 * post-pilot during data export — if it breaks, the operator hits the
 * failure during analysis, which is the worst time. CI catches it now.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { simulateOne } from '../scripts/simulate-pilot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts/csv-export.js');
const TEST_SALT = 'csv-export-cli-test-salt-0123456789';
const CODE_RE = /^P[0-9a-f]{12}$/;

/* Files composeExport always writes (5 trial types × 2 criteria + 5 aux + manifest). */
const EXPECTED_FILES = Object.freeze([
  'D_ONLY_Criterion1.csv',
  'D_ONLY_Criterion2.csv',
  'T_ONLY_Criterion1.csv',
  'T_ONLY_Criterion2.csv',
  'I_ONLY_Criterion1.csv',
  'I_ONLY_Criterion2.csv',
  'I_D_Criterion1.csv',
  'I_D_Criterion2.csv',
  'I_T_Criterion1.csv',
  'I_T_Criterion2.csv',
  'CALIBRATION_SUMMARY.csv',
  'PARTICIPANT_SUMMARY.csv',
  'STRATEGY.csv',
  'STRATEGY_SCORES.csv',
  'MUSIC.csv',
  'ATTENTION_CHECKS.csv',
  'DIAGNOSTICS.csv',
  'DEMOGRAPHICS.csv',
  'EVENTS.csv',
  'trials.csv',
  'stars.csv',
  'probes.csv',
  'EXPORT_MANIFEST.json',
]);

function runCli(args, opts = {}) {
  return spawnSync('node', [SCRIPT_PATH, ...args], {
    encoding: 'utf-8',
    cwd: opts.cwd ?? REPO_ROOT,
    /* An explicit salt keeps every run off the per-user default salt file. */
    env: { ...process.env, CSV_EXPORT_SALT: TEST_SALT, ...(opts.env ?? {}) },
  });
}

function writeEnvelopesToDir(dir, envelopes) {
  for (const env of envelopes) {
    const filename = `${env.prolific_pid}.json`;
    writeFileSync(join(dir, filename), JSON.stringify(env), 'utf-8');
  }
}

function countCsvDataRows(text) {
  const lines = text.split('\n').filter((line) => line.length > 0);
  return Math.max(0, lines.length - 1);
}

describe('csv-export CLI smoke tests', () => {
  let workDir;
  let inputDir;
  let outputDir;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'csv-export-cli-'));
    inputDir = join(workDir, 'inputs');
    outputDir = join(workDir, 'outputs');
    mkdirSync(inputDir, { recursive: true });

    /* Three participants, deterministic seeds, accuracy=1.0 so every probe
     * row passes Criterion 2 (RT-non-NA cells become populated, exercising
     * the wide-CSV serialisation path more thoroughly than chance accuracy). */
    const envelopes = [
      simulateOne({ seed: 'cli-p1', pid: 'CLI_P001', accuracy: 1.0, responseRate: 1.0 }),
      simulateOne({ seed: 'cli-p2', pid: 'CLI_P002', accuracy: 0.85, responseRate: 0.97 }),
      simulateOne({ seed: 'cli-p3', pid: 'CLI_P003', accuracy: 0.65, responseRate: 0.95 }),
    ];
    writeEnvelopesToDir(inputDir, envelopes);
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes all expected CSVs and manifest with directory input', () => {
    const result = runCli(['--out', outputDir, inputDir]);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);

    const written = readdirSync(outputDir).sort();
    expect(written).toEqual([...EXPECTED_FILES].sort());
  });

  it('every wide trial-type CSV has 24 trials × 3 participants = 72 data rows', () => {
    /* Re-uses outputs from the previous test — vitest runs `it` blocks
     * sequentially by default. */
    const trialTypeFiles = EXPECTED_FILES.filter(
      (f) =>
        f.endsWith('.csv') &&
        f !== 'STRATEGY.csv' &&
        f !== 'STRATEGY_SCORES.csv' &&
        f !== 'MUSIC.csv' &&
        f !== 'ATTENTION_CHECKS.csv' &&
        f !== 'DIAGNOSTICS.csv' &&
        f !== 'CALIBRATION_SUMMARY.csv' &&
        f !== 'PARTICIPANT_SUMMARY.csv' &&
        f !== 'DEMOGRAPHICS.csv' &&
        f !== 'EVENTS.csv' &&
        f !== 'trials.csv' &&
        f !== 'stars.csv' &&
        f !== 'probes.csv'
    );
    for (const file of trialTypeFiles) {
      const text = readFileSync(join(outputDir, file), 'utf-8');
      expect(countCsvDataRows(text), `${file}`).toBe(72);
    }
  });

  it('CALIBRATION_SUMMARY.csv has one row per participant', () => {
    const text = readFileSync(join(outputDir, 'CALIBRATION_SUMMARY.csv'), 'utf-8');
    expect(countCsvDataRows(text)).toBe(3);
  });

  it('DEMOGRAPHICS.csv has one row per participant with the in-experiment fields', () => {
    const text = readFileSync(join(outputDir, 'DEMOGRAPHICS.csv'), 'utf-8');
    expect(countCsvDataRows(text)).toBe(3);
    const header = text.split('\n')[0];
    for (const col of ['Handedness', 'Education']) {
      expect(header).toContain(`"${col}"`);
    }
    for (const removed of [
      'Age',
      'Sex',
      'First_Languages',
      'Hearing',
      'Vision',
      'Medication',
      'English_Fluency',
      'Glasses_Contacts',
      'Glasses_Contacts_Note',
    ]) {
      expect(header).not.toContain(`"${removed}"`);
    }
  });

  it('STRATEGY.csv and ATTENTION_CHECKS.csv exist with header rows', () => {
    /* The simulator currently emits stub rows for the calibration phases but
     * no per-strategy-item or per-attention-check rows, so these aux CSVs
     * come out header-only. The point of this test is that the CLI writes
     * them regardless (composeExport always emits aux files); coverage of
     * populated row contents lives in csv-export.test.js unit tests with
     * hand-written fixtures. */
    const strategy = readFileSync(join(outputDir, 'STRATEGY.csv'), 'utf-8');
    expect(
      strategy.startsWith('"Participant_ID","Section","Item_Id","Response_Raw","Response_Score"')
    ).toBe(true);
    const att = readFileSync(join(outputDir, 'ATTENTION_CHECKS.csv'), 'utf-8');
    expect(att.startsWith('"Participant_ID","Check_Id","Raw_Input","Passed"')).toBe(true);
  });

  it('manifest carries build_ids, schema_versions, participant_ids, and per-source sha256', () => {
    const manifest = JSON.parse(readFileSync(join(outputDir, 'EXPORT_MANIFEST.json'), 'utf-8'));
    expect(manifest).toHaveProperty('generated_at_iso');
    expect(manifest).toHaveProperty('generator');
    expect(manifest.generator.name).toBe('csv-export.js');
    expect(manifest.n_participants).toBe(3);
    /* Pseudonymised by default: codes, never the Prolific ids. */
    expect(manifest.participant_ids).toHaveLength(3);
    for (const id of manifest.participant_ids) expect(id).toMatch(CODE_RE);
    expect(JSON.stringify(manifest)).not.toMatch(/CLI_P00/);
    expect(manifest.build_ids).toEqual(['v1']);
    expect(manifest.schema_versions).toEqual(['1.2.0']);
    expect(manifest.is_pilot_run_flags).toEqual([true]);
    expect(manifest.heterogeneity_flags).toEqual({
      build_id_heterogeneous: false,
      schema_version_heterogeneous: false,
      pilot_flag_heterogeneous: false,
    });
    expect(manifest.source_files.length).toBe(3);
    for (const f of manifest.source_files) {
      expect(typeof f.sha256).toBe('string');
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    /* Every output file must appear in the manifest's output_files list
     * except the manifest itself. */
    const manifestPaths = new Set(manifest.output_files.map((f) => f.path));
    for (const expected of EXPECTED_FILES) {
      if (expected === 'EXPORT_MANIFEST.json') continue;
      expect(manifestPaths.has(expected), `manifest missing ${expected}`).toBe(true);
    }
  });

  it('--json-manifest also dumps manifest JSON to stdout', () => {
    const altOut = join(workDir, 'outputs-json');
    const result = runCli(['--out', altOut, '--json-manifest', inputDir]);
    expect(result.status).toBe(0);
    /* The trailing line is the human-readable summary; the manifest JSON is
     * everything before it. */
    const lines = result.stdout.split('\n');
    const summaryLine = lines.findIndex((line) => line.startsWith('csv-export: wrote'));
    expect(summaryLine).toBeGreaterThan(0);
    const jsonText = lines.slice(0, summaryLine).join('\n');
    const manifest = JSON.parse(jsonText);
    expect(manifest.n_participants).toBe(3);
    expect(manifest.build_ids).toEqual(['v1']);
  });

  it('accepts individual file paths as inputs (not just directories)', () => {
    const altOut = join(workDir, 'outputs-files');
    const fileArgs = readdirSync(inputDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(inputDir, f));
    const result = runCli(['--out', altOut, ...fileArgs]);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const written = readdirSync(altOut).sort();
    expect(written).toEqual([...EXPECTED_FILES].sort());
  });

  it('exits 2 when --out is missing', () => {
    const result = runCli([inputDir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/missing --out/);
  });

  it('exits 2 when no input paths are supplied', () => {
    const result = runCli(['--out', join(workDir, 'outputs-noinput')]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/no input paths supplied/);
  });

  it('exits 2 when input directory contains no .json files', () => {
    const emptyDir = join(workDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const result = runCli(['--out', join(workDir, 'outputs-empty'), emptyDir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/no \.json files found/);
  });

  it('exits 1 on a malformed JSON dump (caught by `unexpected error`)', () => {
    const badDir = join(workDir, 'malformed');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'broken.json'), '{not valid json}', 'utf-8');
    const result = runCli(['--out', join(workDir, 'outputs-bad'), badDir]);
    /* Per the CLI: errors during fs read are logged but loadAndFlattenDumps
     * returns errors and continues; if no participant is parsed we exit 2.
     * A truly malformed file therefore produces exit 2 with the specific
     * "no participants parsed" message, not 1. */
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/failed to read|no participants parsed/);
  });

  describe('files of one session', () => {
    const gateRow = (seq, uid, run = 'aaaa1111') => ({
      seq,
      run_id: run,
      phase: 'd_only_trial_start',
      block_label: 'main_a',
      trial_uid: uid,
      trial_index_in_block: 0,
      presentation_index: 1,
    });
    const env = (rows, name) => ({
      name,
      body: {
        session_id: 's1',
        prolific_pid: 'P1',
        build_id: 'v1',
        schema_version: '1.2.0',
        rows,
      },
    });
    function run(files, tag) {
      const dir = join(workDir, `in-${tag}`);
      mkdirSync(dir, { recursive: true });
      for (const f of files) writeFileSync(join(dir, f.name), JSON.stringify(f.body), 'utf-8');
      const out = join(workDir, `out-${tag}`);
      const result = runCli(['--out', out, dir]);
      return { result, out };
    }

    it('merges bucket and checkpoint files without doubling trials', () => {
      const rows = [gateRow(1, 'main_a-001-d_only'), gateRow(2, 'main_a-002-d_only')];
      const { result, out } = run(
        [env(rows, 's1__aaaa1111__03_d_only.json'), env(rows, 's1__aaaa1111__ckpt_1-2.json')],
        'union'
      );
      expect(result.status, result.stderr).toBe(0);
      expect(countCsvDataRows(readFileSync(join(out, 'trials.csv'), 'utf-8'))).toBe(2);
      const manifest = JSON.parse(readFileSync(join(out, 'EXPORT_MANIFEST.json'), 'utf-8'));
      expect(manifest.duplicate_rows_dropped).toBe(2);
    });

    it('splits a reloaded session by run id', () => {
      const { result, out } = run(
        [
          env([gateRow(1, 'main_a-001-d_only', 'aaaa1111')], 'a.json'),
          env([gateRow(1, 'main_a-001-d_only', 'bbbb2222')], 'b.json'),
        ],
        'runs'
      );
      expect(result.status, result.stderr).toBe(0);
      const manifest = JSON.parse(readFileSync(join(out, 'EXPORT_MANIFEST.json'), 'utf-8'));
      expect(manifest.n_participants).toBe(2);
      expect(manifest.reloaded_participants).toHaveLength(1);
      const trials = readFileSync(join(out, 'trials.csv'), 'utf-8');
      expect(trials).toMatch(/P[0-9a-f]{12}__run_bbbb2222/);
      expect(trials).not.toContain('P1__run');
    });

    it('exits 3 after writing the files when a main trial occurs twice in one run', () => {
      const { result, out } = run(
        [env([gateRow(1, 'main_a-001-d_only'), gateRow(2, 'main_a-001-d_only')], 'dup.json')],
        'dup'
      );
      expect(result.status).toBe(3);
      expect(result.stderr).toMatch(/duplicate_main_trial_uid/);
      expect(readdirSync(out)).toContain('trials.csv');
      expect(readdirSync(out)).toContain('EXPORT_MANIFEST.json');
    });
  });
});
