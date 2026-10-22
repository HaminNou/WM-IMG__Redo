/**
 * Pilot-data summariser tests.
 *
 * The CLI itself is a thin wrapper over five pure helpers that we exercise
 * here:
 *
 *   - `parseArgs`             — argv → { paths, jsonOutput }, throws on unknown flags
 *   - `expandPaths`           — directory walking with an injectable fs
 *   - `summariseDump`         — per-participant report from one parsed JSON dump
 *   - `summariseProbeMatrix`  — counterbalance spot-check
 *   - `summariseAttentionChecks` — pass/fail/exclude calculation matching the runtime
 *   - `estimateSessionDurationMin` — coarse timing estimate from rt or time_elapsed
 *   - `aggregate`             — batch-level stats + heterogeneity flags
 *
 * Test fixtures construct rows that mirror what the runner emits — keeping
 * these tests honest as the schema evolves means they catch contract drift.
 */
import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  expandPaths,
  summariseDump,
  summariseProbeMatrix,
  summariseAttentionChecks,
  estimateSessionDurationMin,
  aggregate,
} from '../scripts/pilot-summary.js';

function fakeDownloadDump(overrides = {}) {
  return {
    session: {
      params: {
        session_id: 'sess-1',
        prolific_pid: 'pid-1',
        study_id: 'study-1',
        is_preview: false,
      },
      build_id: 'v1',
      schema_version: '1.1.3',
      is_pilot_run: true,
      pilot_label: 'pilot-test',
      started_at_iso: '2000-01-01T10:00:00Z',
      user_agent: 'TestAgent/1.0',
    },
    n_rows: 0,
    rows: [],
    exported_at_iso: '2000-01-01T11:00:00Z',
    ...overrides,
  };
}

function attentionRow(passed) {
  return { phase: 'attention_check', attention_check_passed: passed };
}

describe('parseArgs', () => {
  it('returns defaults for empty argv', () => {
    expect(parseArgs([])).toEqual({ paths: [], jsonOutput: false });
  });

  it('separates paths from flags', () => {
    expect(parseArgs(['node', 'script.js', 'a.json', 'b.json'])).toEqual({
      paths: ['a.json', 'b.json'],
      jsonOutput: false,
    });
  });

  it('flips jsonOutput on --json', () => {
    expect(parseArgs(['node', 'script.js', '--json', 'dir/'])).toEqual({
      paths: ['dir/'],
      jsonOutput: true,
    });
  });

  it('throws on unknown flags', () => {
    expect(() => parseArgs(['node', 'script.js', '--unknown'])).toThrow(/unknown flag/);
  });
});

describe('expandPaths', () => {
  it('passes through file paths unchanged (sorted)', () => {
    const fakeFs = {
      statSync: () => ({ isDirectory: () => false }),
      readdirSync: () => [],
    };
    const out = expandPaths(['z.json', 'a.json'], { fs: fakeFs });
    expect(out.map((p) => p.endsWith('a.json') || p.endsWith('z.json'))).toEqual([true, true]);
    /* sorted, so a.json is first */
    expect(out[0].endsWith('a.json')).toBe(true);
  });

  it('walks directories and returns only .json files', () => {
    const fakeFs = {
      statSync: (p) =>
        p.endsWith('dir') ? { isDirectory: () => true } : { isDirectory: () => false },
      readdirSync: () => ['one.json', 'README.md', 'two.json'],
    };
    const out = expandPaths(['dir'], { fs: fakeFs });
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.endsWith('.json'))).toBe(true);
  });
});

describe('summariseAttentionChecks', () => {
  it('returns zeros for an empty rows array', () => {
    expect(summariseAttentionChecks([])).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      threshold: 1,
      excluded: false,
    });
  });

  it('counts pass + fail across attention_check rows only', () => {
    const rows = [
      attentionRow(true),
      attentionRow(false),
      attentionRow(true),
      { phase: 'main_a_intro' },
    ];
    const out = summariseAttentionChecks(rows);
    expect(out.total).toBe(3);
    expect(out.passed).toBe(2);
    expect(out.failed).toBe(1);
  });

  it('uses strict-greater-than against the threshold (matches runtime semantics)', () => {
    /* 1 failure equals threshold (1) → excluded should be FALSE */
    const rows = [attentionRow(true), attentionRow(true), attentionRow(false)];
    expect(summariseAttentionChecks(rows).excluded).toBe(false);
  });

  it('excludes when failures EXCEED the threshold', () => {
    const rows = [attentionRow(false), attentionRow(false), attentionRow(true)];
    expect(summariseAttentionChecks(rows).excluded).toBe(true);
  });

  it('honours an override threshold', () => {
    const rows = [attentionRow(false), attentionRow(false)];
    expect(summariseAttentionChecks(rows, { maxFailures: 2 }).excluded).toBe(false);
    expect(summariseAttentionChecks(rows, { maxFailures: 1 }).excluded).toBe(true);
  });
});

