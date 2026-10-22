/**
 * Tidy tables: trials, stars and probes, one row per unit, with keys that
 * are unique across the whole data set.
 *
 *   trials  key: (participant_id, trial_seq_session)
 *   stars   key: (participant_id, trial_seq_session, star_serial_position)
 *   probes  key: (participant_id, trial_seq_session, probe_position)
 *
 * `trial_seq_session` counts the trial-start gates of the session in the
 * order they were presented (practice included), so it is unique even when a
 * practice pass is repeated. `trial_uid` (from the runtime) names the trial;
 * `attempt` numbers the passes through the same practice trial.
 * Nothing is joined on `trial_index_in_block`, which is the index in the
 * condition's 24-trial pool and repeats across conditions.
 *
 * Positions are in millimetres in the fixed grid frame: origin at fixation,
 * x to the right, y down. `cell_x_mm` / `cell_y_mm` are the upright-grid
 * position of a cell; `x_mm` / `y_mm` are the screen position after the
 * rotation the stimulus was drawn at.
 *
 * Planned stimuli come from `trial_spec` on the encoding row, so a star or
 * probe row that was not recorded still appears (row_recorded = false) and
 * counts as excluded.
 *
 * Pure Node; no browser dependencies.
 */
import { config } from '../src/config.js';
import { onPatternCells } from '../src/grid.js';
import { toneForCell } from '../src/audio/tones.js';

export const TIDY_VERSION = '1.0.0';
export const RT_FLOOR_MS = 250;

const HAS_STARS = new Set(['i_only', 'i_d', 'i_t']);
const HAS_PROBES = new Set(['d_only', 't_only', 'i_d', 'i_t']);
const TONE_CONDITIONS = new Set(['t_only', 'i_t']);
const GATE_RE = /^(d_only|t_only|i_only|i_d|i_t)_trial_start$/;
const PHASE_RE =
  /^(d_only|t_only|i_only|i_d|i_t)_(trial_start|arrow_cue|imagination|encoding|retention|probe|star|iti)$/;

const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const pad = (n, w) => String(n).padStart(w, '0');

/* ---------------- geometry ---------------- */

export function buildGeometry(sessionInfo) {
  const n = sessionInfo?.grid_cells_per_side ?? config.grid.cells_per_side;
  const size = sessionInfo?.cell_size_mm ?? config.grid.cell_size_mm;
  const table = new Map();
  if (Array.isArray(sessionInfo?.cell_table) && sessionInfo.cell_table.length === n * n) {
    for (const c of sessionInfo.cell_table) table.set(c.cell, c);
  } else {
    const onSet = new Set(onPatternCells());
    const centre = config.grid.centre_cell_index;
    const mid = (n * size) / 2;
    for (let cell = 0; cell < n * n; cell++) {
      const row = Math.floor(cell / n);
      const col = cell % n;
      const x = col * size + size / 2 - mid;
      const y = row * size + size / 2 - mid;
      const radius = Math.hypot(x, y);
      table.set(cell, {
        cell,
        row,
        col,
        x_mm: r3(x),
        y_mm: r3(y),
        radius_mm: r3(radius),
        radius_cells: r3(radius / size),
        pattern_label: cell === centre ? 'centre' : onSet.has(cell) ? 'on' : 'off',
      });
    }
  }
  return {
    cell: (c) => table.get(c) ?? null,
    screen(c, rotationDeg) {
      const g = table.get(c);
      if (!g) return { x_mm: null, y_mm: null };
      const a = ((rotationDeg ?? 0) * Math.PI) / 180;
      return {
        x_mm: r3(g.x_mm * Math.cos(a) - g.y_mm * Math.sin(a)),
        y_mm: r3(g.x_mm * Math.sin(a) + g.y_mm * Math.cos(a)),
      };
    },
  };
}

const dist = (a, b) => Math.hypot(a.x_mm - b.x_mm, a.y_mm - b.y_mm);

/* ---------------- row ordering and windows ---------------- */

function chronological(rows) {
  const idx = rows.map((r, i) => [r, i]);
  const hasSeq = rows.every((r) => Number.isFinite(r.seq));
  idx.sort((a, b) => (hasSeq ? a[0].seq - b[0].seq : 0) || a[1] - b[1]);
  return idx.map(([r]) => r);
}

/**
 * Split a participant's rows into trial windows. A window opens at a
 * trial-start gate and takes the rows of its condition (and the pattern
 * phase that follows the gate) until the next gate.
 */
