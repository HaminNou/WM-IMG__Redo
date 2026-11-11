/**
 * Glue between the trial code and the console trace (debug mode only).
 *
 * The trial composers hold the trial's plan (`params`) in the shape the scheduler produced. The trace
 * wants flat, display-ready records. This module turns the one into the other, in ONE place, so that the
 * five composers and the shared nodes stay at one-line call sites and print the same layout.
 *
 * Two kinds of export:
 *  - pure builders (`traceMetaFromParams`, `buildEncodingSlots`, `probeTraceInfo`, `keyName`): no state,
 *    no console, unit-tested;
 *  - thin guarded wrappers (`traceTrialStart`, `traceSlotEvent`, `traceProbeOnset`, ...): they return at
 *    once when the trace is off, never throw, and only READ values the trial code already computed (the
 *    results of judgeProbeResponse / judgeStarResponse, the recorded row fields). They never score.
 *
 * The wrappers keep a tiny per-trial tally of early / late / extra keys (stars and probes) so the trial
 * summary can report them; it is reset at every trial start.
 */
import { trace, isTraceOn } from './trace.js';
import { toneForCell } from '../audio/tones.js';
import { slotPositionsMm, postEncodingRotationDeg } from '../conditions/trial-record.js';

const KEY_NAMES = Object.freeze({
  arrowright: 'ArrowRight',
  arrowleft: 'ArrowLeft',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  ' ': 'Space',
});

/** Display name of a key as the code stores it (lower-case `e.key`): `arrowright` -> `ArrowRight`. */
export function keyName(key) {
  if (key === null || key === undefined) return '(none)';
  const k = String(key);
  return KEY_NAMES[k.toLowerCase()] ?? k;
}

/**
 * Header record of a trial for `trace.trialStart`.
 * @param {object} params   trial parameters from the scheduler
 * @param {object} [live]   the LIVE data of the running gate node (carries `main_trial_number_overall`, which
 *                          is stamped after the factories ran)
 */
export function traceMetaFromParams(params, live) {
  const meta = params?.trial_meta ?? {};
  const isPractice = meta.is_practice === true;
  const mainNo = live?.main_trial_number_overall;
  return {
    trial_type: params?.trial_type ?? meta.condition,
    trial_no: Number.isFinite(mainNo)
      ? mainNo
      : isPractice && Number.isFinite(meta.block_position)
        ? meta.block_position + 1
        : undefined,
    trial_total: Number.isFinite(live?.main_trial_total) ? live.main_trial_total : undefined,
    block_label: meta.block_label ?? live?.block_label,
    presentation_index: meta.presentation_index ?? undefined,
    pool_index: Number.isFinite(meta.pool_index) ? meta.pool_index : undefined,
    is_practice: isPractice,
    background_shade: params?.background_shade ?? undefined,
    rotation_deg: postEncodingRotationDeg(params),
    pattern_reminder: meta.pattern_reminder === true,
    trial_uid: meta.trial_uid,
  };
}

/**
 * The planned 6-slot stream for `trace.encodingPlan`.
 * Kinds come from slotPositionsMm (the same rule that fills the data row's `slot_event_kinds`).
 * @param {object} params
 * @param {{m_kind: 'dot'|'tone'|'dummy', s_kind: 'star'|'dummy', onsets_ms?: number[]}} opts
 *        `onsets_ms[i]`: planned onset of slot i, ms from encoding start
 * @returns {object[]} slots numbered 1..6
 */
export function buildEncodingSlots(params, { m_kind, s_kind, onsets_ms = [] }) {
  const memory = new Map((params.memory_items ?? []).map((m) => [m.slot_index_in_seq, m]));
  const stars = new Map((params.stars ?? []).map((s) => [s.slot_index_in_seq, s]));
  const testNoOf = new Map();
  (params.probes ?? []).forEach((p) => {
    if (p.is_target === true) testNoOf.set(p.encoding_position, p.probe_position + 1);
  });
  return slotPositionsMm(params, { rotationDeg: 0, m_kind, s_kind }).map((p) => {
    const slot = { slot: p.slot + 1, serial_pos: p.slot + 1, onset_ms: onsets_ms[p.slot] };
    if (p.kind === 'dot' || p.kind === 'tone') {
      const m = memory.get(p.slot);
      slot.kind = p.kind;
      slot.cell = m.cell;
      slot.on_pattern = m.pattern_label === 'on';
      if (p.kind === 'tone') {
        const tone = toneForCell(m.cell);
        slot.tone_index = tone.index;
        slot.freq_hz = tone.freq_hz;
      }
      slot.tested_as = testNoOf.get(m.encoding_position) ?? null;
    } else if (p.kind === 'star') {
      const s = stars.get(p.slot);
      slot.kind = 'star';
      slot.cell = s.cell;
      slot.on_pattern = s.is_on_pattern === true;
      slot.tested_as = 'judged live';
    } else {
      slot.kind = 'hidden';
      slot.tested_as = null;
    }
    return slot;
  });
}

