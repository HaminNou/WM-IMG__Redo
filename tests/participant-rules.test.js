// @vitest-environment jsdom
/**
 * scripts/participant-rules.js: the one definition of completed, excluded and
 * retained shared by the batch-decision tool and the exporter.
 */
import { describe, it, expect } from 'vitest';
import {
  summariseAttention,
  calibrationOutcome,
  mainAccuracy,
  countMainTrials,
  evaluateRun,
  summariseParticipantRuns,
  SINGLE_TASK_FLOOR,
  ATTENTION_MAX_FAILURES,
  CALIBRATION_FALLBACK_TOLERANCE,
  EXPECTED_MAIN_TRIALS,
} from '../scripts/participant-rules.js';
import { config } from '../src/config.js';
import { _testHelpers as SCREEN_CAL } from '../src/calibration/screen.js';

const ac = (id, passed) => ({
  phase: 'attention_check',
  attention_check_id: id,
  attention_check_passed: passed,
});
const probes = (phase, correct, n, block = 'main_a') =>
  Array.from({ length: n }, (_, i) => ({ phase, block_label: block, probe_correct: i < correct }));
const cleanRows = () => [
  { phase: 'screen_calibration_outcome', value: { accepted: true, status: 'ok' } },
  ac('ac1', true),
  ac('ac2', true),
  ac('ac3', true),
  ...probes('d_only_probe', 30, 36),
  ...probes('t_only_probe', 30, 36),
  { phase: 'completion_redirect' },
];

describe('constants are pinned to the pre-registration and the program', () => {
  it('floor .55, threshold 1, tolerance equal to the one screen.js applies', () => {
    expect(SINGLE_TASK_FLOOR).toBe(0.55);
    expect(ATTENTION_MAX_FAILURES).toBe(1);
    expect(ATTENTION_MAX_FAILURES).toBe(config.attention_checks.instruction_max_failures);
    /* used only when a row has neither `status` nor `consistent`; must not drift */
    expect(CALIBRATION_FALLBACK_TOLERANCE).toBe(SCREEN_CAL.CONSISTENCY_TOL);
    expect(EXPECTED_MAIN_TRIALS).toBe(5 * config.blocks.main_trials_per_type);
  });
});

describe('summariseAttention', () => {
  it('counts distinct checks on their first administration', () => {
    const s = summariseAttention([
      ac('ac1', true),
      ac('ac2', false),
      ac('ac3', true),
      ac('ac1', true),
      ac('ac2', false),
      ac('ac3', true),
    ]);
    expect(s).toMatchObject({
      total: 3,
      failed_first: 1,
      failed_final: 1,
      administrations: 6,
      excluded: false,
    });
  });

  it('strictly greater than the threshold: 1 miss is kept, 2 misses are excluded', () => {
    expect(summariseAttention([ac('a', false), ac('b', true), ac('c', true)]).excluded).toBe(false);
    expect(summariseAttention([ac('a', false), ac('b', false), ac('c', true)]).excluded).toBe(true);
  });

  it('keeps first and final apart', () => {
    const s = summariseAttention([ac('a', false), ac('b', false), ac('a', true), ac('b', true)]);
    expect(s.excluded).toBe(true);
    expect(s.excluded_final).toBe(false);
  });

  it('rows without an id are not merged into one check', () => {
    const rows = [
      { phase: 'attention_check', attention_check_passed: false },
      { phase: 'attention_check', attention_check_passed: false },
    ];
    expect(summariseAttention(rows).total).toBe(2);
    expect(summariseAttention(rows).failed_first).toBe(2);
  });
});

describe('calibrationOutcome', () => {
  const out = (value) => ({ phase: 'screen_calibration_outcome', value });
  it('reads the nested value the call-function plugin writes', () => {
    expect(
      calibrationOutcome([out({ accepted: true, status: 'inconsistent_accepted' })]).status
    ).toBe('inconsistent_accepted');
  });
  it('reads a top-level row (download fallback)', () => {
    expect(
      calibrationOutcome([{ phase: 'screen_calibration_outcome', accepted: true, status: 'ok' }])
        .status
    ).toBe('ok');
  });
  it('takes the LAST attempt', () => {
    const rows = [out({ accepted: false, status: 'retry' }), out({ accepted: true, status: 'ok' })];
    expect(calibrationOutcome(rows).status).toBe('ok');
  });
  it('derives the status from accepted + consistency when the row has none', () => {
    expect(calibrationOutcome([out({ accepted: true, consistent: false })]).status).toBe(
      'inconsistent_accepted'
    );
    expect(calibrationOutcome([out({ accepted: true, rel_diff: 0.06 })]).status).toBe(
      'inconsistent_accepted'
    );
    expect(calibrationOutcome([out({ accepted: true, rel_diff: 0.04 })]).status).toBe('ok');
    expect(calibrationOutcome([out({ accepted: false, consistent: false })]).status).toBe('retry');
  });
  it('is null without any outcome row', () => {
    expect(calibrationOutcome([]).status).toBeNull();
  });
});

