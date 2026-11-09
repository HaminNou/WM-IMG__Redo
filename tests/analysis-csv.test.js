/** analysis-csv: the reduced file is a faithful column subset of the full trial file. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  KEEP_PROBE,
  KEEP_SLOT,
  KEEP_STAR,
  KEEP_TRIAL,
  composeAnalysisCsv,
  parseAnalysisArgs,
  wantedColumns,
} from '../scripts/analysis-csv.js';
import { parseCsv } from '../scripts/raw-to-csv.js';

const full = wantedColumns({ keepTiming: true });
const extra = ['participant_id', 'row_key', 'px_per_mm', 'slot1_x_mm'];
const header = [...extra, ...full];
const q = (s) => `"${s}"`;
function makeInput(n = 3) {
  const lines = [header.map(q).join(',')];
  for (let i = 0; i < n; i++) {
    lines.push(
      header
        .map((c, j) =>
          c === 'is_practice'
            ? i === 0
              ? 'TRUE'
              : 'FALSE'
            : j % 3 === 0
              ? q(`t,""${i}""\nx`)
              : j % 3 === 1
                ? 'NA'
                : String(i * j)
        )
        .join(',')
    );
  }
  return `${lines.join('\n')}\n`;
}

describe('analysis-csv', () => {
  it('has the expected block widths and no duplicate columns', () => {
    const w = wantedColumns();
    expect(w.length).toBe(
      KEEP_TRIAL.length + 6 * KEEP_SLOT.length + 3 * KEEP_PROBE.length + 3 * KEEP_STAR.length
    );
    expect(new Set(w).size).toBe(w.length);
  });
  it('keeps exactly the wanted columns, cell for cell, quoting included', () => {
    const text = makeInput();
    const { csv, manifest } = composeAnalysisCsv(text);
    const a = parseCsv(text);
    const b = parseCsv(csv);
    const names = b[0].map((c) => c.text);
    expect(names).toEqual(wantedColumns());
    const idx = a[0].map((c) => c.text);
    b.slice(1).forEach((row, i) =>
      row.forEach((c, j) => {
        const src = a[i + 1][idx.indexOf(names[j])];
        expect(c).toEqual(src);
      })
    );
    expect(manifest.output.n_columns).toBe(names.length);
    expect(manifest.dropped_columns).toEqual(expect.arrayContaining(extra));
    expect(manifest.kept_columns.length + manifest.dropped_columns.length).toBe(
      manifest.input.n_columns
    );
  });
  it('drops identifiers and geometry', () => {
    const { csv } = composeAnalysisCsv(makeInput());
    const names = parseCsv(csv)[0].map((c) => c.text);
    for (const c of ['participant_id', 'row_key', 'px_per_mm', 'slot1_x_mm'])
      expect(names).not.toContain(c);
  });
  it('--keep and --keep-timing add columns', () => {
    const base = wantedColumns();
    expect(wantedColumns({ keepTiming: true }).length).toBe(base.length + 6 * 6);
    const { csv } = composeAnalysisCsv(makeInput(), { keep: ['px_per_mm'] });
    expect(parseCsv(csv)[0].map((c) => c.text)).toContain('px_per_mm');
  });
  it('--main-trials-only removes practice trials only', () => {
    const { csv, manifest } = composeAnalysisCsv(makeInput(3), { mainTrialsOnly: true });
    expect(parseCsv(csv).length - 1).toBe(2);
    expect(manifest.output.n_trials).toBe(2);
  });
  it('rejects a missing kept column, ragged lines, empty input and a BOM-prefixed file is accepted', () => {
    const text = makeInput();
    expect(() => composeAnalysisCsv(text.replace('"condition"', '"cond"'))).toThrow(
      /not in the input/
    );
    expect(() => composeAnalysisCsv(`${text}1,2\n`)).toThrow(/fields/);
    expect(() => composeAnalysisCsv('')).toThrow(/empty/);
    expect(() => composeAnalysisCsv(`\uFEFF${text}`)).not.toThrow();
  });
  it('parses arguments strictly', () => {
    expect(() => parseAnalysisArgs(['n', 's'])).toThrow(/--in/);
    expect(() => parseAnalysisArgs(['n', 's', '--in', 'a'])).toThrow(/--out/);
    expect(() => parseAnalysisArgs(['n', 's', '--in', 'a', '--out', 'a'])).toThrow(/differ/);
    expect(() => parseAnalysisArgs(['n', 's', '--in', 'a', '--out', 'b', '--bogus'])).toThrow(
      /unknown/
    );
    expect(parseAnalysisArgs(['n', 's', '--in', 'a', '--out', 'b', '--keep', 'x,y']).keep).toEqual([
      'x',
      'y',
    ]);
  });
  it('CLI writes the file and manifest, and exits 2/3 on bad input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'analysis-csv-'));
    try {
      const inp = join(dir, 'in.csv');
      const out = join(dir, 'out.csv');
      writeFileSync(inp, makeInput());
      const script = resolve(__dirname, '../scripts/analysis-csv.js');
      const ok = spawnSync('node', [script, '--in', inp, '--out', out], { encoding: 'utf-8' });
      expect(ok.status).toBe(0);
      expect(readFileSync(`${out}.manifest.json`, 'utf-8')).toContain('analysis-csv.js');
      expect(spawnSync('node', [script, '--in', inp], { encoding: 'utf-8' }).status).toBe(2);
      expect(
        spawnSync('node', [script, '--in', join(dir, 'nope'), '--out', out], { encoding: 'utf-8' })
          .status
      ).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
