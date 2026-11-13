/**
 * Experimenter console trace of a running trial (debug mode only).
 *
 * One coherent API, called with one-liners from the trial code:
 *
 *   trace.banner()                     once, when the session starts
 *   trace.trialStart(meta)             opens the trial's console group
 *   trace.setup(kind, detail)          gate / pattern reminder / arrow cue / imagination / rotation / retention / iti
 *   trace.encodingPlan(slots)          opens ENCODING, prints the 6-slot plan as a table
 *   trace.encodingEvent(slot, info)    one live line per encoding slot
 *   trace.star(info)                   star window events (open / response / closed / feedback / early / late / extra)
 *   trace.recallStart()                opens RECALL
 *   trace.probe(info)                  a memory probe at onset
 *   trace.probeResponse(info)          the response to that probe
 *   trace.recallSummary([rows])        table of the recall (built from probe/probeResponse when no rows are given)
 *   trace.trialEnd(summary)            one-line summary, closes everything
 *   trace.abort(reason)                trial ended abnormally: warn and close everything
 *   trace.marker(text, opts)           rest / block boundary / practice notice line
 *   trace.warn(text, data)             console.warn for an anomaly
 *   trace.mute(on)                     silence the trace while the experimenter skips trials (hidden-nav)
 *
 * Rules that make it safe:
 *  - Active only in debug mode (see debug-mode.js). The decision is read ONCE at module load into a
 *    module-level boolean; when off every function returns on its first statement. Callers whose
 *    arguments are expensive to build should guard with `if (isTraceOn())`.
 *  - It only reads values the trial code already computed (the variables written to the data rows
 *    and used for feedback). It never recomputes scoring, never awaits, never touches the DOM and
 *    never throws (each function body runs inside try/catch).
 *  - Console groups are managed by a small state machine: one group per trial, with at most one
 *    nested sub-group (ENCODING or RECALL) open at a time. trialEnd / abort / the next trialStart
 *    close whatever is open, so groups are always balanced; out-of-order calls open the sub-group
 *    they need, or print flat lines when no trial is open.
 *  - All styling comes from the one STYLES table and all symbols from SYMBOLS.
 *
 * Time stamps: lines inside ENCODING show seconds since encoding started (the plan's slot onsets are on
 * that clock); every other line shows seconds since the trial started. Callers may pass `rel_ms` (already
 * relative) or `at_ms` (a performance.now() value) on any info object; otherwise the current time is used.
 */
import { isDebugMode } from './debug-mode.js';
import { resetReveal, setRevealNote } from './reveal.js';
import { config } from '../config.js';
import { BUILD_COMMIT, BUILD_TIME } from '../build-info.js';
import { cellRowCol, isOnPattern, isCentre } from '../grid.js';
import { TRIAL_TYPE_TAG_COLOURS } from '../conditions/trial-counter.js';

/** Symbols used in every line (one table so the legend and the lines never drift apart). */
export const SYMBOLS = Object.freeze({
  dot: '●',
  tone: '♪',
  star: '★',
  hidden: '▢',
  ok: '✔',
  bad: '✘',
  arrow: '→',
  sub: '⤷',
  setup: '⚙',
  warn: '⚠',
  target: 'T',
  foil: 'F',
});

/** %c styles used by the trace (one table). */
export const STYLES = Object.freeze({
  none: '',
  head: 'font-weight:bold',
  time: 'color:#8a8a8a;font-family:monospace',
  label: 'font-weight:bold;color:#555',
  dim: 'color:#8a8a8a',
  on: 'color:#0b7a5a;font-weight:bold',
  off: 'color:#b3541e;font-weight:bold',
  ok: 'color:#1a8a1a;font-weight:bold',
  bad: 'color:#d02020;font-weight:bold',
  warn: 'color:#b36b00;font-weight:bold',
  sub: 'background:#555;color:#fff;padding:0 6px;border-radius:3px;font-weight:bold',
  banner: 'background:#222;color:#ffd24d;padding:2px 8px;border-radius:3px;font-weight:bold',
});

