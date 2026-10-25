/**
 * `star_correct_all`: every planned star of a trial answered correctly.
 *
 * The flag exists so a star-contingent subset of the memory analysis can be run as a
 * sensitivity analysis. It is a plain column: no exported table is filtered on it.
 * Expected values are recomputed here from the raw star rows, independently of the
 * exporter.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { simulateOne } from '../scripts/simulate-pilot.js';
import { composeExport } from '../scripts/csv-export.js';

function parse(text) {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.split(',').map((c) => c.replace(/"/g, ''));
  return lines.map((l) => {
    const cells = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, ''));
    return Object.fromEntries(cols.map((c, i) => [c, (cells[i] ?? '').replace(/^"|"$/g, '')]));
  });
}

let sim;
let tables;

beforeAll(() => {
  /* 0.6 accuracy: a good mix of trials with all stars correct and with a miss */
  sim = simulateOne({ seed: 'star-all', pid: 'P_STAR', accuracy: 0.6 });
  const { files } = composeExport(
    [{ participant_id: 'P_STAR', source_pid: 'P_STAR', session: {}, rows: sim.rows }],
    { generatedAtIso: '2000-01-01T00:00:00Z' }
  );
  tables = {
    trials: parse(files['trials.csv']),
    stars: parse(files['stars.csv']),
    probes: parse(files['probes.csv']),
  };
});

describe('star_correct_all', () => {
  it('equals "every star row of the trial has star_correct === true" for every star trial', () => {
    const byTrial = new Map();
    for (const r of sim.rows) {
      if (!/^(i_only|i_d|i_t)_star$/.test(r.phase) || r.block_label === 'practice') continue;
      if (!byTrial.has(r.trial_uid)) byTrial.set(r.trial_uid, []);
      byTrial.get(r.trial_uid).push(r.star_correct === true);
    }
    expect(byTrial.size).toBe(72);
    const trials = tables.trials.filter((t) => byTrial.has(t.trial_uid));
    expect(trials).toHaveLength(72);
    let allCorrect = 0;
    for (const t of trials) {
      const answers = byTrial.get(t.trial_uid);
      expect(answers).toHaveLength(3);
      const expected = answers.every(Boolean);
      expect(t.star_correct_all, t.trial_uid).toBe(expected ? 'TRUE' : 'FALSE');
      if (expected) allCorrect += 1;
    }
    /* the fixture really exercises both values */
    expect(allCorrect).toBeGreaterThan(5);
    expect(allCorrect).toBeLessThan(67);
  });

  it('is NA for the conditions without stars', () => {
    const memoryOnly = tables.trials.filter(
      (t) => t.condition === 'd_only' || t.condition === 't_only'
    );
    expect(memoryOnly.length).toBeGreaterThan(40);
    for (const t of memoryOnly) expect(t.star_correct_all).toBe('NA');
  });

  it('is carried, with the same value, on every star row and every probe row of the trial', () => {
    const flag = new Map(tables.trials.map((t) => [t.trial_uid, t.star_correct_all]));
    for (const s of tables.stars) expect(s.star_correct_all).toBe(flag.get(s.trial_uid));
    const dual = tables.probes.filter((p) => p.condition === 'i_d' || p.condition === 'i_t');
    expect(dual.length).toBeGreaterThan(100);
    for (const p of dual) expect(p.star_correct_all).toBe(flag.get(p.trial_uid));
    for (const p of tables.probes.filter(
      (x) => x.condition === 'd_only' || x.condition === 't_only'
    ))
      expect(p.star_correct_all).toBe('NA');
  });

  it('filters nothing: every probe of every trial is exported whatever the star outcome', () => {
    const excluded = tables.probes.filter((p) => p.star_correct_all === 'FALSE');
    expect(excluded.length).toBeGreaterThan(0);
    const dualProbes = sim.rows.filter(
      (r) => /^(i_d|i_t)_probe$/.test(r.phase) && r.block_label !== 'practice'
    );
    expect(
      tables.probes.filter((p) => p.condition === 'i_d' || p.condition === 'i_t')
    ).toHaveLength(dualProbes.length);
  });

  it('differs from trial_star_excluded by ignoring the 250 ms anticipatory rule', () => {
    /* any trial whose stars are all correct but flagged excluded must hold an anticipatory star */
    for (const t of tables.trials.filter((x) => x.star_correct_all === 'TRUE')) {
      if (t.trial_star_excluded === 'TRUE')
        expect(Number(t.n_stars_anticipatory)).toBeGreaterThan(0);
    }
    for (const t of tables.trials.filter((x) => x.star_correct_all === 'FALSE'))
      expect(t.trial_star_excluded).toBe('TRUE');
  });
});
