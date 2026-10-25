/**
 * V4-06 / V4-07 / V4-08: documentation that must match the code.
 *   - config.js describes the real upload file names (run id included; checkpoint,
 *     tail and partial files; regular buckets carry their seq range).
 *   - csv-export.js says what rotation_sign 0 means and which upload column is the
 *     final status.
 *   - csv-export.js and pilot-summary.js both say they must use the same salt.
 * The file-name examples are checked against the real builders.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { dataPipeFilenameForBucket, bucketFileLabel } from '../src/uploader.js';

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

describe('upload file names (config.js comment)', () => {
  const cfg = read('src/config.js');
  it('names the checkpoint, tail and partial files with the run id', () => {
    expect(cfg).toContain('<session_id>__<run_id>__ckpt_<seqMin>-<seqMax>.json');
    expect(cfg).toContain('<session_id>__<run_id>__tail_<seqMin>-<seqMax>.json');
    expect(cfg).toContain('<session_id>__<run_id>__partial_<seqMin>-<seqMax>.json');
    expect(cfg).not.toContain('`<sid>__ckpt_<seqMin>-<seqMax>.json`');
  });
  it('the documented schemes are what the builders produce', () => {
    expect(
      dataPipeFilenameForBucket({ session_id: 'S1', run_id: 'r1', bucket_label: 'ckpt_5-9' })
    ).toBe('S1__r1__ckpt_5-9.json');
    expect(
      dataPipeFilenameForBucket({ session_id: 'S1', run_id: 'r1', bucket_label: 'tail_10-12' })
    ).toBe('S1__r1__tail_10-12.json');
    expect(
      dataPipeFilenameForBucket({ session_id: 'S1', run_id: 'r1', bucket_label: 'partial_13-14' })
    ).toBe('S1__r1__partial_13-14.json');
    expect(
      dataPipeFilenameForBucket({
        session_id: 'S1',
        run_id: 'r1',
        bucket_label: bucketFileLabel({ bucket_label: '03_d_only', seq_min: 20, seq_max: 740 }),
      })
    ).toBe('S1__r1__03_d_only_s20-740.json');
  });
});

describe('exporter notes', () => {
  const exp = read('scripts/csv-export.js');
  const sum = read('scripts/pilot-summary.js');
  it('rotation_sign 0 means no rotation and the scheduler groups 0 with the non-negative angles', () => {
    expect(exp).toMatch(/rotation_sign[^\n]*0 no rotation/);
    expect(exp).toContain('0 with the non-negative group');
  });
  it('Upload_Status_Final is the latest upload status', () => {
    expect(exp).toContain('Upload_Status_Final');
    expect(exp).toMatch(/LATEST\s*\n?\s*\*?\s*upload row|LATEST upload row/);
  });
  it('both tools say they must share one salt', () => {
    expect(exp).toMatch(/must use the SAME\s*\n?\s*\*?\s*salt/);
    expect(sum).toMatch(/must use the SAME salt/);
  });
});