/** Task names, same wording as the trial-type tag above the circle. */
export const TASK_LABELS = Object.freeze({
  d_only: 'Dots',
  t_only: 'Tones',
  i_only: 'Stars',
  i_d: 'Stars + Dots',
  i_t: 'Stars + Tones',
});

const KIND_SYMBOL = Object.freeze({
  dot: SYMBOLS.dot,
  tone: SYMBOLS.tone,
  star: SYMBOLS.star,
  hidden: SYMBOLS.hidden,
});

/* ---------------------------------------------------------------- state */

let ON = false;
/* Muted while the experimenter skips forward (hidden-nav U): the neutralised trials run through
 * their nodes in a few milliseconds and must not print a group each. */
let MUTED = false;
try {
  ON = isDebugMode();
} catch {
  ON = false;
}

let nowFn = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function freshState() {
  return {
    open: false /* the trial group is open */,
    sub: null /* 'ENCODING' | 'RECALL' | null */,
    t0: null,
    encT0: null,
    rows: [] /* recall rows collected from probe/probeResponse */,
    pending: null /* the probe awaiting its response */,
    tally: {
      memory_correct: 0,
      memory_total: 0,
      stars_correct: 0,
      stars_total: 0,
      no_responses: 0,
      anticipatory: 0,
      early: 0,
      late: 0,
      extra: 0,
    },
  };
}
let st = freshState();

/** Is the trace on? Cheap; use it to guard any expensive argument construction. */
export function isTraceOn() {
  return ON;
}

/** Test helper: switch the trace on/off (closes any open groups when switching off). */
export function _setTraceEnabled(on) {
  if (!on) closeAll();
  ON = on === true;
  if (!ON) {
    st = freshState();
    MUTED = false;
  }
}

/** Test helper: inject the clock (a function returning ms). */
export function _setTraceClock(fn) {
  nowFn = typeof fn === 'function' ? fn : () => performance.now();
}

/** Test helper: forget all state without touching the console. */
export function _resetTraceState() {
  st = freshState();
}

/** Test helper: number of console groups the trace currently has open. */
export function _openGroupDepth() {
  return (st.open ? 1 : 0) + (st.sub ? 1 : 0);
}

/* ------------------------------------------------------------ formatting */

/**
 * Build console arguments from parts. A part is a string (unstyled) or `[text, styleKey]`.
 * @param {Array<string|[string,string]>} parts
 * @returns {string[]} `[formatString, ...cssStrings]`
 */
function fmt(parts) {
  let f = '';
  const css = [];
  for (const p of parts) {
    const [text, style] = Array.isArray(p) ? p : [p, 'none'];
    f += `%c${String(text).replace(/%/g, '%%')}`;
    css.push(STYLES[style] ?? '');
  }
  return [f, ...css];
}

