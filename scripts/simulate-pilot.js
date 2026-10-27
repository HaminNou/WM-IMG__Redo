#!/usr/bin/env node
/**
 * Synthetic-pilot data generator.
 *
 * Drives the real schedulers (`generateMainBlockPair`) with a seeded PRNG and
 * synthesises a chunk-envelope-shaped JSON dump matching the runtime row
 * contract. The output is consumable by `scripts/csv-export.js` and
 * `scripts/pilot-summary.js` exactly as if it had come from a real session.
 *
 * Why this exists:
 *   csv-export.js and pilot-summary.js have unit tests that use hand-written
 *   fixtures. Those fixtures can drift from the actual runtime row shape and
 *   nobody notices until live data lands wrong. This simulator closes the
 *   loop: real schedulers produce real trial params, we synthesise plausible
 *   responses, and the resulting dump exercises the same code paths the
 *   pipelines use in production.
 *
 * What it does NOT model:
 *   - Plugin-level instrumentation (jsPsych internals like `time_elapsed`).
 *   - Real RT distributions (we use a coarse correctness-conditioned model;
 *     good enough for column-presence + criterion-filter checks).
 *   - Calibration / instructions / strategy / attention checks (those rows are
 *     stubbed minimally so CALIBRATION_SUMMARY.csv etc. emit a row).
 *
 * Usage:
 *   node scripts/simulate-pilot.js --seed alice --pid SIM_001 --out alice.json
 *   node scripts/simulate-pilot.js --seed alice                           # stdout
 *   node scripts/simulate-pilot.js --seed alice --pilot-label internal-qa
 *   node scripts/simulate-pilot.js --seed alice --accuracy 0.85 --out a.json
 *
 * Pure Node (>=20) — no browser deps. Imports from src/ are pure-data
 * modules: schedulers, PRNG, config; none of them touch `window` at module
 * top-level. (The `conditions/*.js` modules DO touch window via jsPsych
 * plugin imports, so we never import them here.)
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { setSessionPRNG, getSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';
import {
  encodingRecord,
  probeRenderFields,
  starRenderFields,
  postEncodingRotationDeg,
  probeFrameFields,
} from '../src/conditions/trial-record.js';
import { buildSessionInfo } from '../src/session-info.js';
import { toneForCell } from '../src/audio/tones.js';
import { config } from '../src/config.js';

/* The trial plan comes from `src/scheduler/main-plan.js`, the same pure
 * module `main-blocks.js` uses, so a seed gives the same trials, the same
 * order and the same identity fields here as in the browser. */

const GENERATOR_VERSION = '1.0.0';
const SCHEMA_VERSION = config.schema_version;
const BUILD_ID = config.build_id;

/* RT model — tunable via CLI but with sane defaults. Correct responses are
 * faster on average than incorrect ones (typical psychometric pattern); the
 * spread is wide enough that Criterion1 (rt < 250 ms) occasionally trips so
 * downstream filters are exercised. */
const DEFAULT_ACCURACY = 0.8;
const DEFAULT_RESPONSE_RATE = 0.97;
const RT_MEAN_CORRECT_MS = 950;
const RT_MEAN_INCORRECT_MS = 1250;
const RT_STDDEV_MS = 280;
const RT_FLOOR_OUTLIER_PROB = 0.01; /* probability of an anticipatory <250 ms */

/* Synthetic timing model — mirrors the design-locked slot/probe durations
 * (see the task specification and src/conditions/shared.js) so the simulator's emitted
 * `encoding_onset_ts_ms`, `slot_onsets_ts_ms`, `star_onset_ts_ms`, and
 * `probe_onset_ts_ms` are plausible. Values are not exactly the runtime
 * constants (we don't import shared.js — it pulls in jsPsych plugins that
 * touch `window`) but match the documented design durations. Downstream
 * exporter logic only inspects the absolute deltas, so any monotone schedule
 * exercises the new _OnsetMs columns. */
