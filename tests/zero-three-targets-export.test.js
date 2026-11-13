/**
 * Trials with 0 targets (three foils) and 3 targets (no foil) through every exporter: the tidy tables,
 * the one-line-per-trial file (with its re-read verification), the reduced analysis file, the raw
 * file and the wide csv-export files. The sessions come from scripts/simulate-pilot.js, which drives
 * the real generators, so the trials are the generated ones. Every column that is about the target
 * of a probe is NA where there is no target; no exporter throws; nothing is a wrong number.
 */
import { describe, expect, it } from 'vitest';
import { simulateOne } from '../scripts/simulate-pilot.js';
import { composeTidyTables } from '../scripts/tidy-tables.js';
import { composeTrialCsv } from '../scripts/trials-to-csv.js';
import { composeAnalysisCsv } from '../scripts/analysis-csv.js';
import { composeRawCsv, parseCsv } from '../scripts/raw-to-csv.js';
import { composeExport } from '../scripts/csv-export.js';

const MEMORY = ['d_only', 't_only', 'i_d', 'i_t'];
const WIDE = { d_only: 'D_ONLY', t_only: 'T_ONLY', i_d: 'I_D', i_t: 'I_T' };
const TARGET_FIELDS = [
  'target_slot',
  'target_serial_position_overall',
  'target_serial_position_in_modality',
  'target_slot_in_stream',
  'target_event_key',
  'own_enc_dist_mm',
];

const participants = [0, 1].map((i) => {
  const env = simulateOne({
    seed: `zt-export-${i}`,
    pid: `ZT_P${i}`,
    accuracy: 0.75,
    responseRate: 0.96,
  });
  return {
    participant_id: env.prolific_pid,
    source_pid: env.prolific_pid,
    run_id: `run_${i}`,
    subject: i + 1,
    session: env,
    rows: env.rows,
  };
});
const tidy = composeTidyTables(participants);

/** trial key -> its three tidy probe rows (sorted by test position) */
function probesByTrial() {
  const m = new Map();
  for (const p of tidy.probes) {
    const k = `${p.participant_id}|${p.trial_uid}|${p.attempt}`;
    (m.get(k) ?? m.set(k, []).get(k)).push(p);
  }
  for (const v of m.values()) v.sort((a, b) => a.test_position - b.test_position);
  return m;
}
const trials = [...probesByTrial().entries()].map(([key, ps]) => ({
  key,
  ps,
  n: ps.filter((p) => p.is_target).length,
}));

describe('the simulated sessions contain 0- and 3-target trials', () => {
  it('per participant and task: 3 zero-target and 3 three-target trials (the pinned histogram)', () => {
    for (const p of participants) {
      for (const c of MEMORY) {
        const mine = trials.filter(
          (t) => t.key.startsWith(`${p.participant_id}|`) && t.ps[0].condition === c
        );
        const real = mine.filter((t) => t.ps.length === 3);
        expect(real).toHaveLength(24);
        const hist = [0, 1, 2, 3].map((k) => real.filter((t) => t.n === k).length);
        expect(hist).toEqual([3, 9, 9, 3]);
      }
    }
  });
});

describe('tidy tables', () => {
  it('build without issues; 3 probes planned for every memory trial', () => {
    expect(tidy.issues).toEqual([]);
    const mem = tidy.trials.filter((t) => MEMORY.includes(t.condition));
    expect(mem.length).toBeGreaterThan(0);
    expect(mem.every((t) => t.n_probes_planned === 3 && t.n_probe_rows === 3)).toBe(true);
  });

  it('probes: target fields are null on every foil, filled on every target', () => {
    for (const t of trials) {
      for (const p of t.ps) {
        if (p.is_target) {
          expect(p.target_slot).toBeGreaterThan(0);
          expect(p.target_slot_in_stream).toBe(p.target_slot);
          expect(p.target_serial_position_overall).toBeGreaterThan(0);
          expect(p.target_serial_position_in_modality).toBe(p.encoding_position);
          expect(p.target_event_key).toMatch(/\|\d+\|\d$/);
          expect(p.probe_type.startsWith('T_')).toBe(true);
        } else {
          for (const f of TARGET_FIELDS) expect(p[f] ?? null, f).toBe(null);
          expect(p.probe_type.startsWith('F_')).toBe(true);
        }
      }
    }
  });

  it('trials: probe counters add up on 0- and 3-target trials', () => {
    for (const t of trials.filter((x) => x.n === 0 || x.n === 3)) {
      const [pid, uid] = t.key.split('|');
      const row = tidy.trials.find((r) => r.participant_id === pid && r.trial_uid === uid);
      expect(row.n_probes_correct).toBe(t.ps.filter((p) => p.probe_correct === true).length);
      expect(row.n_probes_no_response).toBe(t.ps.filter((p) => p.responded !== true).length);
      expect(row.n_probes_missing_row).toBe(0);
    }
  });

  it('encoding events: no item is tested in a 0-target trial, every item in a 3-target trial', () => {
    for (const t of trials.filter((x) => x.n === 0 || x.n === 3)) {
      const [pid, uid] = t.key.split('|');
      const mem = tidy.events.filter(
        (e) =>
          e.participant_id === pid &&
          e.trial_uid === uid &&
          (e.event_modality === 'dot' || e.event_modality === 'tone')
      );
      expect(mem).toHaveLength(3);
      if (t.n === 0) {
        expect(mem.every((e) => e.tested_later === false)).toBe(true);
        for (const e of mem) {
          expect(e.test_position ?? null).toBe(null);
          expect(e.test_probe_type ?? null).toBe(null);
          expect(e.test_correct ?? null).toBe(null);
        }
      } else {
        expect(mem.every((e) => e.tested_later === true)).toBe(true);
        expect(mem.map((e) => e.test_position).sort()).toEqual([1, 2, 3]);
        for (const e of mem) {
          const p = t.ps.find((x) => x.test_position === e.test_position);
          expect(e.test_probe_type).toBe(p.probe_type);
          expect(e.test_correct).toBe(p.probe_correct);
        }
      }
    }
  });
});