function out(method, parts, ...rest) {
  console[method](...fmt(parts), ...rest);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function secs(ms) {
  return `${ms < 0 ? '-' : '+'}${(Math.abs(ms) / 1000).toFixed(2)} s`;
}

/** Time prefix of a line: relative to encoding start inside ENCODING, otherwise to trial start. */
function stamp(info) {
  let rel;
  if (isNum(info?.rel_ms)) rel = info.rel_ms;
  else {
    const at = isNum(info?.at_ms) ? info.at_ms : nowFn();
    const base = st.sub === 'ENCODING' && st.encT0 !== null ? st.encT0 : st.t0;
    rel = base === null ? 0 : at - base;
  }
  return [secs(rel).padStart(9, ' '), 'time'];
}

const dir = (deg) =>
  !isNum(deg) || deg === 0 ? 'none' : deg > 0 ? 'clockwise' : 'counter-clockwise';
const signed = (deg) => `${deg > 0 ? '+' : ''}${Math.round(deg * 100) / 100}°`;

function cellText(cell) {
  if (!Number.isInteger(cell) || cell < 0 || cell > 24) return 'cell ?';
  const { row, col } = cellRowCol(cell);
  return `cell ${cell} (r${row},c${col})`;
}

/** `[text, style]` for ON/OFF-pattern; uses the value the caller computed, else the pattern definition. */
function tagPart(info) {
  let on = info?.on_pattern;
  if (typeof on !== 'boolean' && Number.isInteger(info?.cell) && !isCentre(info.cell)) {
    on = isOnPattern(info.cell);
  }
  if (typeof on !== 'boolean') return null;
  return on ? ['ON', 'on'] : ['OFF', 'off'];
}

function toneText(info) {
  const bits = [];
  if (isNum(info?.tone_index)) bits.push(`tone #${info.tone_index}`);
  if (isNum(info?.freq_hz)) bits.push(`${Math.round(info.freq_hz * 10) / 10} Hz`);
  return bits.join(' ');
}

/** Stimulus description parts: symbol + KIND + cell + tag (+ tone). */
function stimulusParts(info) {
  const kind = typeof info?.kind === 'string' ? info.kind : null;
  const parts = [];
  if (kind) {
    parts.push([`${KIND_SYMBOL[kind] ?? '?'} ${kind.toUpperCase()}`, 'head'], '  ');
  }
  if (kind !== 'hidden') {
    parts.push(cellText(info?.cell));
    const tag = tagPart(info);
    if (tag) parts.push('  ', tag);
    const tone = toneText(info);
    if (tone) parts.push('  ', [tone, 'dim']);
  }
  return parts;
}

function yn(v) {
  return v === true ? 'ON' : v === false ? 'NOT-on' : '?';
}

function resultPart(correct) {
  if (correct === true) return [`${SYMBOLS.ok} CORRECT`, 'ok'];
  if (correct === false) return [`${SYMBOLS.bad} INCORRECT`, 'bad'];
  return ['(unscored)', 'dim'];
}

/** `rotation_deg=+37° (clockwise)`, `duration_ms=500` -> `duration=500 ms`, booleans yes/no. */
function kv(detail) {
  if (detail === null || detail === undefined) return '';
  if (typeof detail !== 'object') return String(detail);
  const bits = [];
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined) continue;
    if (isNum(v) && k.endsWith('_deg')) {
      const name = k.slice(0, -4);
      bits.push(
        `${name}=${signed(v)}${k === 'rotation_deg' || k === 'arrow_deg' ? ` (${dir(v)})` : ''}`
      );
    } else if (isNum(v) && k.endsWith('_ms')) bits.push(`${k.slice(0, -3)}=${v} ms`);
    else if (typeof v === 'boolean') bits.push(`${k}=${v ? 'yes' : 'no'}`);
    else if (typeof v === 'object') bits.push(`${k}=${JSON.stringify(v)}`);
    else bits.push(`${k}=${v}`);
  }
  return bits.join('  ');
}

/* ---------------------------------------------------------- group machine */

function closeSub() {
  if (st.sub) {
    console.groupEnd();
    st.sub = null;
  }
}

function closeAll() {
  closeSub();
  if (st.open) {
    console.groupEnd();
    st.open = false;
  }
}

function openSub(name) {
  if (st.sub === name) return;
  closeSub();
  if (!st.open) {
    /* No trial group: print a flat header rather than leaving a dangling group. */
    out('log', [[`── ${name} (no open trial) ──`, 'sub']]);
    return;
  }
  console.group(...fmt([[` ${name} `, 'sub']]));
  st.sub = name;
  if (name === 'ENCODING') st.encT0 = nowFn();
}

/** Wrap a function: no-op when off, never throws. */
function guarded(fn) {
  return (...args) => {
    if (!ON || MUTED) return undefined;
    try {
      return fn(...args);
    } catch {
      return undefined;
    }
  };
}

/* ------------------------------------------------------------ public API */

/**
 * @typedef {object} TrialMeta
 * @property {string} trial_type        'd_only' | 't_only' | 'i_only' | 'i_d' | 'i_t'
 * @property {number} [trial_no]        overall 1-based number (main task: 1..120)
 * @property {number} [trial_total]     total trials (e.g. 120)
 * @property {string} [block_label]     'practice' | 'main_a' | 'main_b'
 * @property {number} [presentation_index] 1-based position in the block
 * @property {number} [pool_index]      raw 0-based pool index
 * @property {boolean} [is_practice]
 * @property {string} [background_shade] 'white' | 'gray'
 * @property {number} [rotation_deg]    grid rotation of the trial (signed, clockwise positive)
 * @property {boolean} [pattern_reminder] the trial carries the pattern reminder
 * @property {string} [trial_uid]
 */