describe('summariseProbeMatrix', () => {
  it('skips rows whose block_label is not main_a or main_b', () => {
    const rows = [
      /* No block_label → skipped (calibration / instructions / strategy rows). */
      { phase: 'd_only_probe', probe_type: 'T_on' },
      /* Practice block → skipped per the design. */
      { phase: 'd_only_probe', probe_type: 'F_on', block_label: 'practice' },
      /* Main but not a probe phase → skipped by the PROBE_PHASES filter. */
      { phase: 'pattern_phase', block_label: 'main_a' },
    ];
    expect(summariseProbeMatrix(rows)).toEqual({});
  });

  it('counts only the locked four probe types per phase × main block', () => {
    const rows = [
      { phase: 'd_only_probe', probe_type: 'T_on', block_label: 'main_a' },
      { phase: 'd_only_probe', probe_type: 'T_off', block_label: 'main_a' },
      { phase: 'd_only_probe', probe_type: 'F_on', block_label: 'main_b' },
      { phase: 'd_only_probe', probe_type: 'F_off', block_label: 'main_b' },
      /* Unknown taxon → ignored silently (matrix slot stays at 0). */
      { phase: 'd_only_probe', probe_type: 'unknown_taxon', block_label: 'main_a' },
      /* Mixed-in i_only star row → its own matrix entry. */
      { phase: 'i_only_star', probe_type: 'T_on', block_label: 'main_a' },
    ];
    expect(summariseProbeMatrix(rows)).toEqual({
      d_only_probe: { T_on: 1, T_off: 1, F_on: 1, F_off: 1 },
      i_only_star: { T_on: 1, T_off: 0, F_on: 0, F_off: 0 },
    });
  });

  it('does not require probe_type — rows with falsy probe_type are skipped', () => {
    const rows = [
      { phase: 'd_only_probe', block_label: 'main_a' } /* no probe_type */,
      { phase: 'd_only_probe', probe_type: '', block_label: 'main_a' },
      { phase: 'd_only_probe', probe_type: 'T_on', block_label: 'main_a' },
    ];
    expect(summariseProbeMatrix(rows)).toEqual({
      d_only_probe: { T_on: 1, T_off: 0, F_on: 0, F_off: 0 },
    });
  });
});

describe('estimateSessionDurationMin', () => {
  it('returns null for an empty rows array', () => {
    expect(estimateSessionDurationMin([])).toBeNull();
  });

  it('uses time_elapsed of the last row when available (preferred)', () => {
    const rows = [
      { time_elapsed: 10_000 },
      { time_elapsed: 600_000 } /* 10 min */,
      { time_elapsed: 1_800_000 } /* 30 min */,
    ];
    expect(estimateSessionDurationMin(rows)).toBe(30);
  });

  it('falls back to summing rt when time_elapsed is missing', () => {
    const rows = [{ rt: 60_000 }, { rt: 120_000 }, { rt: 60_000 }];
    expect(estimateSessionDurationMin(rows)).toBe(4);
  });

  it('ignores non-finite values', () => {
    const rows = [{ rt: Infinity }, { rt: NaN }, { rt: '60000' /* string ignored */ }];
    expect(estimateSessionDurationMin(rows)).toBeNull();
  });
});

