// @vitest-environment jsdom
/**
 * A study link opened with Prolific's template placeholders still in it
 * (`?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}`)
 * must never be mistaken for a participant. Prolific replaces the placeholders
 * for real participants, so any value that is not a plain id is treated as
 * missing: the session becomes a preview and the analysis tools leave it out of
 * the stopping-rule counts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/storage.js', () => ({
  initStorage: vi.fn(() => Promise.resolve()),
  setCompletionUrl: vi.fn(() => Promise.resolve()),
  setSessionId: vi.fn(() => Promise.resolve()),
  setSessionStartedAt: vi.fn(() => Promise.resolve()),
  setSessionObject: vi.fn(() => Promise.resolve()),
}));
vi.mock('../src/uploader.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildCompletionUrl: () => 'https://example.test/complete' };
});

import { initSession, readProlificParams } from '../src/prolific.js';
import { sampleClass } from '../scripts/participant-rules.js';

const PILOT = { is_pilot_run: false, pilot_label: null, source: 'none' };
const PID = '5f1e8a1c9b2d4e0012345678';
const STUDY = '65a1b2c3d4e5f60718293a4b';
const SESSION = '6a7b8c9d0e1f2a3b4c5d6e7f';

const q = (pid, study, session) => `?PROLIFIC_PID=${pid}&STUDY_ID=${study}&SESSION_ID=${session}`;
const enc = encodeURIComponent;

describe('real Prolific ids pass through unchanged', () => {
  it('accepts 24-character hex ids', () => {
    const p = readProlificParams(q(PID, STUDY, SESSION));
    expect(p).toEqual({
      prolific_pid: PID,
      study_id: STUDY,
      session_id: SESSION,
      is_preview: false,
    });
  });

  it.each(['TEST_UPLOAD', 'pilot-07', 'abc123', 'A_b-C_9'])(
    'accepts the test-style id %s',
    (id) => {
      const p = readProlificParams(q(id, STUDY, SESSION));
      expect(p.prolific_pid).toBe(id);
      expect(p.is_preview).toBe(false);
    }
  );
});

describe('unreplaced placeholders become a preview', () => {
  const PLACEHOLDER_FORMS = [
    ['Prolific form', (k) => `{{%${k}%}}`],
    ['URL-encoded Prolific form', (k) => enc(`{{%${k}%}}`)],
    ['percent form', (k) => `%${k}%`],
    ['shell form', (k) => `\${${k}}`],
    ['angle brackets', (k) => `<${k}>`],
    ['square brackets', (k) => `[${k}]`],
    ['single braces', (k) => `{${k}}`],
    ['the bare parameter name', (k) => k],
    ['the bare name in lower case', (k) => k.toLowerCase()],
  ];

  it.each(PLACEHOLDER_FORMS)('treats %s as missing for all three parameters', (_name, form) => {
    const p = readProlificParams(
      q(enc(form('PROLIFIC_PID')), enc(form('STUDY_ID')), enc(form('SESSION_ID')))
    );
    expect(p.prolific_pid).toBeNull();
    expect(p.study_id).toBeNull();
    expect(p.session_id).toBeNull();
    expect(p.is_preview).toBe(true);
  });

  it('treats the literal Prolific template link as a preview', () => {
    const link =
      '?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}';
    const p = readProlificParams(link);
    expect(p).toEqual({ prolific_pid: null, study_id: null, session_id: null, is_preview: true });
  });

  it('keeps the valid parameters when only one is a placeholder', () => {
    const p = readProlificParams(
      `?PROLIFIC_PID=${PID}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID=${SESSION}`
    );
    expect(p.prolific_pid).toBe(PID);
    expect(p.study_id).toBeNull();
    expect(p.session_id).toBe(SESSION);
    expect(p.is_preview).toBe(true);
  });

  it('treats empty, blank, hostile and oversized values as missing', () => {
    for (const bad of ['', '%20%20', '../x', 'a b', 'x'.repeat(101), 'id;rm', '5f1e<script>']) {
      const p = readProlificParams(q(enc(bad), STUDY, SESSION));
      expect(p.prolific_pid, JSON.stringify(bad)).toBeNull();
      expect(p.is_preview).toBe(true);
    }
  });

  it('treats a missing parameter as before', () => {
    const p = readProlificParams(`?PROLIFIC_PID=${PID}&STUDY_ID=${STUDY}`);
    expect(p.session_id).toBeNull();
    expect(p.is_preview).toBe(true);
  });
});

describe('what a placeholder session looks like downstream', () => {
  it('is seeded as a preview, gets a local session id, and never carries the placeholder', () => {
    const raw = readProlificParams(
      '?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}'
    );
    const session = initSession(raw, PILOT);
    expect(session.params.is_preview).toBe(true);
    expect(session.params.prolific_pid).toBeNull();
    expect(session.params.session_id_source).toBe('local_fallback');
    expect(session.seed_string.startsWith('preview-')).toBe(true);
    expect(JSON.stringify(session)).not.toContain('{{');
  });

  it('is classed as a preview, not a participant, by the analysis tools', () => {
    const raw = readProlificParams(
      '?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}'
    );
    expect(sampleClass(initSession(raw, PILOT))).toBe('preview');
  });

  it('classes a real link as a real participant', () => {
    expect(sampleClass(initSession(readProlificParams(q(PID, STUDY, SESSION)), PILOT))).toBe(
      'real'
    );
  });
});
