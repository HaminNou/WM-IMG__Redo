/**
 * I+D (imagery + dots) dual-task trial.
 *
 * Sequence:
 *   1. Trial-start gate (empty circle + "press both arrow keys to start
 *      the next trial" hint, no arrow). The trial does not begin until
 *      the participant presses both arrow keys; never auto-passes.
 *   2. Rotation cue (2000 ms): centre-screen arrow showing the required
 *      turn of the frame. Mounted only AFTER the gate fires, so the
 *      arrow presentation is unambiguously part of the trial.
 *   3. Imagination period (3500 ms): empty circle
 *      with no arrow. Fixed-duration window in which the participant
 *      pre-imagines the rotated pattern; no input is accepted.
 *   4. Encoding node (single jsPsych trial; async on_load schedule so the
 *      grid frame mounts once and we avoid between-event flicker):
 *        a. Mount frame at rotation = 0°.
 *        b. Animate rotation 0 → rotation_deg over 500 ms.
 *        c. Stabilisation 1000 ms with the rotated grid visible.
 *        d. For each slot in the 6-event memory/star sequence:
 *             M-slot → white dot at the assigned cell, 1000 ms visible,
 *                      500 ms blank (= 1500 ms total).
 *             S-slot → star at the assigned cell, visible for 3000 ms,
 *                      then a 500 ms empty-circle offset. Listen for
 *                      ArrowRight/ArrowLeft. Answered stars recolour
 *                      green/red SYNCHRONOUSLY on keypress.
 *                      Skipped stars receive no feedback.
 *        e. Tear down stimuli; restore fixation.
 *   5. Retention 2000 ms with central question mark.
 *   6. Three recognition probes in the precomputed probe order. Probe type
 *      balance is enforced across the block, not fixed within each trial.
 *      Each probe: a single
 *      dot at the probed cell in the trial-rotated frame, shown for a fixed
 *      3000 ms response window. Answered probes recolour on the still-
 *      visible dot and stay on screen until the 3000 ms onset ends; a
 *      500 ms question-mark-only offset then hands directly to the next
 *      probe (probes run back-to-back).
 *   7. Final ITI 800 ms.
 *
 * Per-star data rows are emitted via `jsPsych.data.write({...})` so each
 * star produces an `i_d_star` row alongside the encoding node. Probe data
 * is captured on the probe nodes (`i_d_probe` phase) — both stream into the
 * uploader uniformly.
 */
import { createEncodingNode } from './encoding-schedule.js';
import { probeRenderFields } from './trial-record.js';

import { addDot, removeElement } from '../visuals/dot.js';
import {
  arrowCueNode,
  imaginationNode,
  trialStartGateNode,
  timedResponseWindowNode,
  frameNode,
  judgeProbeResponse,
  itiNode,
  RETENTION_MS,
  PROBE_RESPONSE_MS,
  PROBE_OFFSET_MS,
  FEEDBACK_COLOR_CORRECT,
  FEEDBACK_COLOR_WRONG,
  KEY_YES,
  KEY_NO,
} from './shared.js';

/**
 * Trial preamble for imagery + dot trials — see
 * `i_only.js#gatePreambleNodes` for the full rationale of the
 * empty-circle gate → both-arrow-keys → rotation-cue → imagination flow.
 */
function gatePreambleNodes(params) {
  return [
    trialStartGateNode({
      trial_index_in_block: params.trial_index_in_block,
      showArrow: true,
      rotation_deg: params.rotation_deg,
      phase: 'i_d_trial_start',
      background_shade: params.background_shade,
      trialType: 'i_d',
      data: {
        rotation_deg: params.rotation_deg,
        background_shade: params.background_shade,
      },
    }),
    arrowCueNode({
      trial_index_in_block: params.trial_index_in_block,
      rotation_deg: params.rotation_deg,
      phase: 'i_d_arrow_cue',
      background_shade: params.background_shade,
      data: { background_shade: params.background_shade },
    }),
    imaginationNode({
      trial_index_in_block: params.trial_index_in_block,
      rotation_deg: params.rotation_deg,
      phase: 'i_d_imagination',
      background_shade: params.background_shade,
      data: { background_shade: params.background_shade },
    }),
  ];
}

function encodingNode(params) {
  return createEncodingNode({
    params,
    mount_id: 'i-d-mount',
    phase: 'i_d_encoding',
    star_row: { phase: 'i_d_star' },
    rotate: true,
    m_kind: 'dot',
    s_kind: 'star',
    data: {
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
    },
  });
}

function retentionNode(params) {
  return frameNode({
    mount_id: 'i-d-retention-mount',
    phase: 'i_d_retention',
    trial_duration: RETENTION_MS,
    fixation: '?',
    rotation_deg: params.rotation_deg,
    background_shade: params.background_shade,
    timestamp_field: 'retention_onset_ts_ms',
    data: {
      trial_index_in_block: params.trial_index_in_block,
      background_shade: params.background_shade,
    },
  });
}

function probeNode(params, probe) {
  return timedResponseWindowNode({
    mount_id: 'i-d-probe-mount',
    phase: 'i_d_probe',
    onset_ms: PROBE_RESPONSE_MS,
    offset_ms: PROBE_OFFSET_MS,
    fixation: '?',
    rotation_deg: params.rotation_deg,
    background_shade: params.background_shade,
    allowed_keys: [KEY_YES, KEY_NO],
    timestamp_field: 'probe_onset_ts_ms',
    data: {
      trial_index_in_block: params.trial_index_in_block,
      background_shade: params.background_shade,
    },
    on_load: (frame, state) => {
      state.probeDot = addDot(frame, probe.cell);
    },
    on_response: (_frame, state, key) => {
      const judged = judgeProbeResponse(key, probe.is_target);
      state.said_yes = judged.said_yes ?? null;
      state.probe_correct = judged.correct;
      const color = judged.correct ? FEEDBACK_COLOR_CORRECT : FEEDBACK_COLOR_WRONG;
      if (state.probeDot) state.probeDot.setAttribute('fill', color);
    },
    on_onset_end: (_frame, state) => {
      removeElement(state.probeDot);
      state.probeDot = null;
    },
    on_finish: (data, state) => {
      const judged = judgeProbeResponse(state.response_key, probe.is_target);
      data.probe_position = probe.probe_position;
      Object.assign(data, probeRenderFields(probe, state.frame));
      data.encoding_position = probe.encoding_position;
      data.probe_type = probe.type;
      data.probed_cell = probe.cell;
      data.probe_pattern_label = probe.pattern_label;
      data.is_target = probe.is_target;
      data.responded = judged.responded;
      data.said_yes = judged.said_yes ?? null;
      data.probe_correct = judged.correct;
    },
  });
}

/**
 * Compose all jsPsych nodes for one I+D trial.
 */
export function iDTrial(params) {
  const out = [...gatePreambleNodes(params), encodingNode(params), retentionNode(params)];
  for (const probe of params.probes) {
    out.push(probeNode(params, probe));
  }
  out.push(itiNode({ phase: 'i_d_iti', background_shade: params.background_shade }));
  return out;
}