const SIM_M_SLOT_MS = 1500;
const SIM_S_SLOT_MS = 3500; /* star/dummy 3000 + 500 ms post-stimulus offset */
const SIM_ROTATION_PREAMBLE_MS = 1500; /* 500 ms rotation + 1000 ms stabilise */
const SIM_RETENTION_MS = 2000;
const SIM_PROBE_SLOT_MS = 3500; /* 3000 ms response window + 500 ms offset */
const SIM_INTER_TRIAL_MS = 1000;
const SIM_CLOCK_BASE_MS = 1_000_000; /* arbitrary non-zero base for relativity */

/* ---------- CLI argument parsing ---------- */

/**
 * Parse argv into a structured options bag for the simulator.
 * Recognised flags (all optional; sensible defaults applied):
 *   --seed <string>         PRNG seed (default: random)
 *   --pid <string>          Prolific PID to stamp on rows (default: SIM_<seed>)
 *   --pilot-label <string>  Pilot label (default: 'simulated')
 *   --accuracy <0..1>       Mean response accuracy (default: 0.8)
 *   --response-rate <0..1>  Probability the participant answers (default: 0.97)
 *   --out <path>            Write to file (default: stdout)
 *   --participants <N>      Emit N participants concatenated (default: 1)
 *   --calibration-inconsistent  Simulate a screen calibration accepted on the last attempt
 *                           with inconsistent settings (the pre-registered exclusion case)
 */
function parseSimulateArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const opts = {
    seed: null,
    pid: null,
    pilotLabel: 'simulated',
    accuracy: DEFAULT_ACCURACY,
    responseRate: DEFAULT_RESPONSE_RATE,
    out: null,
    participants: 1,
    calibration: 'ok',
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--seed') opts.seed = args[++i] ?? null;
    else if (a === '--pid') opts.pid = args[++i] ?? null;
    else if (a === '--pilot-label') opts.pilotLabel = args[++i] ?? null;
    else if (a === '--accuracy') opts.accuracy = parseFloat(args[++i]);
    else if (a === '--response-rate') opts.responseRate = parseFloat(args[++i]);
    else if (a === '--out') opts.out = args[++i] ?? null;
    else if (a === '--participants') opts.participants = parseInt(args[++i], 10);
    else if (a === '--calibration-inconsistent') opts.calibration = 'inconsistent_accepted';
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
  }
  if (!Number.isFinite(opts.accuracy) || opts.accuracy < 0 || opts.accuracy > 1) {
    throw new Error(`--accuracy must be in [0, 1]; got ${opts.accuracy}`);
  }
  if (!Number.isFinite(opts.responseRate) || opts.responseRate < 0 || opts.responseRate > 1) {
    throw new Error(`--response-rate must be in [0, 1]; got ${opts.responseRate}`);
  }
  if (!Number.isInteger(opts.participants) || opts.participants < 1) {
    throw new Error(`--participants must be a positive integer; got ${opts.participants}`);
  }
  return opts;
}

/* ---------- Simulated response model ---------- */

/* Box-Muller normal sample. We get one usable normal per call (simpler than
 * caching the second; the simulator runs once per CLI invocation). */
