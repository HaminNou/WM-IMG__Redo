/**
 * One `session_info` row per session, written after calibration and before
 * the main task. It holds everything that is fixed for the session so the
 * trial rows do not have to repeat it: seed, build, calibration and the
 * stimulus geometry (a table of all 25 cells with position, distance from
 * fixation and on/off label).
 */
import { config } from './config.js';
import { BUILD_COMMIT, BUILD_TIME } from './build-info.js';
import { getToneBank } from './audio/tones.js';
import { DEFAULT_PEAK } from './audio/dsp.js';
import { cellGeometry, totalCells, gridSizeMm, onPatternCells } from './grid.js';
import { ROTATION_STRATA } from './scheduler/rotation-balance.js';

const PRNG_ALGORITHM = 'xmur3+mulberry32';

const r3 = (x) => Math.round(x * 1000) / 1000;

function cellTable() {
  const out = [];
  for (let c = 0; c < totalCells(); c++) {
    const g = cellGeometry(c);
    out.push({
      cell: c,
      row: g.row,
      col: g.col,
      x_mm: r3(g.x_mm),
      y_mm: r3(g.y_mm),
      radius_mm: r3(g.radius_mm),
      radius_cells: r3(g.radius_cells),
      pattern_label: g.pattern_label,
    });
  }
  return out;
}

/** Parameters of the tone bank as played, so the stimulus can be rebuilt from the data. */
function toneParams() {
  return {
    peak_amplitude: DEFAULT_PEAK,
    duration_ms: config.tones.duration_ms,
    cosine_ramp_ms: config.tones.cosine_ramp_ms,
    bank: getToneBank().map((t) => ({
      index: t.index,
      freq_hz: t.freq_hz,
      gain_compensation_db: r3(t.gain_compensation_db),
      pattern_label: t.pattern_label,
      paired_cell: t.paired_cell,
    })),
  };
}

/**
 * @param {object} session      object returned by `initSession()`
 * @param {object|null} calibration  `value` of the last `screen_calibration_outcome` row, if any
 * @param {object} [env]        browser measurements (injectable for tests): screen and window
 *                              size, `clock_anchor`, `audio_context`, `content_hashes`
 */
export function buildSessionInfo(session, calibration, env = {}) {
  return {
    phase: 'session_info',
    session_id: session.params.session_id ?? null,
    prolific_pid: session.params.prolific_pid ?? null,
    study_id: session.params.study_id ?? null,
    is_preview: session.params.is_preview === true,
    is_pilot_run: session.is_pilot_run === true,
    pilot_label: session.pilot_label ?? null,
    prng_algorithm: PRNG_ALGORITHM,
    prng_seed_string: session.seed_string ?? null,
    prng_seed_uint32: session.prng_seed_uint32 ?? null,
    build_id: session.build_id ?? config.build_id,
    build_commit: BUILD_COMMIT,
    build_time: BUILD_TIME,
    consent_text_sha256: env.content_hashes?.consent_text_sha256 ?? null,
    instruction_deck_sha256: env.content_hashes?.instruction_deck_sha256 ?? null,
    strategy_items_sha256: env.content_hashes?.strategy_items_sha256 ?? null,
    music_items_sha256: env.content_hashes?.music_items_sha256 ?? null,
    schema_version: session.schema_version ?? config.schema_version,
    started_at_iso: session.started_at_iso ?? null,
    clock_anchor: env.clock_anchor ?? null,
    user_agent: session.user_agent ?? env.user_agent ?? null,
    px_per_mm: calibration?.px_per_mm ?? null,
    cc_px_width: calibration?.cc_px_width ?? null,
    px_per_mm_in_bounds: calibration?.px_per_mm_in_bounds ?? null,
    screen_width_px: env.screen_width_px ?? null,
    screen_height_px: env.screen_height_px ?? null,
    inner_width_px: env.inner_width_px ?? null,
    inner_height_px: env.inner_height_px ?? null,
    device_pixel_ratio: env.device_pixel_ratio ?? null,
    audio_context: env.audio_context ?? null,
    tone_params: toneParams(),
    grid_cells_per_side: config.grid.cells_per_side,
    cell_size_mm: config.grid.cell_size_mm,
    grid_size_mm: gridSizeMm(),
    dot_diameter_mm: config.memory.dot_diameter_mm,
    star_size_mm: config.imagery.star_size_mm,
    open_square_size_mm: config.dummies.open_square_size_mm,
    on_pattern_cells: Array.from(onPatternCells()),
    rotation_min_deg: config.grid.rotation_min_deg,
    rotation_max_deg: config.grid.rotation_max_deg,
    rotation_strata: ROTATION_STRATA.map((s) => Array.from(s)),
    main_trials_per_condition: config.blocks.main_trials_per_type,
    cell_table: cellTable(),
  };
}
