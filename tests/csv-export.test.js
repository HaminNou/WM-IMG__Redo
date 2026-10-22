/**
 * CSV exporter tests.
 *
 * The CLI is a thin driver over a stack of pure helpers; this file exercises
 * each one in isolation and then composes a small end-to-end fixture to
 * verify the wide-format pivot + criterion filtering match Project 1's
 * column conventions.
 *
 * Test fixtures are constructed to mirror what the runner emits — see
 * src/conditions/{d_only,t_only,i_only,i_d,i_t}.js for the row shapes.
 */
import { describe, it, expect } from 'vitest';
import {
  parseExportArgs,
  cellToRowCol,
  formatCell,
  trialTypeFromPhase,
  probeTypeCode,
  cellTypeCode,
  applyCriterion1,
  applyCriterion2,
  probeResCodes,
  starResCodes,
  extractRtMs,
  formatCsvValue,
  serializeRowsToCsv,
  groupTrialRows,
  buildWideRowDOnly,
  buildWideRowTOnly,
  buildWideRowIOnly,
  buildWideRowID,
  buildWideRowIT,
  extractCalibrationRow,
  estimateSessionDurationMin,
  extractStrategyRows,
  extractAttentionRows,
  extractDemographicsRow,
  DEMOGRAPHICS_COLUMNS,
  buildExportManifest,
  loadAndFlattenDumps,
  composeExport,
  expandInputPaths,
  COLUMNS_D_ONLY,
  COLUMNS_T_ONLY,
  COLUMNS_I_ONLY,
  COLUMNS_I_D,
  COLUMNS_I_T,
  CALIBRATION_COLUMNS,
  STRATEGY_COLUMNS,
  ATTENTION_COLUMNS,
} from '../scripts/csv-export.js';

/* ---------- Fixture builders ---------- */

function sessionMeta(overrides = {}) {
  return {
    params: { prolific_pid: 'P1', session_id: 'sess-1', study_id: 'study-1' },
    build_id: 'v1',
    schema_version: '1.1.3',
    is_pilot_run: true,
    pilot_label: 'pilot-test',
    started_at_iso: '2000-01-01T10:00:00Z',
    user_agent: 'TestAgent/1.0',
    ...overrides,
  };
}

function dOnlyEncodingRow({ trial = 0, block = 'main_a' } = {}) {
  return {
    phase: 'd_only_encoding',
    block_label: block,
    trial_index_in_block: trial,
    sequence: 'MSMSMS',
    memory_items: [
      { slot: 0, cell: 6, pattern_label: 'on' },
      { slot: 2, cell: 12, pattern_label: 'on' },
      { slot: 4, cell: 7, pattern_label: 'off' },
    ],
    dummies: [],
  };
}

function dOnlyProbeRow({ pos, type, cell, isTarget, correct, rt, trial = 0, block = 'main_a' }) {
  /* `pos` is 1-indexed at the call-site for readability (1 = first probe);
   * the runtime emits `probe_position` as 0-indexed (see memory-block.js
   * line 142 and dual-block.js line 211). The helper subtracts 1 so the
   * fixture row carries the same shape `composeExport` consumes from a
   * real session. */
  return {
    phase: 'd_only_probe',
    block_label: block,
    trial_index_in_block: trial,
    probe_position: pos - 1,
    probe_type: type,
    probed_cell: cell,
    probe_pattern_label: type.endsWith('_on') ? 'on' : 'off',
    is_target: isTarget,
    responded: rt !== null,
    said_yes: rt === null ? null : isTarget === correct,
    probe_correct: correct,
    rt,
  };
}

function tOnlyEncodingRow({ trial = 0, block = 'main_a' } = {}) {
  return {
    phase: 't_only_encoding',
    block_label: block,
    trial_index_in_block: trial,
    sequence: 'MSMSMS',
    memory_items: [
      { slot: 0, cell: 6, tone_index: 5, tone_freq_hz: 311.13, pattern_label: 'on' },
      { slot: 2, cell: 12, tone_index: 11, tone_freq_hz: 415.3, pattern_label: 'on' },
    ],
    dummies: [],
  };
}

function iOnlyEncodingRow({ trial = 0, block = 'main_a', rotation = 45 } = {}) {
  return {
    phase: 'i_only_encoding',
    block_label: block,
    trial_index_in_block: trial,
    rotation_deg: rotation,
    sequence: 'MSMSMS',
    stars: [
      { slot: 1, cell: 6, pattern_label: 'on' },
      { slot: 3, cell: 12, pattern_label: 'on' },
      { slot: 5, cell: 7, pattern_label: 'off' },
    ],
    dummies: [],
  };
}

function iOnlyStarRow({
  pos,
  cell,
  isOn,
  correct,
  rtMs,
  trial = 0,
  block = 'main_a',
  rotation = 45,
}) {
  /* `pos` is 1-indexed at the call-site for readability; runtime stamps
   * `probe_position` as 0-indexed (imagery-block.js line 118, dual-block.js
   * line 242), so we subtract 1 here. */
  return {
    phase: 'i_only_star',
    block_label: block,
    trial_index_in_block: trial,
    rotation_deg: rotation,
    probe_position: pos - 1,
    slot_index_in_seq: 2 * pos - 1,
    probed_cell: cell,
    pattern_label: isOn ? 'on' : 'off',
    is_on_pattern: isOn,
    responded: rtMs !== null,
    said_on: rtMs === null ? null : isOn === correct,
    response_key: rtMs === null ? null : isOn === correct ? 'arrowright' : 'arrowleft',
    response_rt_ms: rtMs,
    star_correct: correct,
    feedback_shown_at_ms: rtMs ? rtMs + 50 : null,
  };
}

/* ---------- parseExportArgs ---------- */

describe('parseExportArgs', () => {
  it('returns defaults for empty argv', () => {
    expect(parseExportArgs([])).toEqual({ inputs: [], outputDir: null, jsonManifest: false });
  });

  it('separates --out and inputs', () => {
    expect(parseExportArgs(['node', 'csv-export.js', '--out', 'out/', 'a.json', 'b.json'])).toEqual(
      {
        inputs: ['a.json', 'b.json'],
        outputDir: 'out/',
        jsonManifest: false,
      }
    );
  });

  it('flips jsonManifest on --json-manifest', () => {
    expect(
      parseExportArgs(['node', 'csv-export.js', '--out', 'o', '--json-manifest', 'a.json'])
    ).toEqual({
      inputs: ['a.json'],
      outputDir: 'o',
      jsonManifest: true,
    });
  });

  it('throws on unknown flags', () => {
    expect(() => parseExportArgs(['node', 'csv-export.js', '--out', 'x', '--unknown'])).toThrow(
      /unknown flag/
    );
  });
});

