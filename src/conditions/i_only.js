/**
 * I-only (imagery-only single-task) trial.
 *
 * Sequence:
 *   1. Trial-start gate (empty circle + "press both arrow keys to start
 *      the next trial" hint, no arrow). The trial does not begin until
 *      the participant presses both arrow keys; never auto-passes.
 *   2. Rotation cue (2000 ms): centre-screen arrow showing the angle the
 *      grid will rotate to, so the participant can pre-imagine the
 *      rotated pattern. Mounted only AFTER the gate fires, so the arrow
 *      presentation is unambiguously part of the trial.
 *   3. Imagination period (3500 ms; with the invisible 500 ms rotation and
 *      1000 ms stabilisation, 5000 ms of blank circle precede the first
 *      stimulus): empty circle
 *      with no arrow. Fixed-duration window in which the participant
 *      pre-imagines the rotated pattern; no input is accepted.
 *   4. Encoding node (one jsPsych trial spanning the whole imagery sequence,
 *      driven by an async on_load schedule so the grid frame mounts once
 *      and we avoid between-event flicker):
 *        a. Mount frame at rotation = 0°.
 *        b. Animate rotation 0 → rotation_deg over 500 ms via SVG transform.
 *        c. Stabilisation 1000 ms with the rotated grid visible.
 *        d. For each slot in the trial's 6-event {M, S} sequence:
 *             S-slot → star at the assigned cell, visible for 3000 ms,
 *                      then a 500 ms empty-circle offset. Listen for
 *                      ArrowRight/ArrowLeft. Recolour star green/red
 *                      synchronously on keypress (no latency).
 *             M-slot → invisible open-square placeholder at a non-star
 *                      cell, occupying 1000 ms + a 500 ms empty-circle
 *                      offset (the dot M-slot envelope). Same filler
 *                      primitive used by D-only / T-only S-slots, but
 *                      shorter: in I-only the placeholder stands in for
 *                      the dual-task condition's *memory item* (dot in
 *                      I+D, tone in I+T), not for its star, so it must
 *                      run on the M-slot envelope rather than the
 *                      S-slot envelope. Rendered invisibly so it does
 *                      not compete visually with the star events; its
 *                      sole purpose is the temporal envelope that keeps
 *                      single-task durations matched to dual-task ones.
 *        e. Tear down stars and dummies; restore fixation.
 *   3. ITI (800 ms blank with central fixation).
 *
 * No retention or recognition probe — the I-only trial ends after the last
 * star slot.
 *
 * Per-star data rows are emitted via `emitAuxDataRow({...})` (shared.js: pushes the row into jsPsych's in-memory data and the storage backend) so each
 * star produces an `i_only_star` row alongside the surrounding nodes. This
 * matches the per-probe row shape from D-only / T-only and makes the
 * data uploader uniform across conditions.
 */
import { createEncodingNode } from './encoding-schedule.js';

import { arrowCueNode, imaginationNode, trialStartGateNode, itiNode } from './shared.js';

/* I-only dummies sit in M-slots — the slot positions that the matched
 * dual-task conditions (I+D, I+T) use for memory items (dots / tones).
 * They therefore inherit the M-slot envelope (1000 ms visible onset +
 * 500 ms empty-circle offset = 1500 ms total), NOT the S-slot envelope
 * used by D-only / T-only dummies (which stand in for the *star* of
 * their matched dual-task condition). Every
 * single-task trial's encoding window is therefore byte-identical to the
 * matched dual-task encoding window: I-only = 3×S_SLOT_MS + 3×M_SLOT_MS
 * = 15 s, matching I+D and I+T. The dummy is rendered invisibly, so the
 * gap between consecutive stars in I-only matches the gap between
 * consecutive stars in I+D / I+T (one M-slot worth of waiting). */

/**
 * Trial preamble for imagery trials :
 *   1. `trialStartGateNode` — empty circle (bull's-eye visible, no
 *      arrow). The participant presses both arrow keys to start the
 *      trial; the gate never auto-passes.
 *   2. `arrowCueNode` — rotation arrow over the empty grid for 2000 ms,
 *      no input. The arrow is sized to 100 px and centred at the bull's-eye (not
 *      contained inside the central cell). It renders only after the
 *      gate fires, so the arrow presentation is unambiguously part of
 *      the started trial.
 *   3. `imaginationNode` — empty circle (no arrow) for a fixed 3500 ms.
 *      The participant uses this window to pre-imagine the rotated
 *      pattern. No input is accepted; the duration is fixed across
 *      trials so encoding-onset is consistent.
 *
 * The gate's `showArrow` / `rotation_deg` fields are kept on the data
 * row for analytic tagging only — they do not drive any visual
 * rendering inside the gate.
 */
function gatePreambleNodes(params) {
  return [
    trialStartGateNode({
      trial_index_in_block: params.trial_index_in_block,
      showArrow: true,
      rotation_deg: params.rotation_deg,
      phase: 'i_only_trial_start',
      background_shade: params.background_shade,
      trialType: 'i_only',
      data: {
        rotation_deg: params.rotation_deg,
        background_shade: params.background_shade,
      },
    }),
    arrowCueNode({
      trial_index_in_block: params.trial_index_in_block,
      rotation_deg: params.rotation_deg,
      phase: 'i_only_arrow_cue',
      background_shade: params.background_shade,
      data: { background_shade: params.background_shade },
    }),
    imaginationNode({
      trial_index_in_block: params.trial_index_in_block,
      rotation_deg: params.rotation_deg,
      phase: 'i_only_imagination',
      background_shade: params.background_shade,
      data: { background_shade: params.background_shade },
    }),
  ];
}

/**
 * The encoding node — one jsPsych node spanning rotation animation,
 * stabilisation, and the 6-slot {M, S} sequence. We drive timing via
 * `setTimeout` / `await sleep(...)` from `on_load` so the grid frame stays
 * mounted across all events (no flicker). The ENCODING_TOTAL_MS constant
 * gives jsPsych a hard upper bound; the schedule completes earlier and the
 * trial ends naturally at trial_duration.
 */
function encodingNode(params) {
  return createEncodingNode({
    params,
    mount_id: 'i-only-mount',
    phase: 'i_only_encoding',
    star_row: { phase: 'i_only_star' },
    rotate: true,
    m_kind: 'dummy',
    s_kind: 'star',
    data: {
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
    },
  });
}

/**
 * Compose all jsPsych nodes for one I-only trial.
 *
 * I-only has no retention/maintenance phase — the trial ends after the last
 * star slot — so the ITI is rendered with a blank fixation. The persistent
 * '?' glyph is reserved for conditions that hold items in mind across a
 * retention window (D-only, T-only, I+D, I+T); showing it after a star-only
 * trial would imply an upcoming probe that never comes.
 */
export function iOnlyTrial(params) {
  return [
    ...gatePreambleNodes(params),
    encodingNode(params),
    itiNode({
      phase: 'i_only_iti',
      fixation: '',
      background_shade: params.background_shade,
    }),
  ];
}