const trialStart = guarded((meta = {}) => {
  if (st.open) {
    /* The previous trial never reached trialEnd/abort: say so before the group is closed. */
    out('warn', [
      [`${SYMBOLS.warn} TRIAL ABORTED: next trial started before this one ended`, 'warn'],
    ]);
  }
  closeAll();
  st = freshState();
  st.t0 = isNum(meta.at_ms) ? meta.at_ms : nowFn();
  const type = meta.trial_type ?? meta.condition;
  const colour = TRIAL_TYPE_TAG_COLOURS[type] || '#888';
  const practice = meta.is_practice === true || meta.block_label === 'practice';
  const head = [];
  head.push(
    isNum(meta.trial_no)
      ? `TRIAL ${meta.trial_no}${isNum(meta.trial_total) ? `/${meta.trial_total}` : ''}`
      : 'TRIAL'
  );
  const bits = [];
  if (meta.block_label) {
    bits.push(
      `${meta.block_label}${isNum(meta.presentation_index) ? ` #${meta.presentation_index}` : ''}`
    );
  }
  if (isNum(meta.pool_index)) bits.push(`pool ${meta.pool_index}`);
  if (meta.background_shade) bits.push(`shade=${meta.background_shade}`);
  if (isNum(meta.rotation_deg))
    bits.push(`rotation=${signed(meta.rotation_deg)} (${dir(meta.rotation_deg)})`);
  if (typeof meta.pattern_reminder === 'boolean') {
    bits.push(`reminder=${meta.pattern_reminder ? 'yes' : 'no'}`);
  }
  const parts = [[head[0], 'head'], '  '];
  parts.push([` ${TASK_LABELS[type] ?? type ?? '?'} `, 'none']);
  if (practice) parts.push('  ', ['PRACTICE', 'warn']);
  if (bits.length) parts.push('  ', bits.join('  '));
  const [f, ...css] = fmt(parts);
  /* The task badge is coloured per task: its %c is the third one (after the title and the gap). */
  css[2] = `background:${colour};color:#fff;padding:1px 7px;border-radius:3px;font-weight:bold`;
  console.group(f, ...css);
  st.open = true;
});

/**
 * Print the one-time legend and active flags.
 * @param {{seed?: string|number, extra?: object}} [info]
 */
const banner = guarded((info = {}) => {
  const search = typeof window !== 'undefined' ? (window.location?.search ?? '') : '';
  console.group(
    ...fmt([
      [' DEBUG TRACE ON ', 'banner'],
      '  experimenter use only: the console shows the answers',
    ])
  );
  out('log', [
    ['legend  ', 'label'],
    `${SYMBOLS.dot} dot  ${SYMBOLS.tone} tone  ${SYMBOLS.star} star  ${SYMBOLS.hidden} hidden placeholder  `,
    [`${SYMBOLS.ok} correct`, 'ok'],
    '  ',
    [`${SYMBOLS.bad} incorrect`, 'bad'],
    '  ',
    ['ON', 'on'],
    ' / ',
    ['OFF', 'off'],
    ' = on/off the pattern  ',
    `${SYMBOLS.target} target  ${SYMBOLS.foil} foil`,
  ]);
  out('log', [
    ['times   ', 'label'],
    'inside ENCODING: seconds since encoding start; elsewhere: seconds since trial start',
  ]);
  out('log', [
    ['reveal  ', 'label'],
    'press G twice quickly to show/hide the hidden grid + pattern (each toggle is logged to the data)',
  ]);
  out('log', [
    ['plan    ', 'label'],
    'the whole session plan is printed below the banner (balances, every trial); window.__WM_PLAN__ holds it, window.__WM_PLAN_DOWNLOAD__() saves it as JSON',
  ]);
  out('log', [['url     ', 'label'], search || '(none)']);
  out('log', [['build   ', 'label'], `${config.build_id} (${BUILD_COMMIT}, ${BUILD_TIME})`]);
  if (info.seed !== undefined && info.seed !== null)
    out('log', [['seed    ', 'label'], String(info.seed)]);
  if (info.extra && typeof info.extra === 'object')
    out('log', [['info    ', 'label'], kv(info.extra)]);
  console.groupEnd();
});

