/**
 * Tidy tables (trials / stars / probes): counts, unique keys, per-trial
 * exclusion flag, screen positions, missing rows, repeated practice passes.
 */
import { describe, it, expect } from 'vitest';
import { simulateOne } from '../scripts/simulate-pilot.js';
import {
  composeTidyTables,
  duplicateKeys,
  TIDY_KEYS,
  buildGeometry,
  segmentTrials,
} from '../scripts/tidy-tables.js';
import { composeExport } from '../scripts/csv-export.js';

function participants(n = 3) {
  return Array.from({ length: n }, (_, i) => {
    const env = simulateOne({ seed: `tidy-${i}`, pid: `P${i}`, accuracy: 0.7, responseRate: 0.95 });
    return { participant_id: env.prolific_pid, session: env, rows: env.rows };
  });
}

describe('tidy tables from simulated sessions', () => {
  const ps = participants();
  const tidy = composeTidyTables(ps);

  it('has 120 trials, 216 stars and 288 probes per participant', () => {
    expect(tidy.trials).toHaveLength(120 * ps.length);
    expect(tidy.stars).toHaveLength(216 * ps.length);
    expect(tidy.probes).toHaveLength(288 * ps.length);
    expect(tidy.issues).toEqual([]);
  });

  it('keys are unique', () => {
    for (const name of ['trials', 'stars', 'probes']) {
      expect(duplicateKeys(tidy[name], TIDY_KEYS[name])).toEqual([]);
    }
    expect(duplicateKeys(tidy.trials, ['participant_id', 'trial_uid', 'attempt'])).toEqual([]);
  });

  it('every row names its condition and block, and presentation order is 1..120', () => {
    for (const p of ps) {
      const mine = tidy.trials.filter((t) => t.participant_id === p.participant_id);
      expect(mine.map((t) => t.presentation_index)).toEqual(
        Array.from({ length: 120 }, (_, i) => i + 1)
      );
      expect(mine.every((t) => t.presentation_index === t.presentation_index_stamped)).toBe(true);
    }
    for (const row of [...tidy.trials, ...tidy.stars, ...tidy.probes]) {
      expect(['d_only', 't_only', 'i_only', 'i_d', 'i_t']).toContain(row.condition);
      expect(['main_a', 'main_b']).toContain(row.block_label);
    }
  });

  it('pool_index repeats across conditions but trial_uid does not', () => {
    const p0 = tidy.trials.filter((t) => t.participant_id === 'P0');
    const byPool = new Map();
    for (const t of p0) byPool.set(t.pool_index, (byPool.get(t.pool_index) ?? 0) + 1);
    expect(Math.max(...byPool.values())).toBeGreaterThan(1);
    expect(new Set(p0.map((t) => t.trial_uid)).size).toBe(120);
  });

  it('trial_star_excluded is computed per trial and agrees with the star rows', () => {
    for (const t of tidy.trials) {
      const mine = tidy.stars.filter(
        (s) => s.participant_id === t.participant_id && s.trial_seq_session === t.trial_seq_session
      );
      if (!t.trial_has_stars) {
        expect(mine).toHaveLength(0);
        expect(t.trial_star_excluded).toBe(false);
        continue;
      }
      expect(mine).toHaveLength(3);
      const expected = mine.some(
        (s) => !s.row_recorded || s.responded !== true || s.rt_ms < 250 || s.star_correct !== true
      );
      expect(t.trial_star_excluded).toBe(expected);
      for (const s of mine) expect(s.trial_star_excluded).toBe(expected);
    }
    for (const p of tidy.probes) {
      const t = tidy.trials.find(
        (x) => x.participant_id === p.participant_id && x.trial_seq_session === p.trial_seq_session
      );
      expect(p.trial_star_excluded).toBe(t.trial_star_excluded);
    }
  });

  it('screen positions follow the rotation (clockwise positive, y down)', () => {
    const g = buildGeometry(null);
    expect(g.screen(0, 0)).toEqual({ x_mm: -20, y_mm: -20 });
    expect(g.screen(0, 90)).toEqual({ x_mm: 20, y_mm: -20 });
    expect(g.screen(1, 180)).toEqual({ x_mm: 10, y_mm: 20 });
    for (const s of tidy.stars) {
      expect(Math.hypot(s.x_mm, s.y_mm)).toBeCloseTo(s.radius_mm, 2);
      expect(s.position_matches_runtime).toBe(true);
    }
    const dotProbes = tidy.probes.filter((p) => p.modality === 'dot');
    expect(dotProbes.length).toBeGreaterThan(0);
    for (const p of dotProbes) {
      expect(p.probe_frame_rotation_deg).toBe(p.condition === 'd_only' ? p.rotation_deg : 0);
      expect(p.position_matches_runtime).toBe(true);
      if (p.rotation_deg === 0) expect(p.x_mm).toBe(p.cell_x_mm);
      expect(p.min_enc_dist_mm).toBeGreaterThanOrEqual(0);
      if (p.is_target) {
        expect(p.own_enc_dist_mm).toBeGreaterThanOrEqual(p.min_enc_dist_mm);
      }
    }
    for (const p of tidy.probes.filter((x) => x.modality === 'tone')) {
      expect(p.x_mm).toBeNull();
      expect(p.tone_index).toBeGreaterThanOrEqual(0);
    }
  });

  it('carries the d_only display rotation into the rotation columns and the geometry', () => {
    const dTrials = tidy.trials.filter((t) => t.condition === 'd_only');
    expect(dTrials.length).toBeGreaterThan(0);
    for (const t of dTrials) {
      expect(Number.isInteger(t.rotation_deg)).toBe(true);
      expect(t.rotation_deg).not.toBe(0);
      expect(t.rotation_sign).toBe(Math.sign(t.rotation_deg));
      expect(t.rotation_stratum).toBeGreaterThanOrEqual(1);
      expect(t.rotation_stratum).toBeLessThanOrEqual(6);
    }
    expect(
      tidy.trials.filter((t) => t.condition === 't_only').every((t) => t.rotation_deg === null)
    ).toBe(true);
  });

  it('a d_only target probe sits on its own encoded dot (distance 0) at a non-zero rotation', () => {
    const targets = tidy.probes.filter(
      (p) => p.condition === 'd_only' && p.is_target && p.rotation_deg !== 0
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const p of targets) {
      expect(p.target_slot).not.toBeNull();
      expect(p.own_enc_dist_mm).toBe(0);
    }
  });

  it('writes trials.csv, stars.csv and probes.csv through composeExport', () => {
    const { files, manifest } = composeExport(ps, { generatedAtIso: '2000-01-01T00:00:00Z' });
    for (const f of ['trials.csv', 'stars.csv', 'probes.csv']) expect(files[f]).toBeTruthy();
    expect(manifest.tidy_tables.duplicate_keys).toEqual({ trials: [], stars: [], probes: [] });
  });
});