function gaussian(rng) {
  const u1 = Math.max(rng.next(), 1e-9);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Sample one (responded, correct, rt) triple given the trial's ground truth.
 *
 * - With probability `responseRate`, the participant responds; otherwise
 *   responded=false, rt=null.
 * - When responding, with probability `accuracy` the answer is correct.
 * - RT is gaussian(mean | correct?) + occasional anticipatory outliers
 *   (rt < RT_FLOOR_MS) to exercise Criterion1's filter. Negatives are
 *   clamped to 100 ms.
 */
function sampleResponse(rng, opts) {
  const responded = rng.next() < opts.responseRate;
  if (!responded) return { responded: false, correct: null, rt_ms: null };
  const correct = rng.next() < opts.accuracy;
  let rt;
  if (rng.next() < RT_FLOOR_OUTLIER_PROB) {
    rt = Math.round(50 + rng.next() * 150);
  } else {
    const mean = correct ? RT_MEAN_CORRECT_MS : RT_MEAN_INCORRECT_MS;
    rt = Math.round(mean + gaussian(rng) * RT_STDDEV_MS);
  }
  if (rt < 100) rt = 100;
  return { responded, correct, rt_ms: rt };
}

/* ---------- Per-condition row builders ---------- */

/* Trial-type → encoding/probe/star phase tags. Mirrors the runtime contract
 * in src/conditions/*.js. */
const PHASE_TAGS = Object.freeze({
  d_only: { encoding: 'd_only_encoding', probe: 'd_only_probe' },
  t_only: { encoding: 't_only_encoding', probe: 't_only_probe' },
  i_only: { encoding: 'i_only_encoding', star: 'i_only_star' },
  i_d: { encoding: 'i_d_encoding', probe: 'i_d_probe', star: 'i_d_star' },
  i_t: { encoding: 'i_t_encoding', probe: 'i_t_probe', star: 'i_t_star' },
});

/**
 * Compute synthetic per-trial timing. Returns absolute `encoding_onset_ts_ms`
 * (advanced by the simulator's monotone clock), absolute slot onsets in the
 * order `params.sequence` defines, and absolute probe onsets after retention.
 * Each trial leaves the clock pointing at the start of the next trial's
 * encoding window, so the synthetic timeline is monotone across trials.
 */
function buildTrialTiming(trialType, params, clockRef) {
  const sequence = params.sequence;
  const hasRotation = trialType === 'i_only' || trialType === 'i_d' || trialType === 'i_t';
  const encodingOnset = clockRef.now();
  let cursor = hasRotation ? SIM_ROTATION_PREAMBLE_MS : 0;
  const slotOnsets = [];
  for (const ch of sequence) {
    slotOnsets.push(encodingOnset + cursor);
    cursor += ch === 'M' ? SIM_M_SLOT_MS : SIM_S_SLOT_MS;
  }
  const encodingEnd = encodingOnset + cursor;
  const retentionEnd = encodingEnd + SIM_RETENTION_MS;
  const probeOnsets = [];
  const probesCount = params.probes ? params.probes.length : 0;
  for (let i = 0; i < probesCount; i++) {
    probeOnsets.push(retentionEnd + i * SIM_PROBE_SLOT_MS);
  }
  const trialEnd = retentionEnd + probesCount * SIM_PROBE_SLOT_MS + SIM_INTER_TRIAL_MS;
  clockRef.advanceTo(trialEnd);
  return { encodingOnset, slotOnsets, probeOnsets };
}

/**
 * Emit the encoding row for one trial. Column shapes match the runtime
 * `data: { ... }` block in each condition module.
 */
function buildEncodingRow(trialType, params, blockLabel, timing) {
  const tag = PHASE_TAGS[trialType].encoding;
  const baseRow = {
    phase: tag,
    block_label: blockLabel,
    ...params.trial_meta,
    trial_index_in_block: params.trial_index_in_block,
    background_shade: params.background_shade,
    trial_spec: encodingRecord(params),
    sequence: params.sequence.join(''),
    encoding_onset_ts_ms: timing.encodingOnset,
    slot_onsets_ts_ms: [...timing.slotOnsets],
  };
  if (trialType === 'd_only') {
    return {
      ...baseRow,
      display_rotation_deg: params.display_rotation_deg,
      memory_items: params.memory_items.map((m) => ({
        slot: m.slot_index_in_seq,
        cell: m.cell,
        pattern_label: m.pattern_label,
      })),
      dummies: params.dummies.map((d) => ({ slot: d.slot_index_in_seq, cell: d.cell })),
    };
  }
  if (trialType === 't_only') {
    return {
      ...baseRow,
      memory_items: params.memory_items.map((m) => {
        const tone = toneForCell(m.cell);
        return {
          slot: m.slot_index_in_seq,
          cell: m.cell,
          tone_index: tone.index,
          tone_freq_hz: tone.freq_hz,
          pattern_label: m.pattern_label,
        };
      }),
      dummies: params.dummies.map((d) => ({ slot: d.slot_index_in_seq, cell: d.cell })),
    };
  }
  if (trialType === 'i_only') {
    return {
      ...baseRow,
      rotation_deg: params.rotation_deg,
      stars: params.stars.map((s) => ({
        slot: s.slot_index_in_seq,
        cell: s.cell,
        pattern_label: s.pattern_label,
      })),
      dummies: params.dummies.map((d) => ({
        slot: d.slot_index_in_seq,
        cell: d.cell,
      })),
    };
  }
  if (trialType === 'i_d') {
    return {
      ...baseRow,
      rotation_deg: params.rotation_deg,
      memory_items: params.memory_items.map((m) => ({
        slot: m.slot_index_in_seq,
        encoding_position: m.encoding_position,
        cell: m.cell,
        pattern_label: m.pattern_label,
      })),
      stars: params.stars.map((s) => ({
        slot: s.slot_index_in_seq,
        cell: s.cell,
        pattern_label: s.pattern_label,
      })),
    };
  }
  /* i_t */
  return {
    ...baseRow,
    rotation_deg: params.rotation_deg,
    memory_items: params.memory_items.map((m) => {
      const tone = toneForCell(m.cell);
      return {
        slot: m.slot_index_in_seq,
        encoding_position: m.encoding_position,
        cell: m.cell,
        tone_index: tone.index,
        tone_freq_hz: tone.freq_hz,
        pattern_label: m.pattern_label,
      };
    }),
    stars: params.stars.map((s) => ({
      slot: s.slot_index_in_seq,
      cell: s.cell,
      pattern_label: s.pattern_label,
    })),
  };
}

/**
 * Emit one probe row given the trial params + the probe spec + a sampled
 * response. `said_yes` follows the (is_target, correct) ground truth.
 */
function buildProbeRow(trialType, params, probe, blockLabel, response, timing) {
  const phase = PHASE_TAGS[trialType].probe;
  const said_yes = response.responded === true ? response.correct === probe.is_target : null;
  const probeOnset = timing.probeOnsets[probe.probe_position] ?? null;
  const responseKey = response.responded ? (said_yes ? 'arrowright' : 'arrowleft') : null;
  /* Same rule as the runtime: the probe frame keeps the encoding rotation. */
  const probeFrame = { rotation_deg: postEncodingRotationDeg(params) };
  const isTone = trialType === 't_only' || trialType === 'i_t';
  const row = {
    phase,
    block_label: blockLabel,
    ...params.trial_meta,
    trial_index_in_block: params.trial_index_in_block,
    background_shade: params.background_shade,
    probe_position: probe.probe_position,
    ...(isTone ? probeFrameFields(probeFrame) : probeRenderFields(probe, probeFrame)),
    probe_type: probe.type,
    probed_cell: probe.cell,
    probe_pattern_label: probe.pattern_label,
    is_target: probe.is_target,
    responded: response.responded,
    said_yes,
    probe_correct: response.correct === true,
    rt: response.rt_ms,
    /* jsPsych keyboard plugins stamp the raw key under `response`; the
     * exporter's `extractResponseKey` reads it from there. We stamp both
     * `response` and `response_key` so simulator dumps round-trip through
     * downstream tooling that may look at either. */
    response: responseKey,
    response_key: responseKey,
    probe_onset_ts_ms: probeOnset,
  };
  if (isTone) {
    const tone = toneForCell(probe.cell);
    row.probed_tone_index = tone.index;
    row.probed_tone_freq_hz = tone.freq_hz;
  }
  row.encoding_position = probe.encoding_position ?? null;
  return row;
}

/**
 * Emit one star row (i_only / i_d / i_t). `said_on` follows the
 * (is_on_pattern, correct) ground truth. RT for stars is recorded under
 * `response_rt_ms` per the runtime contract.
 */
function buildStarRow(trialType, params, star, blockLabel, response, timing) {
  const phase = PHASE_TAGS[trialType].star;
  const said_on = response.responded === true ? response.correct === star.is_on_pattern : null;
  const starOnset = timing.slotOnsets[star.slot_index_in_seq] ?? null;
  const row = {
    phase,
    block_label: blockLabel,
    ...params.trial_meta,
    trial_index_in_block: params.trial_index_in_block,
    background_shade: params.background_shade,
    probe_position: star.probe_position,
    ...starRenderFields(star, params.rotation_deg),
    slot_index_in_seq: star.slot_index_in_seq,
    probed_cell: star.cell,
    pattern_label: star.pattern_label,
    is_on_pattern: star.is_on_pattern,
    responded: response.responded,
    said_on,
    response_key: response.responded ? (said_on ? 'arrowright' : 'arrowleft') : null,
    response_rt_ms: response.rt_ms,
    star_correct: response.correct === true,
    star_onset_ts_ms: starOnset,
  };
  if (trialType === 'i_only' || trialType === 'i_d' || trialType === 'i_t') {
    row.rotation_deg = params.rotation_deg;
  }
  return row;
}

/* ---------- Per-trial row composition ---------- */

function emitTrialRows(
  trialType,
  params,
  blockLabel,
  rng,
  modelOpts,
  sessionMeta,
  seqRef,
  clockRef
) {
  const timing = buildTrialTiming(trialType, params, clockRef);
  const rows = [];
  /* Trial-start gate, as in the runtime: carries the identity fields. */
  rows.push(
    stamp(
      {
        phase: `${trialType}_trial_start`,
        block_label: blockLabel,
        ...params.trial_meta,
        trial_index_in_block: params.trial_index_in_block,
        background_shade: params.background_shade,
        ...(params.rotation_deg !== undefined ? { rotation_deg: params.rotation_deg } : {}),
        main_trial_number_overall: params.trial_meta.presentation_index,
      },
      seqRef,
      sessionMeta
    )
  );
  rows.push(stamp(buildEncodingRow(trialType, params, blockLabel, timing), seqRef, sessionMeta));
  if (trialType !== 'i_only') {
    for (const probe of params.probes) {
      const response = sampleResponse(rng, modelOpts);
      rows.push(
        stamp(
          buildProbeRow(trialType, params, probe, blockLabel, response, timing),
          seqRef,
          sessionMeta
        )
      );
    }
  }
  if (trialType === 'i_only' || trialType === 'i_d' || trialType === 'i_t') {
    for (const star of params.stars) {
      const response = sampleResponse(rng, modelOpts);
      rows.push(
        stamp(
          buildStarRow(trialType, params, star, blockLabel, response, timing),
          seqRef,
          sessionMeta
        )
      );
    }
  }
  return rows;
}

/* Stamp every row with the runtime-injected fields: monotone seq, the
 * session/global tags addPropertiesByDefault wires onto every row, and
 * trial_type. Mirrors `runner.js`'s `addProperties` call. */
function stamp(row, seqRef, sessionMeta) {
  return {
    ...row,
    seq: seqRef.next(),
    schema_version: SCHEMA_VERSION,
    build_id: BUILD_ID,
    is_pilot_run: sessionMeta.is_pilot_run,
    pilot_label: sessionMeta.pilot_label,
  };
}

/* ---------- Calibration / instructions stub rows ---------- */

/* These rows aren't necessary for the trial-data pipeline test, but a real
 * dump always carries them and CALIBRATION_SUMMARY.csv pulls fields from
 * them. We emit minimal-but-consistent stand-ins so the auxiliary CSVs land
 * with non-null values. */
/* Two card-width settings and the attempt outcome, shaped like the rows
 * src/calibration/screen.js writes. 'inconsistent_accepted' reproduces the
 * pre-registered exclusion case: the two settings differ by more than the
 * consistency tolerance and the attempt was accepted on the last try. */
function calibrationStubRows(seqRef, sessionMeta, mode) {
  const inconsistent = mode === 'inconsistent_accepted';
  const attempts = inconsistent ? 3 : 1;
  const [a, b] = inconsistent ? [300, 360] : [318, 322];
  const mean = (a + b) / 2;
  const pxPerMm = mean / 85.6;
  const rows = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const last = attempt === attempts;
    const passes = last ? [a, b] : [300, 360];
    [1, 2].forEach((pass) =>
      rows.push(
        stamp(
          {
            phase: 'screen_calibration',
            cal_pass: pass,
            cal_attempt: attempt,
            cc_px_width: passes[pass - 1],
            px_per_mm: passes[pass - 1] / 85.6,
            px_per_mm_in_bounds: true,
            display_colour_locked: false,
          },
          seqRef,
          sessionMeta
        )
      )
    );
    const relDiff = Math.abs(passes[0] - passes[1]) / ((passes[0] + passes[1]) / 2);
    const consistent = relDiff <= 0.05;
    const accepted = consistent || last;
    rows.push(
      stamp(
        {
          phase: 'screen_calibration_outcome',
          value: {
            attempt,
            accepted,
            status: accepted ? (consistent ? 'ok' : 'inconsistent_accepted') : 'retry',
            px_per_mm: pxPerMm,
            cc_px_width: mean,
            rel_diff: relDiff,
            consistent,
            usable: true,
            reasons: [],
            implied_screen_mm: 1440 / pxPerMm,
            attempts_used: attempt,
            max_attempts: 3,
            retried: attempt > 1,
            px_per_mm_in_bounds: true,
          },
        },
        seqRef,
        sessionMeta
      )
    );
  }
  return rows;
}