/**
 * One setup line (not part of ENCODING/RECALL). `kind` is free text, conventionally one of:
 * 'gate', 'pattern_reminder', 'arrow_cue' (detail: arrow_deg, rotation_deg), 'imagination',
 * 'rotation_turn', 'rotation_hold' (rotation_deg, duration_ms), 'retention', 'iti'.
 * 'retention', 'iti' and 'encoding_end' first close an open ENCODING / RECALL sub-group.
 * @param {string} kind
 * @param {string|object} [detail] text, or an object formatted as key=value (`*_deg` -> degrees, `*_ms` -> ms)
 */
const setup = guarded((kind, detail) => {
  if (kind === 'retention' || kind === 'iti' || kind === 'encoding_end') closeSub();
  const label = String(kind ?? 'setup')
    .replace(/_/g, ' ')
    .toUpperCase();
  /* Inside ENCODING the stamp is on the encoding clock (rotation turn / hold): say so. */
  const clock = st.sub === 'ENCODING' ? '  (encoding clock)' : '';
  out('log', [
    stamp(detail),
    '  ',
    [`${SYMBOLS.setup} ${label}`, 'label'],
    '  ',
    kv(detail),
    ...(clock ? [[clock, 'dim']] : []),
  ]);
});

/**
 * @typedef {object} PlanSlot
 * @property {number} slot            0- or 1-based slot number as used by the trial code
 * @property {number} [serial_pos]    serial position overall
 * @property {'dot'|'tone'|'star'|'hidden'} kind
 * @property {number} [cell]          0-24
 * @property {boolean} [on_pattern]
 * @property {number} [tone_index]
 * @property {number} [freq_hz]
 * @property {number} [onset_ms]      planned onset
 * @property {number|string|null} [tested_as] test number it is tested at later, or null/'not tested'
 */

/**
 * Open ENCODING and print the planned stream as a table.
 * @param {PlanSlot[]} slots
 * @param {{t0_ms?: number}} [opts] performance.now() at which encoding started (default: now)
 */
const encodingPlan = guarded((slots, opts = {}) => {
  openSub('ENCODING');
  if (isNum(opts.t0_ms)) st.encT0 = opts.t0_ms;
  const rows = (Array.isArray(slots) ? slots : []).map((s) => {
    const tag = tagPart(s);
    const hidden = s?.kind === 'hidden';
    return {
      /* `slot` = serial position 1-6 of the stream (not the memory-item number of the recall lines) */
      slot: s?.serial_pos ?? s?.slot,
      kind: `${KIND_SYMBOL[s?.kind] ?? '?'} ${String(s?.kind ?? '?').toUpperCase()}`,
      cell: hidden ? '' : s?.cell,
      'row,col':
        hidden || !Number.isInteger(s?.cell) || s.cell < 0 || s.cell > 24
          ? ''
          : `r${cellRowCol(s.cell).row},c${cellRowCol(s.cell).col}`,
      tag: hidden || !tag ? '' : tag[0],
      tone: toneText(s),
      onset_ms: s?.onset_ms ?? '',
      tested:
        s?.tested_as === null || s?.tested_as === undefined
          ? 'not tested'
          : typeof s.tested_as === 'number'
            ? `test #${s.tested_as}`
            : s.tested_as,
    };
  });
  out('log', [['plan', 'label'], '  planned stream (times are ms from encoding start)']);
  console.table(rows);
});

/**
 * One live line for an encoding slot (dot / tone / hidden placeholder shown).
 * @param {number} slot
 * @param {{kind:'dot'|'tone'|'star'|'hidden', cell?:number, on_pattern?:boolean, tone_index?:number, freq_hz?:number, note?:string, rel_ms?:number, at_ms?:number}} info
 */