export function segmentTrials(rows) {
  const windows = [];
  let cur = null;
  let restSeen = false;
  for (const r of chronological(rows)) {
    const ph = r.phase;
    if (typeof ph !== 'string') continue;
    const gate = GATE_RE.exec(ph);
    if (gate) {
      cur = {
        condition: gate[1],
        gate: r,
        encoding: null,
        stars: [],
        probes: [],
        patternPhase: false,
        restBefore: restSeen,
        rows: [r],
      };
      restSeen = false;
      windows.push(cur);
      continue;
    }
    if (ph === 'rest' || ph === 'rest_resume_gate') {
      restSeen = true;
      continue;
    }
    if (!cur) continue;
    if (ph === 'pattern_phase') {
      cur.patternPhase = true;
      continue;
    }
    const m = PHASE_RE.exec(ph);
    if (!m || m[1] !== cur.condition) continue;
    cur.rows.push(r);
    if (m[2] === 'encoding') cur.encoding = r;
    else if (m[2] === 'star') cur.stars.push(r);
    else if (m[2] === 'probe') cur.probes.push(r);
  }
  return windows;
}

/* ---------------- plan of a trial ---------------- */

function planOf(w) {
  const spec = w.encoding?.trial_spec;
  if (spec && Array.isArray(spec.memory_items)) return { ...spec, from_spec: true };
  return { from_spec: false };
}

/* ---------------- columns ---------------- */

const SESSION_COLS = [
  'build_id',
  'schema_version',
  'px_per_mm',
  'cell_size_mm',
  'prng_seed_uint32',
];

export const TRIALS_COLUMNS = [
  'participant_id',
  'trial_seq_session',
  'trial_uid',
  'attempt',
  'condition',
  'block_label',
  'is_practice',
  'presentation_index',
  'presentation_index_stamped',
  'block_position',
  'pool_index',
  'rotation_deg',
  'rotation_abs_deg',
  'rotation_sign',
  'rotation_stratum',
  'background_shade',
  'sequence',
  'n_stars_planned',
  'n_star_rows',
  'n_probes_planned',
  'n_probe_rows',
  'pattern_phase_before_trial',
  'trials_since_pattern_phase',
  'rest_before_trial',
  'trial_has_stars',
  'n_stars_correct',
  'n_stars_incorrect',
  'n_stars_no_response',
  'n_stars_anticipatory',
  'n_stars_missing_row',
  'trial_star_excluded',
  'n_probes_correct',
  'n_probes_no_response',
  'n_probes_anticipatory',
  'n_probes_missing_row',
  'encoding_onset_ts_ms',
  'plan_source',
  ...SESSION_COLS,
];

export const STARS_COLUMNS = [
  'participant_id',
  'trial_seq_session',
  'star_serial_position',
  'trial_uid',
  'attempt',
  'condition',
  'block_label',
  'is_practice',
  'presentation_index',
  'pool_index',
  'rotation_deg',
  'rotation_sign',
  'rotation_stratum',
  'background_shade',
  'sequence',
  'slot',
  'cell',
  'cell_row',
  'cell_col',
  'cell_x_mm',
  'cell_y_mm',
  'x_mm',
  'y_mm',
  'radius_mm',
  'radius_cells',
  'pattern_label',
  'is_on_pattern',
  'row_recorded',
  'responded',
  'said_on',
  'star_correct',
  'rt_ms',
  'response_key',
  'excluded_anticipatory',
  'star_onset_ms',
  'trial_star_excluded',
  'position_matches_runtime',
  'px_per_mm',
  'build_id',
];

export const PROBES_COLUMNS = [
  'participant_id',
  'trial_seq_session',
  'probe_position',
  'trial_uid',
  'attempt',
  'condition',
  'block_label',
  'is_practice',
  'presentation_index',
  'pool_index',
  'rotation_deg',
  'background_shade',
  'sequence',
  'modality',
  'probe_type',
  'is_target',
  'pattern_label',
  'cell',
  'cell_row',
  'cell_col',
  'cell_x_mm',
  'cell_y_mm',
  'probe_frame_rotation_deg',
  'x_mm',
  'y_mm',
  'radius_mm',
  'radius_cells',
  'encoding_position',
  'target_slot',
  'enc1_cell',
  'enc1_pattern_label',
  'enc1_x_mm',
  'enc1_y_mm',
  'enc2_cell',
  'enc2_pattern_label',
  'enc2_x_mm',
  'enc2_y_mm',
  'enc3_cell',
  'enc3_pattern_label',
  'enc3_x_mm',
  'enc3_y_mm',
  'min_enc_dist_mm',
  'nearest_enc_position',
  'own_enc_dist_mm',
  'tone_index',
  'tone_freq_hz',
  'min_tone_rank_gap',
  'row_recorded',
  'responded',
  'said_yes',
  'probe_correct',
  'rt_ms',
  'response_key',
  'excluded_anticipatory',
  'probe_onset_ms',
  'trial_star_excluded',
  'position_matches_runtime',
  'px_per_mm',
  'build_id',
];

