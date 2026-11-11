/**
 * Shared encoding node for all five conditions.
 *
 * One jsPsych node holds the pre-encoding period (rotation + stabilisation
 * for imagery trials, a blank pad otherwise) and the six-slot {M, S}
 * sequence. Every event is placed on one absolute timeline measured from the
 * moment the grid is mounted (t0), so timer error does not accumulate from
 * slot to slot. The node ends itself at t0 + plan.total_ms; the jsPsych
 * `trial_duration` is only a watchdog set above that.
 *
 * Data rules:
 *   - A star's data row is written when its 3000 ms response window closes,
 *     in the same call that removes the star. It does not depend on the
 *     500 ms offset that follows, on the node end, or on any token.
 *   - Closing a node (normal end, watchdog, skip) never drops data: an open
 *     window is closed and written with `truncated: true`; stars that had not
 *     yet started are written with `displayed: false, truncated: true`.
 *   - All timers, animation frames, key listeners and scheduled audio are
 *     cancelled when the node ends, so nothing runs into the next node.
 *
 * Timing rules:
 *   - Visual onsets are applied inside a requestAnimationFrame callback and the
 *     callback's frame time is the recorded onset and the RT origin.
 *   - Tones are scheduled on the audio clock for the planned time, so they do
 *     not depend on timer jitter. For each tone the row keeps the audio clock
 *     and `performance.now()` at the moment of scheduling, the scheduled start
 *     on both clocks and whether scheduling came after the planned onset
 *     (`slot_tone_events`). `audio_output_latency_ms` and `audio_context` are
 *     stored so the acoustic onset can be reconstructed.
 *   - Response time is taken from the key event's own timestamp, not from the
 *     time the handler ran. A key counts only if it lies in [onset, onset +
 *     3000 ms).
 *
 * Event record (what the encoding row stores for every one of the six slots,
 * placeholders included; all arrays are aligned by slot, 0-based at the raw
 * level, and hold null for an event that never happened):
 *   - `slot_onsets_ts_ms`    onset: frame time for dots, stars and placeholders,
 *                            PLANNED time for tones;
 *   - `slot_offsets_ts_ms`   offset on the same performance.now() scale: the frame
 *                            time of the first frame without the element (source
 *                            'frame'; the time of the removal call, source
 *                            'removal_call', when no frame arrived before the node
 *                            ended); for a tone the planned onset plus the nominal
 *                            tone duration (source 'scheduled': not measured). An
 *                            event that was still on when the node was cut short
 *                            gets null and source 'aborted';
 *   - `slot_offset_sources`  how each offset was obtained (null if there is none);
 *   - `slot_planned_onsets_ts_ms` / `slot_planned_offsets_ts_ms`  the plan on the
 *                            same scale (t0 + planned time), complete from the
 *                            moment the node starts;
 *   - `slot_event_kinds`     'dot' | 'tone' | 'star' | 'dummy' (placeholder) per slot.
 * Recording an offset adds one animation-frame request after a removal that
 * already happens; no timer, onset or removal is moved by it.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';

import {
  encodingRecord,
  starRenderFields,
  slotPositionsMm,
  postEncodingRotationDeg,
} from './trial-record.js';
import { config } from '../config.js';
import { createGridFrame, clearStimuli, setFixation, setRotation } from '../visuals/frame.js';
import { addDot, removeElement } from '../visuals/dot.js';
import { addStar, recolourStar } from '../visuals/star.js';
import { addOpenSquare } from '../visuals/dummy.js';
import { playToneByCell, toneForCell } from '../audio/tones.js';
import { getAudioContext, audioContextInfo } from '../audio/context.js';
import { stopAllScheduledAudio } from '../audio/dsp.js';
import { createTrialResponseButtons } from '../visuals/response-buttons.js';
import {
  traceEncodingStart,
  traceSlotEvent,
  traceStarOpen,
  traceStarAnswer,
  traceStarClosed,
  traceKeyIssue,
  traceToneIssue,
  traceSetup,
  traceEncodingCut,
} from '../debug/trace-adapters.js';
import {
  stampTrialData,
  judgeStarResponse,
  emitAuxDataRow,
  eventTime,
  WINDOW_FAILSAFE_MS,
  M_SLOT_MS,
  S_SLOT_MS,
  DOT_VISIBLE_MS,
  STAR_DURATION_MS,
  PRE_ENCODING_PAD_MS,
  ROTATION_ANIMATION_MS,
  FEEDBACK_COLOR_CORRECT,
  FEEDBACK_COLOR_WRONG,
  KEY_ON,
  KEY_OFF,
} from './shared.js';

/* Watchdog margin above the planned encoding length. The node normally ends
 * itself at the planned time; this only bounds a stuck timer. */
