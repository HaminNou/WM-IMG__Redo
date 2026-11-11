/**
 * Debug-session flags through the analysis tools: a session run with the experimenter debug
 * tools (debug_mode) and the trials in which the secret grid reveal was on (debug_reveal rows)
 * must be detectable in every export, and the debug run must be excluded by the shared rules.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { simulateOne } from '../scripts/simulate-pilot.js';
import { parseCsv } from '../scripts/raw-to-csv.js';
import { segmentTrials } from '../scripts/tidy-tables.js';
import { groupTrialRows } from '../scripts/csv-export.js';
import {
  DEBUG_SESSION_REASON,
  evaluateRun,
  isDebugRun,
  sampleClass,
  summariseParticipantRuns,
} from '../scripts/participant-rules.js';
import { stageOf, taskOf } from '../scripts/raw-to-csv.js';
import { aggregate, summariseParticipant } from '../scripts/pilot-summary.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SALT = 'debug-exporters-test-salt-0123456789';
let work;
let env;

const readTable = (path) => {
  const [header, ...body] = parseCsv(readFileSync(path, 'utf-8').replace(/^\uFEFF/, ''));
  const cols = header.map((h) => h.text);
  return { cols, rows: body.map((r) => Object.fromEntries(r.map((c, i) => [cols[i], c.text]))) };
};
const node = (script, args) =>
  spawnSync('node', [join(REPO, 'scripts', script), ...args], {
    encoding: 'utf-8',
    cwd: REPO,
    env: { ...process.env, CSV_EXPORT_SALT: SALT, WM_IMG_SUBJECT_FILE: join(work, 'subjects.csv') },
  });

/** Insert reveal rows (on, then off) before the first main-block gate row and renumber seq. */
function injectReveal(envelope) {
  const rows = envelope.rows.slice();
  const gateAt = rows.findIndex((r) => /_trial_start$/.test(r.phase) && r.block_label === 'main_a');
  const uid = rows[gateAt].trial_uid;
  const mk = (on) => ({
    phase: 'debug_reveal',
    debug_reveal_on: on,
    trial_uid: uid,
    debug_node_phase: 'gate',
    ts: 1000,
    debug_mode: true,
  });
  rows.splice(gateAt, 0, mk(true));
  rows.splice(gateAt + 3, 0, mk(false));
  rows.forEach((r, i) => {
    r.seq = i + 1;
  });
  return { uid, envelope: { ...envelope, rows, n_rows: rows.length, seq_max: rows.length } };
}

let revealUid;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'debug-exporters-'));
  mkdirSync(join(work, 'in'));
  const base = simulateOne({ seed: 'dbg-1', pid: 'DBG_P001', accuracy: 0.9, responseRate: 1 });
  const dbg = simulateOne({
    seed: 'dbg-2',
    pid: 'DBG_P002',
    accuracy: 0.9,
    responseRate: 1,
    debug: true,
  });
  const injected = injectReveal(dbg);
  revealUid = injected.uid;
  env = { base, dbg: injected.envelope };
  for (const e of [base, injected.envelope])
    writeFileSync(join(work, 'in', `${e.prolific_pid}.json`), JSON.stringify(e));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('participant rules', () => {
  it('a debug run gets the debug_session reason and is not retained', () => {
    const clean = evaluateRun(env.base.rows);
    const dbg = evaluateRun(env.dbg.rows);
    expect(clean.reasons).not.toContain(DEBUG_SESSION_REASON);
    expect(dbg.reasons).toContain(DEBUG_SESSION_REASON);
    expect(dbg.debug_session).toBe(true);
    expect(dbg.retained).toBe(false);
    expect(summariseParticipantRuns([{ run_id: 'a', rows: env.dbg.rows }]).debug_session).toBe(
      true
    );
  });
  it('is_debug_run: debug_mode stamp or a reveal-on row, nothing else', () => {
    expect(isDebugRun([{ phase: 'x' }, { phase: 'y', debug_mode: false }])).toBe(false);
    expect(isDebugRun([{ phase: 'y', debug_mode: true }])).toBe(true);
    expect(isDebugRun([{ phase: 'debug_reveal', debug_reveal_on: true }])).toBe(true);
    expect(isDebugRun([{ phase: 'debug_reveal', debug_reveal_on: false }])).toBe(false);
    expect(isDebugRun(null)).toBe(false);
  });
  it('sampleClass: debug wins over pilot, previews stay previews', () => {
    const params = { prolific_pid: 'p' };
    expect(sampleClass({ params, is_pilot_run: true, debug_mode: true })).toBe('debug');
    expect(sampleClass({ params, is_pilot_run: true })).toBe('pilot');
    expect(sampleClass({ params: {}, debug_mode: true })).toBe('preview');
  });
  it('pilot-summary does not count a debug session, even in a pilot batch', () => {
    const mk = (e) =>
      summariseParticipant([{ run_id: 'r', rows: e.rows }], {
        session: {
          params: { prolific_pid: e.prolific_pid },
          is_pilot_run: true,
          debug_mode: e.debug_mode,
        },
      });
    const a = aggregate([mk(env.base), mk(env.dbg)], { expectPilot: true });
    expect(mk(env.dbg).sample_class).toBe('debug');
    expect(mk(env.dbg).debug_mode).toBe(true);
    expect(a.issues.map((i) => i.code)).toContain('DEBUG_SESSIONS_NOT_COUNTED');
    expect(a.n_completed).toBe(1);
  });
});

describe('row classification', () => {
  it('debug_reveal rows are session events with no task', () => {
    const row = { phase: 'debug_reveal', debug_reveal_on: true, trial_uid: 'main_a-001-d_only' };
    expect(stageOf(row)).toBe('session_event');
    expect(taskOf({ phase: 'debug_reveal' })).toBeNull();
  });
});