/**
 * Probe record for `trace.probe` (and the answer that follows).
 * @param {object} params
 * @param {object} probe   one entry of `params.probes`
 * @param {'dot'|'tone'} kind
 */
export function probeTraceInfo(params, probe, kind) {
  const info = {
    test_no: probe.probe_position + 1,
    test_total: (params.probes ?? []).length,
    label: probe.type,
    kind,
    cell: probe.cell,
    on_pattern: probe.pattern_label === 'on',
    is_target: probe.is_target === true,
    encoded_pos: probe.is_target === true ? probe.encoding_position + 1 : null,
  };
  if (kind === 'tone') {
    const tone = toneForCell(probe.cell);
    info.tone_index = tone.index;
    info.freq_hz = tone.freq_hz;
  }
  return info;
}

/* ------------------------------------------------------------ guarded wrappers */

/** Build-time probe spec for a probe node: `null` (no work at all) when the trace is off. */
export function traceProbeSpec(params, probe, kind) {
  if (!isTraceOn()) return null;
  try {
    return probeTraceInfo(params, probe, kind);
  } catch {
    return null;
  }
}

const tally = { early: 0, late: 0, extra: 0, probes: 0 };
const resetTally = () => {
  tally.early = tally.late = tally.extra = tally.probes = 0;
};
const liveData = () => window.jsPsych?.getCurrentTrial?.()?.data;

/** Run `fn` only when the trace is on; never throws. */
function safely(fn) {
  if (!isTraceOn()) return;
  try {
    fn();
  } catch {
    /* the trace never breaks a trial */
  }
}

/** Gate on_load: open the trial group (reads the LIVE data for the trial number) and note the wait. */
export function traceTrialStart(params) {
  safely(() => {
    resetTally();
    trace.trialStart(traceMetaFromParams(params, liveData()));
    trace.setup('gate', 'waiting for both arrow keys');
  });
}

/** Trial summary and close (ITI on_finish). */
export function traceTrialEnd() {
  safely(() => {
    trace.trialEnd({ early_keys: tally.early, late_keys: tally.late, extra_keys: tally.extra });
    resetTally();
  });
}

/**
 * Encoding node start: print the planned stream. Returns the slot list for traceSlotEvent
 * (`null` when the trace is off, so the call sites cost nothing).
 */
export function traceEncodingStart(params, { m_kind, s_kind, events, t0 }) {
  if (!isTraceOn()) return null;
  try {
    const slots = buildEncodingSlots(params, {
      m_kind,
      s_kind,
      onsets_ms: events.map((e) => e.start_ms),
    });
    trace.encodingPlan(slots, { t0_ms: t0 });
    return slots;
  } catch {
    return null;
  }
}

/** One live encoding line for slot index `idx` of the plan built by buildEncodingSlots. */
export function traceSlotEvent(slots, idx, at_ms, note) {
  safely(() => {
    const s = slots?.[idx];
    if (!s) return;
    const hidden = s.kind === 'hidden';
    trace.encodingEvent(s.slot, {
      kind: s.kind,
      cell: hidden ? undefined : s.cell,
      on_pattern: hidden ? undefined : s.on_pattern,
      tone_index: s.tone_index,
      freq_hz: s.freq_hz,
      at_ms,
      note: note ?? (hidden ? 'invisible placeholder' : undefined),
    });
  });
}

