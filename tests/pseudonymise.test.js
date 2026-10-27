/**
 * Pseudonymisation of the analysis exports.
 *
 * The consent says the Prolific ID "is replaced with a code before analysis or
 * sharing". These tests drive the REAL CLIs over simulated sessions (with
 * realistic 24-hex Prolific ids, bucket-style file names that carry the session
 * id, and a participant who reloaded) and assert from the files on disk that no
 * output carries a raw id, that codes are stable and joinable, and that the only
 * link back to a person is a key file outside the export folder.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { simulateOne } from '../scripts/simulate-pilot.js';
import {
  makeCoder,
  makeScrubber,
  findLeaks,
  resolveSalt,
  writeKeyFile,
  keyRowsToCsv,
  defaultPrivateDir,
  isInside,
  pseudonymisePerParticipant,
} from '../scripts/pseudonymise.js';
import { loadAndFlattenDumps } from '../scripts/dump-loader.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT_CLI = join(REPO_ROOT, 'scripts/csv-export.js');
const SUMMARY_CLI = join(REPO_ROOT, 'scripts/pilot-summary.js');
const SALT_A = 'pseudonymise-test-salt-A-0123456789';
const SALT_B = 'pseudonymise-test-salt-B-9876543210';
const CODE_RE = /^P[0-9a-f]{12}$/;

const PIDS = ['5f3c9a2b7d1e4a6c8b0d1001', '5f3c9a2b7d1e4a6c8b0d1002', '5f3c9a2b7d1e4a6c8b0d1003'];
const RELOAD_PID = '60a1b2c3d4e5f60718293a4b';
const RELOAD_SID = '61b2c3d4e5f60718293a4b5c';

function cli(script, args, env = {}) {
  return spawnSync('node', [script, ...args], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
    /* Always an explicit salt: a test must never create the per-user salt file. */
    env: { ...process.env, CSV_EXPORT_SALT: SALT_A, ...env },
  });
}

/** Every file under a directory, as { relativeName: contents }. */
function readTree(dir) {
  const out = {};
  for (const name of readdirSync(dir)) out[name] = readFileSync(join(dir, name), 'utf-8');
  return out;
}

function csvColumn(text, column) {
  const [head, ...lines] = text.split('\n').filter((l) => l.length > 0);
  const cols = head.split(',').map((c) => c.replace(/^"|"$/g, ''));
  const i = cols.indexOf(column);
  return lines.map((l) => l.split(',')[i].replace(/^"|"$/g, ''));
}