describe('summariseDump', () => {
  it('extracts session-level metadata from a download-fallback dump', () => {
    const dump = fakeDownloadDump({
      rows: [
        attentionRow(true),
        attentionRow(true),
        attentionRow(false),
        /* Two trial rows tagged with main-block labels by `assembleBlock`. */
        { phase: 'd_only_probe', block_label: 'main_a' },
        { phase: 'd_only_probe', block_label: 'main_b' },
        /* Two practice rows. */
        { phase: 'd_only_probe', block_label: 'practice' },
        { phase: 'd_only_probe', block_label: 'practice' },
        {
          phase: 'upload_session_end',
          status: 'no_endpoint',
          downloadFallback: true,
        },
        {
          phase: 'completion_redirect',
          completion_was_placeholder: true,
          completion_redirect_url: null,
        },
      ],
    });
    const s = summariseDump(dump, { sourceLabel: 'fixture.json' });
    expect(s.prolific_pid).toBe('pid-1');
    expect(s.build_id).toBe('v1');
    expect(s.is_pilot_run).toBe(true);
    expect(s.pilot_label).toBe('pilot-test');
    expect(s.n_total_rows).toBe(9);
    expect(s.n_main_rows).toBe(2);
    expect(s.n_practice_rows).toBe(2);
    expect(s.attention.total).toBe(3);
    expect(s.attention.failed).toBe(1);
    expect(s.attention.excluded).toBe(false);
    expect(s.upload_status).toBe('no_endpoint');
    expect(s.completion_was_placeholder).toBe(true);
  });

  it('extracts session metadata from a bucket-envelope dump (server-side payload shape)', () => {
    const env = {
      session_id: 'sess-2',
      prolific_pid: 'pid-2',
      study_id: 'study-2',
      is_preview: false,
      build_id: 'v1',
      schema_version: '1.1.3',
      is_pilot_run: true,
      pilot_label: 'pilot-test',
      started_at_iso: '2000-01-01T10:00:00Z',
      user_agent: 'TestAgent/1.0',
      bucket_id: 'meta',
      bucket_label: '10_meta',
      bucket_index: 9,
      total_buckets: 10,
      seq_min: 1,
      seq_max: 3,
      n_rows: 3,
      rows: [{ phase: 'main_a_intro' }, attentionRow(true), { phase: 'main_b_intro' }],
      uploaded_at_iso: '2000-01-01T11:00:00Z',
    };
    const s = summariseDump(env, { sourceLabel: 'env.json' });
    expect(s.prolific_pid).toBe('pid-2');
    expect(s.is_pilot_run).toBe(true);
    expect(s.n_total_rows).toBe(3);
    expect(s.attention.total).toBe(1);
  });

  it('reports null/false defaults when fields are missing', () => {
    const s = summariseDump({}, { sourceLabel: '/tmp/empty.json' });
    expect(s.prolific_pid).toBeNull();
    expect(s.is_pilot_run).toBe(false);
    expect(s.n_total_rows).toBe(0);
    expect(s.attention.total).toBe(0);
  });
});

describe('aggregate', () => {
  function fakeSummary(overrides = {}) {
    return {
      prolific_pid: 'pid-X',
      build_id: 'v1',
      schema_version: '1.1.3',
      is_pilot_run: true,
      session_duration_min: 30,
      attention: { total: 3, passed: 3, failed: 0, threshold: 1, excluded: false },
      ...overrides,
    };
  }

  it('counts participants and computes exclusion rate', () => {
    const summaries = [
      fakeSummary({ attention: { total: 3, passed: 3, failed: 0, threshold: 1, excluded: false } }),
      fakeSummary({ attention: { total: 3, passed: 1, failed: 2, threshold: 1, excluded: true } }),
      fakeSummary({ attention: { total: 3, passed: 2, failed: 1, threshold: 1, excluded: false } }),
      fakeSummary({ attention: { total: 3, passed: 0, failed: 3, threshold: 1, excluded: true } }),
    ];
    const out = aggregate(summaries);
    expect(out.n_participants).toBe(4);
    expect(out.n_excluded).toBe(2);
    expect(out.exclusion_rate).toBe(0.5);
  });

  it('flags BUILD_ID_HETEROGENEOUS when build_ids differ', () => {
    const summaries = [fakeSummary({ build_id: 'v1' }), fakeSummary({ build_id: 'v0' })];
    const out = aggregate(summaries);
    expect(out.issues.some((i) => i.code === 'BUILD_ID_HETEROGENEOUS')).toBe(true);
  });

  it('flags MISSING_PILOT_FLAG when expectPilot=true and any session lacks it', () => {
    const summaries = [fakeSummary({ is_pilot_run: true }), fakeSummary({ is_pilot_run: false })];
    const out = aggregate(summaries, { expectPilot: true });
    expect(out.issues.some((i) => i.code === 'MISSING_PILOT_FLAG')).toBe(true);
  });

  it('flags UNEXPECTED_PILOT_FLAG when expectPilot=false and pilot rows leak in', () => {
    const summaries = [fakeSummary({ is_pilot_run: false }), fakeSummary({ is_pilot_run: true })];
    const out = aggregate(summaries, { expectPilot: false });
    expect(out.issues.some((i) => i.code === 'UNEXPECTED_PILOT_FLAG')).toBe(true);
  });

  it('computes median session duration for both odd and even sample sizes', () => {
    const odd = [10, 20, 30].map((d) => fakeSummary({ session_duration_min: d }));
    expect(aggregate(odd).median_duration_min).toBe(20);
    const even = [10, 20, 30, 40].map((d) => fakeSummary({ session_duration_min: d }));
    expect(aggregate(even).median_duration_min).toBe(25);
  });

  it('returns no issues for a homogeneous batch with consistent build_ids and pilot flags', () => {
    const summaries = [fakeSummary(), fakeSummary(), fakeSummary()];
    const out = aggregate(summaries, { expectPilot: true });
    expect(out.issues).toEqual([]);
  });
});