/** A star window opened (rAF frame time `at_ms`). `star` is the plan record (`params.stars[i]`). */
export function traceStarOpen(slotIdx, star, at_ms) {
  safely(() =>
    trace.star({
      event: 'open',
      slot: slotIdx + 1,
      cell: star.cell,
      on_pattern: star.is_on_pattern,
      at_ms,
    })
  );
}

/** The accepted star answer plus its feedback colour, from the window's already-judged fields. */
export function traceStarAnswer(slotIdx, star, w, at_ms) {
  safely(() => {
    trace.star({
      event: 'response',
      slot: slotIdx + 1,
      cell: star.cell,
      on_pattern: star.is_on_pattern,
      key: keyName(w.response_key),
      said_on: w.said_on,
      correct: w.correct,
      rt_ms: w.response_rt_ms,
      at_ms,
    });
    trace.star({ event: 'feedback', feedback: w.correct ? 'green' : 'red', correct: w.correct });
  });
}

/** A star window closed; `w` is the window record (responded / truncated / displayed). */
export function traceStarClosed(slotIdx, w, truncated) {
  safely(() => {
    if (w.onset === null || w.onset === undefined) {
      trace.warn(`star slot ${slotIdx + 1} never shown (trial ended first)`);
      return;
    }
    if (truncated) trace.warn(`star slot ${slotIdx + 1} cut short (trial ended first)`);
    trace.star({ event: 'closed', slot: slotIdx + 1, responded: w.responded });
    if (!w.responded) trace.star({ event: 'feedback', feedback: 'none' });
  });
}

/**
 * An early / late / extra key (counted in the trial summary).
 * @param {'star'|'probe'|'outside'} where
 * @param {'early'|'late'|'extra'} kind
 */
export function traceKeyIssue(where, kind, key) {
  safely(() => {
    if (where !== 'outside' && kind in tally) tally[kind] += 1;
    if (where === 'star') trace.star({ event: kind, key: keyName(key) });
    else if (where === 'probe') {
      const why =
        kind === 'early'
          ? 'probe not yet on screen'
          : kind === 'late'
            ? 'window already over'
            : 'already answered';
      trace.warn(`${kind} key ${keyName(key)} (${why})`);
    } else trace.warn(`key ${keyName(key)} outside any response window (not counted)`);
  });
}

/** Probe onset (rAF frame time `at_ms`). `info` comes from probeTraceInfo. */
export function traceProbeOnset(info, at_ms) {
  safely(() => {
    tally.probes += 1;
    trace.probe({ ...info, at_ms });
  });
}

/** The accepted probe answer, read from the window state the composer's on_response just filled. */
export function traceProbeAnswer(info, state, key) {
  safely(() =>
    trace.probeResponse({
      key: keyName(key),
      said_yes: state.said_yes,
      expected_yes: info.is_target,
      correct: state.probe_correct,
      rt_ms: state.response_rt_ms,
      feedback: state.probe_correct ? 'green' : 'red',
      at_ms: state.response_ts_ms,
    })
  );
}

/** The probe window ended: print the miss when nothing was answered; after the last probe print the recall table. */
export function traceProbeClosed(info, state) {
  safely(() => {
    if (state.onset_ts === null) return;
    if (state.response_key === null) {
      trace.probeResponse({ no_response: true, expected_yes: info.is_target, feedback: 'none' });
    }
    if (info.test_no === info.test_total) trace.recallSummary();
  });
}

/** A one-line marker between trials (rest, block boundary, practice attempt / notice); closes an open trial group by default. */
export function traceMarker(text, closeTrial = true) {
  safely(() => trace.marker(text, { closeTrial }));
}

/** A setup line (`kind`: gate | arrow_cue | imagination | retention | iti | ...). */
export function traceSetup(kind, detail) {
  safely(() => trace.setup(kind, detail));
}

/** The encoding node was cut short (watchdog, skip, abort). */
export function traceEncodingCut(reason) {
  safely(() => trace.warn(`encoding cut short (${reason})`));
}

/** Tone scheduling problems: late scheduling and errors, from the recorded tone event. */
export function traceToneIssue(event, slotIdx) {
  safely(() => {
    if (event.late === true) {
      trace.warn(`tone slot ${slotIdx + 1} scheduled late by ${event.late_ms} ms`);
    }
    if (event.error) trace.warn(`tone slot ${slotIdx + 1} error: ${event.error}`);
  });
}