describe('pseudonymisation of the analysis exports', () => {
  let work;
  let inputDir;
  let allIds;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'pseudonymise-'));
    inputDir = join(work, 'raw');
    mkdirSync(inputDir, { recursive: true });
    allIds = [...PIDS, RELOAD_PID, RELOAD_SID];
    PIDS.forEach((pid, i) => {
      const env = simulateOne({ seed: `pseudo-${i}`, pid, accuracy: 0.85, responseRate: 0.97 });
      env.session_id = `62c3d4e5f60718293a4b5c6${i}`;
      allIds.push(env.session_id);
      if (i === 0) {
        /* A participant typed their own Prolific id into the only free-text answer (an
         * attention check; the demographics form has no free-text box). */
        env.rows.push({
          seq: 99990,
          phase: 'attention_check',
          attention_check_id: 'ac1_colour',
          attention_check_raw: `my id is ${pid} ok`,
          attention_check_passed: false,
        });
      }
      /* Bucket-style name: the session id is part of the file name. */
      writeFileSync(
        join(inputDir, `${env.session_id}__run${i}__03_d_only.json`),
        JSON.stringify(env)
      );
    });
    const gate = (seq, run) => ({
      seq,
      run_id: run,
      phase: 'd_only_trial_start',
      block_label: 'main_a',
      trial_uid: 'main_a-001-d_only',
      trial_index_in_block: 0,
      presentation_index: 1,
      note: `free text mentioning ${RELOAD_PID} on purpose`,
    });
    for (const run of ['aaaa1111', 'bbbb2222']) {
      writeFileSync(
        join(inputDir, `${RELOAD_SID}__${run}__03_d_only.json`),
        JSON.stringify({
          session_id: RELOAD_SID,
          prolific_pid: RELOAD_PID,
          build_id: 'v1',
          schema_version: '1.2.0',
          rows: [gate(1, run)],
        })
      );
    }
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  describe('export CLI, default (pseudonymised)', () => {
    let out;
    let priv;
    beforeAll(() => {
      out = join(work, 'export');
      priv = defaultPrivateDir(out);
      const r = cli(EXPORT_CLI, ['--out', out, inputDir]);
      expect(r.status, r.stderr).toBe(0);
    });

    it('no output file contains any raw Prolific id, session id, or local file name', () => {
      const tree = readTree(out);
      expect(Object.keys(tree).length).toBeGreaterThan(15);
      const leaks = findLeaks(tree, allIds);
      expect(leaks).toEqual([]);
      /* Independent of the helper under test: a plain substring scan. */
      for (const [file, text] of Object.entries(tree)) {
        for (const id of allIds) expect(text.includes(id), `${id} in ${file}`).toBe(false);
        expect(text.includes(work), `local path in ${file}`).toBe(false);
        expect(text).not.toMatch(/__run\d|03_d_only\.json/);
      }
    });

    it('a Prolific id typed into free text is replaced by its code in ATTENTION_CHECKS.csv', () => {
      const checks = readFileSync(join(out, 'ATTENTION_CHECKS.csv'), 'utf-8');
      expect(checks).not.toContain(PIDS[0]);
      const notes = csvColumn(checks, 'Raw_Input');
      expect(notes.some((n) => /^my id is P[0-9a-f]{12} ok$/.test(n.replace(/^"|"$/g, '')))).toBe(
        true
      );
    });

    it('tables carry codes and the manifest says the export is pseudonymised', () => {
      const ids = csvColumn(
        readFileSync(join(out, 'PARTICIPANT_SUMMARY.csv'), 'utf-8'),
        'Participant_ID'
      );
      expect(ids).toHaveLength(PIDS.length + 1);
      for (const id of ids) expect(id).toMatch(CODE_RE);
      const manifest = JSON.parse(readFileSync(join(out, 'EXPORT_MANIFEST.json'), 'utf-8'));
      expect(manifest.export_options).toMatchObject({ pseudonymised: true, keep_pid: false });
      expect(manifest.source_files.map((f) => f.path)).toEqual(
        manifest.source_files.map((_, i) => `input_${String(i + 1).padStart(3, '0')}.json`)
      );
      expect(JSON.stringify(manifest)).not.toContain('prolific_pid');
    });

    it('PID_KEY.csv sits outside the export folder and maps every code back', () => {
      expect(isInside(priv, out)).toBe(false);
      const keyPath = join(priv, 'PID_KEY.csv');
      expect(existsSync(keyPath)).toBe(true);
      expect(existsSync(join(out, 'PID_KEY.csv'))).toBe(false);
      const key = readFileSync(keyPath, 'utf-8');
      const codes = csvColumn(
        readFileSync(join(out, 'PARTICIPANT_SUMMARY.csv'), 'utf-8'),
        'Participant_ID'
      );
      const pairs = new Map(
        key
          .split('\n')
          .slice(1)
          .filter(Boolean)
          .map((l) => l.split(','))
          .map(([code, pid]) => [code, pid])
      );
      for (const c of codes) expect(pairs.has(c), c).toBe(true);
      expect([...pairs.values()].sort()).toEqual([...PIDS, RELOAD_PID].sort());
      expect(statSync(keyPath).mode & 0o077).toBe(0);
    });

    it('the salt is not written anywhere in the export folder', () => {
      for (const text of Object.values(readTree(out))) {
        expect(text).not.toContain(SALT_A);
      }
    });

    it('joins still work: every trial-table participant id is in PARTICIPANT_SUMMARY', () => {
      const summary = readFileSync(join(out, 'PARTICIPANT_SUMMARY.csv'), 'utf-8');
      const known = new Set([
        ...csvColumn(summary, 'Participant_ID'),
        ...csvColumn(summary, 'Table_Participant_ID'),
      ]);
      for (const f of ['trials.csv', 'stars.csv', 'probes.csv']) {
        const ids = new Set(csvColumn(readFileSync(join(out, f), 'utf-8'), 'participant_id'));
        expect(ids.size).toBeGreaterThan(0);
        for (const id of ids) {
          const base = id.replace(/__run_.*$/, '');
          expect(base, `${f}: ${id}`).toMatch(CODE_RE);
          expect(known.has(id) || known.has(base), `${f}: ${id}`).toBe(true);
        }
      }
    });

    it('the reloaded participant keeps a run suffix on a code, never on the PID', () => {
      const trials = readFileSync(join(out, 'trials.csv'), 'utf-8');
      expect(trials).toMatch(/P[0-9a-f]{12}__run_bbbb2222/);
      expect(trials).not.toContain(RELOAD_PID);
    });
  });

  describe('stability of the codes', () => {
    it('same salt gives identical tables; another salt gives unrelated codes', () => {
      const a1 = join(work, 'stab-a1');
      const a2 = join(work, 'stab-a2');
      const b = join(work, 'stab-b');
      expect(cli(EXPORT_CLI, ['--out', a1, inputDir]).status).toBe(0);
      expect(cli(EXPORT_CLI, ['--out', a2, inputDir]).status).toBe(0);
      expect(cli(EXPORT_CLI, ['--out', b, inputDir], { CSV_EXPORT_SALT: SALT_B }).status).toBe(0);
      const sa1 = readFileSync(join(a1, 'PARTICIPANT_SUMMARY.csv'), 'utf-8');
      const sa2 = readFileSync(join(a2, 'PARTICIPANT_SUMMARY.csv'), 'utf-8');
      const sb = readFileSync(join(b, 'PARTICIPANT_SUMMARY.csv'), 'utf-8');
      expect(sa1).toBe(sa2);
      const ca = new Set(csvColumn(sa1, 'Participant_ID'));
      const cb = csvColumn(sb, 'Participant_ID');
      for (const c of cb) expect(ca.has(c)).toBe(false);
      /* The file salt wins over the environment, and is read, not created. */
      const saltFile = join(work, 'salt.txt');
      writeFileSync(saltFile, `${SALT_B}\n`);
      const f = join(work, 'stab-file');
      expect(cli(EXPORT_CLI, ['--out', f, '--salt-file', saltFile, inputDir]).status).toBe(0);
      expect(readFileSync(join(f, 'PARTICIPANT_SUMMARY.csv'), 'utf-8')).toBe(sb);
    });

    it('the batch tool prints the same codes as the tables, and no raw id', () => {
      const r = cli(SUMMARY_CLI, ['--json', inputDir]);
      expect(r.status, r.stderr).toBe(0);
      for (const id of allIds) expect(r.stdout.includes(id), id).toBe(false);
      const ref = csvColumn(
        readFileSync(join(work, 'stab-a1', 'PARTICIPANT_SUMMARY.csv'), 'utf-8'),
        'Participant_ID'
      );
      const shown = JSON.parse(r.stdout).perParticipant.map((p) => p.prolific_pid);
      expect([...shown].sort()).toEqual([...ref].sort());
    });
  });

  describe('flags', () => {
    it('--keep-pid exports raw ids, warns, and writes no key file', () => {
      const out = join(work, 'keep');
      const r = cli(EXPORT_CLI, ['--out', out, '--keep-pid', inputDir]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/--keep-pid/);
      const ids = csvColumn(
        readFileSync(join(out, 'PARTICIPANT_SUMMARY.csv'), 'utf-8'),
        'Participant_ID'
      );
      expect(ids.sort()).toEqual([...PIDS, RELOAD_PID].sort());
      expect(existsSync(defaultPrivateDir(out))).toBe(false);
      const manifest = JSON.parse(readFileSync(join(out, 'EXPORT_MANIFEST.json'), 'utf-8'));
      expect(manifest.export_options).toMatchObject({ pseudonymised: false, keep_pid: true });
    });

    it('--keep-pid together with --share is refused and writes nothing', () => {
      const out = join(work, 'keep-share');
      const r = cli(EXPORT_CLI, ['--out', out, '--keep-pid', '--share', inputDir]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/--keep-pid .*--share/);
      expect(existsSync(out)).toBe(false);
    });

    it('--share on a pseudonymised export works', () => {
      const out = join(work, 'shared');
      const r = cli(EXPORT_CLI, ['--out', out, '--share', inputDir]);
      expect(r.status, r.stderr).toBe(0);
      expect(findLeaks(readTree(out), allIds)).toEqual([]);
    });

    it('a private directory inside the export folder is refused', () => {
      const out = join(work, 'bad-private');
      const r = cli(EXPORT_CLI, ['--out', out, '--private-dir', join(out, 'private'), inputDir]);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/inside the export folder/);
      expect(existsSync(out)).toBe(false);
    });

    it('--private-dir chooses where the key goes', () => {
      const out = join(work, 'custom-private');
      const priv = join(work, 'elsewhere');
      expect(cli(EXPORT_CLI, ['--out', out, '--private-dir', priv, inputDir]).status).toBe(0);
      expect(existsSync(join(priv, 'PID_KEY.csv'))).toBe(true);
    });
  });
});

