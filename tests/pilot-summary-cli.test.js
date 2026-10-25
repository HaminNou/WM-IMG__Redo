/**
 * End-to-end CLI smoke tests for `scripts/pilot-summary.js`.
 *
 * The unit tests in `pilot-summary.test.js` exercise `summariseDump`,
 * `aggregate`, `summariseAttentionChecks`, and friends as pure functions.
 * Neither the argv parsing, the `expandPaths` fs traversal, nor the
 * --json stdout serialisation is tested as a process.
 *
 * This file spawns `node scripts/pilot-summary.js` against simulator-
 * produced JSON dumps and asserts on the exit code, stdout shape (both
 * human-readable and --json modes), and a few aggregate-report invariants.
 * Same operator workflow that runs after each pilot batch — if it breaks,
 * the operator misses the exclusion-rate signal at exactly the wrong time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { simulateOne } from '../scripts/simulate-pilot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts/pilot-summary.js');

const TEST_SALT = 'pilot-summary-cli-test-salt-0123456789';

function runCli(args) {
  return spawnSync('node', [SCRIPT_PATH, ...args], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
    /* An explicit salt keeps every run off the per-user default salt file. */
    env: { ...process.env, CSV_EXPORT_SALT: TEST_SALT },
  });
}

function writeEnvelopesToDir(dir, envelopes) {
  for (const env of envelopes) {
    const filename = `${env.prolific_pid}.json`;
    writeFileSync(join(dir, filename), JSON.stringify(env), 'utf-8');
  }
}

describe('pilot-summary CLI smoke tests', () => {
  let workDir;
  let inputDir;
  let envelopes;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'pilot-summary-cli-'));
    inputDir = join(workDir, 'inputs');
    mkdirSync(inputDir, { recursive: true });

    envelopes = [
      simulateOne({ seed: 'ps-p1', pid: 'PS_P001' }),
      simulateOne({ seed: 'ps-p2', pid: 'PS_P002' }),
      simulateOne({ seed: 'ps-p3', pid: 'PS_P003' }),
    ];
    writeEnvelopesToDir(inputDir, envelopes);
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('exits 0 and renders human-readable per-participant + aggregate sections', () => {
    const result = runCli([inputDir]);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    /* Per-participant headers show the pseudonymous code and the file count, never the
     * Prolific id or the file name. The aggregate header is "=== Batch summary ===". */
    expect(result.stdout.match(/P[0-9a-f]{12} \(1 file\(s\)\)/g)).toHaveLength(3);
    expect(result.stdout).not.toMatch(/PS_P00\d/);
    expect(result.stdout).toContain('=== Batch summary ===');
    expect(result.stdout).toContain('participants:');
    expect(result.stdout).toContain('attention-excluded:');
  });

  it('flags every participant as included (simulator emits no per-check fail rows)', () => {
    /* Simulator emits a single `attention_check_summary` row but no
     * `attention_check` rows; summariseAttentionChecks therefore returns
     * total=0/failed=0/excluded=false. So the simulator's output represents
     * a hypothetical "all participants pass attention checks" batch.
     * Coverage of failure/exclusion paths lives in pilot-summary.test.js
     * unit tests with hand-written fixtures. */
    const result = runCli([inputDir]);
    expect(result.status).toBe(0);
    /* Three "included" markers (one per participant), zero "EXCLUDED". */
    const includedCount = (result.stdout.match(/included/g) ?? []).length;
    expect(includedCount).toBe(3);
    expect(result.stdout).not.toContain('EXCLUDED');
  });

  it('--json emits structured per-participant + aggregate report', () => {
    const result = runCli(['--json', inputDir]);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('perParticipant');
    expect(parsed).toHaveProperty('aggregate');
    expect(parsed.perParticipant.length).toBe(3);
    /* Per-participant invariants. */
    for (const p of parsed.perParticipant) {
      expect(p.build_id).toBe('v1');
      expect(p.schema_version).toBe('1.2.0');
      expect(p.is_pilot_run).toBe(true);
      expect(p.attention.excluded).toBe(false);
      expect(p.upload_status).toBe('uploaded');
    }
    /* Aggregate invariants. */
    expect(parsed.aggregate.n_participants).toBe(3);
    expect(parsed.aggregate.build_ids).toEqual(['v1']);
    expect(parsed.aggregate.schema_versions).toEqual(['1.2.0']);
    expect(parsed.aggregate.n_excluded).toBe(0);
    expect(parsed.aggregate.exclusion_rate).toBe(0);
    expect(parsed.aggregate.issues).toEqual([]);
  });

  it('detects build_id heterogeneity and exits 1 with BUILD_ID_HETEROGENEOUS', () => {
    /* Hand-mutate one envelope's build_id to provoke the aggregate flag.
     * Done in-test (not via the simulator) because the simulator imports
     * config at module-load and we don't want to fork it just to mutate
     * one field. */
    const heteroDir = join(workDir, 'hetero');
    mkdirSync(heteroDir, { recursive: true });
    const hetero = envelopes.map((e) => ({ ...e }));
    hetero[0] = { ...hetero[0], build_id: 'STALE_BUILD' };
    writeEnvelopesToDir(heteroDir, hetero);

    const result = runCli(['--json', heteroDir]);
    expect(result.status).toBe(1); /* aggregate has an error → exit 1 */
    const parsed = JSON.parse(result.stdout);
    const codes = parsed.aggregate.issues.map((i) => i.code);
    expect(codes).toContain('BUILD_ID_HETEROGENEOUS');
    expect(parsed.aggregate.build_ids.sort()).toEqual(['STALE_BUILD', 'v1'].sort());
  });

  it('exits 2 when no input paths are supplied', () => {
    const result = runCli([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/no input paths supplied/);
  });

  it('exits 2 when input directory contains no .json files', () => {
    const emptyDir = join(workDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const result = runCli([emptyDir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/no \.json files found/);
  });

  it('accepts individual file paths as inputs (not just directories)', () => {
    const singleFile = join(inputDir, 'PS_P001.json');
    const result = runCli(['--keep-pid', '--json', singleFile]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.perParticipant.length).toBe(1);
    expect(parsed.perParticipant[0].prolific_pid).toBe('PS_P001');
    /* Without --keep-pid the same run shows a code and no raw id anywhere. */
    const coded = runCli(['--json', singleFile]);
    expect(coded.status).toBe(0);
    expect(coded.stdout).not.toContain('PS_P001');
    expect(JSON.parse(coded.stdout).perParticipant[0].prolific_pid).toMatch(/^P[0-9a-f]{12}$/);
  });

  it('rejects unknown flags', () => {
    const result = runCli(['--bogus-flag', inputDir]);
    expect(result.status).toBe(1); /* unhandled throw → caught by .catch → exit 1 */
    expect(result.stderr).toMatch(/unknown flag/);
  });
});
