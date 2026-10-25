/**
 * V4-04, reader side: the final upload status is the status of the LATEST
 * upload row (`upload_session_end` or `upload_retry_result`), not the first.
 * A retry that delivered every file reads 'uploaded' even though
 * `upload_session_end` keeps the first attempt's 'partial'.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { simulateOne } from '../scripts/simulate-pilot.js';
import { uploadStatuses, summariseParticipantRuns } from '../scripts/participant-rules.js';
import { buildParticipantSummaryRows, PARTICIPANT_COLUMNS } from '../scripts/csv-export.js';
import { summariseParticipant } from '../scripts/pilot-summary.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const end = (status, seq) => ({ phase: 'upload_session_end', status, seq });
const retry = (status, seq) => ({ phase: 'upload_retry_result', status, seq });

describe('uploadStatuses', () => {
  it('first = end-of-session row, final = latest of either kind', () => {
    const u = uploadStatuses([end('partial', 10), retry('partial', 12), retry('uploaded', 15)]);
    expect(u).toEqual({ first: 'partial', final: 'uploaded', retries: 2 });
  });
  it('uses seq order, not array order', () => {
    const u = uploadStatuses([retry('uploaded', 15), end('partial', 10)]);
    expect(u.final).toBe('uploaded');
    expect(u.first).toBe('partial');
  });
  it('a later failed retry makes the final status the failure', () => {
    expect(uploadStatuses([end('uploaded', 3), retry('partial', 5)]).final).toBe('partial');
  });
  it('no retry rows: first == final; no upload rows at all: nulls', () => {
    expect(uploadStatuses([end('uploaded', 3)])).toEqual({
      first: 'uploaded',
      final: 'uploaded',
      retries: 0,
    });
    expect(uploadStatuses([])).toEqual({ first: null, final: null, retries: 0 });
    expect(uploadStatuses(undefined)).toEqual({ first: null, final: null, retries: 0 });
  });
  it('rows without seq keep their input order', () => {
    const u = uploadStatuses([
      { phase: 'upload_session_end', status: 'partial' },
      { phase: 'upload_retry_result', status: 'uploaded' },
    ]);
    expect(u.final).toBe('uploaded');
  });
});

function retriedEnvelope() {
  const env = simulateOne({ seed: 'retry-status', pid: 'RETRY_P1' });
  const rows = env.rows.map((r) =>
    r.phase === 'upload_session_end' ? { ...r, status: 'partial' } : r
  );
  const maxSeq = Math.max(...rows.map((r) => r.seq));
  const completion = rows.find((r) => r.phase === 'completion_redirect');
  rows.push({
    phase: 'upload_retry_result',
    status: 'uploaded',
    upload_attempt: 1,
    after_failure: true,
    retry_trigger: 'retry_button',
    previous_status: 'partial',
    seq: maxSeq + 1,
    run_id: completion?.run_id,
  });
  return { ...env, rows };
}

describe('participant rules, participant table and summary', () => {
  const env = retriedEnvelope();

  it('summariseParticipantRuns reports first, final and retries', () => {
    const r = summariseParticipantRuns([{ run_id: null, rows: env.rows }]);
    expect(r.upload_status_first).toBe('partial');
    expect(r.upload_status_final).toBe('uploaded');
    expect(r.upload_retries).toBe(1);
    expect(r.completed).toBe(true); /* completion still means the completion row */
  });

  it('PARTICIPANT_SUMMARY has Upload_Status_First/_Final/_Retries', () => {
    for (const c of ['Upload_Status_First', 'Upload_Status_Final', 'Upload_Retries'])
      expect(PARTICIPANT_COLUMNS).toContain(c);
    const [row] = buildParticipantSummaryRows([
      { participant_id: 'P1', source_pid: 'RETRY_P1', run_id: null, rows: env.rows, session: env },
    ]);
    expect(row.Upload_Status_First).toBe('partial');
    expect(row.Upload_Status_Final).toBe('uploaded');
    expect(row.Upload_Retries).toBe(1);
  });

  it('pilot-summary reports the final status and the first attempt', () => {
    const s = summariseParticipant([{ run_id: null, rows: env.rows }], { session: env });
    expect(s.upload_status).toBe('uploaded');
    expect(s.upload_status_first).toBe('partial');
    expect(s.upload_retries).toBe(1);
  });

  it('the printed line says uploaded, after 1 retry, with the first status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'upload-readers-'));
    try {
      writeFileSync(join(dir, 'RETRY_P1.json'), JSON.stringify(env));
      const out = spawnSync('node', [join(REPO, 'scripts/pilot-summary.js'), dir], {
        encoding: 'utf-8',
        cwd: REPO,
        env: { ...process.env, CSV_EXPORT_SALT: 'upload-readers-test-salt-0123456789' },
      });
      // eslint-disable-next-line no-control-regex
      const text = out.stdout.replace(/\u001b\[[0-9;]*m/g, '');
      expect(text).toContain('upload: uploaded (after 1 retry; first attempt: partial)');
      expect(text).not.toContain('upload: partial');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no retry rows: the line is the plain status, unchanged from before', () => {
    const plain = simulateOne({ seed: 'retry-status-plain', pid: 'RETRY_P2' });
    const s = summariseParticipant([{ run_id: null, rows: plain.rows }], { session: plain });
    expect(s.upload_status).toBe('uploaded');
    expect(s.upload_retries).toBe(0);
  });
});
