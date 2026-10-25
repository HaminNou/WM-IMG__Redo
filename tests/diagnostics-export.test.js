/**
 * Runtime diagnostics reach the analysis exports.
 *
 * `runtime_error`, `runtime_error_fatal` and `audio_state_change` rows are written
 * to the raw data, but no CSV carried them, so the error net and the audio-state log
 * were visible only in the private raw JSON (final independent review). The exporter
 * now writes DIAGNOSTICS.csv (one row per diagnostic row, pseudonymised like every
 * other table) and counts them per participant in PARTICIPANT_SUMMARY.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { simulateOne } from '../scripts/simulate-pilot.js';
import { loadAndFlattenDumps } from '../scripts/dump-loader.js';
import { composeExport } from '../scripts/csv-export.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_CLI = join(REPO_ROOT, 'scripts/csv-export.js');
const PID = '5f3c9a2b7d1e4a6c8b0d7001';
const OTHER = '5f3c9a2b7d1e4a6c8b0d7002';

function csv(text) {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',').map((c) => c.replace(/^"|"$/g, ''));
  return lines.map((l) => {
    const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, ''));
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? '').replace(/^"|"$/g, '')]));
  });
}

function withDiagnostics(env, extras) {
  const top = Math.max(...env.rows.map((r) => r.seq ?? 0));
  env.rows = [...env.rows, ...extras.map((r, i) => ({ seq: top + i + 1, ...r }))];
  return env;
}

const DIAG = (message) => [
  {
    phase: 'runtime_error',
    kind: 'error',
    error_name: 'TypeError',
    message,
    source: 'main.js:10:5',
    trial_phase: 'i_d_probe',
    wall_ms: 1,
  },
  {
    phase: 'runtime_error',
    kind: 'unhandledrejection',
    error_name: 'Error',
    message: 'x',
    source: null,
    trial_phase: null,
    wall_ms: 2,
  },
  { phase: 'runtime_error_fatal', stage: 'running', message: 'ref abc', wall_ms: 3 },
  { phase: 'audio_state_change', audio_state: 'running', wall_ms: 4 },
  { phase: 'audio_state_change', audio_state: 'suspended', wall_ms: 5 },
  { phase: 'audio_state_change', audio_state: 'interrupted', wall_ms: 6 },
];

describe('diagnostics export', () => {
  let work;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'diag-'));
    mkdirSync(join(work, 'raw'));
    const a = withDiagnostics(simulateOne({ seed: 'd1', pid: PID }), DIAG('boom'));
    const b = simulateOne({ seed: 'd2', pid: OTHER });
    writeFileSync(join(work, 'raw', 'a.json'), JSON.stringify(a));
    writeFileSync(join(work, 'raw', 'b.json'), JSON.stringify(b));
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  const load = () =>
    loadAndFlattenDumps(readdirSync(join(work, 'raw')).map((f) => join(work, 'raw', f)))
      .perParticipant;

  it('writes DIAGNOSTICS.csv with one row per diagnostic row', () => {
    const { files } = composeExport(load(), {});
    expect(files['DIAGNOSTICS.csv']).toBeDefined();
    const rows = csv(files['DIAGNOSTICS.csv']);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.Phase)).toEqual([
      'runtime_error',
      'runtime_error',
      'runtime_error_fatal',
      'audio_state_change',
      'audio_state_change',
      'audio_state_change',
    ]);
    expect(rows[0].Error_Name).toBe('TypeError');
    expect(rows[0].Message).toBe('boom');
    expect(rows[0].Trial_Phase).toBe('i_d_probe');
    expect(rows[2].Stage).toBe('running');
    expect(rows[5].Audio_State).toBe('interrupted');
    for (const r of rows) expect(r.Participant_ID).toBe(PID);
  });

  it('counts them per participant in PARTICIPANT_SUMMARY', () => {
    const { files } = composeExport(load(), {});
    const rows = csv(files['PARTICIPANT_SUMMARY.csv']);
    const a = rows.find((r) => r.Participant_ID === PID);
    const b = rows.find((r) => r.Participant_ID === OTHER);
    expect(a.Runtime_Errors).toBe('2');
    expect(a.Runtime_Error_Fatal).toBe('1');
    expect(a.Audio_State_Changes).toBe('3');
    expect(a.Audio_Interruptions).toBe('2'); /* suspended + interrupted */
    expect(b.Runtime_Errors).toBe('0');
    expect(b.Runtime_Error_Fatal).toBe('0');
    expect(b.Audio_State_Changes).toBe('0');
    expect(b.Audio_Interruptions).toBe('0');
  });

  it('lists the new file in the export manifest list', () => {
    const { fileList } = composeExport(load(), {});
    expect(fileList.some((f) => f.path === 'DIAGNOSTICS.csv')).toBe(true);
  });

  it('the CLI pseudonymises it: a PID typed into an error message does not leak', () => {
    const dir = join(work, 'leak');
    mkdirSync(join(dir, 'raw'), { recursive: true });
    const env = withDiagnostics(
      simulateOne({ seed: 'd3', pid: PID }),
      DIAG(`failed for ${PID} at ${OTHER}`)
    );
    writeFileSync(join(dir, 'raw', 'a.json'), JSON.stringify(env));
    /* the second id belongs to another participant of the same dataset, so it is known */
    writeFileSync(
      join(dir, 'raw', 'b.json'),
      JSON.stringify(simulateOne({ seed: 'd4', pid: OTHER }))
    );
    const out = join(dir, 'export');
    const run = spawnSync('node', [EXPORT_CLI, '--out', out, join(dir, 'raw')], {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
      env: { ...process.env, CSV_EXPORT_SALT: 'diag-test-salt-0123456789abcdef' },
    });
    expect(run.status, run.stderr).toBe(0);
    const text = readFileSync(join(out, 'DIAGNOSTICS.csv'), 'utf-8');
    expect(text).not.toContain(PID);
    expect(text).not.toContain(OTHER);
    expect(csv(text)[0].Participant_ID).toMatch(/^P[0-9a-f]{12}$/);
    expect(csv(text)[0].Message).toMatch(/^failed for P[0-9a-f]{12} at P[0-9a-f]{12}$/);
  });
});
