/**
 * CALIBRATION_SUMMARY.csv: the final-attempt calibration columns and the
 * pre-registered exclusion flag (pre-reg rule `screen_calibration_inconsistent`:
 * exclude when the calibration outcome is `inconsistent_accepted`), exercised
 * on simulated sessions; plus the optional --excel-bom / --neutralise-formulas
 * output safety.
 */
import { describe, it, expect } from 'vitest';
import {
  CALIBRATION_COLUMNS,
  composeExport,
  extractCalibrationRow,
  formatCsvValue,
  serializeRowsToCsv,
  UTF8_BOM,
} from '../scripts/csv-export.js';
import { simulateOne } from '../scripts/simulate-pilot.js';
import { _testHelpers as SCREEN_CAL } from '../src/calibration/screen.js';

const NEW_COLUMNS = [
  'Screen_Cal_Status',
  'Screen_Cal_Accepted',
  'Screen_Cal_Usable',
  'Screen_Cal_Pass1_Px',
  'Screen_Cal_Pass2_Px',
  'Screen_Cal_Rel_Diff',
  'Screen_Cal_Consistent',
  'Screen_Cal_Tolerance',
  'Screen_Cal_Implied_Screen_Mm',
  'Screen_Cal_Reasons',
  'Exclude_Screen_Cal_Inconsistent',
];