const table = (csv) => {
  const [h, ...b] = parseCsv(csv.replace(/^\uFEFF/, ''));
  const cols = h.map((c) => c.text);
  return { cols, rows: b.map((r) => Object.fromEntries(r.map((c, i) => [cols[i], c.text]))) };
};

describe('trial file, analysis file, raw file (each re-reads its own CSV)', () => {
  const { csv } = composeTrialCsv(participants);
  const full = table(csv);

  it('the target columns of a probe are NA where the probe is a foil, a number where a target', () => {
    let checked = 0;
    for (const r of full.rows) {
      if (!MEMORY.includes(r.condition)) continue;
      for (let i = 1; i <= 3; i++) {
        const isTarget = r[`probe${i}_is_target`] === 'TRUE';
        for (const f of TARGET_FIELDS) {
          const v = r[`probe${i}_${f}`];
          if (isTarget && f !== 'own_enc_dist_mm') expect(v, `${f}`).not.toBe('NA');
          if (!isTarget) expect(v, `${f}`).toBe('NA');
        }
        checked += 1;
      }
    }
    expect(checked).toBe(participants.length * 4 * 24 * 3);
  });

  it('zero- and three-target trial lines agree with the tidy probes', () => {
    const byKey = new Map(
      full.rows.map((r) => [`${r.participant_id}|${r.trial_uid}|${r.attempt}`, r])
    );
    for (const t of trials.filter((x) => x.n === 0 || x.n === 3)) {
      const line = byKey.get(t.key);
      expect(line, t.key).toBeTruthy();
      t.ps.forEach((p, i) => {
        expect(line[`probe${i + 1}_is_target`]).toBe(p.is_target ? 'TRUE' : 'FALSE');
        expect(line[`probe${i + 1}_probe_type`]).toBe(p.probe_type);
        expect(line[`probe${i + 1}_probe_correct`]).toBe(p.probe_correct ? 'TRUE' : 'FALSE');
        expect(line[`probe${i + 1}_said_yes`]).toBe(
          p.said_yes === null || p.said_yes === undefined ? 'NA' : p.said_yes ? 'TRUE' : 'FALSE'
        );
      });
      const tested = [1, 2, 3, 4, 5, 6].filter((s) => line[`slot${s}_tested_later`] === 'TRUE');
      expect(tested).toHaveLength(t.n);
    }
  });

  it('the analysis file keeps the same cells', () => {
    const a = composeAnalysisCsv(csv);
    const red = table(a.csv);
    expect(red.rows).toHaveLength(full.rows.length);
    for (const col of red.cols.filter((c) =>
      /^probe\d_(target_|is_target|probe_correct)/.test(c)
    )) {
      expect(red.rows.map((r) => r[col])).toEqual(full.rows.map((r) => r[col]));
    }
  });

  it('the raw file builds and verifies', () => {
    const { csv: raw } = composeRawCsv(participants);
    const t = table(raw);
    const probes = t.rows.filter((r) => /_probe$/.test(r.phase));
    expect(probes.length).toBe(participants.length * 4 * 24 * 3);
    const nT = probes.filter((r) => r.is_target === 'TRUE').length;
    expect(nT).toBe(participants.length * 4 * (9 + 2 * 9 + 3 * 3));
  });
});

describe('csv-export wide files and EVENTS', () => {
  const { files } = composeExport(participants);

  it.each(MEMORY)('%s: type codes, correctness and encoding position follow the probes', (cond) => {
    for (const crit of [1, 2]) {
      const { rows } = table(files[`${WIDE[cond]}_Criterion${crit}.csv`]);
      expect(rows).toHaveLength(participants.length * 24);
    }
    const { rows } = table(files[`${WIDE[cond]}_Criterion1.csv`]);
    const mine = trials.filter((t) => t.ps[0].condition === cond && (t.n === 0 || t.n === 3));
    expect(mine).toHaveLength(participants.length * 6);
    /* every wide line of a zero- or three-target trial has types 3/4 or 1/2 in all three probes */
    const kinds = rows.map((r) => [1, 2, 3].map((i) => Number(r[`Qmark_${i}_Type`])));
    const uniform = kinds.filter((k) => k.every((c) => c <= 2) || k.every((c) => c >= 3));
    expect(uniform).toHaveLength(participants.length * 6);
    expect(kinds.every((k) => k.every((c) => c >= 1 && c <= 4))).toBe(true);
  });

  it('EVENTS: target-only columns are NA on foil recognition rows', () => {
    const { rows } = table(files['EVENTS.csv']);
    const recog = rows.filter((r) => r.Phase === 'recognition' && /probe/.test(r.Event_Kind));
    expect(recog.length).toBeGreaterThan(0);
    for (const r of recog) {
      const foil = Number(r.Probe_Type) >= 3;
      if (foil) expect(r.Target_Serial_Position_Overall).toBe('NA');
      else expect(r.Target_Serial_Position_Overall).not.toBe('NA');
    }
  });
});