describe('pseudonymise.js units', () => {
  it('codes are deterministic per salt, prefixed, 12 hex, and differ by kind and salt', () => {
    const a = makeCoder(SALT_A);
    const b = makeCoder(SALT_B);
    expect(a.participant('X'.repeat(24))).toBe(a.participant('X'.repeat(24)));
    expect(a.participant('X'.repeat(24))).toMatch(CODE_RE);
    expect(a.session('X'.repeat(24))).toMatch(/^S[0-9a-f]{12}$/);
    expect(a.participant('abc')).not.toBe(b.participant('abc'));
    expect(a.participant('abc').slice(1)).not.toBe(a.session('abc').slice(1));
    expect(() => makeCoder('short')).toThrow(/salt/);
  });

  it('scrubber replaces long ids anywhere (even in file names) but short ids only as tokens', () => {
    const long = '5f3c9a2b7d1e4a6c8b0d1001';
    const scrub = makeScrubber(
      new Map([
        [long, 'Pcode'],
        ['TEST', 'Pshort'],
      ])
    );
    expect(scrub(`${long}__run1__01.json`)).toBe('Pcode__run1__01.json');
    expect(scrub({ a: [`x ${long} y`], n: 3, b: null })).toEqual({
      a: ['x Pcode y'],
      n: 3,
      b: null,
    });
    expect(scrub('TEST')).toBe('Pshort');
    expect(scrub('TEST_UPLOAD and TESTING and a TEST here')).toBe(
      'TEST_UPLOAD and TESTING and a Pshort here'
    );
  });

  it('findLeaks finds a raw id wherever it hides, and a clean text passes', () => {
    const id = '5f3c9a2b7d1e4a6c8b0d1001';
    expect(findLeaks({ a: 'clean', b: `x${id}y` }, [id])).toEqual([{ file: 'b', identifier: id }]);
    expect(findLeaks({ a: 'clean' }, [id])).toEqual([]);
    expect(findLeaks({ a: 'TEST_X', b: 'a TEST b' }, ['TEST'])).toEqual([
      { file: 'b', identifier: 'TEST' },
    ]);
  });

  it('pseudonymisePerParticipant does not mutate its input and fails on a code collision', () => {
    const pid = '5f3c9a2b7d1e4a6c8b0d1001';
    const input = [
      {
        participant_id: pid,
        source_pid: pid,
        run_id: 'none',
        session: { params: { prolific_pid: pid, session_id: '62c3d4e5f60718293a4b5c60' } },
        rows: [{ seq: 1, note: pid }],
        source_paths: ['/x/y.json'],
      },
    ];
    const snapshot = JSON.stringify(input);
    const out = pseudonymisePerParticipant(input, makeCoder(SALT_A));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out.perParticipant[0].source_paths).toBeUndefined();
    expect(JSON.stringify(out.perParticipant)).not.toContain(pid);
    expect(out.keyRows).toHaveLength(1);
    const fake = { participant: () => 'Psame', session: () => 'Ssame' };
    const two = [input[0], { ...input[0], participant_id: 'other', source_pid: 'other' }];
    expect(() => pseudonymisePerParticipant(two, fake)).toThrow(/collision/);
  });

  it('writeKeyFile refuses a directory inside the export folder; key CSV quotes cells', () => {
    const base = mkdtempSync(join(tmpdir(), 'pseudonymise-key-'));
    try {
      const out = join(base, 'out');
      expect(() => writeKeyFile({ keyRows: [], outDir: out, privateDir: join(out, 'p') })).toThrow(
        /must not be inside/
      );
      const path = writeKeyFile({
        keyRows: [
          { Participant_Code: 'P1', PROLIFIC_PID: 'a,b', Session_Code: 'S1', SESSION_ID: 'q"r' },
        ],
        outDir: out,
      });
      expect(path).toBe(join(defaultPrivateDir(out), 'PID_KEY.csv'));
      expect(readFileSync(path, 'utf-8')).toBe(
        'Participant_Code,PROLIFIC_PID,Session_Code,SESSION_ID\nP1,"a,b",S1,"q""r"\n'
      );
      expect(keyRowsToCsv([])).toBe('Participant_Code,PROLIFIC_PID,Session_Code,SESSION_ID\n');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('resolveSalt: --salt-file beats env beats the default file; the default is created once, 0600', () => {
    const base = mkdtempSync(join(tmpdir(), 'pseudonymise-salt-'));
    try {
      const messages = [];
      const log = (m) => messages.push(m);
      const file = join(base, 'given');
      writeFileSync(file, 'file-salt-0123456789abcdef\n');
      expect(
        resolveSalt({ saltFile: file, env: { CSV_EXPORT_SALT: 'env-salt-0123456789abcdef' } })
      ).toMatchObject({
        salt: 'file-salt-0123456789abcdef',
        source: 'file',
      });
      expect(() => resolveSalt({ saltFile: join(base, 'missing') })).toThrow(/does not exist/);
      expect(
        resolveSalt({ env: { CSV_EXPORT_SALT: 'env-salt-0123456789abcdef' }, log })
      ).toMatchObject({
        source: 'env',
      });
      const def = join(base, 'default-salt');
      const first = resolveSalt({ env: {}, defaultFile: def, log });
      expect(first.source).toBe('generated');
      expect(first.salt).toMatch(/^[0-9a-f]{64}$/);
      expect(messages.join('\n')).toMatch(/created a new random salt/);
      expect(statSync(def).mode & 0o077).toBe(0);
      const second = resolveSalt({ env: {}, defaultFile: def, log });
      expect(second).toMatchObject({ source: 'default_file', salt: first.salt });
      writeFileSync(def, 'tiny');
      expect(() => resolveSalt({ env: {}, defaultFile: def, log })).toThrow(/too short/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('the loader output for a bucket-style session pseudonymises end to end', () => {
    const base = mkdtempSync(join(tmpdir(), 'pseudonymise-load-'));
    try {
      const pid = '5f3c9a2b7d1e4a6c8b0d1001';
      const sid = '62c3d4e5f60718293a4b5c60';
      const file = join(base, `${sid}__aaaa1111__01.json`);
      writeFileSync(
        file,
        JSON.stringify({
          session_id: sid,
          prolific_pid: pid,
          rows: [{ seq: 1, run_id: 'aaaa1111', phase: 'consent', who: pid }],
        })
      );
      const loaded = loadAndFlattenDumps([file]);
      const out = pseudonymisePerParticipant(loaded.perParticipant, makeCoder(SALT_A));
      const text = JSON.stringify(out.perParticipant);
      expect(text).not.toContain(pid);
      expect(text).not.toContain(sid);
      expect(text).not.toContain(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
