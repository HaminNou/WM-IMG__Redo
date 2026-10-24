/**
 * D-only (dots-only single-task) trial.
 *
 * Sequence:
 *   1. Trial-start gate: participant presses both arrow keys together to
 *      arm the trial.
 *   2. Pre-stimulus pad (1500 ms): empty circle
 *      with no fixation. The same temporal envelope as the rotation
 *      animation + stabilisation in imagery trials, applied here even
 *      though there is no rotation, so that the gap between gate-pass
 *      and the first encoding stimulus is matched across trial types.
 *   3. Encoding (length-6 sequence): for each event,
 *        M-slot → white dot at the assigned cell, 1000 ms visible, 500 ms blank.
 *        S-slot → open-square dummy at a non-item cell, visible for
 *                 3000 ms, followed by a 500 ms empty-circle offset.
 *   4. Retention 2000 ms with central question mark.
 *   5. Three recognition probes in the precomputed probe order. Probe-type
 *      balance is enforced across the block, not fixed within each trial.
 *      Each probe: a single dot at the
 *      probed cell, shown for a fixed 3000 ms response window. Answered
 *      probes recolour on the still-visible dot and remain on screen until
 *      the 3000 ms onset ends; a 500 ms question-mark-only offset then
 *      hands directly to the next probe (probes run back-to-back).
 *   6. Final ITI 800 ms.
 *
 * Returns an array of jsPsych trial objects. The data uploader will
 * concatenate them into the trial-record stream with `phase` tags.
 */
import { createEncodingNode } from './encoding-schedule.js';

import { probeRenderFields } from './trial-record.js';
import { addDot, removeElement } from '../visuals/dot.js';
import {
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

/* Encoding length = 1500 ms pre-stim pad + 3×M + 3×S. The pad keeps the
 * gate-pass → first-stimulus gap byte-identical to the imagery trials'
 * rotation-animation (500 ms) + stabilisation (1000 ms) interval. The
 * trial-start gate is a separate node and ends immediately on a valid
 * two-key response, so none of its duration comes out of this budget. */

/**
 * Trial-start gate (both-arrow-keys, no arrow for D-only
 * since there is no rotation to pre-imagine). The persistent grid +
 * bull's-eye remain visible while the participant arms the trial.
 */
function trialStartNode(params) {
  return trialStartGateNode({
    trial_index_in_block: params.trial_index_in_block,
    showArrow: false,
    phase: 'd_only_trial_start',
    background_shade: params.background_shade,
    trialType: 'd_only',
    data: { background_shade: params.background_shade },
  });
}

/**
 * Build the encoding trial node for one D-only trial. The full encoding
 * sequence runs inside a single jsPsych trial so the participant sees one
 * uninterrupted grid; we drive timing via setTimeout from `on_load`.
 */
function encodingNode(params) {
  return createEncodingNode({
    params,
    mount_id: 'd-only-mount',
    phase: 'd_only_encoding',
    star_row: null,
    rotate: false,
    frame_rotation_deg: params.display_rotation_deg ?? 0,
    m_kind: 'dot',
    s_kind: 'dummy',
    data: {
      display_rotation_deg: params.display_rotation_deg ?? 0,
      memory_items: params.memory_items.map((m) => ({
        slot: m.slot_index_in_seq,
        encoding_position: m.encoding_position,
        cell: m.cell,
        pattern_label: m.pattern_label,
      })),
      dummies: params.dummies.map((d) => ({
        slot: d.slot_index_in_seq,
        cell: d.cell,
      })),
    },
  });
}

function retentionNode(params) {
  return frameNode({
    mount_id: 'd-only-retention-mount',
    phase: 'd_only_retention',
    trial_duration: RETENTION_MS,
    fixation: '?',
    rotation_deg: params.display_rotation_deg ?? 0,
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
    mount_id: 'd-only-probe-mount',
    phase: 'd_only_probe',
    onset_ms: PROBE_RESPONSE_MS,
    offset_ms: PROBE_OFFSET_MS,
    fixation: '?',
    rotation_deg: params.display_rotation_deg ?? 0,
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
 * Compose all the jsPsych nodes for one D-only trial. The caller appends
 * the array into the global timeline.
 */
export function dOnlyTrial(params) {
  const out = [trialStartNode(params), encodingNode(params), retentionNode(params)];
  for (const probe of params.probes) {
    out.push(probeNode(params, probe));
  }
  out.push(itiNode({ phase: 'd_only_iti', background_shade: params.background_shade }));
  return out;
}