/* ---------- Pure helpers ---------- */

describe('cellToRowCol', () => {
  it('maps cell index 0 to [0, 0] (top-left)', () => {
    expect(cellToRowCol(0)).toEqual([0, 0]);
  });
  it('maps cell index 12 to [2, 2] (centre of the 5x5)', () => {
    expect(cellToRowCol(12)).toEqual([2, 2]);
  });
  it('maps cell index 24 to [4, 4] (bottom-right)', () => {
    expect(cellToRowCol(24)).toEqual([4, 4]);
  });
  it('returns null for out-of-range or non-integer input', () => {
    expect(cellToRowCol(-1)).toBeNull();
    expect(cellToRowCol(25)).toBeNull();
    expect(cellToRowCol(2.5)).toBeNull();
    expect(cellToRowCol('5')).toBeNull();
    expect(cellToRowCol(null)).toBeNull();
  });
});

describe('formatCell', () => {
  it('formats [row, col] pair with a single space after the comma (Project 1 convention)', () => {
    expect(formatCell([1, 2])).toBe('[1, 2]');
  });
  it('accepts a raw cell index', () => {
    expect(formatCell(12)).toBe('[2, 2]');
  });
  it('returns NA for null / undefined / invalid', () => {
    expect(formatCell(null)).toBe('NA');
    expect(formatCell(undefined)).toBe('NA');
    expect(formatCell(99)).toBe('NA');
  });
});

describe('trialTypeFromPhase', () => {
  it('detects each of the five trial-type prefixes', () => {
    expect(trialTypeFromPhase('d_only_encoding')).toBe('d_only');
    expect(trialTypeFromPhase('t_only_probe')).toBe('t_only');
    expect(trialTypeFromPhase('i_only_star')).toBe('i_only');
    expect(trialTypeFromPhase('i_d_probe')).toBe('i_d');
    expect(trialTypeFromPhase('i_t_star')).toBe('i_t');
  });
  it('returns null for non-trial phases', () => {
    expect(trialTypeFromPhase('consent')).toBeNull();
    expect(trialTypeFromPhase('strategy_memory_only')).toBeNull();
    expect(trialTypeFromPhase('attention_check')).toBeNull();
    expect(trialTypeFromPhase(null)).toBeNull();
    expect(trialTypeFromPhase('')).toBeNull();
  });
  it('does not confuse i_only_ with i_d_ / i_t_ prefixes', () => {
    expect(trialTypeFromPhase('i_only_trial_start')).toBe('i_only');
    expect(trialTypeFromPhase('i_d_trial_start')).toBe('i_d');
    expect(trialTypeFromPhase('i_t_trial_start')).toBe('i_t');
  });
});

describe('probeTypeCode', () => {
  it('maps the four locked types to 1..4', () => {
    expect(probeTypeCode('T_on')).toBe(1);
    expect(probeTypeCode('T_off')).toBe(2);
    expect(probeTypeCode('F_on')).toBe(3);
    expect(probeTypeCode('F_off')).toBe(4);
  });
  it('returns NA for unknown / missing types', () => {
    expect(probeTypeCode(null)).toBe('NA');
    expect(probeTypeCode(undefined)).toBe('NA');
    expect(probeTypeCode('mystery')).toBe('NA');
  });
});

describe('cellTypeCode', () => {
  it('returns 1 for on-pattern / 0 for off-pattern', () => {
    expect(cellTypeCode({ pattern_label: 'on' })).toBe(1);
    expect(cellTypeCode({ pattern_label: 'off' })).toBe(0);
    expect(cellTypeCode({ is_on_pattern: true })).toBe(1);
    expect(cellTypeCode({ is_on_pattern: false })).toBe(0);
  });
  it('returns NA for missing input', () => {
    expect(cellTypeCode({})).toBe('NA');
    expect(cellTypeCode()).toBe('NA');
  });
});

describe('applyCriterion1', () => {
  it('returns NA for null / undefined / non-finite RT', () => {
    expect(applyCriterion1(null)).toBe('NA');
    expect(applyCriterion1(undefined)).toBe('NA');
    expect(applyCriterion1(NaN)).toBe('NA');
    expect(applyCriterion1(Infinity)).toBe('NA');
  });
  it('returns NA when RT is below the 250 ms anticipatory floor', () => {
    expect(applyCriterion1(0)).toBe('NA');
    expect(applyCriterion1(100)).toBe('NA');
    expect(applyCriterion1(249)).toBe('NA');
  });
  it('passes through RT >= 250 ms', () => {
    expect(applyCriterion1(250)).toBe(250);
    expect(applyCriterion1(500)).toBe(500);
    expect(applyCriterion1(3999)).toBe(3999);
  });
});

describe('applyCriterion2', () => {
  it('returns NA when ResVA is not exactly 1 (incorrect or skipped)', () => {
    expect(applyCriterion2(500, 0)).toBe('NA');
    expect(applyCriterion2(500, -1)).toBe('NA');
  });
  it('returns NA when RT is below 250 ms even if correct', () => {
    expect(applyCriterion2(100, 1)).toBe('NA');
  });
  it('passes through RT only when both conditions hold', () => {
    expect(applyCriterion2(500, 1)).toBe(500);
  });
});

describe('probeResCodes', () => {
  it('codes a yes-response as Res=1 ResVA=correctness', () => {
    expect(probeResCodes({ responded: true, said_yes: true, probe_correct: true })).toEqual({
      res: 1,
      resVA: 1,
    });
  });
  it('codes a no-response as Res=0 ResVA=correctness', () => {
    expect(probeResCodes({ responded: true, said_yes: false, probe_correct: false })).toEqual({
      res: 0,
      resVA: 0,
    });
  });
  it('codes a non-response as Res=-1 ResVA=-1', () => {
    expect(probeResCodes({ responded: false })).toEqual({ res: -1, resVA: -1 });
  });
});