const encodingEvent = guarded((slot, info = {}) => {
  openSub('ENCODING');
  out('log', [
    stamp(info),
    '  ',
    [`slot ${slot}`, 'label'],
    '  ',
    ...stimulusParts(info),
    ...(info.note ? ['  ', [String(info.note), 'dim']] : []),
  ]);
});

/**
 * A star window event. `event` selects the line:
 *  'open'      {slot, cell, on_pattern}
 *  'response'  {key, said_on, on_pattern (truth), correct, rt_ms}
 *  'closed'    {responded}  (a warning when false)
 *  'feedback'  {feedback: 'green'|'red'|..., correct}
 *  'early' | 'late' | 'extra'  {key}   (warn)
 * @param {{event:string, slot?:number, cell?:number, on_pattern?:boolean, key?:string, said_on?:boolean, correct?:boolean, rt_ms?:number, responded?:boolean, feedback?:string, rel_ms?:number, at_ms?:number}} info
 */
const star = guarded((info = {}) => {
  openSub('ENCODING');
  const t = stamp(info);
  const slotPart = isNum(info.slot) ? [[`slot ${info.slot}`, 'label'], '  '] : [];
  switch (info.event) {
    case 'open':
      st.tally.stars_total += 1;
      out('log', [
        t,
        '  ',
        ...slotPart,
        ...stimulusParts({ ...info, kind: 'star' }),
        '  ',
        ['window OPEN', 'dim'],
      ]);
      break;
    case 'response': {
      if (info.correct === true) st.tally.stars_correct += 1;
      if (isNum(info.rt_ms) && info.rt_ms < config.rt_cutoff_ms) st.tally.anticipatory += 1;
      out('log', [
        t,
        '  ',
        `   ${SYMBOLS.sub} key ${info.key ?? '?'} ${SYMBOLS.arrow} says ${yn(info.said_on)} · truth ${yn(info.on_pattern)} ${SYMBOLS.arrow} `,
        resultPart(info.correct),
        isNum(info.rt_ms) ? ` · rt ${Math.round(info.rt_ms)} ms` : '',
      ]);
      break;
    }
    case 'closed':
      out('log', [t, '  ', `   ${SYMBOLS.sub} star window CLOSED`]);
      if (info.responded === false) {
        st.tally.no_responses += 1;
        out('warn', [t, '  ', [`${SYMBOLS.warn} star: no response`, 'warn']]);
      }
      break;
    case 'feedback':
      out('log', [
        t,
        '  ',
        `   ${SYMBOLS.sub} feedback `,
        [String(info.feedback ?? '?').toUpperCase(), info.correct === false ? 'bad' : 'ok'],
      ]);
      break;
    case 'early':
    case 'late':
    case 'extra':
      if (info.event in st.tally) st.tally[info.event] += 1;
      out('warn', [
        t,
        '  ',
        [
          `${SYMBOLS.warn} ${info.event} key ${info.key ?? '?'} (star ${info.event === 'early' ? 'not yet on screen' : info.event === 'late' ? 'window already over' : 'already answered'})`,
          'warn',
        ],
      ]);
      break;
    default:
      out('log', [t, '  ', ...slotPart, `star ${info.event ?? '?'}`]);
  }
});

/** Open the RECALL sub-group. */
const recallStart = guarded(() => {
  openSub('RECALL');
});

/**
 * A memory probe at onset.
 * @param {{test_no?:number, test_total?:number, label?:string, kind:'dot'|'tone', cell?:number, on_pattern?:boolean, tone_index?:number, freq_hz?:number, is_target?:boolean, encoded_pos?:number|null, rel_ms?:number, at_ms?:number}} info
 */
const probe = guarded((info = {}) => {
  openSub('RECALL');
  st.pending = info;
  st.tally.memory_total += 1;
  const test = isNum(info.test_no)
    ? `TEST ${info.test_no}${isNum(info.test_total) ? `/${info.test_total}` : ''}`
    : 'TEST';
  const role =
    info.is_target === true
      ? [`TARGET${isNum(info.encoded_pos) ? ` (memory item ${info.encoded_pos})` : ''}`, 'head']
      : info.is_target === false
        ? ['FOIL', 'head']
        : ['?', 'dim'];
  out('log', [
    stamp(info),
    '  ',
    [test, 'label'],
    '  ',
    ...(info.label ? [[String(info.label), 'dim'], '  '] : []),
    ...stimulusParts(info),
    '  ',
    role,
  ]);
});