/** Column documentation, used to generate schemas/tidy-tables.schema.json. */
export const COLUMN_DOCS = {
  participant_id: 'Prolific participant id.',
  trial_seq_session:
    'Running number of trial-start gates in the session (practice included), in presentation order. Unique per participant.',
  trial_uid:
    'Trial name from the runtime, e.g. main_a-007-i_d. Unique for main trials; practice names repeat when a practice pass is repeated.',
  attempt:
    'Pass number of the trial: 1 for main trials, 1 or 2 for practice trials (practice can run twice).',
  condition: 'd_only, t_only, i_only, i_d or i_t.',
  block_label: 'practice, main_a or main_b.',
  is_practice: 'True for practice trials.',
  presentation_index:
    '1-120 over the main task in presentation order; empty in practice. Counted by the exporter.',
  presentation_index_stamped:
    'Value written by the runtime, for comparison with presentation_index.',
  block_position: '0-based position in the block.',
  pool_index:
    'Index of the trial in the condition pool of 24 (trial_index_in_block of the raw rows). Not unique across conditions.',
  rotation_deg:
    'Rotation of the grid for the trial, -90..90, clockwise positive: the angle imagined in the imagery conditions and the angle the grid is shown at in d_only. Empty for t_only.',
  rotation_abs_deg: 'Absolute rotation.',
  rotation_sign: '-1 counter-clockwise, 1 clockwise.',
  rotation_stratum:
    'Index 1-6 of the 30-degree stratum the angle was drawn from (-90..-61 = 1 ... 61..90 = 6).',
  background_shade: 'white or gray.',
  sequence: 'Six-slot sequence, M = memory-item slot, S = star slot.',
  n_stars_planned: 'Stars planned for the trial (3 in imagery conditions, 0 otherwise).',
  n_star_rows: 'Star rows recorded.',
  n_probes_planned: 'Recognition probes planned (3 in memory conditions, 0 otherwise).',
  n_probe_rows: 'Probe rows recorded.',
  pattern_phase_before_trial: 'True if the pattern reminder was shown at the start of this trial.',
  trials_since_pattern_phase:
    'Trials since the last pattern reminder (0 when this trial had one); empty before the first.',
  rest_before_trial: 'True if a rest screen came directly before this trial.',
  trial_has_stars: 'True for conditions that contain stars.',
  n_stars_correct: 'Stars answered correctly.',
  n_stars_incorrect: 'Stars answered incorrectly.',
  n_stars_no_response: 'Stars with no response (recorded rows only).',
  n_stars_anticipatory: 'Stars answered faster than 250 ms.',
  n_stars_missing_row: 'Planned stars with no recorded row.',
  trial_star_excluded:
    'True if any planned star of the trial was incorrect, unanswered, answered faster than 250 ms, or has no recorded row. False for conditions without stars. Computed per trial, so it cannot collide across conditions.',
  n_probes_correct: 'Probes answered correctly.',
  n_probes_no_response: 'Probes with no response (recorded rows only).',
  n_probes_anticipatory: 'Probes answered faster than 250 ms.',
  n_probes_missing_row: 'Planned probes with no recorded row.',
  encoding_onset_ts_ms: 'performance.now() at encoding onset (ms).',
  plan_source: 'trial_spec when the runtime plan was recorded on the encoding row; null otherwise.',
  build_id: 'Build identifier.',
  schema_version: 'Schema version.',
  px_per_mm: 'Pixels per mm from the card calibration.',
  cell_size_mm: 'Cell size, mm.',
  prng_seed_uint32: 'Seed of the schedule.',
  star_serial_position: 'Star number within the trial, 1-3, in order of presentation.',
  slot: 'Slot of the event in the six-slot sequence, 1-6.',
  cell: 'Cell index 0-24, row-major; 12 is the centre.',
  cell_row: 'Row of the cell, 0-4.',
  cell_col: 'Column of the cell, 0-4.',
  cell_x_mm: 'Cell centre x in the upright grid, mm from fixation.',
  cell_y_mm: 'Cell centre y in the upright grid, mm from fixation (down positive).',
  x_mm: 'Screen x of the stimulus after rotation, mm from fixation. Empty for tones.',
  y_mm: 'Screen y of the stimulus after rotation, mm from fixation (down positive). Empty for tones.',
  radius_mm: 'Distance of the cell centre from fixation, mm.',
  radius_cells: 'Same distance in cell widths.',
  pattern_label: 'on or off the 12-cell pattern.',
  is_on_pattern: 'True if the cell is on the pattern.',
  row_recorded: 'False if the planned event has no row in the data.',
  responded: 'True if a valid key was pressed in the window.',
  said_on: 'True if the participant answered on-pattern.',
  star_correct: 'Correct star response.',
  rt_ms: 'Response time, ms from stimulus onset.',
  response_key: 'Key pressed.',
  excluded_anticipatory: 'True if rt_ms < 250.',
  star_onset_ms: 'Star onset relative to encoding onset, ms.',
  position_matches_runtime:
    'True if the exporter position equals the position logged at runtime; empty if none was logged.',
  probe_position: 'Probe number within the trial, 1-3.',
  modality: 'dot (visual probe) or tone (auditory probe).',
  probe_type: 'T_on, T_off, F_on or F_off.',
  is_target: 'True if the probe matches an encoded item.',
  probe_frame_rotation_deg: 'Rotation of the frame the probe was drawn in (0 = upright).',
  encoding_position:
    'Encoding position 1-3 tied to the probe. For a foil it is a design label only.',
  target_slot: 'Slot (1-6) of the probed item; empty for foils.',
  enc1_cell: 'Cell of the item encoded first.',
  enc1_pattern_label: 'on or off label of the first item.',
  enc1_x_mm: 'Screen x of the first encoded dot (rotated), mm. Dot conditions only.',
  enc1_y_mm: 'Screen y of the first encoded dot (rotated), mm.',
  enc2_cell: 'Cell of the item encoded second.',
  enc2_pattern_label: 'on or off label of the second item.',
  enc2_x_mm: 'Screen x of the second encoded dot, mm.',
  enc2_y_mm: 'Screen y of the second encoded dot, mm.',
  enc3_cell: 'Cell of the item encoded third.',
  enc3_pattern_label: 'on or off label of the third item.',
  enc3_x_mm: 'Screen x of the third encoded dot, mm.',
  enc3_y_mm: 'Screen y of the third encoded dot, mm.',
  min_enc_dist_mm:
    'Smallest distance between the probe screen position and the screen positions of the encoded dots, mm. Dot conditions only.',
  nearest_enc_position:
    'Encoding position (1-3) of the encoded dot nearest to the probe on screen.',
  own_enc_dist_mm:
    'For a target: distance between the probe and its own encoded dot on screen, mm (0 when the probe frame and encoding frame have the same rotation).',
  tone_index: 'Index 0-23 of the probe tone. Tone conditions only.',
  tone_freq_hz: 'Frequency of the probe tone, Hz.',
  min_tone_rank_gap: 'Smallest rank distance between the probe tone and the encoded tones.',
  said_yes: 'True if the participant answered yes.',
  probe_correct: 'Correct probe response.',
  probe_onset_ms: 'Probe onset relative to encoding onset, ms.',
};