describe('trial segmentation', () => {
  it('flags only the revealed trial and leaves trial_guard_excluded alone', () => {
    const w = segmentTrials(env.dbg.rows);
    const flagged = w.filter((x) => x.debugRevealSeen);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].gate.trial_uid).toBe(revealUid);
    expect(w.some((x) => x.rows.some((r) => r.phase === 'debug_reveal'))).toBe(false);
    expect(segmentTrials(env.base.rows).some((x) => x.debugRevealSeen)).toBe(false);
  });
  it('a reveal-off row alone does not flag; a uid-less on row flags the window it is in', () => {
    const gate = (uid) => ({ phase: 'd_only_trial_start', trial_uid: uid });
    const off = { phase: 'debug_reveal', debug_reveal_on: false, trial_uid: 'u1' };
    const on = { phase: 'debug_reveal', debug_reveal_on: true };
    const rows = [gate('u1'), off, gate('u2'), on].map((r, i) => ({ ...r, seq: i }));
    expect(segmentTrials(rows).map((x) => x.debugRevealSeen)).toEqual([false, true]);
  });
  it('csv-export groups carry the same flag', () => {
    const groups = [...groupTrialRows(new Map([['p', env.dbg.rows]])).values()];
    expect(groups.filter((g) => g.debug_reveal_seen)).toHaveLength(1);
  });
});

describe('exporters, end to end', () => {
  it('raw-to-csv: debug_mode column, reveal rows labelled', () => {
    const out = join(work, 'raw.csv');
    const r = node('raw-to-csv.js', ['--keep-pid', '--out', out, join(work, 'in')]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/WARNING: 1 run\(s\) are DEBUG sessions/);
    expect(JSON.parse(readFileSync(`${out}.manifest.json`, 'utf-8')).debug_runs).toHaveLength(1);
    const { cols, rows } = readTable(out);
    expect(cols).toContain('debug_mode');
    expect(cols.indexOf('debug_mode')).toBe(cols.indexOf('is_pilot_run') + 1);
    const reveal = rows.filter((x) => x.phase === 'debug_reveal');
    expect(reveal).toHaveLength(2);
    expect(new Set(reveal.map((x) => x.session_stage))).toEqual(new Set(['session_event']));
    expect(new Set(reveal.map((x) => x.debug_mode))).toEqual(new Set(['TRUE']));
    const bySubject = new Set(rows.map((x) => `${x.prolific_pid}:${x.debug_mode}`));
    expect(bySubject).toContain('DBG_P001:FALSE');
    expect(bySubject).toContain('DBG_P002:TRUE');
  });
  it('trials-to-csv and analysis-csv: debug_mode and debug_reveal_seen', () => {
    const out = join(work, 'trials.csv');
    let r = node('trials-to-csv.js', ['--keep-pid', '--out', out, join(work, 'in')]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/WARNING: 1 run\(s\) are DEBUG sessions/);
    expect(JSON.parse(readFileSync(`${out}.manifest.json`, 'utf-8')).debug_runs).toHaveLength(1);
    const { cols, rows } = readTable(out);
    expect(cols).toContain('debug_mode');
    expect(cols).toContain('debug_reveal_seen');
    const seen = rows.filter((x) => x.debug_reveal_seen === 'TRUE');
    expect(seen).toHaveLength(1);
    expect(seen[0].trial_uid).toBe(revealUid);
    expect(seen[0].debug_mode).toBe('TRUE');
    expect(rows.filter((x) => x.debug_mode === 'FALSE').length).toBeGreaterThan(100);
    expect(
      rows.filter((x) => x.debug_mode === 'FALSE').every((x) => x.debug_reveal_seen !== 'TRUE')
    ).toBe(true);
    const ana = join(work, 'analysis.csv');
    r = node('analysis-csv.js', ['--in', out, '--out', ana]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/WARNING: 1 run\(s\) are DEBUG sessions/);
    expect(JSON.parse(readFileSync(`${ana}.manifest.json`, 'utf-8')).debug_runs).toHaveLength(1);
    const a = readTable(ana);
    expect(a.cols).toContain('debug_mode');
    expect(a.cols).toContain('debug_reveal_seen');
    expect(a.rows.filter((x) => x.debug_reveal_seen === 'TRUE')).toHaveLength(1);
  });
  it('csv-export: Debug_Mode, Debug_Reveal_Seen, debug_session exclusion, tidy trials', () => {
    const out = join(work, 'export');
    const r = node('csv-export.js', ['--keep-pid', '--out', out, join(work, 'in')]);
    expect(r.status, r.stderr).toBe(0);
    const ps = readTable(join(out, 'PARTICIPANT_SUMMARY.csv')).rows;
    const d = ps.find((x) => x.Participant_ID === 'DBG_P002');
    expect(d.Debug_Mode).toBe('1');
    expect(d.Sample_Class).toBe('debug');
    expect(d.Exclusion_Reasons).toContain('debug_session');
    expect(ps.find((x) => x.Participant_ID === 'DBG_P001').Debug_Mode).toBe('0');
    const tidy = readTable(join(out, 'trials.csv'));
    expect(tidy.cols).toContain('debug_reveal_seen');
    expect(tidy.rows.filter((x) => x.debug_reveal_seen === 'TRUE')).toHaveLength(1);
    const wide = readTable(join(out, 'D_ONLY_Criterion1.csv'));
    expect(wide.cols).toContain('Debug_Mode');
    expect(wide.cols).toContain('Debug_Reveal_Seen');
    const manifest = JSON.parse(readFileSync(join(out, 'EXPORT_MANIFEST.json'), 'utf-8'));
    expect(JSON.stringify(manifest)).toContain('debug_mode_flags');
  });
});