/**
 * The response to the current probe (or its absence).
 * @param {{key?:string|null, said_yes?:boolean, expected_yes?:boolean, correct?:boolean, rt_ms?:number|null, feedback?:string, no_response?:boolean, rel_ms?:number, at_ms?:number}} info
 */
const probeResponse = guarded((info = {}) => {
  openSub('RECALL');
  const t = stamp(info);
  const none = info.no_response === true || info.key === null || info.key === undefined;
  const p = st.pending ?? {};
  if (none) {
    st.tally.no_responses += 1;
    out('warn', [t, '  ', [`${SYMBOLS.warn} probe: NO RESPONSE`, 'warn']]);
  } else {
    if (info.correct === true) st.tally.memory_correct += 1;
    if (isNum(info.rt_ms) && info.rt_ms < config.rt_cutoff_ms) st.tally.anticipatory += 1;
    out('log', [
      t,
      '  ',
      `   ${SYMBOLS.sub} key ${info.key} ${SYMBOLS.arrow} ${info.said_yes === true ? 'YES' : info.said_yes === false ? 'NO' : '?'} · correct answer ${info.expected_yes === true ? 'YES' : info.expected_yes === false ? 'NO' : '?'} ${SYMBOLS.arrow} `,
      resultPart(info.correct),
      isNum(info.rt_ms) ? ` · rt ${Math.round(info.rt_ms)} ms` : '',
      info.feedback ? ` · feedback ${String(info.feedback).toUpperCase()}` : '',
    ]);
  }
  const tag = tagPart(p);
  st.rows.push({
    test: p.test_no ?? st.rows.length + 1,
    probe: `${KIND_SYMBOL[p.kind] ?? '?'} ${p.kind === 'tone' ? toneText(p) || cellText(p.cell) : cellText(p.cell)}`,
    tag: tag ? tag[0] : '',
    role: p.is_target === true ? SYMBOLS.target : p.is_target === false ? SYMBOLS.foil : '?',
    correct_answer: info.expected_yes === true ? 'YES' : info.expected_yes === false ? 'NO' : '?',
    key: none ? '(none)' : info.key,
    response: none
      ? '(none)'
      : info.said_yes === true
        ? 'YES'
        : info.said_yes === false
          ? 'NO'
          : '?',
    result: none
      ? '-'
      : info.correct === true
        ? SYMBOLS.ok
        : info.correct === false
          ? SYMBOLS.bad
          : '?',
    rt_ms: isNum(info.rt_ms) ? Math.round(info.rt_ms) : '',
    feedback: info.feedback ? String(info.feedback).toUpperCase() : '',
  });
  st.pending = null;
});

/**
 * Print the recall summary table.
 * @param {object[]} [rows] explicit rows; by default the rows collected from probe()/probeResponse()
 */
const recallSummary = guarded((rows) => {
  openSub('RECALL');
  const data = Array.isArray(rows) ? rows : st.rows;
  out('log', [['recall summary', 'label']]);
  console.table(data);
});

/**
 * @typedef {object} TrialSummary  any field left out falls back to the trace's own tally
 * @property {number} [memory_correct]
 * @property {number} [memory_total]
 * @property {number} [stars_correct]
 * @property {number} [stars_total]
 * @property {number} [no_responses]
 * @property {number} [anticipatory]  responses faster than config.rt_cutoff_ms
 * @property {number} [early_keys]
 * @property {number} [late_keys]
 * @property {number} [extra_keys]
 */

/**
 * Print the one-line trial summary and close every open group.
 * @param {TrialSummary} [summary]
 */