describe('mainAccuracy and countMainTrials', () => {
  it('uses main blocks only and counts an unanswered probe as a miss', () => {
    const rows = [
      ...probes('d_only_probe', 3, 4),
      ...probes('d_only_probe', 0, 10, 'practice'),
      { phase: 'd_only_probe', block_label: 'main_b' }, // no probe_correct: a miss
    ];
    expect(mainAccuracy(rows, 'd_only_probe')).toEqual({ n: 5, accuracy: 3 / 5 });
    expect(mainAccuracy([], 'd_only_probe')).toEqual({ n: 0, accuracy: null });
  });
  it('counts distinct main trials from their encoding rows', () => {
    const enc = (i, block = 'main_a', phase = 'i_d_encoding') => ({
      phase,
      block_label: block,
      trial_index_in_block: i,
    });
    expect(
      countMainTrials([
        enc(0),
        enc(0),
        enc(1),
        enc(1, 'practice'),
        enc(0, 'main_b'),
        enc(0, 'main_a', 'd_only_encoding'),
      ])
    ).toBe(4);
  });
});

describe('evaluateRun: the three participant-level rules', () => {
  it('retains a clean completed run', () => {
    const e = evaluateRun(cleanRows());
    expect(e).toMatchObject({ completed: true, excluded: false, retained: true });
  });
  it('the floor is <= .55 in EITHER single-task condition (.55 excluded, just above kept)', () => {
    const at = (c) => [
      ...cleanRows().filter((r) => r.phase !== 'd_only_probe'),
      ...probes('d_only_probe', c, 20),
    ];
    expect(evaluateRun(at(11)).reasons).toContain('single_task_floor'); // .55
    expect(evaluateRun(at(12)).reasons).not.toContain('single_task_floor'); // .60
    const t = [
      ...cleanRows().filter((r) => r.phase !== 't_only_probe'),
      ...probes('t_only_probe', 11, 20),
    ];
    expect(evaluateRun(t).reasons).toContain('single_task_floor');
  });
  it('a run that ended at a screen-out is not completed even with a completion row', () => {
    const rows = [...cleanRows(), { phase: 'x', exit_reason: 'audio_check_failed' }];
    expect(evaluateRun(rows)).toMatchObject({
      completed: false,
      retained: false,
      screened_out: true,
    });
  });
  it('a run without a completion row is not completed', () => {
    const rows = cleanRows().filter((r) => r.phase !== 'completion_redirect');
    expect(evaluateRun(rows)).toMatchObject({ completed: false, retained: false });
  });
});

describe('summariseParticipantRuns', () => {
  const run = (run_id, rows) => ({ run_id, rows });
  it('one completed run: retained', () => {
    const p = summariseParticipantRuns([run('r1', cleanRows())]);
    expect(p).toMatchObject({
      status: 'retained',
      completed: true,
      n_runs: 1,
      reload_after_main: false,
    });
  });
  it('analyses the completed run and ignores the partial one, but flags a reload after main trials', () => {
    const partial = [
      { phase: 'i_d_encoding', block_label: 'main_a', trial_index_in_block: 0 },
      ac('ac1', false),
      ac('ac2', false),
      ac('ac3', false),
    ];
    const p = summariseParticipantRuns([run('r1', partial), run('r2', cleanRows())]);
    expect(p.status).toBe('retained'); // the failed checks of run 1 do not count
    expect(p.analysed_run_id).toBe('r2');
    expect(p.reload_after_main).toBe(true);
    expect(p.n_runs).toBe(2);
  });
  it('a reload BEFORE any main trial is not flagged', () => {
    const p = summariseParticipantRuns([run('r1', [{ phase: 'consent' }]), run('r2', cleanRows())]);
    expect(p.reload_after_main).toBe(false);
  });
  it('no completed run: incomplete, or screened out if a run ended at a screen-out', () => {
    expect(summariseParticipantRuns([run('r1', [{ phase: 'consent' }])]).status).toBe('incomplete');
    expect(
      summariseParticipantRuns([run('r1', [{ phase: 'x', exit_reason: 'consent_declined' }])])
        .status
    ).toBe('screened_out');
    expect(summariseParticipantRuns([run('r1', [{ phase: 'consent' }])]).completed).toBe(false);
  });
  it('an incomplete participant is never retained or excluded', () => {
    const rows = cleanRows().filter((r) => r.phase !== 'completion_redirect');
    const p = summariseParticipantRuns([run('r1', rows)]);
    expect(p).toMatchObject({ retained: false, excluded: false, reasons: [] });
  });
  it('several completed runs: the one with most rows is analysed and the case is flagged', () => {
    const short = cleanRows();
    const long = [...cleanRows(), { phase: 'extra' }, { phase: 'extra' }];
    const p = summariseParticipantRuns([run('a', short), run('b', long)]);
    expect(p.analysed_run_id).toBe('b');
    expect(p.multiple_completed_runs).toBe(true);
  });
});