function emitSessionStubRows(seqRef, sessionMeta, calibrationMode = 'ok') {
  const rows = [];
  rows.push(
    stamp({ phase: 'consent', consented: true }, seqRef, sessionMeta),
    ...calibrationStubRows(seqRef, sessionMeta, calibrationMode),
    stamp({ phase: 'speaker_volume_instruction' }, seqRef, sessionMeta),
    stamp(
      {
        phase: 'tone_audibility_and_comfort',
        tones_audible: true,
        user_playback_pct: 65,
        user_playback_gain: 0.65,
        sweeps_completed: 2,
      },
      seqRef,
      sessionMeta
    ),
    stamp(
      {
        phase: 'demographics',
        response: {
          handedness: 'right',
          education: 'bachelor',
        },
      },
      seqRef,
      sessionMeta
    ),
    stamp(
      {
        phase: 'attention_check_summary',
        attention_total: 3,
        attention_passed: 3,
        attention_failed: 0,
        attention_excluded: false,
      },
      seqRef,
      sessionMeta
    )
  );
  return rows;
}

function emitSessionEndRows(seqRef, sessionMeta) {
  return [
    stamp(
      { phase: 'upload_session_end', status: 'uploaded', storage_write_failures: 0 },
      seqRef,
      sessionMeta
    ),
    stamp({ phase: 'completion_redirect', completion_was_placeholder: false }, seqRef, sessionMeta),
  ];
}