const ENCODING_WATCHDOG_MARGIN_MS = 1000;
/* Tones are handed to the audio clock this long before their planned time. */
const AUDIO_LEAD_MS = 80;
const KEY_LOG_MAX = 80;
/* Nominal length of a tone (envelope including its ramps). Tones are scheduled on
 * the audio clock, so their offset is planned, not measured. */
const TONE_NOMINAL_MS = config.tones.duration_ms;

/**
 * Build the event plan. Times are offsets from t0 in ms.
 *
 * @param {object} p
 * @param {string[]} p.sequence          e.g. ['M','S','S','M','M','S']
 * @param {number} p.pre_ms              pre-encoding period
 * @returns {{events: object[], total_ms: number}}
 */
function planEncoding({ sequence, pre_ms }) {
  const events = [];
  let t = pre_ms;
  sequence.forEach((kind, slot) => {
    const slot_ms = kind === 'M' ? M_SLOT_MS : S_SLOT_MS;
    const visible_ms = kind === 'M' ? DOT_VISIBLE_MS : STAR_DURATION_MS;
    events.push({ slot, kind, start_ms: t, visible_ms, slot_ms });
    t += slot_ms;
  });
  return { events, total_ms: t };
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

/**
 * The time on the `performance.now()` scale at which the audio device is
 * expected to emit the sound that is scheduled for `when` (seconds on the
 * audio clock), from the context's output timestamp. That timestamp is the
 * position of the device output, so the estimate includes the output delay.
 * `null` if the browser gives no usable pairing.
 */
function scheduledOnsetPerfMs(ac, when) {
  try {
    const pair = ac.getOutputTimestamp?.();
    if (!pair || !(pair.performanceTime > 0)) return null;
    return round1(pair.performanceTime + (when - pair.contextTime) * 1000);
  } catch {
    return null;
  }
}

/**
 * @param {object} cfg
 * @param {object} cfg.params            trial parameters from the scheduler
 * @param {string} cfg.mount_id
 * @param {string} cfg.phase             e.g. 'i_t_encoding'
 * @param {{phase: string}|null} cfg.star_row   e.g. { phase: 'i_t_star' } (null if no star rows)
 * @param {boolean} cfg.rotate           animate 0 -> the trial's rotation angle before slot 0
 *                                       (`postEncodingRotationDeg(params)`: the imagery angle,
 *                                       or the display angle of a D-only trial)
 * @param {'dot'|'tone'|'dummy'} cfg.m_kind   what an M-slot shows
 * @param {'star'|'dummy'} cfg.s_kind         what an S-slot shows
 * @param {object} [cfg.data]            extra fields for the node's data row
 * @param {{left: string, right: string}|null} [cfg.response_buttons]  practice only: the
 *                                       buttons shown under the circle while a star window is open
 */
export function createEncodingNode(cfg) {
  const {
    params,
    mount_id,
    phase,
    star_row,
    rotate,
    m_kind,
    s_kind,
    data = {},
    frame_rotation_deg = 0,
    response_buttons = null,
  } = cfg;
  const star_phase = star_row ? star_row.phase : null;
  const sequence = params.sequence;
  /* One angle per trial for every condition that rotates (I-only, I+D, I+T and
   * D-only), taken through the same helper the retention and probe frames use. */
  const angle_deg = postEncodingRotationDeg(params);
  const plan = planEncoding({ sequence, pre_ms: PRE_ENCODING_PAD_MS });
  const slot_onsets_ts_ms = new Array(sequence.length).fill(null);
  const slot_offsets_ts_ms = new Array(sequence.length).fill(null);
  const slot_offset_sources = new Array(sequence.length).fill(null);
  const slot_planned_onsets_ts_ms = new Array(sequence.length).fill(null);
  const slot_planned_offsets_ts_ms = new Array(sequence.length).fill(null);
  const slot_audio_context_times_ms = new Array(sequence.length).fill(null);
  const slot_tone_events = [];
  const key_log = [];
  const summary = {
    n_star_rows: 0,
    keys_outside_window: 0,
    key_log_overflow: false,
    rotation_start_ts_ms: null,
  };
  let run = null;

  const slot_positions_mm = slotPositionsMm(params, {
    rotationDeg: rotate ? angle_deg : frame_rotation_deg,
    m_kind,
    s_kind,
  });
  const nodeData = {
    phase,
    trial_index_in_block: params.trial_index_in_block,
    background_shade: params.background_shade,
    sequence: sequence.join(''),
    planned_total_ms: plan.total_ms,
    trial_spec: encodingRecord(params),
    slot_positions_mm,
    slot_event_kinds: slot_positions_mm.map((p) => p.kind),
    slot_onsets_ts_ms,
    slot_offsets_ts_ms,
    slot_offset_sources,
    slot_planned_onsets_ts_ms,
    slot_planned_offsets_ts_ms,
    slot_audio_context_times_ms,
    slot_tone_events,
    key_log,
    ...data,
  };

  return {
    type: htmlKeyboardResponse,
    stimulus: `<div id="${mount_id}" style="margin: 0 auto;"></div>`,
    choices: 'NO_KEYS',
    trial_duration: plan.total_ms + ENCODING_WATCHDOG_MARGIN_MS,
    on_load: () => {
      slot_onsets_ts_ms.fill(null);
      slot_offsets_ts_ms.fill(null);
      slot_offset_sources.fill(null);
      slot_planned_onsets_ts_ms.fill(null);
      slot_planned_offsets_ts_ms.fill(null);
      slot_audio_context_times_ms.fill(null);
      slot_tone_events.length = 0;
      key_log.length = 0;
      summary.n_star_rows = 0;
      summary.keys_outside_window = 0;
      summary.key_log_overflow = false;
      summary.rotation_start_ts_ms = null;

      const mount = document.getElementById(mount_id);
      const frame = createGridFrame({
        rotation_deg: frame_rotation_deg,
        fixation: '',
        background_shade: params.background_shade,
      });
      mount.appendChild(frame.wrapper);
      stampTrialData('encoding_onset_ts_ms', performance.now());

      run = startRun({
        frame,
        params,
        plan,
        rotate,
        angle_deg,
        m_kind,
        s_kind,
        star_phase,
        response_buttons,
        slot_onsets_ts_ms,
        slot_offsets_ts_ms,
        slot_offset_sources,
        slot_planned_onsets_ts_ms,
        slot_planned_offsets_ts_ms,
        slot_audio_context_times_ms,
        slot_tone_events,
        key_log,
        summary,
        block_label: window.jsPsych?.getCurrentTrial?.()?.data?.block_label ?? null,
      });
    },
    on_finish: (trialData) => {
      if (run) run.abort('finish');
      /* Copies, so a replayed node (practice re-loop) cannot overwrite them. */
      trialData.slot_onsets_ts_ms = slot_onsets_ts_ms.slice();
      trialData.slot_offsets_ts_ms = slot_offsets_ts_ms.slice();
      trialData.slot_offset_sources = slot_offset_sources.slice();
      trialData.slot_planned_onsets_ts_ms = slot_planned_onsets_ts_ms.slice();
      trialData.slot_planned_offsets_ts_ms = slot_planned_offsets_ts_ms.slice();
      trialData.slot_audio_context_times_ms = slot_audio_context_times_ms.slice();
      trialData.slot_tone_events = slot_tone_events.slice();
      trialData.tone_error = slot_tone_events.some((e) => e.error !== null);
      trialData.key_log = key_log.slice();
      trialData.key_log_t0_ms = run ? Math.round(run.t0) : null;
      trialData.key_log_overflow = summary.key_log_overflow;
      trialData.rotation_start_ts_ms = summary.rotation_start_ts_ms;
      trialData.n_star_rows = summary.n_star_rows;
      trialData.n_star_rows_expected = star_phase ? params.stars.length : 0;
      trialData.keys_outside_window = summary.keys_outside_window;
      trialData.audio_output_latency_ms = run ? run.audioLatencyMs : null;
      trialData.audio_context = audioContextInfo();
      run = null;
    },
    data: nodeData,
  };
}

function startRun(ctx) {
  const { frame, params, plan, rotate, angle_deg, m_kind, s_kind, star_phase, summary, key_log } =
    ctx;
  /* Practice only: the response buttons, shown for as long as a star window is open. */
  const buttons = ctx.response_buttons
    ? createTrialResponseButtons({ labels: ctx.response_buttons, anchorEl: frame.wrapper })
    : null;
  const t0 = performance.now();
  /* Experimenter trace (null unless debug mode is on): the planned stream, printed once. */
  const traceSlots = traceEncodingStart(params, { m_kind, s_kind, events: plan.events, t0 });
  const timers = new Set();
  const frames = new Set();
  let aborted = false;
  let openWindow = null;
  const closedSlots = new Set();
  const toneSlots = new Set();

  let audioLatencyMs = null;
  try {
    const ac = getAudioContext();
    audioLatencyMs = round1(((ac.outputLatency || 0) + (ac.baseLatency || 0)) * 1000);
  } catch {
    audioLatencyMs = null;
  }

  const at = (planned_ms, fn) => {
    const delay = Math.max(0, t0 + planned_ms - performance.now());
    const id = setTimeout(() => {
      timers.delete(id);
      if (!aborted) fn();
    }, delay);
    timers.add(id);
  };
  const afterMs = (ms, fn) => {
    const id = setTimeout(
      () => {
        timers.delete(id);
        if (!aborted) fn();
      },
      Math.max(0, ms)
    );
    timers.add(id);
  };
  const nextFrame = (fn) => {
    const id = requestAnimationFrame((ts) => {
      frames.delete(id);
      if (!aborted) fn(ts);
    });
    frames.add(id);
  };

  /* Take an element off the grid and record the offset of its slot. The offset is the
   * time of the removal call at first and is replaced by the time of the next animation
   * frame (the first frame in which the element is gone: the same kind of timestamp as
   * the onset, which is the frame the element first appears in) when that frame arrives.
   * The extra frame request changes nothing about when the element is removed. */
  const removeAndRecordOffset = (slot, el) => {
    removeElement(el);
    ctx.slot_offsets_ts_ms[slot] = Math.round(performance.now());
    ctx.slot_offset_sources[slot] = 'removal_call';
    nextFrame((ts) => {
      ctx.slot_offsets_ts_ms[slot] = Math.round(ts);
      ctx.slot_offset_sources[slot] = 'frame';
    });
  };

  /* One key listener for the whole node. It logs every arrow key and routes
   * it to the open star window, if there is one. */
  const onKey = (e) => {
    if (e.repeat) return;
    const k = String(e.key).toLowerCase();
    if (k !== KEY_ON && k !== KEY_OFF) return;
    e.preventDefault();
    e.stopPropagation();
    const t = eventTime(e);
    if (key_log.length < KEY_LOG_MAX) key_log.push([k === KEY_ON ? 'R' : 'L', Math.round(t - t0)]);
    else summary.key_log_overflow = true;
    if (openWindow) openWindow.onKey(k, t);
    else {
      summary.keys_outside_window += 1;
      traceKeyIssue('outside', 'extra', k);
    }
  };
  window.addEventListener('keydown', onKey, { capture: true });

  /* ---- Star window ---- */
  function openStarWindow(ev, star) {
    const w = {
      slot: ev.slot,
      star,
      onset: null,
      el: null,
      closed: false,
      responded: false,
      said_on: null,
      response_key: null,
      response_rt_ms: null,
      response_ts_ms: null,
      correct: null,
      early: 0,
      late: 0,
      extra: 0,
      onsetLagMs: null,
    };
    openWindow = w;
    nextFrame((ts) => {
      if (w.closed) return;
      w.el = addStar(frame, star.cell);
      buttons?.show();
      /* The angle the star was actually drawn at (read from the frame), so the row
       * records what was rendered and not only what was planned. */
      w.drawn_rotation_deg = frame.rotation_deg;
      w.onset = ts;
      traceStarOpen(ev.slot, star, ts);
      ctx.slot_onsets_ts_ms[ev.slot] = Math.round(ts);
      w.onsetLagMs = round1(ts - (t0 + ev.start_ms));
      afterMs(ts + STAR_DURATION_MS - performance.now(), () => closeStarWindow(w, false));
    });
    /* If no frame arrives, still close and write the row. */
    at(ev.start_ms + STAR_DURATION_MS + WINDOW_FAILSAFE_MS, () => closeStarWindow(w, false));
    w.onKey = (k, t) => {
      if (w.closed || w.onset === null) {
        summary.keys_outside_window += 1;
        traceKeyIssue('outside', 'early', k);
        return;
      }
      const rt = t - w.onset;
      if (rt < 0) {
        w.early += 1;
        traceKeyIssue('star', 'early', k);
        return;
      }
      if (rt >= STAR_DURATION_MS) {
        w.late += 1;
        traceKeyIssue('star', 'late', k);
        return;
      }
      if (w.responded) {
        w.extra += 1;
        traceKeyIssue('star', 'extra', k);
        return;
      }
      w.responded = true;
      buttons?.press(k);
      w.response_key = k;
      w.response_rt_ms = Math.max(1, Math.round(rt));
      w.response_ts_ms = Math.round(t);
      const judged = judgeStarResponse(k, star.is_on_pattern);
      w.said_on = judged.said_on;
      w.correct = judged.correct;
      /* Recolour in the key handler; it is painted on the next frame. */
      recolourStar(w.el, w.correct ? FEEDBACK_COLOR_CORRECT : FEEDBACK_COLOR_WRONG);
      traceStarAnswer(ev.slot, star, w, t);
    };
    return w;
  }

  function closeStarWindow(w, truncated) {
    if (w.closed) return;
    w.closed = true;
    if (openWindow === w) openWindow = null;
    buttons?.hide();
    closedSlots.add(w.slot);
    if (w.el) {
      if (truncated) {
        /* Cut short by the end of the node: the star was on for less than its
         * window, so no offset is recorded (see `abort`). */
        removeElement(w.el);
        ctx.slot_offset_sources[w.slot] = 'aborted';
      } else {
        removeAndRecordOffset(w.slot, w.el);
      }
    }
    traceStarClosed(w.slot, w, truncated);
    writeStarRow(w, truncated);
  }

  function writeStarRow(w, truncated) {
    const star = w.star;
    emitAuxDataRow({
      phase: star_phase,
      ...(params.trial_meta ?? {}),
      block_label: params.trial_meta?.block_label ?? ctx.block_label,
      ...starRenderFields(star, w.drawn_rotation_deg ?? params.rotation_deg),
      background_shade: params.background_shade ?? null,
      trial_index_in_block: params.trial_index_in_block,
      rotation_deg: params.rotation_deg,
      probe_position: star.probe_position,
      slot_index_in_seq: star.slot_index_in_seq,
      probed_cell: star.cell,
      pattern_label: star.pattern_label,
      is_on_pattern: star.is_on_pattern,
      responded: w.responded,
      said_on: w.said_on,
      response_key: w.response_key,
      response_rt_ms: w.response_rt_ms,
      response_ts_ms: w.response_ts_ms ?? null,
      star_correct: w.correct === true,
      star_onset_ts_ms: w.onset === null ? null : Math.round(w.onset),
      star_onset_lag_ms: w.onsetLagMs,
      window_closed_ts_ms: Math.round(performance.now()),
      displayed: w.onset !== null,
      truncated: !!truncated,
      early_keypresses: w.early,
      late_keypresses: w.late,
      extra_keypresses: w.extra,
    });
    summary.n_star_rows += 1;
  }

  /* ---- Build the event table ---- */
  const byMemory = new Map(params.memory_items?.map((m) => [m.slot_index_in_seq, m]) ?? []);
  const byStar = new Map(params.stars?.map((s) => [s.slot_index_in_seq, s]) ?? []);
  const byDummy = new Map(params.dummies?.map((d) => [d.slot_index_in_seq, d]) ?? []);

  /* ---- Pre-encoding rotation ---- */
  if (rotate) {
    frame.rotor.style.transition = `transform ${ROTATION_ANIMATION_MS}ms ease-in-out`;
    nextFrame((ts) => {
      setRotation(frame, angle_deg);
      summary.rotation_start_ts_ms = Math.round(ts);
      traceSetup('rotation_turn', { rotation_deg: angle_deg, duration_ms: ROTATION_ANIMATION_MS });
    });
    at(ROTATION_ANIMATION_MS + 50, () => {
      frame.rotor.style.transition = '';
      traceSetup('rotation_hold', {
        rotation_deg: angle_deg,
        duration_ms: PRE_ENCODING_PAD_MS - ROTATION_ANIMATION_MS,
      });
    });
  } else {
    traceSetup('blank_pad', { duration_ms: PRE_ENCODING_PAD_MS });
  }

  /* ---- Slots ---- */
  for (const ev of plan.events) {
    /* The plan on the timeline of the recorded onsets and offsets. */
    const plannedMs =
      ev.kind === 'M' && m_kind === 'tone' && byMemory.has(ev.slot)
        ? TONE_NOMINAL_MS
        : ev.visible_ms;
    ctx.slot_planned_onsets_ts_ms[ev.slot] = Math.round(t0 + ev.start_ms);
    ctx.slot_planned_offsets_ts_ms[ev.slot] = Math.round(t0 + ev.start_ms + plannedMs);
    if (ev.kind === 'M') {
      const item = byMemory.get(ev.slot);
      const dummy = byDummy.get(ev.slot);
      if (m_kind === 'tone' && item) {
        at(ev.start_ms - AUDIO_LEAD_MS, () => {
          const planned = t0 + ev.start_ms;
          ctx.slot_onsets_ts_ms[ev.slot] = Math.round(planned);
          /* Scheduled, not measured: the planned onset plus the nominal duration. */
          ctx.slot_offsets_ts_ms[ev.slot] = Math.round(planned + TONE_NOMINAL_MS);
          ctx.slot_offset_sources[ev.slot] = 'scheduled';
          toneSlots.add(ev.slot);
          const event = {
            slot: ev.slot,
            cell: item.cell,
            tone_index: toneForCell(item.cell).index,
            planned_ts_ms: Math.round(planned),
            perf_at_schedule_ms: null,
            ac_time_at_schedule_ms: null,
            when_ms: null,
            scheduled_onset_perf_ms: null,
            nominal_duration_ms: TONE_NOMINAL_MS,
            scheduled_offset_perf_ms: null,
            late_ms: null,
            late: null,
            error: null,
          };
          ctx.slot_tone_events.push(event);
          try {
            const ac = getAudioContext();
            const perfNow = performance.now();
            const when = ac.currentTime + Math.max(0, planned - perfNow) / 1000;
            event.perf_at_schedule_ms = round1(perfNow);
            event.ac_time_at_schedule_ms = round1(ac.currentTime * 1000);
            event.when_ms = Math.round(when * 1000);
            event.scheduled_onset_perf_ms = scheduledOnsetPerfMs(ac, when);
            event.scheduled_offset_perf_ms =
              event.scheduled_onset_perf_ms === null
                ? null
                : round1(event.scheduled_onset_perf_ms + TONE_NOMINAL_MS);
            event.late_ms = round1(Math.max(0, perfNow - planned));
            event.late = perfNow > planned;
            ctx.slot_audio_context_times_ms[ev.slot] = Math.round(when * 1000);
            Promise.resolve(playToneByCell(item.cell, { when })).catch((err) => {
              event.error = String(err?.message ?? err);
              traceToneIssue({ error: event.error }, ev.slot);
            });
          } catch (err) {
            event.error = String(err?.message ?? err);
          }
          traceSlotEvent(traceSlots, ev.slot, planned);
          traceToneIssue(event, ev.slot);
        });
      } else {
        const cell = (item ?? dummy)?.cell;
        at(ev.start_ms, () => {
          nextFrame((ts) => {
            ctx.slot_onsets_ts_ms[ev.slot] = Math.round(ts);
            traceSlotEvent(traceSlots, ev.slot, ts);
            if (cell === undefined) return;
            const el =
              m_kind === 'dot' && item
                ? addDot(frame, cell)
                : addOpenSquare(frame, cell, { visible: false });
            afterMs(ts + ev.visible_ms - performance.now(), () =>
              removeAndRecordOffset(ev.slot, el)
            );
          });
        });
      }
    } else {
      const star = byStar.get(ev.slot);
      const dummy = byDummy.get(ev.slot);
      if (s_kind === 'star' && star) {
        at(ev.start_ms, () => openStarWindow(ev, star));
      } else {
        const cell = (star ?? dummy)?.cell;
        at(ev.start_ms, () => {
          nextFrame((ts) => {
            ctx.slot_onsets_ts_ms[ev.slot] = Math.round(ts);
            traceSlotEvent(traceSlots, ev.slot, ts);
            if (cell === undefined) return;
            const el = addOpenSquare(frame, cell, { visible: false });
            afterMs(ts + ev.visible_ms - performance.now(), () =>
              removeAndRecordOffset(ev.slot, el)
            );
          });
        });
      }
    }
  }

  /* ---- End of node ---- */
  at(plan.total_ms, () => {
    abort('complete');
    window.jsPsych?.finishTrial?.();
  });

  function abort(reason) {
    if (aborted) return;
    if (reason !== 'complete') traceEncodingCut(reason);
    /* Write any star that is still open or has not started, before the
     * timers are cleared. */
    if (openWindow) closeStarWindow(openWindow, true);
    if (star_phase) {
      for (const star of params.stars) {
        if (!closedSlots.has(star.slot_index_in_seq)) {
          closedSlots.add(star.slot_index_in_seq);
          traceStarClosed(star.slot_index_in_seq, { onset: null }, true);
          writeStarRow(
            {
              slot: star.slot_index_in_seq,
              star,
              onset: null,
              responded: false,
              said_on: null,
              response_key: null,
              response_rt_ms: null,
              correct: null,
              early: 0,
              late: 0,
              extra: 0,
              onsetLagMs: null,
            },
            true
          );
        }
      }
    }
    /* An event that was still running when the node was cut short has no offset: what
     * was shown is shorter than planned, so a value here would be wrong. A tone is
     * scheduled ahead, so its planned offset is kept only if it had already passed. */
    const nowTs = performance.now();
    for (let slot = 0; slot < ctx.slot_onsets_ts_ms.length; slot++) {
      if (ctx.slot_onsets_ts_ms[slot] === null) continue;
      if (toneSlots.has(slot)) {
        if (nowTs < ctx.slot_planned_offsets_ts_ms[slot]) {
          ctx.slot_offsets_ts_ms[slot] = null;
          ctx.slot_offset_sources[slot] = 'aborted';
        }
      } else if (ctx.slot_offsets_ts_ms[slot] === null && ctx.slot_offset_sources[slot] === null) {
        ctx.slot_offset_sources[slot] = 'aborted';
      }
    }
    aborted = true;
    buttons?.hide();
    for (const id of timers) clearTimeout(id);
    timers.clear();
    for (const id of frames) cancelAnimationFrame(id);
    frames.clear();
    window.removeEventListener('keydown', onKey, { capture: true });
    frame.rotor.style.transition = '';
    clearStimuli(frame);
    setFixation(frame, '');
    if (reason !== 'complete') stopAllScheduledAudio();
  }

  return { abort, audioLatencyMs, t0 };
}