/* ---------------- builders ---------------- */

function rtOf(row) {
  if (Number.isFinite(row?.response_rt_ms)) return row.response_rt_ms;
  if (Number.isFinite(row?.rt)) return row.rt;
  return null;
}

function keyOf(row) {
  if (typeof row?.response_key === 'string' && row.response_key) return row.response_key;
  if (typeof row?.response === 'string' && row.response) return row.response;
  return null;
}

function rel(ts, t0) {
  return Number.isFinite(ts) && Number.isFinite(t0) ? Math.round(ts - t0) : null;
}

const STRATA = [
  [-90, -61],
  [-60, -31],
  [-30, -1],
  [1, 30],
  [31, 60],
  [61, 90],
];
function stratumOf(angle) {
  if (!Number.isFinite(angle)) return null;
  const i = STRATA.findIndex(([lo, hi]) => angle >= lo && angle <= hi);
  return i < 0 ? null : i + 1;
}

export function buildTidyForParticipant(participantId, rows, sessionMeta = {}) {
  const trials = [];
  const stars = [];
  const probes = [];
  const issues = [];

  const info = rows.find((r) => r.phase === 'session_info') ?? null;
  const calib =
    [...rows].reverse().find((r) => r.phase === 'screen_calibration_outcome')?.value ?? null;
  const geom = buildGeometry(info);
  const session = {
    build_id: info?.build_id ?? sessionMeta.build_id ?? null,
    schema_version: info?.schema_version ?? sessionMeta.schema_version ?? null,
    px_per_mm: info?.px_per_mm ?? calib?.px_per_mm ?? null,
    cell_size_mm: info?.cell_size_mm ?? config.grid.cell_size_mm,
    prng_seed_uint32: info?.prng_seed_uint32 ?? sessionMeta.prng_seed_uint32 ?? null,
  };

  if (!rows.every((r) => Number.isFinite(r.seq))) {
    issues.push({
      participant_id: participantId,
      trial_seq_session: null,
      issue: 'rows_without_seq_order_not_guaranteed',
    });
  }

  const windows = segmentTrials(rows);
  const attempts = new Map();
  let mainCount = 0;
  let sinceReminder = null;

  windows.forEach((w, wi) => {
    const gate = w.gate;
    const cond = w.condition;
    const block = gate.block_label ?? w.encoding?.block_label ?? null;
    const isPractice = block === 'practice';
    const poolIndex = Number.isInteger(gate.pool_index)
      ? gate.pool_index
      : (gate.trial_index_in_block ?? null);
    if (!isPractice) mainCount += 1;
    const presentation = isPractice ? null : mainCount;
    const stamped = Number.isInteger(gate.presentation_index) ? gate.presentation_index : null;
    if (!isPractice && stamped !== null && stamped !== presentation) {
      issues.push({
        participant_id: participantId,
        trial_seq_session: wi + 1,
        issue: 'presentation_index_mismatch',
      });
    }
    const uid =
      gate.trial_uid ??
      (isPractice
        ? `practice-${cond}-${pad((poolIndex ?? 0) + 1, 2)}`
        : `${block}-${pad(presentation, 3)}-${cond}`);
    const attemptKey = `${uid}`;
    const attempt = (attempts.get(attemptKey) ?? 0) + 1;
    attempts.set(attemptKey, attempt);
    if (!isPractice && attempt > 1) {
      issues.push({
        participant_id: participantId,
        trial_seq_session: wi + 1,
        issue: 'duplicate_main_trial_uid',
      });
    }

    const plan = planOf(w);
    const rotation =
      [
        plan.rotation_deg,
        w.gate.rotation_deg,
        plan.display_rotation_deg,
        w.encoding?.display_rotation_deg,
      ].find(Number.isFinite) ?? null;
    const t0 = w.encoding?.encoding_onset_ts_ms;
    const shade = gate.background_shade ?? w.encoding?.background_shade ?? null;
    const sequence = plan.sequence ?? w.encoding?.sequence ?? null;
    const seqNo = wi + 1;

    if (w.patternPhase) sinceReminder = 0;
    else if (sinceReminder !== null) sinceReminder += 1;

    const base = {
      participant_id: participantId,
      trial_seq_session: seqNo,
      trial_uid: uid,
      attempt,
      condition: cond,
      block_label: block,
      is_practice: isPractice,
      presentation_index: presentation,
      pool_index: poolIndex,
      rotation_deg: rotation,
      background_shade: shade,
      sequence,
    };

    /* ---- stars ---- */
    const starRowBySlot = new Map();
    for (const r of w.stars)
      if (Number.isInteger(r.slot_index_in_seq)) starRowBySlot.set(r.slot_index_in_seq, r);
    const plannedStars = HAS_STARS.has(cond) ? (plan.stars ?? []) : [];
    const starRecords = plannedStars.map((ps, i) => {
      const row = starRowBySlot.get(ps.slot) ?? null;
      const g = geom.cell(ps.cell);
      const pos = geom.screen(ps.cell, rotation ?? 0);
      const rt = rtOf(row);
      const responded = row ? row.responded === true : null;
      const rec = {
        ...base,
        star_serial_position: Number.isInteger(ps.probe_position) ? ps.probe_position + 1 : i + 1,
        slot: ps.slot + 1,
        cell: ps.cell,
        cell_row: g?.row ?? null,
        cell_col: g?.col ?? null,
        cell_x_mm: g?.x_mm ?? null,
        cell_y_mm: g?.y_mm ?? null,
        x_mm: pos.x_mm,
        y_mm: pos.y_mm,
        radius_mm: g?.radius_mm ?? null,
        radius_cells: g?.radius_cells ?? null,
        pattern_label: ps.pattern_label ?? g?.pattern_label ?? null,
        is_on_pattern: (ps.pattern_label ?? g?.pattern_label) === 'on',
        row_recorded: row !== null,
        responded,
        said_on: row ? (row.said_on ?? null) : null,
        star_correct: row ? row.star_correct === true : null,
        rt_ms: rt,
        response_key: keyOf(row),
        excluded_anticipatory: row ? responded === true && rt !== null && rt < RT_FLOOR_MS : null,
        star_onset_ms: rel(row?.star_onset_ts_ms, t0),
        position_matches_runtime:
          row && Number.isFinite(row.star_x_mm)
            ? Math.abs(row.star_x_mm - pos.x_mm) < 0.01 && Math.abs(row.star_y_mm - pos.y_mm) < 0.01
            : null,
        px_per_mm: session.px_per_mm,
        build_id: session.build_id,
      };
      return rec;
    });
    const starBad = (s) =>
      !s.row_recorded ||
      s.responded !== true ||
      s.rt_ms === null ||
      s.rt_ms < RT_FLOOR_MS ||
      s.star_correct !== true;
    const trialStarExcluded = starRecords.some(starBad);
    starRecords.forEach((s) => {
      s.rotation_sign = Number.isFinite(rotation) ? Math.sign(rotation) : null;
      s.rotation_stratum = stratumOf(rotation);
      s.trial_star_excluded = trialStarExcluded;
      stars.push(s);
    });

    /* ---- probes ---- */
    const probeRowByPos = new Map();
    for (const r of w.probes)
      if (Number.isInteger(r.probe_position)) probeRowByPos.set(r.probe_position, r);
    /* Data from before `trial_spec` existed: rebuild the probe list from the
     * rows that were recorded. */
    const rowProbes = w.probes.map((r) => ({
      probe_position: r.probe_position,
      encoding_position: r.encoding_position ?? null,
      type: r.probe_type,
      cell: r.probed_cell,
      is_target: r.is_target,
      pattern_label: r.probe_pattern_label,
    }));
    const plannedProbes = HAS_PROBES.has(cond) ? (plan.probes ?? rowProbes) : [];
    const isTone = TONE_CONDITIONS.has(cond);
    const items = [...(plan.memory_items ?? [])].sort((a, b) => a.slot - b.slot);
    const itemScreen = items.map((m) => ({
      ...geom.screen(m.cell, rotation ?? 0),
      cell: m.cell,
      slot: m.slot,
      label: m.pattern_label,
    }));
    const itemTones = isTone ? items.map((m) => toneForCell(m.cell)) : [];
    const probeRecords = plannedProbes.map((pp) => {
      const row = probeRowByPos.get(pp.probe_position) ?? null;
      const g = geom.cell(pp.cell);
      const frameRot = Number.isFinite(row?.probe_frame_rotation_deg)
        ? row.probe_frame_rotation_deg
        : 0;
      const pos = isTone ? { x_mm: null, y_mm: null } : geom.screen(pp.cell, frameRot);
      const rt = rtOf(row);
      const responded = row ? row.responded === true : null;
      const rec = {
        ...base,
        probe_position: pp.probe_position + 1,
        modality: isTone ? 'tone' : 'dot',
        probe_type: pp.type,
        is_target: pp.is_target,
        pattern_label: pp.pattern_label,
        cell: pp.cell,
        cell_row: g?.row ?? null,
        cell_col: g?.col ?? null,
        cell_x_mm: g?.x_mm ?? null,
        cell_y_mm: g?.y_mm ?? null,
        probe_frame_rotation_deg: frameRot,
        x_mm: pos.x_mm,
        y_mm: pos.y_mm,
        radius_mm: g?.radius_mm ?? null,
        radius_cells: g?.radius_cells ?? null,
        encoding_position: Number.isInteger(pp.encoding_position) ? pp.encoding_position + 1 : null,
        target_slot: null,
        row_recorded: row !== null,
        responded,
        said_yes: row ? (row.said_yes ?? null) : null,
        probe_correct: row ? row.probe_correct === true : null,
        rt_ms: rt,
        response_key: keyOf(row),
        excluded_anticipatory: row ? responded === true && rt !== null && rt < RT_FLOOR_MS : null,
        probe_onset_ms: rel(row?.probe_onset_ts_ms, t0),
        trial_star_excluded: trialStarExcluded,
        position_matches_runtime:
          row && Number.isFinite(row.probe_x_mm) && pos.x_mm !== null
            ? Math.abs(row.probe_x_mm - pos.x_mm) < 0.01 &&
              Math.abs(row.probe_y_mm - pos.y_mm) < 0.01
            : null,
        px_per_mm: session.px_per_mm,
        build_id: session.build_id,
      };
      items.forEach((m, k) => {
        rec[`enc${k + 1}_cell`] = m.cell;
        rec[`enc${k + 1}_pattern_label`] = m.pattern_label;
        rec[`enc${k + 1}_x_mm`] = isTone ? null : itemScreen[k].x_mm;
        rec[`enc${k + 1}_y_mm`] = isTone ? null : itemScreen[k].y_mm;
      });
      if (pp.is_target) {
        const own = items.findIndex((m) => m.cell === pp.cell);
        if (own >= 0) {
          rec.target_slot = items[own].slot + 1;
          if (!isTone) rec.own_enc_dist_mm = r3(dist(pos, itemScreen[own]));
        }
      }
      if (!isTone && itemScreen.length) {
        const ds = itemScreen.map((p) => dist(pos, p));
        const k = ds.indexOf(Math.min(...ds));
        rec.min_enc_dist_mm = r3(ds[k]);
        rec.nearest_enc_position = k + 1;
      }
      if (isTone) {
        const t = toneForCell(pp.cell);
        rec.tone_index = t.index;
        rec.tone_freq_hz = t.freq_hz;
        const gaps = itemTones
          .filter((x, k) => items[k].cell !== pp.cell)
          .map((x) => Math.abs(x.rank - t.rank));
        rec.min_tone_rank_gap = gaps.length ? Math.min(...gaps) : null;
      }
      return rec;
    });
    probeRecords.forEach((p) => {
      p.rotation_deg = rotation;
      probes.push(p);
    });

    const cnt = (arr, f) => arr.filter(f).length;
    trials.push({
      ...base,
      presentation_index_stamped: stamped,
      block_position: Number.isInteger(gate.block_position) ? gate.block_position : null,
      rotation_abs_deg: Number.isFinite(rotation) ? Math.abs(rotation) : null,
      rotation_sign: Number.isFinite(rotation) ? Math.sign(rotation) : null,
      rotation_stratum: stratumOf(rotation),
      n_stars_planned: plannedStars.length,
      n_star_rows: w.stars.length,
      n_probes_planned: plannedProbes.length,
      n_probe_rows: w.probes.length,
      pattern_phase_before_trial: w.patternPhase,
      trials_since_pattern_phase: sinceReminder,
      rest_before_trial: w.restBefore,
      trial_has_stars: HAS_STARS.has(cond),
      n_stars_correct: cnt(starRecords, (s) => s.star_correct === true),
      n_stars_incorrect: cnt(
        starRecords,
        (s) => s.row_recorded && s.responded === true && s.star_correct === false
      ),
      n_stars_no_response: cnt(starRecords, (s) => s.row_recorded && s.responded !== true),
      n_stars_anticipatory: cnt(starRecords, (s) => s.excluded_anticipatory === true),
      n_stars_missing_row: cnt(starRecords, (s) => !s.row_recorded),
      trial_star_excluded: trialStarExcluded,
      n_probes_correct: cnt(probeRecords, (p) => p.probe_correct === true),
      n_probes_no_response: cnt(probeRecords, (p) => p.row_recorded && p.responded !== true),
      n_probes_anticipatory: cnt(probeRecords, (p) => p.excluded_anticipatory === true),
      n_probes_missing_row: cnt(probeRecords, (p) => !p.row_recorded),
      encoding_onset_ts_ms: Number.isFinite(t0) ? t0 : null,
      plan_source: plan.from_spec ? 'trial_spec' : null,
      ...session,
    });
    if (plannedStars.length === 0 && w.stars.length > 0) {
      issues.push({
        participant_id: participantId,
        trial_seq_session: seqNo,
        issue: 'star_rows_without_plan',
      });
    }
  });

  return { trials, stars, probes, issues };
}