describe('damaged and repeated data', () => {
  it('lists a star whose row was not recorded and excludes the trial', () => {
    const [p] = participants(1);
    const target = p.rows.find((r) => r.phase === 'i_t_encoding');
    const lastStarSlot = Math.max(...target.trial_spec.stars.map((s) => s.slot));
    const rows = p.rows.filter(
      (r) =>
        !(
          r.phase === 'i_t_star' &&
          r.trial_uid === target.trial_uid &&
          r.slot_index_in_seq === lastStarSlot
        )
    );
    expect(rows.length).toBe(p.rows.length - 1);
    const tidy = composeTidyTables([{ ...p, rows }]);
    const trial = tidy.trials.find((t) => t.trial_uid === target.trial_uid);
    expect(trial.n_star_rows).toBe(2);
    expect(trial.n_stars_missing_row).toBe(1);
    expect(trial.trial_star_excluded).toBe(true);
    const mine = tidy.stars.filter((s) => s.trial_uid === target.trial_uid);
    expect(mine).toHaveLength(3);
    expect(mine.filter((s) => !s.row_recorded)).toHaveLength(1);
  });

  it('keeps both passes of a repeated practice trial', () => {
    const gate = (cond, n) => ({
      phase: `${cond}_trial_start`,
      block_label: 'practice',
      trial_uid: `practice-${cond}-01`,
      trial_index_in_block: 0,
      seq: n,
    });
    const rows = [gate('d_only', 1), gate('d_only', 2)];
    const windows = segmentTrials(rows);
    expect(windows).toHaveLength(2);
    const tidy = composeTidyTables([{ participant_id: 'P', session: {}, rows }]);
    expect(tidy.trials.map((t) => [t.trial_seq_session, t.attempt])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(duplicateKeys(tidy.trials, TIDY_KEYS.trials)).toEqual([]);
  });
});

describe('schema file', () => {
  it('schemas/tidy-tables.schema.json matches the column definitions', async () => {
    const { readFileSync } = await import('node:fs');
    const { buildTidySchema } = await import('../scripts/tidy-tables.js');
    const onDisk = JSON.parse(
      readFileSync(new URL('../schemas/tidy-tables.schema.json', import.meta.url), 'utf-8')
    );
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildTidySchema())));
  });

  it('every exported column is documented', async () => {
    const { TRIALS_COLUMNS, STARS_COLUMNS, PROBES_COLUMNS, COLUMN_DOCS } =
      await import('../scripts/tidy-tables.js');
    for (const c of new Set([...TRIALS_COLUMNS, ...STARS_COLUMNS, ...PROBES_COLUMNS])) {
      expect(COLUMN_DOCS[c], c).toBeTruthy();
    }
  });
});