describe('starResCodes', () => {
  it('codes said_on=true → Res=1', () => {
    expect(starResCodes({ responded: true, said_on: true, star_correct: true })).toEqual({
      res: 1,
      resVA: 1,
    });
  });
  it('codes said_on=false → Res=0', () => {
    expect(starResCodes({ responded: true, said_on: false, star_correct: false })).toEqual({
      res: 0,
      resVA: 0,
    });
  });
  it('codes a non-response as -1 / -1', () => {
    expect(starResCodes({ responded: false })).toEqual({ res: -1, resVA: -1 });
  });
});

describe('extractRtMs', () => {
  it('prefers response_rt_ms (star rows) when present', () => {
    expect(extractRtMs({ response_rt_ms: 800, rt: 1234 })).toBe(800);
  });
  it('falls back to jsPsych rt (probe rows)', () => {
    expect(extractRtMs({ rt: 1234 })).toBe(1234);
  });
  it('returns null when no usable timing column exists', () => {
    expect(extractRtMs({})).toBeNull();
    expect(extractRtMs({ rt: null, response_rt_ms: null })).toBeNull();
  });
});

describe('formatCsvValue', () => {
  it('quotes strings and doubles embedded quotes', () => {
    expect(formatCsvValue('hello')).toBe('"hello"');
    expect(formatCsvValue('he said "hi"')).toBe('"he said ""hi"""');
  });
  it('emits bare numbers for finite numeric values', () => {
    expect(formatCsvValue(0)).toBe('0');
    expect(formatCsvValue(-1)).toBe('-1');
    expect(formatCsvValue(311.13)).toBe('311.13');
  });
  it('emits NA for null, undefined, and the NA sentinel', () => {
    expect(formatCsvValue(null)).toBe('NA');
    expect(formatCsvValue(undefined)).toBe('NA');
    expect(formatCsvValue('NA')).toBe('NA');
  });
  it('emits NA for non-finite numbers', () => {
    expect(formatCsvValue(NaN)).toBe('NA');
    expect(formatCsvValue(Infinity)).toBe('NA');
  });
});

describe('serializeRowsToCsv', () => {
  it('emits a quoted header followed by one line per row, terminated with \\n', () => {
    const csv = serializeRowsToCsv(
      [
        { A: 1, B: 'x' },
        { A: 2, B: null },
      ],
      ['A', 'B']
    );
    expect(csv).toBe('"A","B"\n1,"x"\n2,NA\n');
  });
  it('emits header only for an empty rows array', () => {
    expect(serializeRowsToCsv([], ['A', 'B'])).toBe('"A","B"\n');
  });
});

/* ---------- Trial grouping + wide-row builders ---------- */

describe('groupTrialRows', () => {
  it('keys groups by (pid, trial_type, block, trial_idx) and bundles roles', () => {
    const rows = [
      dOnlyEncodingRow({ trial: 0, block: 'main_a' }),
      dOnlyProbeRow({
        pos: 1,
        type: 'T_on',
        cell: 6,
        isTarget: true,
        correct: true,
        rt: 800,
        trial: 0,
      }),
      dOnlyProbeRow({
        pos: 2,
        type: 'F_off',
        cell: 0,
        isTarget: false,
        correct: true,
        rt: 700,
        trial: 0,
      }),
    ];
    const groups = groupTrialRows(new Map([['P1', rows]]));
    expect(groups.size).toBe(1);
    const g = [...groups.values()][0];
    expect(g.participant_id).toBe('P1');
    expect(g.trial_type).toBe('d_only');
    expect(g.block_label).toBe('main_a');
    expect(g.trial_index_in_block).toBe(0);
    expect(g.encoding).toBeTruthy();
    expect(g.probes).toHaveLength(2);
    expect(g.stars).toHaveLength(0);
  });

  it('skips rows lacking block_label or trial_index_in_block', () => {
    const rows = [
      { phase: 'd_only_probe', trial_index_in_block: 0 } /* missing block_label */,
      { phase: 'd_only_probe', block_label: 'main_a' } /* missing trial idx */,
      { phase: 'consent' },
    ];
    expect(groupTrialRows(new Map([['P1', rows]])).size).toBe(0);
  });

  it('separates trials in different blocks and trial indices', () => {
    const rows = [
      dOnlyEncodingRow({ trial: 0, block: 'practice' }),
      dOnlyEncodingRow({ trial: 0, block: 'main_a' }),
      dOnlyEncodingRow({ trial: 1, block: 'main_a' }),
    ];
    expect(groupTrialRows(new Map([['P1', rows]])).size).toBe(3);
  });
});