export function composeTidyTables(perParticipant) {
  const out = { trials: [], stars: [], probes: [], issues: [] };
  for (const p of perParticipant) {
    const t = buildTidyForParticipant(p.participant_id, p.rows ?? [], p.session ?? {});
    out.trials.push(...t.trials);
    out.stars.push(...t.stars);
    out.probes.push(...t.probes);
    out.issues.push(...t.issues);
  }
  return out;
}

/** Check that the keys are unique; returns the list of duplicated keys. */
export function duplicateKeys(rows, keyFields) {
  const seen = new Set();
  const dup = [];
  for (const r of rows) {
    const k = keyFields.map((f) => String(r[f])).join('|');
    if (seen.has(k)) dup.push(k);
    seen.add(k);
  }
  return dup;
}

export const TIDY_KEYS = {
  trials: ['participant_id', 'trial_seq_session'],
  stars: ['participant_id', 'trial_seq_session', 'star_serial_position'],
  probes: ['participant_id', 'trial_seq_session', 'probe_position'],
};

/* Column types for the schema file. Anything not listed is a string. */
const INTEGER_COLUMNS = new Set([
  'trial_seq_session',
  'attempt',
  'presentation_index',
  'presentation_index_stamped',
  'block_position',
  'pool_index',
  'rotation_deg',
  'rotation_abs_deg',
  'rotation_sign',
  'rotation_stratum',
  'n_stars_planned',
  'n_star_rows',
  'n_probes_planned',
  'n_probe_rows',
  'trials_since_pattern_phase',
  'n_stars_correct',
  'n_stars_incorrect',
  'n_stars_no_response',
  'n_stars_anticipatory',
  'n_stars_missing_row',
  'n_probes_correct',
  'n_probes_no_response',
  'n_probes_anticipatory',
  'n_probes_missing_row',
  'encoding_onset_ts_ms',
  'prng_seed_uint32',
  'star_serial_position',
  'slot',
  'cell',
  'cell_row',
  'cell_col',
  'probe_position',
  'probe_frame_rotation_deg',
  'encoding_position',
  'target_slot',
  'enc1_cell',
  'enc2_cell',
  'enc3_cell',
  'nearest_enc_position',
  'tone_index',
  'min_tone_rank_gap',
  'rt_ms',
  'star_onset_ms',
  'probe_onset_ms',
]);
const NUMBER_COLUMNS = new Set([
  'px_per_mm',
  'cell_size_mm',
  'cell_x_mm',
  'cell_y_mm',
  'x_mm',
  'y_mm',
  'radius_mm',
  'radius_cells',
  'enc1_x_mm',
  'enc1_y_mm',
  'enc2_x_mm',
  'enc2_y_mm',
  'enc3_x_mm',
  'enc3_y_mm',
  'min_enc_dist_mm',
  'own_enc_dist_mm',
  'tone_freq_hz',
]);
const BOOLEAN_COLUMNS = new Set([
  'is_practice',
  'pattern_phase_before_trial',
  'rest_before_trial',
  'trial_has_stars',
  'trial_star_excluded',
  'is_on_pattern',
  'row_recorded',
  'responded',
  'said_on',
  'star_correct',
  'excluded_anticipatory',
  'position_matches_runtime',
  'is_target',
  'said_yes',
  'probe_correct',
]);

