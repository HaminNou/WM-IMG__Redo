/**
 * The fallback download (shown when the upload fails) is named without the
 * Prolific id: a file name travels in e-mails and download folders. The file
 * CONTENT still carries the id, because the researcher needs it to approve and
 * pay the participant.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadAsJson } from '../src/uploader.js';

const PID = '5f3c9a2b7d1e4a6c8b0d1001';
const SESSION = {
  params: { prolific_pid: PID, session_id: '62c3d4e5f60718293a4b5c60', study_id: 'S' },
};

function fakeDoc() {
  const a = { click: vi.fn(), href: '', download: '' };
  return {
    a,
    createElement: () => a,
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
  };
}

describe('downloadAsJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('puts neither the Prolific id nor the session id in the file name', () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const doc = fakeDoc();
    const { filename } = downloadAsJson({ session: SESSION, rows: [{ seq: 1 }], doc });
    expect(filename).toMatch(/^wm-img-followup__[0-9a-f]{8}__\d{4}-\d{2}-\d{2}T.*\.json$/);
    expect(filename).not.toContain(PID);
    expect(filename).not.toContain(SESSION.params.session_id);
    expect(doc.a.download).toBe(filename);
    expect(doc.a.click).toHaveBeenCalledTimes(1);
  });

  it('uses a different random token each time (two downloads are distinguishable)', () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const tokens = new Set();
    for (let i = 0; i < 20; i++) {
      const { filename } = downloadAsJson({ session: SESSION, rows: [], doc: fakeDoc() });
      tokens.add(filename.split('__')[1]);
    }
    expect(tokens.size).toBeGreaterThan(15);
  });

  it('still carries the Prolific id in the file content', async () => {
    vi.useFakeTimers();
    let captured = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      captured = blob;
      return 'blob:x';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    downloadAsJson({ session: SESSION, rows: [{ seq: 1 }], doc: fakeDoc() });
    const text = await captured.text();
    expect(JSON.parse(text).session.params.prolific_pid).toBe(PID);
  });

  it('works without a session (preview)', () => {
    vi.useFakeTimers();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { filename } = downloadAsJson({ rows: [], doc: fakeDoc() });
    expect(filename).toMatch(/^wm-img-followup__[0-9a-f]{8}__/);
  });
});
