/**
 * The scheduler's pattern-reminder plan (`pattern_reminder`,
 * `trials_since_pattern_reminder`, see src/scheduler/pattern-reminders.js) must
 * reach the exported CSVs: Pattern_Reminder / Trials_Since_Pattern_Reminder in
 * every wide per-trial table and in EVENTS.csv, and pattern_reminder /
 * trials_since_pattern_reminder in the tidy trials.csv. Exercised on simulated
 * sessions, including a dump from before the fields were stamped.
 */
import { describe, it, expect } from 'vitest';
import {
  COLUMNS_D_ONLY,
  COLUMNS_T_ONLY,
  COLUMNS_I_ONLY,
  COLUMNS_I_D,
  COLUMNS_I_T,
  composeExport,
} from '../scripts/csv-export.js';
import { TRIALS_COLUMNS } from '../scripts/tidy-tables.js';
import { simulateOne } from '../scripts/simulate-pilot.js';

const REMINDER_COLS = ['Pattern_Reminder', 'Trials_Since_Pattern_Reminder'];
const WIDE = {
  d_only: { file: 'D_ONLY_Criterion1.csv', columns: COLUMNS_D_ONLY, after: 'Rotation_Deg' },
  t_only: { file: 'T_ONLY_Criterion1.csv', columns: COLUMNS_T_ONLY, after: 'Background_Shade' },
  i_only: { file: 'I_ONLY_Criterion1.csv', columns: COLUMNS_I_ONLY, after: 'Rotation_Deg' },
  i_d: { file: 'I_D_Criterion1.csv', columns: COLUMNS_I_D, after: 'Rotation_Deg' },
  i_t: { file: 'I_T_Criterion1.csv', columns: COLUMNS_I_T, after: 'Rotation_Deg' },
};
const IMAGERY = ['i_only', 'i_d', 'i_t'];
const MEMORY_ONLY = ['d_only', 't_only'];

/** Minimal RFC-4180 reader (quotes, doubled quotes, embedded commas/newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return { header, rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))) };
}

const SEEDS = ['rem-export-1', 'rem-export-2', 'rem-export-3'];
const envs = SEEDS.map((seed, i) =>
  simulateOne({ seed, pid: `REM_${i + 1}`, accuracy: 0.9, responseRate: 1 })
);
const inputOf = (list, mutate = (r) => r) =>
  list.map((env, i) => ({
    participant_id: `REM_${i + 1}`,
    rows: (env.rows ?? env.data).map(mutate),
    session: env.session ?? {},
  }));
const { files } = composeExport(inputOf(envs));

/** Trial type of an encoding row, from its phase name (`i_d_encoding` etc.). */
const encodingTypeOf = (phase) => /^(d_only|t_only|i_only|i_d|i_t)_encoding$/.exec(phase)?.[1];

