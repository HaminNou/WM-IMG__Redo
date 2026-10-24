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

describe('recorded timing, keypress and guard fields', () => {
  const [p] = participants(1);
  const trialRows = (uid) => p.rows.filter((r) => r.trial_uid === uid);

  it('exports window timestamps and encoding counters', () => {
    const rows = [
      {
        phase: 'i_t_trial_start',
        block_label: 'main_a',
        trial_uid: 'u',
        seq: 1,
        trial_start_gate_onset_ts_ms: 100,
        gate_passed_at_ms: 700,
      },
      { phase: 'i_t_arrow_cue', arrow_cue_onset_ts_ms: 800, seq: 2 },
      { phase: 'i_t_imagination', imagination_onset_ts_ms: 2800, seq: 3 },
      {
        phase: 'i_t_encoding',
        encoding_onset_ts_ms: 6300,
        rotation_start_ts_ms: 6320,
        planned_total_ms: 16500,
        n_star_rows_expected: 3,
        keys_outside_window: 2,
        key_log: [['R', 10]],
        key_log_overflow: true,
        key_log_t0_ms: 6301,
        slot_tone_events: [
          { slot: 0, late: true, tone_error: false },
          { slot: 2, late: false, tone_error: true },
        ],
        seq: 4,
      },
      { phase: 'i_t_retention', retention_onset_ts_ms: 22800, seq: 5 },
    ];
    const t = composeTidyTables([{ participant_id: 'P', session: {}, rows }]).trials[0];
    expect(t).toMatchObject({
      gate_onset_ms: -6200,
      gate_passed_at_ms: 700,
      arrow_cue_onset_ms: -5500,
      imagination_onset_ms: -3500,
      rotation_start_ms: 20,
      retention_onset_ms: 16500,
      planned_total_ms: 16500,
      n_star_rows_expected: 3,
      keys_outside_window: 2,
      n_key_log: 1,
      key_log_overflow: true,
      key_log_t0_offset_ms: 1,
      n_tones_late: 1,
      n_tone_errors: 1,
      trial_guard_excluded: false,
    });
  });

  it('picks up the <condition>_iti row and the pattern phase onset', () => {
    const gate = { phase: 'i_d_trial_start', block_label: 'main_a', trial_uid: 'u', seq: 1 };
    const enc = { phase: 'i_d_encoding', encoding_onset_ts_ms: 1000, seq: 3, trial_spec: null };
    const rows = [
      gate,
      { phase: 'pattern_phase', pattern_onset_ts_ms: 400, seq: 2 },
      enc,
      { phase: 'i_d_iti', iti_onset_ts_ms: 9000, seq: 4 },
    ];
    const t = composeTidyTables([{ participant_id: 'P', session: {}, rows }]).trials[0];
    expect(t.iti_onset_ms).toBe(8000);
    expect(t.pattern_onset_ms).toBe(-600);
  });

  it('flags guard events on any row of the trial for trial, star and probe rows', () => {
    const tidy0 = composeTidyTables([p]);
    const target = tidy0.trials.find((x) => x.condition === 'i_d' && !x.is_practice);
    const rows = p.rows.map((r) =>
      r.trial_uid === target.trial_uid && r.phase === 'i_d_encoding'
        ? { ...r, guard_flags: 'resize,hidden', guard_n: 2 }
        : r
    );
    expect(trialRows(target.trial_uid).some((r) => r.phase === 'i_d_encoding')).toBe(true);
    const tidy = composeTidyTables([{ ...p, rows }]);
    const t = tidy.trials.find((x) => x.trial_uid === target.trial_uid);
    expect(t.trial_guard_excluded).toBe(true);
    expect(t.guard_flags).toBe('resize,hidden');
    expect(t.guard_n).toBe(2);
    const mine = [
      ...tidy.stars.filter((x) => x.trial_uid === target.trial_uid),
      ...tidy.probes.filter((x) => x.trial_uid === target.trial_uid),
    ];
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.trial_guard_excluded === true)).toBe(true);
    const other = tidy.trials.filter((x) => x.trial_uid !== target.trial_uid);
    expect(other.every((x) => x.trial_guard_excluded === false)).toBe(true);
  });

  it('carries keypress counts, onset lag and audio fields from the rows', () => {
    const star = p.rows.find((r) => r.phase === 'i_d_star');
    const probe = p.rows.find((r) => r.phase === 'i_t_probe');
    const rows = p.rows.map((r) =>
      r === star
        ? {
            ...r,
            early_keypresses: 1,
            late_keypresses: 2,
            extra_keypresses: 3,
            star_onset_lag_ms: 4.5,
            displayed: true,
            truncated: false,
            window_closed_ts_ms: 123456,
            user_gain: 0.5,
          }
        : r === probe
          ? {
              ...r,
              audio_context: { sample_rate_hz: 48000, state: 'running', base_latency_ms: 5 },
              tone_error: false,
              audio_output_latency_ms: 25,
            }
          : r
    );
    const tidy = composeTidyTables([{ ...p, rows }]);
    const s = tidy.stars.find(
      (x) => x.trial_uid === star.trial_uid && x.slot - 1 === star.slot_index_in_seq
    );
    expect(s.early_keypresses).toBe(1);
    expect(s.late_keypresses).toBe(2);
    expect(s.extra_keypresses).toBe(3);
    expect(s.star_onset_lag_ms).toBe(4.5);
    expect(s.displayed).toBe(true);
    expect(s.user_gain).toBe(0.5);
    expect(Number.isInteger(s.window_closed_ms)).toBe(true);
    const pr = tidy.probes.find(
      (x) => x.trial_uid === probe.trial_uid && x.probe_position - 1 === probe.probe_position
    );
    expect(pr.audio_sample_rate_hz).toBe(48000);
    expect(pr.audio_state).toBe('running');
    expect(pr.audio_base_latency_ms).toBe(5);
    expect(pr.audio_output_latency_ms).toBe(25);
    expect(pr.tone_error).toBe(false);
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