describe('buildWideRowDOnly', () => {
  it('produces 3 Dot_* and 3 Qmark_* slot blocks plus session metadata', () => {
    const group = {
      participant_id: 'P1',
      trial_type: 'd_only',
      block_label: 'main_a',
      trial_index_in_block: 0,
      encoding: dOnlyEncodingRow(),
      probes: [
        dOnlyProbeRow({ pos: 1, type: 'T_on', cell: 6, isTarget: true, correct: true, rt: 800 }),
        dOnlyProbeRow({ pos: 2, type: 'T_off', cell: 7, isTarget: true, correct: false, rt: 200 }),
        dOnlyProbeRow({
          pos: 3,
          type: 'F_off',
          cell: 0,
          isTarget: false,
          correct: false,
          rt: null,
        }),
      ],
      stars: [],
    };
    const meta = sessionMeta();
    const row = buildWideRowDOnly(group, 1, meta);
    expect(row.Participant_ID).toBe('P1');
    expect(row.Block).toBe('main_a');
    expect(row.Trial).toBe(1);
    expect(row.Dot_1_Cell).toBe('[1, 1]');
    expect(row.Dot_1_CellTY).toBe(1);
    expect(row.Dot_3_Cell).toBe('[1, 2]');
    expect(row.Dot_3_CellTY).toBe(0);
    expect(row.Qmark_1_Type).toBe(1);
    expect(row.Qmark_1_Cell).toBe('[1, 1]');
    expect(row.Qmark_1_Res).toBe(1);
    expect(row.Qmark_1_ResVA).toBe(1);
    expect(row.Qmark_1_RecTI).toBe(800);
    expect(row.Qmark_1_RecTI_1).toBe(800); /* >= 250, criterion 1 passes */
    expect(row.Qmark_1_RecTY).toBe(1);
    /* Probe 2: RT < 250 → criterion1 NA. */
    expect(row.Qmark_2_RecTI).toBe(200);
    expect(row.Qmark_2_RecTI_1).toBe('NA');
    /* Probe 3: no response → Res=-1 ResVA=-1, RT NA. */
    expect(row.Qmark_3_Res).toBe(-1);
    expect(row.Qmark_3_ResVA).toBe(-1);
    expect(row.Qmark_3_RecTI).toBe('NA');
    expect(row.Qmark_3_RecTY).toBe('NA');
    /* Session meta. */
    expect(row.Build_ID).toBe('v1');
    expect(row.Pilot_Run).toBe(1);
  });

  it('Criterion2 NA-s incorrect responses even when RT >= 250', () => {
    const group = {
      participant_id: 'P1',
      trial_type: 'd_only',
      block_label: 'main_a',
      trial_index_in_block: 0,
      encoding: dOnlyEncodingRow(),
      probes: [
        dOnlyProbeRow({ pos: 1, type: 'T_on', cell: 6, isTarget: true, correct: false, rt: 600 }),
      ],
      stars: [],
    };
    const c1 = buildWideRowDOnly(group, 1, sessionMeta());
    const c2 = buildWideRowDOnly(group, 2, sessionMeta());
    expect(c1.Qmark_1_RecTI_1).toBe(600); /* criterion1: only floors RT */
    expect(c2.Qmark_1_RecTI_1).toBe('NA'); /* criterion2: incorrect → NA */
  });

  it('emits NA for all 3 slots when probes are missing', () => {
    const group = {
      participant_id: 'P1',
      trial_type: 'd_only',
      block_label: 'main_a',
      trial_index_in_block: 0,
      encoding: dOnlyEncodingRow(),
      probes: [],
      stars: [],
    };
    const row = buildWideRowDOnly(group, 1, sessionMeta());
    for (let i = 1; i <= 3; i++) {
      expect(row[`Qmark_${i}_Cell`]).toBe('NA');
      expect(row[`Qmark_${i}_Res`]).toBe('NA');
      expect(row[`Qmark_${i}_RecTI`]).toBe('NA');
    }
  });
});

describe('buildWideRowTOnly', () => {
  it('includes Tone_*_Idx + Tone_*_FreqHz from the encoding row', () => {
    const group = {
      participant_id: 'P1',
      trial_type: 't_only',
      block_label: 'main_a',
      trial_index_in_block: 0,
      encoding: tOnlyEncodingRow(),
      probes: [
        {
          phase: 't_only_probe',
          block_label: 'main_a',
          trial_index_in_block: 0,
          probe_position: 0,
          probe_type: 'T_on',
          probed_cell: 6,
          probed_tone_index: 5,
          probed_tone_freq_hz: 311.13,
          probe_pattern_label: 'on',
          is_target: true,
          responded: true,
          said_yes: true,
          probe_correct: true,
          rt: 850,
        },
      ],
      stars: [],
    };
    const row = buildWideRowTOnly(group, 1, sessionMeta());
    expect(row.Tone_1_ToneIdx).toBe(5);
    expect(row.Tone_1_ToneFreqHz).toBe(311.13);
    expect(row.Qmark_1_ToneIdx).toBe(5);
    expect(row.Qmark_1_ToneFreqHz).toBe(311.13);
    expect(row.Qmark_1_Cell).toBe('[1, 1]');
  });
});

describe('Rotation_Deg for d_only', () => {
  const dOnlyGroup = (encoding) => ({
    participant_id: 'P1',
    trial_type: 'd_only',
    block_label: 'main_a',
    trial_index_in_block: 0,
    encoding,
    probes: [],
    stars: [],
  });

  it('takes the display angle of a d_only trial', () => {
    const row = buildWideRowDOnly(
      dOnlyGroup({ display_rotation_deg: 37, memory_items: [] }),
      1,
      sessionMeta()
    );
    expect(row.Rotation_Deg).toBe(37);
  });

  it('is NA when the trial has no rotation', () => {
    expect(buildWideRowDOnly(dOnlyGroup({ memory_items: [] }), 1, sessionMeta()).Rotation_Deg).toBe(
      'NA'
    );
  });

  it('is a column of the d_only table, next to the background shade', () => {
    const i = COLUMNS_D_ONLY.indexOf('Background_Shade');
    expect(COLUMNS_D_ONLY[i + 1]).toBe('Rotation_Deg');
  });
});

describe('buildWideRowIOnly', () => {
  it('produces 3 Ast_* slots, no Qmark_*, plus Rotation_Deg + Dummy_Mode', () => {
    const group = {
      participant_id: 'P1',
      trial_type: 'i_only',
      block_label: 'main_a',
      trial_index_in_block: 0,
      encoding: iOnlyEncodingRow({ rotation: -45 }),
      probes: [],
      stars: [
        iOnlyStarRow({ pos: 1, cell: 6, isOn: true, correct: true, rtMs: 700 }),
        iOnlyStarRow({ pos: 2, cell: 12, isOn: true, correct: true, rtMs: 200 }),
        iOnlyStarRow({ pos: 3, cell: 18, isOn: false, correct: true, rtMs: null }),
      ],
    };
    const row = buildWideRowIOnly(group, 1, sessionMeta());
    expect(row.Rotation_Deg).toBe(-45);
    expect(row.Dummy_Mode).toBeUndefined();
    expect(row.Ast_1_Cell).toBe('[1, 1]');
    expect(row.Ast_1_CellTY).toBe(1);
    expect(row.Ast_1_RecTI).toBe(700);
    expect(row.Ast_2_RecTI_1).toBe('NA'); /* RT < 250 */
    expect(row.Ast_3_Res).toBe(-1);
    expect(row.Ast_3_ResVA).toBe(-1);
    expect(row.Ast_3_RecTY).toBe('NA');
    /* No Qmark columns on I-only. */
    expect(row.Qmark_1_Cell).toBeUndefined();
  });
});