describe('pattern-reminder fields in the wide trial tables', () => {
  for (const [type, { file, columns, after }] of Object.entries(WIDE)) {
    it(`${type}: both columns sit right after ${after}, once each`, () => {
      for (const c of REMINDER_COLS) expect(columns.filter((x) => x === c)).toHaveLength(1);
      const i = columns.indexOf(after);
      expect(columns.slice(i + 1, i + 3)).toEqual(REMINDER_COLS);
      const { header } = parseCsv(files[file]);
      expect(header).toEqual([...columns]);
    });
  }

  it('Pattern_Reminder is 1 only for imagery conditions, and matches the stamped plan', () => {
    for (const [type, { file }] of Object.entries(WIDE)) {
      const { rows } = parseCsv(files[file]);
      expect(rows.length).toBeGreaterThan(0);
      const exported = rows.filter((r) => r.Pattern_Reminder === '1').length;
      for (const r of rows) expect(['0', '1']).toContain(r.Pattern_Reminder);

      /* Count the reminders stamped on the raw encoding rows (one per trial
       * pass) for this condition, over the same participants. */
      const planned = envs.reduce(
        (n, env) =>
          n +
          (env.rows ?? env.data).filter(
            (r) => encodingTypeOf(r.phase) === type && r.pattern_reminder === true
          ).length,
        0
      );
      expect(exported).toBe(planned);
      if (MEMORY_ONLY.includes(type)) expect(exported).toBe(0);
    }
    const total = IMAGERY.reduce(
      (n, t) =>
        n + parseCsv(files[WIDE[t].file]).rows.filter((r) => r.Pattern_Reminder === '1').length,
      0
    );
    expect(total).toBeGreaterThan(0); /* the simulated sessions do contain reminders */
  });

  it('Trials_Since_Pattern_Reminder is 0 on a reminded trial and NA on memory-only trials', () => {
    for (const type of MEMORY_ONLY) {
      for (const r of parseCsv(files[WIDE[type].file]).rows) {
        expect(r.Pattern_Reminder).toBe('0');
        expect(r.Trials_Since_Pattern_Reminder).toBe('NA');
      }
    }
    for (const type of IMAGERY) {
      for (const r of parseCsv(files[WIDE[type].file]).rows) {
        if (r.Pattern_Reminder === '1') expect(r.Trials_Since_Pattern_Reminder).toBe('0');
        if (r.Trials_Since_Pattern_Reminder !== 'NA') {
          expect(Number.isInteger(Number(r.Trials_Since_Pattern_Reminder))).toBe(true);
          expect(Number(r.Trials_Since_Pattern_Reminder)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('the same value is exported by every table for the same trial', () => {
    const events = parseCsv(files['EVENTS.csv']);
    expect(events.header).toEqual(expect.arrayContaining(REMINDER_COLS));
    const i = events.header.indexOf('Rotation_Deg');
    expect(events.header.slice(i + 1, i + 3)).toEqual(REMINDER_COLS);
    const key = (r) => `${r.Participant_ID}|${r.Trial_Type}|${r.Block}|${r.Trial}`;
    const byTrial = new Map();
    for (const type of Object.keys(WIDE)) {
      for (const r of parseCsv(files[WIDE[type].file]).rows) {
        /* practice can run twice with the same key; compare only when unique */
        const k = key(r);
        byTrial.set(
          k,
          byTrial.has(k) ? null : [r.Pattern_Reminder, r.Trials_Since_Pattern_Reminder]
        );
      }
    }
    let compared = 0;
    for (const e of events.rows) {
      const want = byTrial.get(key(e));
      if (!want) continue;
      expect([e.Pattern_Reminder, e.Trials_Since_Pattern_Reminder]).toEqual(want);
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
  });
});

describe('pattern-reminder fields in the tidy trials table', () => {
  it('declares pattern_reminder and trials_since_pattern_reminder once, after the observed phase columns', () => {
    for (const c of ['pattern_reminder', 'trials_since_pattern_reminder'])
      expect(TRIALS_COLUMNS.filter((x) => x === c)).toHaveLength(1);
    const i = TRIALS_COLUMNS.indexOf('trials_since_pattern_phase');
    expect(TRIALS_COLUMNS.slice(i + 1, i + 3)).toEqual([
      'pattern_reminder',
      'trials_since_pattern_reminder',
    ]);
  });

  it('trials.csv: planned reminders per condition match the stamped plan and the observed phase', () => {
    const { rows } = parseCsv(files['trials.csv']);
    expect(rows.length).toBeGreaterThan(0);
    for (const type of Object.keys(WIDE)) {
      const mine = rows.filter((r) => r.condition === type);
      const planned = envs.reduce(
        (n, env) =>
          n +
          (env.rows ?? env.data).filter(
            (r) => encodingTypeOf(r.phase) === type && r.pattern_reminder === true
          ).length,
        0
      );
      expect(mine.filter((r) => r.pattern_reminder === 'true')).toHaveLength(planned);
      if (MEMORY_ONLY.includes(type)) {
        for (const r of mine) {
          expect(r.pattern_reminder).toBe('false');
          expect(r.trials_since_pattern_reminder).toBe('NA');
        }
      }
      for (const r of mine.filter((x) => x.pattern_reminder === 'true'))
        expect(r.trials_since_pattern_reminder).toBe('0');
    }
  });
});

describe('dumps from before the reminder fields were stamped', () => {
  const stripped = composeExport(
    inputOf(envs, (r) => {
      const { pattern_reminder: _a, trials_since_pattern_reminder: _b, ...rest } = r;
      return rest;
    })
  ).files;

  it('export NA for both fields in every wide table and EVENTS.csv', () => {
    for (const { file } of Object.values(WIDE)) {
      const { rows } = parseCsv(stripped[file]);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.Pattern_Reminder).toBe('NA');
        expect(r.Trials_Since_Pattern_Reminder).toBe('NA');
      }
    }
    const events = parseCsv(stripped['EVENTS.csv']);
    expect(events.rows.length).toBeGreaterThan(0);
    for (const r of events.rows) {
      expect(r.Pattern_Reminder).toBe('NA');
      expect(r.Trials_Since_Pattern_Reminder).toBe('NA');
    }
  });

  it('export NA for both fields in trials.csv, without losing any other column', () => {
    const { header, rows } = parseCsv(stripped['trials.csv']);
    expect(header).toEqual(TRIALS_COLUMNS);
    for (const r of rows) {
      expect(r.pattern_reminder).toBe('NA');
      expect(r.trials_since_pattern_reminder).toBe('NA');
    }
  });
});