/* ---------- Top-level simulator ---------- */

/* A monotone sequence counter mirrors the IDB autoIncrement behaviour. The
 * counter is per-participant; reset on each simulateOne() call. */
function makeSeqRef() {
  let n = 0;
  return {
    next() {
      n += 1;
      return n;
    },
  };
}

/* A monotone synthetic clock for stamping `*_onset_ts_ms` timing fields.
 * Each trial reads `now()` at the start and calls `advanceTo(end)` to skip
 * the clock to the next trial's start. Returned values mimic absolute
 * `performance.now()` deltas — what the runtime stamps via the same field. */
function makeClockRef(baseMs = SIM_CLOCK_BASE_MS) {
  let t = baseMs;
  return {
    now() {
      return t;
    },
    advanceTo(end) {
      if (Number.isFinite(end) && end > t) t = end;
    },
  };
}

/**
 * Simulate one participant. Returns a flat envelope-shaped object — exactly
 * the format `csv-export.js` and `pilot-summary.js` ingest via the same
 * `extractSessionFromEnvelope` path the live bucket envelopes use. Real
 * sessions emit one envelope per non-empty bucket (up to 10); the simulator
 * skips partitioning and emits a single all-rows envelope per participant,
 * which the loader concatenates the same way it would the live 10-file set.
 */