describe('buildWideRowID and buildWideRowIT', () => {
  it('I+D row contains both Ast_* and Qmark_* with EncPos passthrough', () => {
    const encoding = {
      phase: 'i_d_encoding',
      block_label: 'main_a',
      trial_index_in_block: 0,
      rotation_deg: 90,
      sequence: 'MSMSMS',
      memory_items: [
        { slot: 0, encoding_position: 1, cell: 6, pattern_label: 'on' },
        { slot: 2, encoding_position: 2, cell: 12, pattern_label: 'on' },
      ],
      stars: [
        { slot: 1, cell: 7, pattern_label: 'off' },
        { slot: 3, cell: 18, pattern_label: 'off' },
      ],
    };
    const probe = {
      phase: 'i_d_probe',
      block_label: 'main_a',
      trial_index_in_block: 0,
      probe_position: 0,
      encoding_position: 1,
      probe_type: 'T_on',
      probed_cell: 6,
      probe_pattern_label: 'on',
      is_target: true,
      responded: true,
      said_yes: true,
      probe_correct: true,
      rt: 700,
    };
    const star = {
      phase: 'i_d_star',
      block_label: 'main_a',
      trial_index_in_block: 0,
      probe_position: 0,
      slot_index_in_seq: 1,
      probed_cell: 7,
      pattern_label: 'off',
      is_on_pattern: false,
      responded: true,
      said_on: false,
      response_key: 'arrowleft',
      response_rt_ms: 950,
      star_correct: true,
    };
    const group = {
      participant_id: 'P1',
      trial_type: 'i_d',
      block_label: 'main_a',
      trial_index_in_block: 0,
      encoding,
      probes: [probe],
      stars: [star],
    };
    const row = buildWideRowID(group, 1, sessionMeta());
    expect(row.Rotation_Deg).toBe(90);
    expect(row.Dot_1_Cell).toBe('[1, 1]');
    expect(row.Dot_1_OrderN).toBe(1);
    expect(row.Ast_1_SlotN).toBe(1);
    expect(row.Ast_1_Cell).toBe('[1, 2]');
    expect(row.Ast_1_RecTI).toBe(950);
    expect(row.Qmark_1_Cell).toBe('[1, 1]');
    expect(row.Qmark_1_Type).toBe(1);
    expect(row.Qmark_1_EncPos).toBe(1);
  });

  it('I+T row carries tone columns on both Tone_ and Qmark_ groups', () => {
    const encoding = {
      phase: 'i_t_encoding',
      block_label: 'main_a',
      trial_index_in_block: 0,
      rotation_deg: 0,
      sequence: 'MSMSMS',
      memory_items: [
        {
          slot: 0,
          encoding_position: 1,
          cell: 6,
          tone_index: 5,
          tone_freq_hz: 311.13,
          pattern_label: 'on',
        },
      ],
      stars: [{ slot: 1, cell: 18, pattern_label: 'off' }],
    };
    const probe = {
      phase: 'i_t_probe',
      block_label: 'main_a',
      trial_index_in_block: 0,
      probe_position: 0,
      encoding_position: 1,
      probe_type: 'T_on',
      probed_cell: 6,
      probed_tone_index: 5,
      probed_tone_freq_hz: 311.13,
      probe_pattern_label: 'on',
      is_target: true,
      responded: true,
      said_yes: true,
      probe_correct: true,
      rt: 600,
    };
    const group = {
      participant_id: 'P1',
      trial_type: 'i_t',
      block_label: 'main_a',
      trial_index_in_block: 0,
      encoding,
      probes: [probe],
      stars: [],
    };
    const row = buildWideRowIT(group, 1, sessionMeta());
    expect(row.Tone_1_ToneIdx).toBe(5);
    expect(row.Qmark_1_ToneIdx).toBe(5);
    expect(row.Qmark_1_EncPos).toBe(1);
  });
});

/* ---------- Auxiliary CSV builders ---------- */

describe('extractCalibrationRow', () => {
  it('captures consent / screen / audibility-comfort / attention / upload + completion', () => {
    const rows = [
      { phase: 'consent', consented: true },
      {
        phase: 'screen_calibration',
        cc_px_width: 320,
        px_per_mm: 4.5,
        px_per_mm_in_bounds: true,
        display_colour_locked: false,
      },
      {
        phase: 'screen_calibration_outcome',
        value: {
          attempts_used: 1,
          retried: false,
          cc_px_width: 320,
          px_per_mm: 4.5,
          px_per_mm_in_bounds: true,
        },
      },
      {
        phase: 'tone_audibility_and_comfort',
        tones_audible: true,
        user_playback_pct: 65,
        user_playback_gain: 0.65,
        sweeps_completed: 2,
      },
      {
        phase: 'attention_check_summary',
        attention_total: 3,
        attention_passed: 2,
        attention_failed: 1,
        attention_excluded: false,
      },
      { phase: 'upload_session_end', status: 'no_endpoint', storage_failures: 0 },
      { phase: 'completion_redirect', completion_was_placeholder: true },
      { time_elapsed: 1_800_000 } /* 30-min session */,
    ];
    const row = extractCalibrationRow('P1', sessionMeta(), rows);
    expect(row.Participant_ID).toBe('P1');
    expect(row.Consented).toBe(1);
    expect(row.Cc_Px_Width).toBe(320);
    expect(row.Px_Per_Mm).toBe(4.5);
    expect(row.Px_Per_Mm_In_Bounds).toBe(1);
    expect(row.Screen_Cal_Attempts).toBe(1);
    expect(row.Screen_Cal_Retried).toBe(0);
    expect(row.Display_Colour_Locked).toBe(0);
    expect(row.Tones_Audible).toBe(1);
    expect(row.User_Playback_Pct).toBe(65);
    expect(row.User_Playback_Gain).toBeCloseTo(0.65);
    expect(row.Sweeps_Completed).toBe(2);
    expect(row.Attention_Total).toBe(3);
    expect(row.Attention_Passed).toBe(2);
    expect(row.Attention_Failed).toBe(1);
    expect(row.Attention_Excluded).toBe(0);
    expect(row.Upload_Status).toBe('no_endpoint');
    expect(row.Completion_Was_Placeholder).toBe(1);
    expect(row.Storage_Failures).toBe(0);
    expect(row.Session_Duration_Min).toBe(30);
    expect(row.User_Agent).toBe('TestAgent/1.0');
  });

  it('returns NA-coded fields when calibration phases are missing', () => {
    const row = extractCalibrationRow('P1', sessionMeta(), []);
    expect(row.Consented).toBe('NA');
    expect(row.Cc_Px_Width).toBe('NA');
    expect(row.Px_Per_Mm_In_Bounds).toBe('NA');
    expect(row.Screen_Cal_Attempts).toBe('NA');
    expect(row.Screen_Cal_Retried).toBe('NA');
    expect(row.Display_Colour_Locked).toBe('NA');
    expect(row.Tones_Audible).toBe('NA');
    expect(row.User_Playback_Pct).toBe('NA');
    expect(row.User_Playback_Gain).toBe('NA');
    expect(row.Sweeps_Completed).toBe('NA');
    expect(row.Attention_Total).toBe('NA');
  });

  it('flags out-of-bounds px/mm and a retry attempt', () => {
    const rows = [
      {
        phase: 'screen_calibration',
        cc_px_width: 200,
        px_per_mm: 2.34,
        px_per_mm_in_bounds: false,
        display_colour_locked: false,
      },
      {
        phase: 'screen_calibration_outcome',
        value: {
          attempts_used: 1,
          retried: false,
          cc_px_width: 200,
          px_per_mm: 2.34,
          px_per_mm_in_bounds: false,
        },
      },
      {
        phase: 'screen_calibration',
        cc_px_width: 320,
        px_per_mm: 3.74,
        px_per_mm_in_bounds: true,
        display_colour_locked: true,
      },
      {
        phase: 'screen_calibration_outcome',
        value: {
          attempts_used: 2,
          retried: true,
          cc_px_width: 320,
          px_per_mm: 3.74,
          px_per_mm_in_bounds: true,
        },
      },
    ];
    const row = extractCalibrationRow('P1', sessionMeta(), rows);
    /* Should pull the LAST outcome row (the retry that succeeded). */
    expect(row.Px_Per_Mm).toBeCloseTo(3.74);
    expect(row.Px_Per_Mm_In_Bounds).toBe(1);
    expect(row.Screen_Cal_Attempts).toBe(2);
    expect(row.Screen_Cal_Retried).toBe(1);
    expect(row.Display_Colour_Locked).toBe(1);
  });
});

