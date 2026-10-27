/**
 * Locked experiment parameters.
 *
 * Values here are fixed at build time (no runtime override). They are kept
 * in lockstep with `pre-reg/pre-reg.json#config_locked`; the byte-equality
 * test enforces agreement between the two. After registration, any change
 * here requires a post-registration amendment in addition to a
 * `schema_version` bump.
 *
 * The object is deeply frozen.
 */

/* Prolific screening filters, in plain language, as listed on the study's
 * Prolific page, in the listing text and in the pre-registration. Keep this
 * list identical to the filters set on the Prolific study: Prolific requires
 * every screening criterion to be applied through its own filters before the
 * study is shown, never inside the study or only in the description, so the
 * consent form does not restate them. It is display text only and does not
 * affect the task. */
export const PROLIFIC_PRESCREEN_SUMMARY = Object.freeze([
  'Age: 18 to 40 years',
  'First language: English',
  'Country of birth: United States',
  'Prolific approval rate: 85% or higher',
  'Hearing: no hearing loss or hearing difficulties',
  'Vision: normal or corrected-to-normal vision',
  'Cognitive health: never diagnosed with mild cognitive impairment or dementia',
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export const config = deepFreeze({
  schema_version: '1.2.0',
  build_id: 'v1',

  /* Localisation. English ships for the main Prolific batch. */
  locale: 'en',

  /* PRNG — every counterbalance step consumes from a single seeded Mulberry32 instance. */
  prng: {
    /* If null, seed is hashed from PROLIFIC_PID at session start. */
    deterministic_override: null,
  },

  /* Visual frame
   *
   * Cells are 10 mm (5×5 grid = 50 mm edge-to-edge, ≈ 190 px at 96 DPI). */
  grid: {
    cells_per_side: 5,
    cell_size_mm: 10,
    centre_cell_index: 12,
    rotation_min_deg: -90,
    rotation_max_deg: 90,
  },

  /* Imagery pattern, hard-coded per domain non-negotiable #1 */
  pattern: {
    gray_pattern_cells: Object.freeze([1, 2, 3, 7, 10, 11, 12, 13, 14, 17, 21, 22, 23]),
    pattern_phase_duration_ms: 4000,
    pattern_phase_frequency_trials: 8,
  },

  /* Tone bank; audio-only; never rendered visually.
   *
   * 24 sine tones **logarithmically spaced** between `low_freq_hz` and
   * `high_freq_hz`, so no tone lands on a named pitch class (which would
   * expose the bank to note-name re-encoding by musically trained
   * participants).
   *
   * Anchor band 200–3900 Hz follows Li, Cowan & Saults (2013, APP 75(1),
   * pp. 150–151) — chosen because (i) Sek & Moore (1995, J. Acoust. Soc. Am.
   * 97(4), 2479–2486) report similar frequency difference limens across this
   * range so all 24 tones sit in a regime of comparable pitch acuity, and
   * (ii) Li et al. demonstrated this band can be filled with non-musical sine
   * tones that resist octave-equivalence chunking (Shepard 1982). At 24
   * tones the neighbour ratio is `(3900/200)^(1/23) ≈ 1.138` (~13.8 %),
   * distinct from any Western interval (semitone 5.9 %, whole-tone 12.25 %,
   * minor third 18.92 %, major third 25.99 %, fifth 49.83 %); see
   * `tests/tones.test.js` for the no-near-harmonic and no-near-musical-step
   * invariants pinned across the bank. The cell↔tone bijection is in
   * `src/audio/tones.js`.
   *
   * Envelope: duration 350 ms, 10 ms cosine ramp; the 1500 ms slot is built around it (350 ms tone + 1150 ms silence).
   *
   * Equal-loudness compensation: the per-tone digital amplitude is scaled by 10^(comp_dB/20), where
   * comp_dB is the dB difference between the SPL needed at the tone's
   * frequency and the SPL needed at 1 kHz to elicit the same loudness
   * in phons (ISO 226:2023 Formula (1) and Table 1, `target_phon_level: 70`, a
   * nominal listening level: the experiment does not measure SPL).
   * Across 200–3900 Hz the correction ranges from ≈ +7.8 dB at the low end to
   * ≈ −3.0 dB near the ear's 3 kHz sensitivity peak; with the
   * default 0.25 peak (≈ −12 dBFS) the worst-case boosted peak is
   * ≈ 0.62, well below the 0.95 clipping margin. See
   * `src/audio/equal-loudness.js` for the formula and parameters. */
  tones: {
    count: 24,
    low_freq_hz: 200,
    high_freq_hz: 3900,
    duration_ms: 350,
    cosine_ramp_ms: 10,
    target_db_spl: 70,
    target_phon_level: 70,
  },

  /* Dummies Side length scales with cell_size_mm (10 mm) at
   * a ~0.5 cell ratio (5 mm side = star bounding diameter). The open-square
   * stroke is specified in mm (not px) because the SVG viewBox is in mm;
   * 0.4 mm keeps the contour visible after browser stroke-rounding.
   *
   * The dummy primitive is an open square. Its per-slot envelope follows the
   * "single-task dummy stands in for the matched dual-task condition's
   * other modality" rule:
   *   - D-only / T-only dummies stand in for the matched I+D / I+T
   *     condition's STAR, and therefore run on the S-slot envelope
   *     (3000 ms visible + 500 ms empty-circle offset = 3500 ms).
   *   - I-only dummies stand in for the matched I+D / I+T condition's
   *     MEMORY ITEM (dot or tone), and therefore run on the M-slot
   *     envelope (1000 ms visible + 500 ms empty-circle offset = 1500
   *     ms) — the same envelope a dot occupies in I+D and a tone in I+T.
   * Per-slot timing is therefore byte-identical between each single-task
   * condition and the dual-task condition it stands in for. The visible
   * portion is irrelevant for the participant (live dummies are mounted
   * with `visible: false`); the timing rule is purely a temporal-equating
   * device. */
  dummies: {
    open_square_size_mm: 5,
    open_square_stroke_mm: 0.4,
  },

  /* Memory items */
  memory: {
    set_size: 3,
    dot_diameter_mm: 5,
    dot_duration_ms: 1000,
    inter_stimulus_interval_ms: 500,
    retention_interval_ms: 2000,
  },

  /* Imagery probes `rotation_arrow_size_px` is a CSS-px size
   * (the arrow renders as an HTML <img>, not an SVG primitive on the mm
   * grid).
   *
   * Imagination period (`imagination_duration_ms`):
   * the empty-circle hold between the arrow cue and the encoding rotation
   * is fixed at 3500 ms. The circle (with its bull's-eye) stays blank through
   * the encoding node's own rotation (500 ms) and stabilisation (1000 ms), so
   * from the end of the arrow cue to the first stimulus the participant faces
   * 3500 + 500 + 1000 = 5000 ms of blank circle: the "5,000-ms imagination
   * period" of the manuscript and thesis, and the "5 seconds" of the
   * instructions (pinned by tests/instruction-claims.test.js). Do not raise
   * `imagination_duration_ms` to 5000: that would make the interval 6500 ms.
   * During this window the participant has the
   * rotation angle in mind from the arrow cue and uses the time to
   * pre-imagine the rotated 13-cell pattern. The window is fixed (no
   * input, no auto-pass-on-keypress) so encoding-onset is identical
   * within and across imagery-bearing trial types.
   *
   * Star feedback is synchronous on keypress: the green/red recolour
   * happens on the same frame as the keypress, matching the dot/tone probe
   * path. */
  imagery: {
    stars_per_trial: 3,
    star_size_mm: 5,
    star_duration_ms: 3000,
    inter_star_interval_ms: 500,
    imagination_duration_ms: 3500,
    rotation_animation_ms: 500,
    post_rotation_delay_ms: 1000,
    rotation_arrow_size_px: 100,
  },

  /* Recognition probes
   *
   * The 3000 ms response window matches the manuscript spec and the
   * instruction copy ("you will have 3 seconds for each test"). Answered
   * probes stay on screen for the rest of that 3000 ms onset, with the
   * feedback colour shown on the still-visible dot or question mark. The
   * same 500 ms value below also serves as the shared post-stimulus offset
   * after the onset ends, and the only gap between successive probes (no
   * separate inter-probe interval). */
  probes: {
    response_window_ms: 3000,
    feedback_duration_ms: 500,
  },

  /* Counterbalance & sequencing */
  sequencing: {
    /* Within-trial M/S sequence run-length cap.
     * Maximum allowed run of consecutive M (or S) slots. cap = 2 → runs of
     * length 2 are OK, length 3 is rejected. */
    within_trial_run_length_cap: 2,
    /* Across-trial trial-type run-length cap.
     * "No more than 2 trials of the same type in a row" — primary spec.
     * Design notes the cap may be relaxed to 3 if pilot pacing is hectic. */
    between_trial_run_length_cap: 2,
  },

  /* Block structure */
  blocks: {
    practice_trials_per_type: 2,
    main_trials_per_type: 24,
    /* The 24 main trials of each type are split across two main blocks (12 + 12). */
    main_block_count: 2,
    rest_duration_s: 30,
  },

  /* Practice gating */
  practice: {
    accuracy_criterion: 0.7,
    max_loops: 1,
  },

  /* Anticipatory-response cutoff for analysis (logged but not enforced at collection). */
  rt_cutoff_ms: 250,

  /* Attention checks */
  attention_checks: {
    instruction_typed_count: 3,
    instruction_max_failures: 1,
  },

  /* Prolific & data flow */
  prolific: {
    /* The completion URL is participant-specific; this is the placeholder template
     * that gets the participant's completion code substituted at session end.
     * Replace with the actual Prolific completion URL when the study is published. */
    completion_url: 'https://app.prolific.com/submissions/complete?cc=CQ6EH8Q1',

    /* Completion code Prolific issues for participants screened out by an
     * in-study check (desktop check, screen-size calibration, tone audibility, timing check, practice criterion).
     * Prolific generates it when a completion path labelled "Screened out"
     * is added in the study editor's Data collection section; the value here
     * must equal the generated code. */
    screen_out_completion_code: 'CED70N6J',

    /* Statement shown in the consent form about what is paid when an in-study
     * check ends the session. Prolific pays every screened-out participant the
     * single fixed screen-out reward set on the study, so this text names one
     * amount; it must equal the screen-out reward in the Prolific editor. */
    payment_policy_text:
      'a fixed screen-out payment of $0.14 through Prolific, the same whichever of these checks ends the session',
  },

  /* Data egress — DataPipe (https://pipe.jspsych.org), jsPsych's free
   * forwarding service into a storage folder. The uploader partitions the
   * captured rows into the canonical 10-bucket layout
   * (`src/uploader.js#BUCKETS`) and POSTs one DataPipe envelope per
   * non-empty bucket. DataPipe writes one file per envelope, named
   * `<session_id>__<run_id>__<NN_label>_s<seqMin>-<seqMax>.json` (e.g.
   * `<sid>__<run>__03_d_only_s20-740.json`; the seq range makes a bucket that
   * grew between two upload attempts a new file). A
   * complete session therefore yields up to 10 bucket files: consent +
   * demographics, practice, d_only, i_only (= "star-only"), t_only, i_t
   * (= "dual tone+star"), i_d (= "dual dot+star"), music questionnaire,
   * strategy questionnaire, and a meta bucket for everything else
   * (calibration, instructions, demos, fullscreen events, pattern phases,
   * etc.). The two-digit prefix is so a directory listing sorts in
   * canonical reading order without manual sort.
   *
   * Timeline of uploads: the consent and practice buckets are sent at the
   * inter-block rest, a checkpoint file
   * (`<session_id>__<run_id>__ckpt_<seqMin>-<seqMax>.json`) is sent at every
   * rest screen, and the remaining buckets are sent at the end of the session
   * (or when a check ends the session). The rows written after that upload go
   * out in a tail file (`<session_id>__<run_id>__tail_<seqMin>-<seqMax>.json`),
   * and a best-effort flush when the page is hidden or closed sends a partial
   * file (`<session_id>__<run_id>__partial_<seqMin>-<seqMax>.json`). The file
   * names are built from sanitised ids; the loaders read the rows inside the
   * files and de-duplicate them on (run, seq), so a row present in a partial
   * and in a regular file is counted once. Every row is also
   * persisted to IndexedDB immediately, so a crash before upload still
   * yields a recoverable local download.
   *
   * `request_timeout_ms` bounds a single POST; `session_end_max_wait_ms`
   * bounds the whole end-of-session upload, after which the participant is
   * released to the final screen and the download fallback is offered.
   *
   * `datapipe_experiment_id` must be replaced with the alphanumeric ID
   * minted on the DataPipe dashboard for this study. Until it is, the
   * uploader detects the `PLACEHOLDER` token and falls through to the JSON
   * download fallback, so a pilot or dev session can still finish without
   * losing data. */
  uploader: {
    endpoint: 'https://pipe.jspsych.org/api/data/',
    provider: 'datapipe',
    datapipe_experiment_id: 'epIpSzIi9r7O',
    retry_max: 5,
    retry_initial_backoff_ms: 1000,
    request_timeout_ms: 15000,
    session_end_max_wait_ms: 120000,
  },
});
