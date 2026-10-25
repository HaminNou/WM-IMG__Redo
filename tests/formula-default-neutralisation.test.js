/**
 * Spreadsheet-formula protection is ON by default for participant-typed text.
 *
 * A free-text field that begins with = + - @ (a tab, a CR) is evaluated as a formula
 * when a CSV is opened in Excel or Sheets. `glasses_contacts_note` is free text, and
 * `=HYPERLINK(...)` used to reach DEMOGRAPHICS.csv unchanged unless the researcher
 * remembered `--neutralise-formulas` (final independent review). Now, by default:
 *   - the columns that can hold participant- or browser-supplied text get a leading
 *     apostrophe when they would be read as a formula;
 *   - numeric cells and every fixed-vocabulary column are never touched (R reads the
 *     default output; a leading apostrophe on a code would be an error there);
 *   - `--neutralise-formulas` still covers every text cell;
 *   - `--no-neutralise-formulas` switches the protection off.
 */
import { describe, it, expect } from 'vitest';
import {
  composeExport,
  formatCsvValue,
  parseExportArgs,
  serializeRowsToCsv,
  FREE_TEXT_COLUMNS,
} from '../scripts/csv-export.js';
import { simulateOne } from '../scripts/simulate-pilot.js';

function parseCsv(text) {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',').map((c) => c.replace(/^"|"$/g, ''));
  return lines.map((l) => {
    const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, ''));
    return Object.fromEntries(
      cols.map((c, i) => [c, (cells[i] ?? '').replace(/^"|"$/g, '').replace(/""/g, '"')])
    );
  });
}

function input() {
  const env = simulateOne({ seed: 'fn', pid: 'FN', accuracy: 0.9, responseRate: 1 });
  const rows = (env.rows ?? env.data).map((r) =>
    r.phase === 'demographics'
      ? {
          ...r,
          response: { ...(r.response ?? {}), glasses_contacts_note: '=HYPERLINK("http://x","y")' },
        }
      : r.phase === 'attention_check'
        ? { ...r, attention_check_raw: '+cmd|calc' }
        : r
  );
  rows.push({
    seq: 99998,
    phase: 'attention_check',
    attention_check_id: 'ac1_colour',
    attention_check_raw: '+cmd|calc',
    attention_check_passed: false,
  });
  rows.push({
    seq: 99999,
    phase: 'runtime_error',
    kind: 'error',
    message: '@SUM(A1:A9)',
    source: '-x:1:1',
  });
  return [{ participant_id: 'FN', rows, session: { pilot_label: '=evil()' } }];
}

describe('default protection', () => {
  it('lists the columns that can hold typed text', () => {
    for (const c of ['Glasses_Contacts_Note', 'Raw_Input', 'Message', 'Source']) {
      expect(FREE_TEXT_COLUMNS.has(c), c).toBe(true);
    }
    /* numeric and fixed-vocabulary columns are not in it */
    for (const c of ['Participant_ID', 'Px_Per_Mm', 'Exclusion_Reasons', 'Status']) {
      expect(FREE_TEXT_COLUMNS.has(c), c).toBe(false);
    }
  });

  it('a formula-like glasses note and attention input are neutralised without any flag', () => {
    const { files } = composeExport(input());
    const demo = parseCsv(files['DEMOGRAPHICS.csv'])[0];
    expect(demo.Glasses_Contacts_Note).toBe(`'=HYPERLINK("http://x","y")`);
    const att = parseCsv(files['ATTENTION_CHECKS.csv']);
    expect(att.length).toBeGreaterThan(0);
    expect(att[0].Raw_Input).toBe("'+cmd|calc");
    const diag = parseCsv(files['DIAGNOSTICS.csv'])[0];
    expect(diag.Message).toBe("'@SUM(A1:A9)");
    expect(diag.Source).toBe("'-x:1:1");
  });

  it('leaves every other column alone, numbers included', () => {
    const plain = composeExport(input(), { neutraliseMode: 'none' });
    const dflt = composeExport(input());
    const a = parseCsv(plain.files['CALIBRATION_SUMMARY.csv'])[0];
    const b = parseCsv(dflt.files['CALIBRATION_SUMMARY.csv'])[0];
    expect(b).toEqual(a); /* nothing in this table is free text */
    expect(b.Pilot_Label).toBe('=evil()'); /* researcher-set, not participant-typed */
    expect(dflt.files['trials.csv']).toBe(plain.files['trials.csv']);
  });

  it('does not touch ordinary text', () => {
    const safe = serializeRowsToCsv(
      [{ Glasses_Contacts_Note: 'contacts, no problem', Raw_Input: 'right' }],
      ['Glasses_Contacts_Note', 'Raw_Input']
    );
    const [row] = parseCsv(safe);
    expect(row.Glasses_Contacts_Note).toBe('contacts, no problem');
    expect(row.Raw_Input).toBe('right');
  });

  it('a negative number in a free-text column is a number, not text, and stays as it is', () => {
    expect(formatCsvValue(-3, { neutraliseFormulas: true })).toBe('-3');
    const csv = serializeRowsToCsv([{ Message: -3 }], ['Message']);
    expect(csv).toContain('\n-3\n');
  });
});

describe('modes', () => {
  it('--neutralise-formulas (all) also protects columns outside the free-text list', () => {
    const { files } = composeExport(input(), { neutraliseMode: 'all' });
    expect(parseCsv(files['CALIBRATION_SUMMARY.csv'])[0].Pilot_Label).toBe("'=evil()");
    expect(parseCsv(files['DEMOGRAPHICS.csv'])[0].Glasses_Contacts_Note).toBe(
      `'=HYPERLINK("http://x","y")`
    );
  });

  it('the legacy option neutraliseFormulas: true still means all', () => {
    const { files } = composeExport(input(), { neutraliseFormulas: true });
    expect(parseCsv(files['CALIBRATION_SUMMARY.csv'])[0].Pilot_Label).toBe("'=evil()");
  });

  it('--no-neutralise-formulas switches the protection off', () => {
    const { files } = composeExport(input(), { neutraliseMode: 'none' });
    expect(parseCsv(files['DEMOGRAPHICS.csv'])[0].Glasses_Contacts_Note).toBe(
      '=HYPERLINK("http://x","y")'
    );
  });

  it('the command line: default is free_text, flags select all or none, both together is an error', () => {
    const base = ['node', 'csv-export.js', '--out', 'o', 'a.json'];
    expect(parseExportArgs(base).neutraliseMode).toBe('free_text');
    expect(parseExportArgs([...base, '--neutralise-formulas']).neutraliseMode).toBe('all');
    expect(parseExportArgs([...base, '--no-neutralise-formulas']).neutraliseMode).toBe('none');
    expect(parseExportArgs([...base, '--neutralise-formulas']).neutraliseFormulas).toBe(true);
    expect(parseExportArgs(base).neutraliseFormulas).toBe(false);
    expect(() =>
      parseExportArgs([...base, '--neutralise-formulas', '--no-neutralise-formulas'])
    ).toThrow(/cannot be combined/);
  });

  it('the manifest records the mode', () => {
    const { manifest } = composeExport(input(), { neutraliseMode: 'free_text' });
    expect(JSON.stringify(manifest)).not.toContain('=HYPERLINK');
  });
});