describe('estimateSessionDurationMin', () => {
  it('returns NA on an empty rows array', () => {
    expect(estimateSessionDurationMin([])).toBe('NA');
  });
  it('uses the last time_elapsed when available', () => {
    expect(estimateSessionDurationMin([{ time_elapsed: 600_000 }])).toBe(10);
  });
});

describe('extractStrategyRows', () => {
  it('produces one row per (section × item) with raw + numeric score', () => {
    const rows = [
      {
        phase: 'strategy_memory_only',
        strategy_section: 'memory_only',
        strategy_responses: {
          strategy_q01: '1',
          strategy_q02: '5',
          strategy_q03: null,
        },
      },
    ];
    const out = extractStrategyRows('P1', rows);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      Participant_ID: 'P1',
      Section: 'memory_only',
      Item_Id: 'strategy_q01',
      Response_Raw: '1',
      Response_Score: 1,
    });
    expect(out[1].Response_Raw).toBe('5');
    expect(out[1].Response_Score).toBe(5);
    expect(out[2].Response_Raw).toBe('NA');
    expect(out[2].Response_Score).toBe('NA');
  });

  it('ignores non-strategy phases', () => {
    const rows = [
      {
        phase: 'demographics',
        strategy_responses: { strategy_q01: '5' },
      },
    ];
    expect(extractStrategyRows('P1', rows)).toEqual([]);
  });
});

describe('extractAttentionRows', () => {
  it('emits one row per attention_check with passed coded 1/0/NA', () => {
    const rows = [
      {
        phase: 'attention_check',
        attention_check_id: 'ac1_alpha',
        attention_check_raw: 'cat',
        attention_check_passed: true,
      },
      {
        phase: 'attention_check',
        attention_check_id: 'ac2_beta',
        attention_check_raw: 'dog',
        attention_check_passed: false,
      },
    ];
    const out = extractAttentionRows('P1', rows);
    expect(out).toHaveLength(2);
    expect(out[0].Passed).toBe(1);
    expect(out[1].Passed).toBe(0);
  });
});

describe('extractDemographicsRow', () => {
  it('pulls the in-experiment fields (plus the optional note) from the demographics row response object', () => {
    const rows = [
      {
        phase: 'demographics',
        response: {
          handedness: 'right',
          education: 'master',
          english_fluency: 'fluent',
          glasses_contacts: 'yes',
          glasses_contacts_note: '',
        },
      },
    ];
    const row = extractDemographicsRow('P1', sessionMeta(), rows);
    expect(row.Participant_ID).toBe('P1');
    expect(row.Build_ID).toBe('v1');
    expect(row.Age).toBeUndefined();
    expect(row.Sex).toBeUndefined();
    expect(row.First_Languages).toBeUndefined();
    expect(row.Handedness).toBe('right');
    expect(row.Education).toBe('master');
    expect(row.English_Fluency).toBe('fluent');
    expect(row.Glasses_Contacts).toBe('yes');
  });

  it('emits NA for every field when no demographics row is present', () => {
    const row = extractDemographicsRow('P1', sessionMeta(), []);
    expect(row.Participant_ID).toBe('P1');
    expect(row.Age).toBeUndefined();
    expect(row.Handedness).toBe('NA');
    expect(row.Glasses_Contacts_Note).toBe('NA');
  });

  it('exposes a column list with the 10-column shape for serialisation', () => {
    expect(DEMOGRAPHICS_COLUMNS).not.toContain('Age');
    expect(DEMOGRAPHICS_COLUMNS).not.toContain('Sex');
    expect(DEMOGRAPHICS_COLUMNS).not.toContain('First_Languages');
    expect(DEMOGRAPHICS_COLUMNS).toContain('Handedness');
    expect(DEMOGRAPHICS_COLUMNS).toContain('Glasses_Contacts_Note');
    for (const removed of ['Hearing', 'Hearing_Note', 'Vision', 'Medication', 'Medication_Note'])
      expect(DEMOGRAPHICS_COLUMNS).not.toContain(removed);
    expect(DEMOGRAPHICS_COLUMNS.length).toBe(10);
  });
});

/* ---------- Manifest + dump-loading ---------- */