export function simulateOne(opts) {
  const seedSource = opts.seed ?? `auto_${Date.now()}_${Math.random()}`;
  const pid = opts.pid ?? `SIM_${slugify(seedSource).slice(0, 16)}`;
  setSessionPRNG(seedSource);
  resetSequencePools();
  const rng = getSessionPRNG();

  const sessionMeta = {
    is_pilot_run: true,
    pilot_label: opts.pilotLabel ?? 'simulated',
  };
  const modelOpts = {
    accuracy: opts.accuracy ?? DEFAULT_ACCURACY,
    responseRate: opts.responseRate ?? DEFAULT_RESPONSE_RATE,
  };

  const seqRef = makeSeqRef();
  const clockRef = makeClockRef();
  const rows = [];
  rows.push(...emitSessionStubRows(seqRef, sessionMeta, opts.calibration ?? 'ok'));

  /* Session-level row written after calibration (seed, build, calibration,
   * stimulus geometry), as the runner does before the main task. */
  const calibration = rows.find((r) => r.phase === 'screen_calibration_outcome')?.value ?? null;
  rows.push(
    stamp(
      buildSessionInfo(
        {
          params: {
            session_id: `sim_${slugify(seedSource).slice(0, 16)}`,
            prolific_pid: pid,
            study_id: 'SIM_STUDY',
          },
          seed_string: seedSource,
          prng_seed_uint32: rng.seed,
          build_id: BUILD_ID,
          schema_version: SCHEMA_VERSION,
          is_pilot_run: sessionMeta.is_pilot_run,
          pilot_label: sessionMeta.pilot_label,
          started_at_iso: new Date(0).toISOString(),
          user_agent: 'simulate-pilot/1.0',
        },
        calibration,
        {
          /* Same shape the browser writes, so the row validates against the schema. */
          clock_anchor: {
            perf_now_ms: 0,
            time_origin_ms: 0,
            date_now_ms: 0,
            iso: new Date(0).toISOString(),
            jspsych_start_ms: null,
          },
        }
      ),
      seqRef,
      sessionMeta
    )
  );

  const plan = generateMainPlan({ prng: rng });
  for (const [blockLabel, block] of [
    ['main_a', plan.mainA],
    ['main_b', plan.mainB],
  ]) {
    block.trialParams.forEach((params, i) => {
      rows.push(
        ...emitTrialRows(
          block.schedule[i],
          params,
          blockLabel,
          rng,
          modelOpts,
          sessionMeta,
          seqRef,
          clockRef
        )
      );
    });
  }

  rows.push(...emitSessionEndRows(seqRef, sessionMeta));

  return {
    /* Flat envelope contract — mirrors the session-meta fields the live
     * bucket envelopes carry (src/uploader.js#buildBucketEnvelope), minus
     * the bucket-specific fields (the simulator emits one all-rows envelope
     * per participant, not the 10-file bucketed layout). */
    session_id: `sim_${slugify(seedSource).slice(0, 16)}`,
    prolific_pid: pid,
    study_id: 'SIM_STUDY',
    is_preview: false,
    schema_version: SCHEMA_VERSION,
    build_id: BUILD_ID,
    is_pilot_run: sessionMeta.is_pilot_run,
    pilot_label: sessionMeta.pilot_label,
    started_at_iso: new Date(0).toISOString(),
    user_agent: 'simulate-pilot/1.0',
    seq_min: rows.length ? rows[0].seq : null,
    seq_max: rows.length ? rows[rows.length - 1].seq : null,
    n_rows: rows.length,
    rows,
    uploaded_at_iso: new Date(0).toISOString(),
    /* Provenance — not part of the upload envelope but useful for downstream
     * tooling to spot synthetic dumps. */
    simulator: { name: 'simulate-pilot.js', version: GENERATOR_VERSION, seed: seedSource },
  };
}

