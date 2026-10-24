/**
 * I+T (imagery + tones) dual-task trial.
 *
 * Sequence (mirrors i_d.js with tones replacing dots; identical imagery
 * portion):
 *   1. Trial-start gate (empty circle + "press both arrow keys to start
 *      the next trial" hint, no arrow). The trial does not begin until
 *      the participant presses both arrow keys; never auto-passes.
 *   2. Rotation cue (2000 ms). Mounted only AFTER the gate fires, so
 *      the arrow presentation is unambiguously part of the trial.
 *   3. Imagination period (3500 ms): empty circle
 *      with no arrow. Fixed-duration window in which the participant
 *      pre-imagines the rotated pattern; no input is accepted.
 *   4. Encoding node (single jsPsych trial; async on_load schedule):
 *        a. Mount frame at rotation = 0°.
 *        b. Animate rotation 0 → rotation_deg over 500 ms.
 *        c. Stabilisation 1000 ms with the rotated grid visible.
 *        d. For each slot in the 6-event {M, S} sequence:
 *             M-slot → tone (350 ms) at the assigned cell's paired frequency
 *                      (audio-only, no visual change), 1500 ms total slot.
 *             S-slot → star at the assigned cell, visible for 3000 ms,
 *                      then a 500 ms empty-circle offset. Same
 *                      ArrowRight/ArrowLeft + synchronous recolour
 *                      feedback as I-only for answered stars only;
 *                      skipped stars receive no feedback.
 *        e. Tear down stimuli; restore fixation.
 *   5. Retention 2000 ms.
 *   6. Three recognition probes — each plays the probed cell's paired tone
 *      while the central '?' remains visible, for a fixed 3000 ms response
 *      window. Answered probes recolour the still-visible '?' and keep that
 *      colour until the 3000 ms onset ends; a 500 ms question-mark-only
 *      offset then hands directly to the next probe (probes run
 *      back-to-back).
 *   7. Final ITI.
 *
 * Per-star data rows are emitted via `jsPsych.data.write({...})` (`i_t_star`
 * phase). Probe data is on the probe nodes (`i_t_probe` phase).
 */
import { createEncodingNode } from './encoding-schedule.js';

import { setFixation } from '../visuals/frame.js';
import { toneForCell } from '../audio/tones.js';
import {
  playProbeTone,
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
 * Trial preamble for imagery + tone trials — see
 * `i_only.js#gatePreambleNodes` for the full rationale of the
 * empty-circle gate → both-arrow-keys → rotation-cue → imagination flow.
 */
function gatePreambleNodes(params) {
  return [
    trialStartGateNode({
      trial_index_in_block: params.trial_index_in_block,
      showArrow: true,
      rotation_deg: params.rotation_deg,
      phase: 'i_t_trial_start',
      background_shade: params.background_shade,
      trialType: 'i_t',
      data: {
        rotation_deg: params.rotation_deg,
        background_shade: params.background_shade,
      },
    }),
    arrowCueNode({
      trial_index_in_block: params.trial_index_in_block,
      rotation_deg: params.rotation_deg,
      phase: 'i_t_arrow_cue',
      background_shade: params.background_shade,
      data: { background_shade: params.background_shade },
    }),
    imaginationNode({
      trial_index_in_block: params.trial_index_in_block,
      rotation_deg: params.rotation_deg,
      phase: 'i_t_imagination',
      background_shade: params.background_shade,
      data: { background_shade: params.background_shade },
    }),
  ];
}

function encodingNode(params) {
  return createEncodingNode({
    params,
    mount_id: 'i-t-mount',
    phase: 'i_t_encoding',
    star_row: { phase: 'i_t_star' },
    rotate: true,
    m_kind: 'tone',
    s_kind: 'star',
    data: {
      rotation_deg: params.rotation_deg,
      memory_items: params.memory_items.map((m) => ({
        slot: m.slot_index_in_seq,
        encoding_position: m.encoding_position,
        cell: m.cell,
        tone_index: toneForCell(m.cell).index,
        tone_freq_hz: toneForCell(m.cell).freq_hz,
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
    mount_id: 'i-t-retention-mount',
    phase: 'i_t_retention',
    trial_duration: RETENTION_MS,
    fixation: '?',
    background_shade: params.background_shade,
    timestamp_field: 'retention_onset_ts_ms',
    data: {
      trial_index_in_block: params.trial_index_in_block,
      background_shade: params.background_shade,
    },
  });
}

function probeNode(params, probe) {
  const tone = toneForCell(probe.cell);
  return timedResponseWindowNode({
    mount_id: 'i-t-probe-mount',
    phase: 'i_t_probe',
    onset_ms: PROBE_RESPONSE_MS,
    offset_ms: PROBE_OFFSET_MS,
    fixation: '?',
    background_shade: params.background_shade,
    allowed_keys: [KEY_YES, KEY_NO],
    timestamp_field: 'probe_onset_ts_ms',
    data: {
      trial_index_in_block: params.trial_index_in_block,
      background_shade: params.background_shade,
    },
    on_onset: () => {
      playProbeTone(probe.cell);
    },
    on_response: (frame, state, key) => {
      const judged = judgeProbeResponse(key, probe.is_target);
      state.said_yes = judged.said_yes ?? null;
      state.probe_correct = judged.correct;
      setFixation(frame, '?', {
        color: judged.correct ? FEEDBACK_COLOR_CORRECT : FEEDBACK_COLOR_WRONG,
      });
    },
    on_onset_end: (frame) => {
      setFixation(frame, '?');
    },
    on_finish: (data, state) => {
      const judged = judgeProbeResponse(state.response_key, probe.is_target);
      data.probe_position = probe.probe_position;
      data.encoding_position = probe.encoding_position;
      data.probe_type = probe.type;
      data.probed_cell = probe.cell;
      data.probed_tone_index = tone.index;
      data.probed_tone_freq_hz = tone.freq_hz;
      data.probe_pattern_label = probe.pattern_label;
      data.is_target = probe.is_target;
      data.responded = judged.responded;
      data.said_yes = judged.said_yes ?? null;
      data.probe_correct = judged.correct;
    },
  });
}

/**
 * Compose all jsPsych nodes for one I+T trial.
 */
export function iTTrial(params) {
  const out = [...gatePreambleNodes(params), encodingNode(params), retentionNode(params)];
  for (const probe of params.probes) {
    out.push(probeNode(params, probe));
  }
  out.push(itiNode({ phase: 'i_t_iti', background_shade: params.background_shade }));
  return out;
}