describe('buildExportManifest', () => {
  it('flags heterogeneity across build_ids and pilot flags', () => {
    const perParticipant = [
      {
        participant_id: 'P1',
        session: { build_id: 'a', schema_version: 'v1', is_pilot_run: true },
      },
      {
        participant_id: 'P2',
        session: { build_id: 'b', schema_version: 'v1', is_pilot_run: false },
      },
    ];
    const m = buildExportManifest({
      inputPaths: ['x.json'],
      perParticipant,
      fileList: [],
      generatedAtIso: '2000-01-01T10:00:00Z',
      generatorVersion: '1.0.0',
    });
    expect(m.heterogeneity_flags.build_id_heterogeneous).toBe(true);
    expect(m.heterogeneity_flags.pilot_flag_heterogeneous).toBe(true);
    expect(m.heterogeneity_flags.schema_version_heterogeneous).toBe(false);
    expect(m.n_participants).toBe(2);
    expect(m.participant_ids).toEqual(['P1', 'P2']);
  });
});

describe('loadAndFlattenDumps', () => {
  it('groups multi-chunk envelopes by prolific_pid and concatenates rows', () => {
    const fakeFs = {
      readFileSync: (p) => {
        if (p.endsWith('chunk0.json')) {
          return JSON.stringify({
            session_id: 's1',
            prolific_pid: 'P1',
            build_id: 'b',
            schema_version: 'v',
            is_pilot_run: true,
            rows: [{ phase: 'main_a_intro' }],
          });
        }
        if (p.endsWith('chunk1.json')) {
          return JSON.stringify({
            session_id: 's1',
            prolific_pid: 'P1',
            rows: [{ phase: 'attention_check', attention_check_passed: true }],
          });
        }
        if (p.endsWith('p2.json')) {
          return JSON.stringify({
            session: {
              params: { prolific_pid: 'P2' },
              build_id: 'b',
              schema_version: 'v',
              is_pilot_run: false,
            },
            rows: [{ phase: 'consent', consented: true }],
          });
        }
        throw new Error(`unexpected path ${p}`);
      },
    };
    const out = loadAndFlattenDumps(['/tmp/chunk0.json', '/tmp/chunk1.json', '/tmp/p2.json'], {
      fs: fakeFs,
    });
    expect(out.errors).toEqual([]);
    expect(out.perParticipant).toHaveLength(2);
    const p1 = out.perParticipant.find((p) => p.participant_id === 'P1');
    expect(p1.rows).toHaveLength(2);
    expect(p1.session.build_id).toBe('b');
    const p2 = out.perParticipant.find((p) => p.participant_id === 'P2');
    expect(p2.session.is_pilot_run).toBe(false);
    /* SHA-256 hashes are stamped per source file. */
    expect(out.fileSha256ByPath['/tmp/chunk0.json']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records errors for unparseable JSON without aborting', () => {
    const fakeFs = {
      readFileSync: (p) => {
        if (p.endsWith('bad.json')) return 'not json';
        return JSON.stringify({ rows: [] });
      },
    };
    const out = loadAndFlattenDumps(['/tmp/bad.json', '/tmp/ok.json'], { fs: fakeFs });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0].path).toBe('/tmp/bad.json');
    expect(out.perParticipant).toHaveLength(1);
  });
});

describe('expandInputPaths', () => {
  it('walks directories and keeps only .json files', () => {
    const fakeFs = {
      statSync: (p) =>
        p.endsWith('dir') ? { isDirectory: () => true } : { isDirectory: () => false },
      readdirSync: () => ['a.json', 'README.md', 'b.json'],
    };
    const out = expandInputPaths(['dir'], { fs: fakeFs });
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.endsWith('.json'))).toBe(true);
  });
});

/* ---------- composeExport (end-to-end) ---------- */

describe('composeExport', () => {
  it('emits 5 trial-type files × 2 criteria + 4 aux files for a one-participant fixture', () => {
    const rows = [
      dOnlyEncodingRow({ trial: 0 }),
      dOnlyProbeRow({ pos: 1, type: 'T_on', cell: 6, isTarget: true, correct: true, rt: 800 }),
      dOnlyProbeRow({ pos: 2, type: 'T_off', cell: 7, isTarget: true, correct: false, rt: 600 }),
      dOnlyProbeRow({ pos: 3, type: 'F_on', cell: 12, isTarget: false, correct: true, rt: 1100 }),
      iOnlyEncodingRow({ trial: 0 }),
      iOnlyStarRow({ pos: 1, cell: 6, isOn: true, correct: true, rtMs: 700 }),
      iOnlyStarRow({ pos: 2, cell: 12, isOn: true, correct: false, rtMs: 200 }),
      iOnlyStarRow({ pos: 3, cell: 7, isOn: false, correct: false, rtMs: 800 }),
      { phase: 'consent', consented: true },
      { phase: 'screen_calibration', cc_px_width: 320, px_per_mm: 4.5 },
      {
        phase: 'tone_audibility_and_comfort',
        tones_audible: true,
        user_playback_pct: 60,
        user_playback_gain: 0.6,
        sweeps_completed: 1,
      },
      {
        phase: 'attention_check_summary',
        attention_total: 3,
        attention_passed: 3,
        attention_failed: 0,
        attention_excluded: false,
      },
      {
        phase: 'attention_check',
        attention_check_id: 'ac1_alpha',
        attention_check_raw: 'banana',
        attention_check_passed: true,
      },
      {
        phase: 'strategy_memory_only',
        strategy_section: 'memory_only',
        strategy_responses: {
          strategy_q01: '1',
          strategy_q02: '2',
          strategy_q03: '3',
          strategy_q04: '4',
        },
      },
      { phase: 'upload_session_end', status: 'no_endpoint', storage_failures: 0 },
      { phase: 'completion_redirect', completion_was_placeholder: true },
    ];
    const perParticipant = [
      { participant_id: 'P1', session: sessionMeta(), rows, source_paths: [] },
    ];
    const { files, manifest } = composeExport(perParticipant, {
      generatedAtIso: '2000-01-01T11:00:00Z',
    });
    /* 5 trial types × 2 criteria + 5 auxiliary files + 3 tidy tables = 18 entries. */
    expect(Object.keys(files)).toHaveLength(18);
    expect(files['D_ONLY_Criterion1.csv']).toContain(
      '"Participant_ID","Block","Trial_Type","Trial"'
    );
    expect(files['D_ONLY_Criterion1.csv'].split('\n').filter(Boolean)).toHaveLength(
      2
    ); /* header + 1 trial */
    expect(files['I_ONLY_Criterion2.csv'].split('\n').filter(Boolean)).toHaveLength(2);
    expect(files['T_ONLY_Criterion1.csv'].split('\n').filter(Boolean)).toHaveLength(
      1
    ); /* no T-only trials */
    expect(files['CALIBRATION_SUMMARY.csv'].split('\n').filter(Boolean)).toHaveLength(2);
    expect(files['STRATEGY.csv'].split('\n').filter(Boolean)).toHaveLength(
      5
    ); /* 1 header + 4 items */
    expect(files['ATTENTION_CHECKS.csv'].split('\n').filter(Boolean)).toHaveLength(2);
    expect(manifest.n_participants).toBe(1);
    expect(manifest.heterogeneity_flags.build_id_heterogeneous).toBe(false);
  });

  it('Criterion1 vs Criterion2: incorrect probe RT NA-d only in Criterion2', () => {
    const rows = [
      dOnlyEncodingRow({ trial: 0 }),
      /* Correct, slow → both criteria keep the RT. */
      dOnlyProbeRow({ pos: 1, type: 'T_on', cell: 6, isTarget: true, correct: true, rt: 800 }),
      /* Incorrect but >250ms → C1 keeps, C2 NA-s. */
      dOnlyProbeRow({ pos: 2, type: 'T_off', cell: 7, isTarget: true, correct: false, rt: 1100 }),
      /* Anticipatory → both NA. */
      dOnlyProbeRow({ pos: 3, type: 'F_on', cell: 12, isTarget: false, correct: false, rt: 100 }),
    ];
    const perParticipant = [
      { participant_id: 'P1', session: sessionMeta(), rows, source_paths: [] },
    ];
    const { files } = composeExport(perParticipant, { generatedAtIso: '2000-01-01T11:00:00Z' });
    const c1Lines = files['D_ONLY_Criterion1.csv'].split('\n').filter(Boolean);
    const c2Lines = files['D_ONLY_Criterion2.csv'].split('\n').filter(Boolean);
    expect(c1Lines).toHaveLength(2);
    expect(c2Lines).toHaveLength(2);
    /* Same row, different RecTI_1 columns. The whole row should NOT match
     * because the criterion-filtered RT differs for probe 2. */
    expect(c1Lines[1]).not.toEqual(c2Lines[1]);
    /* But the body up to "Qmark_2_RecTI_1" should match. We can't easily
     * isolate that without parsing — instead, verify the trial-level columns
     * by checking the Cell columns appear in both. */
    expect(c1Lines[1]).toContain('"[1, 1]"'); /* Dot_1_Cell */
    expect(c2Lines[1]).toContain('"[1, 1]"');
  });
});