function slugify(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
}

/* ---------- CLI ---------- */

async function main(argv) {
  const opts = parseSimulateArgs(argv);
  const envelopes = [];
  const baseSeed = opts.seed ?? `auto_${Date.now()}`;
  for (let i = 0; i < opts.participants; i++) {
    const seed = opts.participants === 1 ? baseSeed : `${baseSeed}_${i}`;
    const pid = opts.pid && opts.participants === 1 ? opts.pid : null;
    envelopes.push(
      simulateOne({
        seed,
        pid,
        pilotLabel: opts.pilotLabel,
        accuracy: opts.accuracy,
        responseRate: opts.responseRate,
        calibration: opts.calibration,
      })
    );
  }
  /* Multi-participant runs emit a JSON array of envelopes; single-participant
   * emits one envelope object so the file is directly groupable by pid. */
  const payload = opts.participants === 1 ? envelopes[0] : envelopes;
  const text = JSON.stringify(payload, null, 2);
  if (opts.out) {
    writeFileSync(resolve(opts.out), text, 'utf-8');
    console.error(`simulate-pilot: wrote ${envelopes.length} participant(s) to ${opts.out}`);
  } else {
    process.stdout.write(text + '\n');
  }
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  main(process.argv).catch((err) => {
    console.error('simulate-pilot: unexpected error', err);
    process.exit(1);
  });
}