function parseCsv(text) {
  /* Minimal RFC-4180 reader for the exporter's quoting style. */
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const t = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

describe('calibration columns on simulated sessions', () => {
  const okEnv = simulateOne({ seed: 'cal-ok', pid: 'CAL_OK', accuracy: 0.9, responseRate: 1 });
  const badEnv = simulateOne({
    seed: 'cal-bad',
    pid: 'CAL_BAD',
    accuracy: 0.9,
    responseRate: 1,
    calibration: 'inconsistent_accepted',
  });

  it('declares every new column exactly once, after Screen_Cal_Retried', () => {
    for (const c of NEW_COLUMNS) expect(CALIBRATION_COLUMNS.filter((x) => x === c)).toHaveLength(1);
    const i = CALIBRATION_COLUMNS.indexOf('Screen_Cal_Retried');
    expect(CALIBRATION_COLUMNS.slice(i + 1, i + 1 + NEW_COLUMNS.length)).toEqual(NEW_COLUMNS);
    expect(new Set(CALIBRATION_COLUMNS).size).toBe(CALIBRATION_COLUMNS.length);
  });

  it('a consistent participant is status ok and not excluded', () => {
    const row = extractCalibrationRow('CAL_OK', okEnv.session ?? {}, okEnv.rows ?? okEnv.data);
    expect(row.Screen_Cal_Status).toBe('ok');
    expect(row.Screen_Cal_Accepted).toBe(1);
    expect(row.Screen_Cal_Consistent).toBe(1);
    expect(row.Screen_Cal_Pass1_Px).toBe(318);
    expect(row.Screen_Cal_Pass2_Px).toBe(322);
    expect(row.Screen_Cal_Rel_Diff).toBeCloseTo(4 / 320, 10);
    expect(row.Screen_Cal_Rel_Diff).toBeLessThanOrEqual(SCREEN_CAL.CONSISTENCY_TOL);
    expect(row.Screen_Cal_Tolerance).toBe(SCREEN_CAL.CONSISTENCY_TOL);
    expect(row.Screen_Cal_Attempts).toBe(1);
    expect(row.Exclude_Screen_Cal_Inconsistent).toBe(0);
  });

  it('an inconsistent_accepted participant is flagged for exclusion', () => {
    const row = extractCalibrationRow('CAL_BAD', badEnv.session ?? {}, badEnv.rows ?? badEnv.data);
    expect(row.Screen_Cal_Status).toBe('inconsistent_accepted');
    expect(row.Screen_Cal_Accepted).toBe(1);
    expect(row.Screen_Cal_Consistent).toBe(0);
    expect(row.Screen_Cal_Attempts).toBe(3);
    expect(row.Screen_Cal_Pass1_Px).toBe(300);
    expect(row.Screen_Cal_Pass2_Px).toBe(360);
    expect(row.Screen_Cal_Rel_Diff).toBeGreaterThan(SCREEN_CAL.CONSISTENCY_TOL);
    expect(row.Exclude_Screen_Cal_Inconsistent).toBe(1);
  });

  it('the exported CSV carries the columns and one row per participant', () => {
    const { files } = composeExport([
      { participant_id: 'CAL_OK', rows: okEnv.rows ?? okEnv.data, session: okEnv.session ?? {} },
      {
        participant_id: 'CAL_BAD',
        rows: badEnv.rows ?? badEnv.data,
        session: badEnv.session ?? {},
      },
    ]);
    const table = parseCsv(files['CALIBRATION_SUMMARY.csv']);
    expect(table).toHaveLength(2);
    const byId = Object.fromEntries(table.map((r) => [r.Participant_ID, r]));
    expect(byId.CAL_OK.Exclude_Screen_Cal_Inconsistent).toBe('0');
    expect(byId.CAL_BAD.Exclude_Screen_Cal_Inconsistent).toBe('1');
    expect(byId.CAL_BAD.Screen_Cal_Status).toBe('inconsistent_accepted');
    for (const c of NEW_COLUMNS) expect(Object.keys(byId.CAL_OK)).toContain(c);
  });
});

describe('exclusion flag edge cases', () => {
  const out = (value, extra = []) => [...extra, { phase: 'screen_calibration_outcome', value }];

  it('is NA when there is no calibration outcome row', () => {
    const row = extractCalibrationRow('P', {}, [{ phase: 'consent', consented: true }]);
    expect(row.Exclude_Screen_Cal_Inconsistent).toBe('NA');
    expect(row.Screen_Cal_Status).toBe('NA');
  });

  it('falls back to accepted + consistent for dumps without a status field', () => {
    const bad = extractCalibrationRow(
      'P',
      {},
      out({ accepted: true, consistent: false, rel_diff: 0.2 })
    );
    expect(bad.Screen_Cal_Status).toBe('inconsistent_accepted');
    expect(bad.Exclude_Screen_Cal_Inconsistent).toBe(1);
    const good = extractCalibrationRow(
      'P',
      {},
      out({ accepted: true, consistent: true, rel_diff: 0.01 })
    );
    expect(good.Exclude_Screen_Cal_Inconsistent).toBe(0);
  });

  it('a screened-out final attempt (status retry) is not this exclusion', () => {
    const row = extractCalibrationRow(
      'P',
      {},
      out({ attempt: 3, accepted: false, status: 'retry', consistent: false, rel_diff: 0.3 })
    );
    expect(row.Screen_Cal_Accepted).toBe(0);
    expect(row.Exclude_Screen_Cal_Inconsistent).toBe(0);
  });

  it('uses the live tolerance at the boundary (exactly at tolerance is consistent)', () => {
    const tol = SCREEN_CAL.CONSISTENCY_TOL;
    const rows = [
      { phase: 'screen_calibration', cal_attempt: 1, cc_px_width: 300 },
      {
        phase: 'screen_calibration',
        cal_attempt: 1,
        cc_px_width: (300 * (1 + tol / 2)) / (1 - tol / 2),
      },
      { phase: 'screen_calibration_outcome', value: { attempt: 1 } },
    ];
    const row = extractCalibrationRow('P', {}, rows);
    expect(row.Screen_Cal_Rel_Diff).toBeCloseTo(tol, 6);
  });
});

describe('--excel-bom and --neutralise-formulas', () => {
  it('formatCsvValue leaves numbers and NA alone and only prefixes triggering strings', () => {
    const o = { neutraliseFormulas: true };
    expect(formatCsvValue(-3.5, o)).toBe('-3.5');
    expect(formatCsvValue('NA', o)).toBe('NA');
    expect(formatCsvValue(null, o)).toBe('NA');
    expect(formatCsvValue('=1+1', o)).toBe(`"'=1+1"`);
    expect(formatCsvValue('+44 1', o)).toBe(`"'+44 1"`);
    expect(formatCsvValue('-x', o)).toBe(`"'-x"`);
    expect(formatCsvValue('@SUM(A1)', o)).toBe(`"'@SUM(A1)"`);
    expect(formatCsvValue('\tcmd', o)).toBe(`"'\tcmd"`);
    expect(formatCsvValue('plain = text', o)).toBe('"plain = text"');
    /* Default is untouched. */
    expect(formatCsvValue('=1+1')).toBe('"=1+1"');
  });

  it('hostile strings round-trip intact by default', () => {
    const hostile = 'He said "hi", then\nleft; η² 😀 =cmd';
    const csv = serializeRowsToCsv([{ A: hostile, B: 1 }], ['A', 'B']);
    const [row] = parseCsv(csv);
    expect(row.A).toBe(hostile);
  });

  it('with the flag, only the leading apostrophe is added and the rest round-trips', () => {
    const hostile = '=HYPERLINK("http://x","y")';
    const csv = serializeRowsToCsv([{ A: hostile }], ['A'], { neutraliseFormulas: true });
    const [row] = parseCsv(csv);
    expect(row.A).toBe(`'${hostile}`);
  });

  it('composeExport applies the flag to text cells of the written files, and only then', () => {
    const env = simulateOne({ seed: 'neu', pid: 'NEU', accuracy: 0.9, responseRate: 1 });
    const input = [
      {
        participant_id: 'NEU',
        rows: env.rows ?? env.data,
        session: { pilot_label: '=evil()' },
      },
    ];
    const plain = composeExport(input);
    const safe = composeExport(input, { neutraliseFormulas: true });
    expect(Object.keys(safe.files)).toEqual(Object.keys(plain.files));
    const p = parseCsv(plain.files['CALIBRATION_SUMMARY.csv'])[0];
    const s = parseCsv(safe.files['CALIBRATION_SUMMARY.csv'])[0];
    expect(p.Pilot_Label).toBe('=evil()');
    expect(s.Pilot_Label).toBe("'=evil()");
    /* Numeric cells are never altered. */
    expect(s.Screen_Cal_Pass1_Px).toBe(p.Screen_Cal_Pass1_Px);
    expect(s.Px_Per_Mm).toBe(p.Px_Per_Mm);
  });

  it('UTF8_BOM is the single U+FEFF character and the parser tolerates it', () => {
    expect(UTF8_BOM).toBe('\uFEFF');
    const csv = UTF8_BOM + serializeRowsToCsv([{ A: 'η²' }], ['A']);
    expect(parseCsv(csv)[0].A).toBe('η²');
  });
});