function columnSchema(name) {
  const type = INTEGER_COLUMNS.has(name)
    ? 'integer'
    : NUMBER_COLUMNS.has(name)
      ? 'number'
      : BOOLEAN_COLUMNS.has(name)
        ? 'boolean'
        : 'string';
  return { type: [type, 'null'], description: COLUMN_DOCS[name] ?? '' };
}

/** JSON Schema (draft 2020-12) of one row of each exported tidy table. */
export function buildTidySchema() {
  const table = (title, columns, key) => ({
    title,
    description: `One row per ${title.replace(/ row$/, '')}. Unique key: ${key.join(', ')}. Missing values are NA in the CSV.`,
    type: 'object',
    required: key,
    additionalProperties: false,
    properties: Object.fromEntries(columns.map((c) => [c, columnSchema(c)])),
  });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Tidy tables - WM x Imagery follow-up experiment',
    description:
      'Rows of trials.csv, stars.csv and probes.csv written by scripts/csv-export.js (generator scripts/tidy-tables.js). Positions are in mm in the fixed grid frame: origin at fixation, x right, y down; x_mm / y_mm are after rotation, cell_x_mm / cell_y_mm are in the upright grid.',
    version: TIDY_VERSION,
    $defs: {
      trial: table('trial row', TRIALS_COLUMNS, TIDY_KEYS.trials),
      star: table('star row', STARS_COLUMNS, TIDY_KEYS.stars),
      probe: table('probe row', PROBES_COLUMNS, TIDY_KEYS.probes),
    },
  };
}