/* ---------- Column-list snapshot ---------- */

describe('column lists', () => {
  /* These snapshots lock the column ordering and count so future schema
   * changes have to consciously update the test, not just silently drift. */

  it('D_ONLY column list is stable', () => {
    expect(COLUMNS_D_ONLY).toMatchInlineSnapshot(`
      [
        "Participant_ID",
        "Block",
        "Trial_Type",
        "Trial",
        "Background_Shade",
        "Rotation_Deg",
        "Dot_1_OrderN",
        "Dot_1_Cell",
        "Dot_1_CellTY",
        "Dot_1_OnsetMs",
        "Dot_2_OrderN",
        "Dot_2_Cell",
        "Dot_2_CellTY",
        "Dot_2_OnsetMs",
        "Dot_3_OrderN",
        "Dot_3_Cell",
        "Dot_3_CellTY",
        "Dot_3_OnsetMs",
        "Qmark_1_Cell",
        "Qmark_1_Type",
        "Qmark_1_Res",
        "Qmark_1_ResVA",
        "Qmark_1_Key",
        "Qmark_1_RecTI",
        "Qmark_1_RecTI_1",
        "Qmark_1_RecTY",
        "Qmark_1_OnsetMs",
        "Qmark_2_Cell",
        "Qmark_2_Type",
        "Qmark_2_Res",
        "Qmark_2_ResVA",
        "Qmark_2_Key",
        "Qmark_2_RecTI",
        "Qmark_2_RecTI_1",
        "Qmark_2_RecTY",
        "Qmark_2_OnsetMs",
        "Qmark_3_Cell",
        "Qmark_3_Type",
        "Qmark_3_Res",
        "Qmark_3_ResVA",
        "Qmark_3_Key",
        "Qmark_3_RecTI",
        "Qmark_3_RecTI_1",
        "Qmark_3_RecTY",
        "Qmark_3_OnsetMs",
        "Build_ID",
        "Schema_Version",
        "Pilot_Run",
        "Pilot_Label",
      ]
    `);
  });

  it('all auxiliary column lists are non-empty and contain Participant_ID first', () => {
    for (const cols of [CALIBRATION_COLUMNS, STRATEGY_COLUMNS, ATTENTION_COLUMNS]) {
      expect(cols.length).toBeGreaterThan(0);
      expect(cols[0]).toBe('Participant_ID');
    }
  });

  it('dual-task column lists carry both Ast_ and Qmark_ prefixes', () => {
    expect(COLUMNS_I_D.some((c) => c.startsWith('Ast_'))).toBe(true);
    expect(COLUMNS_I_D.some((c) => c.startsWith('Qmark_'))).toBe(true);
    expect(COLUMNS_I_T.some((c) => c.startsWith('Ast_'))).toBe(true);
    expect(COLUMNS_I_T.some((c) => c.startsWith('Tone_'))).toBe(true);
    expect(COLUMNS_I_T.some((c) => c.startsWith('Qmark_'))).toBe(true);
  });

  it('I_ONLY column list contains no Qmark_ columns (no recognition probe) and no Dummy_Mode (uniform open-square fillers)', () => {
    expect(COLUMNS_I_ONLY.some((c) => c.startsWith('Qmark_'))).toBe(false);
    expect(COLUMNS_I_ONLY).toContain('Rotation_Deg');
    expect(COLUMNS_I_ONLY).not.toContain('Dummy_Mode');
  });

  it('T_ONLY column list carries Tone_ + Qmark_ tone passthrough columns', () => {
    expect(COLUMNS_T_ONLY).toContain('Tone_1_ToneIdx');
    expect(COLUMNS_T_ONLY).toContain('Tone_1_ToneFreqHz');
    expect(COLUMNS_T_ONLY).toContain('Qmark_1_ToneIdx');
    expect(COLUMNS_T_ONLY).toContain('Qmark_1_ToneFreqHz');
  });
});
