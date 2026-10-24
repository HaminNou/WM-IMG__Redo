/**
 * T-only (tones-only single-task) trial.
 *
 * Sequence (mirrors d_only.js, with tones replacing dots):
 *   1. Trial-start gate: participant presses both arrow keys together to
 *      arm the trial.
 *   2. Pre-stimulus pad (1500 ms): empty circle
 *      with no fixation. The same temporal envelope as the rotation
 *      animation + stabilisation in imagery trials, applied here even
 *      though there is no rotation, so that the gap between gate-pass
 *      and the first encoding stimulus is matched across trial types.
 *   3. Encoding (length-6 sequence): for each event,
 *        M-slot → tone (350 ms) at the assigned cell's paired frequency
 *                  (analytic mapping; participant hears only the tone),
 *                  followed by 1150 ms silence = 1500 ms slot.
 *        S-slot → open-square dummy in a non-centre cell (visual filler;
 *                 participant is told to ignore it). Visible for 3000 ms,
 *                 followed by a 500 ms empty-circle offset.
 *   4. Retention 2000 ms with central question mark.
 *   5. Three recognition probes; each plays a single tone (the probed cell's
 *      paired tone). Each probe stays on screen for a fixed 3000 ms
 *      response window; answered probes recolour the central '?'
 *      immediately and keep that colour until the 3000 ms onset ends.
 *      A 500 ms question-mark-only offset then hands directly to the next
 *      probe (probes run back-to-back).
 *   6. Final ITI.
 *
 * Note: unlike D-only, T-only's encoding has no visible memory stimulus;
 * the open-square dummies are still visible (so there is *something* on the
 * grid to look at, helping the participant maintain a comparable visual
 * orientation across conditions). The grid frame and centre fixation remain
 * visible throughout encoding.
 */
import { createEncodingNode } from './encoding-schedule.js';

import { setFixation } from '../visuals/frame.js';
import { toneForCell } from '../audio/tones.js';
import {
  playProbeTone,
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
 * two-key response. */

/**
 * Trial-start gate (both-arrow-keys, no arrow for T-only
 * since there is no rotation to pre-imagine).
 */
function trialStartNode(params) {
  return trialStartGateNode({
    trial_index_in_block: params.trial_index_in_block,
    showArrow: false,
    phase: 't_only_trial_start',
    background_shade: params.background_shade,
    trialType: 't_only',
    data: { background_shade: params.background_shade },
  });
}

function encodingNode(params) {
  return createEncodingNode({
    params,
    mount_id: 't-only-mount',
    phase: 't_only_encoding',
    star_row: null,
    rotate: false,
    m_kind: 'tone',
    s_kind: 'dummy',
    data: {
      memory_items: params.memory_items.map((m) => ({
        slot: m.slot_index_in_seq,
        encoding_position: m.encoding_position,
        cell: m.cell,
        tone_index: toneForCell(m.cell).index,
        tone_freq_hz: toneForCell(m.cell).freq_hz,
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
    mount_id: 't-only-retention-mount',
    phase: 't_only_retention',
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
    mount_id: 't-only-probe-mount',
    phase: 't_only_probe',
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

export function tOnlyTrial(params) {
  const out = [trialStartNode(params), encodingNode(params), retentionNode(params)];
  for (const probe of params.probes) {
    out.push(probeNode(params, probe));
  }
  out.push(itiNode({ phase: 't_only_iti', background_shade: params.background_shade }));
  return out;
}