const trialEnd = guarded((summary = {}) => {
  closeSub();
  const s = { ...st.tally };
  const pick = (a, b) => (isNum(a) ? a : b);
  const mc = pick(summary.memory_correct, s.memory_correct);
  const mt = pick(summary.memory_total, s.memory_total);
  const sc = pick(summary.stars_correct, s.stars_correct);
  const sT = pick(summary.stars_total, s.stars_total);
  const nr = pick(summary.no_responses, s.no_responses);
  const an = pick(summary.anticipatory, s.anticipatory);
  const keys = `${pick(summary.early_keys, s.early)}/${pick(summary.late_keys, s.late)}/${pick(summary.extra_keys, s.extra)}`;
  const parts = [
    ['SUMMARY', 'label'],
    '  ',
    [`memory ${mc}/${mt}`, mc === mt ? 'ok' : 'bad'],
    '  ·  ',
    [`stars ${sc}/${sT}`, sc === sT ? 'ok' : 'bad'],
    `  ·  no-response ${nr}  ·  anticipatory (<${config.rt_cutoff_ms} ms) ${an}  ·  early/late/extra keys ${keys}`,
  ];
  if (st.open) out('log', parts);
  closeAll();
  st = freshState();
  resetReveal();
});

/**
 * The trial ended abnormally (skipped, errored, page hidden): warn and close every group.
 * @param {string} [reason]
 */
const abort = guarded((reason) => {
  if (st.open)
    out('warn', [[`${SYMBOLS.warn} TRIAL ABORTED${reason ? `: ${reason}` : ''}`, 'warn']]);
  closeAll();
  st = freshState();
  resetReveal();
});

/**
 * A one-line marker (rest, block boundary, practice repeat, practice notice, counter, reveal toggle).
 * @param {string} text
 * @param {{closeTrial?: boolean, timed?: boolean}} [opts] `closeTrial: true` also ends the open trial group first (use for rests/boundaries); `timed: true` prefixes the trial time stamp
 */
const marker = guarded((text, opts = {}) => {
  if (opts.closeTrial === true) {
    closeAll();
    st = freshState();
  }
  /* `timed` (used inside a trial) puts the usual time stamp in front, so the line sits in the
   * same column as the other lines of the current group or sub-group. */
  const lead = opts.timed === true && st.open ? [stamp(opts), '  '] : [];
  out('log', [...lead, [`── ${String(text)} ──`, 'sub']]);
});

/**
 * The reveal toggle line (called by reveal.js through `setRevealNote`): a timed marker that leaves
 * the open trial group and its ENCODING / RECALL sub-group as they are.
 * @returns {boolean} true if the trace printed it (reveal.js falls back to console.log otherwise)
 */
function revealNote(text) {
  if (!ON || MUTED) return false;
  marker(text, { closeTrial: false, timed: true });
  return true;
}
setRevealNote(revealNote);

/**
 * console.warn for an anomaly (missing response, late/early/extra key, tone error, hidden page ...).
 * @param {string} text
 * @param {object} [data] logged as an extra expandable argument
 */
const warn = guarded((text, data) => {
  /* Same time stamp as the other warnings (encoding clock inside ENCODING, trial clock elsewhere). */
  const args = fmt([
    ...(st.open ? [stamp(data), '  '] : []),
    [`${SYMBOLS.warn} ${String(text)}`, 'warn'],
  ]);
  if (data !== undefined) args.push(data);
  console.warn(...args);
});

/**
 * Mute / unmute the trace (hidden-nav skip: neutralised trials stay silent). Muting first closes any
 * open trial group with a warning, so the console never shows a dangling group.
 * @param {boolean} on
 */
function mute(on) {
  if (!ON) return;
  try {
    if (on === true && !MUTED) {
      if (st.open) {
        out('warn', [[`${SYMBOLS.warn} TRIAL ABORTED: skipped by the experimenter`, 'warn']]);
      }
      closeAll();
      st = freshState();
      resetReveal();
    }
    MUTED = on === true;
  } catch {
    /* the trace never throws */
  }
}

/** The one trace surface used by the trial code. */
export const trace = Object.freeze({
  banner,
  trialStart,
  setup,
  encodingPlan,
  encodingEvent,
  star,
  recallStart,
  probe,
  probeResponse,
  recallSummary,
  trialEnd,
  abort,
  marker,
  warn,
  mute,
});
