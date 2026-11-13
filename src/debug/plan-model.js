/**
 * Pure model of the session plan for the experimenter print (plan-print.js): trial records and
 * balance tables computed from the generated trial parameters, the SAME objects the trial nodes
 * use. No console, no DOM, no randomness. Conventions of the project: counts and ordinals are
 * 1-based (trial n, slot, test #, memory item k); identifiers are 0-based (cell 0-24, tone_index 0-23).
 */
import { buildEncodingSlots, probeTraceInfo } from './trace-adapters.js';
import { TASK_LABELS } from './trace.js';
import { cellRowCol } from '../grid.js';
import { postEncodingRotationDeg } from '../conditions/trial-record.js';
import { M_SLOT_MS, S_SLOT_MS, PRE_ENCODING_PAD_MS } from '../conditions/shared.js';
import { ROTATION_STRATA, rotationStratumIndex } from '../scheduler/rotation-balance.js';
import {
  blockInvariantViolations,
  poolInvariantViolations,
  planInvariantViolations,
} from '../scheduler/balance-invariants.js';

export const TASKS = Object.freeze(['d_only', 't_only', 'i_only', 'i_d', 'i_t']);
/** One digit per task in the session sequence strings (Task 1..5 of the instructions). */
export const TASK_DIGIT = Object.freeze({
  d_only: '1',
  t_only: '2',
  i_only: '3',
  i_d: '4',
  i_t: '5',
});
/** What an M slot and an S slot show, per task (the same values the five composers pass). */
export const SLOT_KINDS = Object.freeze({
  d_only: { m_kind: 'dot', s_kind: 'dummy' },
  t_only: { m_kind: 'tone', s_kind: 'dummy' },
  i_only: { m_kind: 'dummy', s_kind: 'star' },
  i_d: { m_kind: 'dot', s_kind: 'star' },
  i_t: { m_kind: 'tone', s_kind: 'star' },
});
export const PROBE_TYPES = Object.freeze(['T_on', 'T_off', 'F_on', 'F_off']);
const range = (n) => Array.from({ length: n }, (_, i) => i);
const zeros = (n) => range(n).map(() => 0);
const signed = (d) => `${d > 0 ? '+' : ''}${d}°`;

/** `+34° (cw)`, `-83° (ccw)`, `0°`, or `none` (no rotation in that task). */
export function rotationText(params) {
  const deg = params.rotation_deg ?? params.display_rotation_deg;
  if (typeof deg !== 'number') return 'none';
  return deg === 0 ? '0°' : `${signed(deg)} (${deg > 0 ? 'cw' : 'ccw'})`;
}

/** The six slots of a trial with everything the experimenter needs (see module comment for indexing). */
export function encodingRecord(params) {
  const type = params.trial_type;
  const onsets = [];
  let t = PRE_ENCODING_PAD_MS;
  for (const k of params.sequence) {
    onsets.push(t);
    t += k === 'M' ? M_SLOT_MS : S_SLOT_MS;
  }
  const slots = buildEncodingSlots(params, { ...SLOT_KINDS[type], onsets_ms: onsets });
  const dummies = new Map((params.dummies ?? []).map((d) => [d.slot_index_in_seq, d]));
  const memSlot = new Map((params.memory_items ?? []).map((m) => [m.slot_index_in_seq, m]));
  const starSlot = new Map((params.stars ?? []).map((s) => [s.slot_index_in_seq, s]));
  return slots.map((s, i) => {
    const out = {
      slot: s.slot,
      kind: s.kind,
      cell: s.cell ?? dummies.get(i)?.cell ?? null,
      onset_ms: s.onset_ms,
      ordinal: null,
    };
    if (Number.isInteger(out.cell)) Object.assign(out, cellRowCol(out.cell));
    if (s.kind === 'dot' || s.kind === 'tone') {
      out.on_pattern = s.on_pattern;
      out.ordinal = `memory item ${memSlot.get(i).encoding_position + 1}`;
      out.tested = s.tested_as === null ? 'not tested' : `test #${s.tested_as}`;
      if (s.kind === 'tone') {
        out.tone_index = s.tone_index;
        out.freq_hz = Math.round(s.freq_hz * 10) / 10;
      }
    } else if (s.kind === 'star') {
      out.on_pattern = s.on_pattern;
      out.ordinal = `star ${starSlot.get(i).probe_position + 1}`;
      out.tested = 'judged live (ON / not-on key)';
    } else {
      out.on_pattern = null;
      out.tested = 'not tested';
    }
    return out;
  });
}

/** The recall probes in test order. */
export function recallRecord(params) {
  const type = params.trial_type;
  const kind = SLOT_KINDS[type].m_kind === 'tone' ? 'tone' : 'dot';
  const items = params.memory_items ?? [];
  return (params.probes ?? []).map((p) => {
    const info = probeTraceInfo(params, p, kind);
    const item = items[p.encoding_position];
    const slotText = item ? ` (encoded in slot ${item.slot_index_in_seq + 1})` : '';
    const out = {
      test: info.test_no,
      probe: p.type,
      role: p.is_target ? 'TARGET' : 'FOIL',
      kind,
      cell: p.cell,
      on_pattern: info.on_pattern,
      refers_to: `${p.is_target ? '' : 'paired with '}memory item ${p.encoding_position + 1}${slotText}`,
      answer: p.is_target ? 'YES' : 'NO',
    };
    Object.assign(out, cellRowCol(p.cell));
    if (kind === 'tone') {
      out.tone_index = info.tone_index;
      out.freq_hz = Math.round(info.freq_hz * 10) / 10;
    }
    return out;
  });
}

/** Flat record of one trial for the overview table and the trial group. */
export function trialRecord(params, { n, total, label }) {
  const meta = params.trial_meta ?? {};
  const probes = recallRecord(params);
  return {
    n,
    total,
    label,
    block: meta.block_label,
    block_no: (meta.block_position ?? n - 1) + 1,
    uid: meta.trial_uid,
    task: params.trial_type,
    task_label: TASK_LABELS[params.trial_type],
    shade: params.background_shade,
    rotation_deg: postEncodingRotationDeg(params),
    rotation: rotationText(params),
    reminder: meta.pattern_reminder === true,
    seq: params.sequence.join(''),
    probes: probes.map((p) => p.probe).join(' '),
    targets: probes.filter((p) => p.role === 'TARGET').length,
    mem_on: (params.memory_items ?? []).filter((m) => m.pattern_label === 'on').length,
    star_on: (params.stars ?? []).filter((s) => s.is_on_pattern === true).length,
    pool_index: meta.pool_index,
    encoding: encodingRecord(params),
    recall: probes,
  };
}

/* ------------------------------------------------------------ balances */

const histOf = (counts) => [0, 1, 2, 3].map((k) => counts.filter((x) => x === k).length);

/**
 * Counts of every balanced quantity for the given trials of ONE task (a half or the 24-pool),
 * recomputed from the trial parameters.
 */
export function balanceCounts(trials, type) {
  const slots = {
    M: zeros(6),
    S: zeros(6),
    memN: zeros(6),
    memOn: zeros(6),
    starN: zeros(6),
    starOn: zeros(6),
    T_on: zeros(6),
    T_off: zeros(6),
  };
  const ord = { memN: zeros(3), memOn: zeros(3), starN: zeros(3), starOn: zeros(3) };
  const probeByPos = Object.fromEntries(PROBE_TYPES.map((k) => [k, zeros(3)]));
  const encByPos = range(3).map(() => zeros(3));
  const shade = { white: 0, gray: 0 };
  const cross = { mem: { white: [0, 0], gray: [0, 0] }, star: { white: [0, 0], gray: [0, 0] } };
  const strata = ROTATION_STRATA.map(([lo, hi]) => ({ range: `${lo}..${hi}`, angles: [] }));
  const memOnPerTrial = [];
  const starOnPerTrial = [];
  const targetsPerTrial = [];
  for (const t of trials) {
    t.sequence.forEach((c, i) => slots[c][i]++);
    if (t.background_shade in shade) shade[t.background_shade]++;
    const items = t.memory_items ?? [];
    const stars = t.stars ?? [];
    items.forEach((m) => {
      const on = m.pattern_label === 'on';
      slots.memN[m.slot_index_in_seq]++;
      ord.memN[m.encoding_position]++;
      if (on) {
        slots.memOn[m.slot_index_in_seq]++;
        ord.memOn[m.encoding_position]++;
      }
      if (t.background_shade in shade) cross.mem[t.background_shade][on ? 1 : 0]++;
    });
    stars.forEach((s) => {
      slots.starN[s.slot_index_in_seq]++;
      ord.starN[s.probe_position]++;
      if (s.is_on_pattern) {
        slots.starOn[s.slot_index_in_seq]++;
        ord.starOn[s.probe_position]++;
      }
      if (t.background_shade in shade) cross.star[t.background_shade][s.is_on_pattern ? 1 : 0]++;
    });
    (t.probes ?? []).forEach((p) => {
      probeByPos[p.type][p.probe_position]++;
      encByPos[p.encoding_position][p.probe_position]++;
      if (p.is_target === true) slots[p.type][items[p.encoding_position].slot_index_in_seq]++;
    });
    memOnPerTrial.push(items.filter((m) => m.pattern_label === 'on').length);
    starOnPerTrial.push(stars.filter((s) => s.is_on_pattern).length);
    targetsPerTrial.push((t.probes ?? []).filter((p) => p.is_target).length);
    const deg = t.rotation_deg ?? t.display_rotation_deg;
    if (typeof deg === 'number') {
      const k = rotationStratumIndex(deg);
      if (k >= 0) strata[k].angles.push(deg);
    }
  }
  strata.forEach((s) => s.angles.sort((a, b) => a - b));
  return {
    type,
    n: trials.length,
    slots,
    ordinals: ord,
    probeByPos,
    encByPos,
    shade,
    cross,
    strata,
    hist: {
      targets: histOf(targetsPerTrial),
      memOn: histOf(memOnPerTrial),
      starOn: histOf(starOnPerTrial),
    },
  };
}

/** Longest run of one value in an array. */
export function longestRun(seq) {
  let best = 0;
  let run = 0;
  seq.forEach((v, i) => {
    run = i > 0 && v === seq[i - 1] ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
}

/**
 * Everything the print and `window.__WM_PLAN__.summaries` need: per task and scope the counts, the
 * validator results, the session-level sequence / reminder / rest facts and the overall verdict.
 * @param {{mainA: object, mainB: object, trialParamsByType: object}} pair  result of generateMainBlockPair
 * @param {{restsA: number[], restsB: number[]}} rests  within-block rests (after within-block trial n)
 */
export function summarisePlan(pair, rests) {
  const plan = { mainA: pair.mainA, mainB: pair.mainB, trialParamsByType: pair.trialParamsByType };
  const failures = [];
  const perTask = {};
  for (const type of TASKS) {
    const a = pair.mainA.trialParams.filter((t) => t.trial_type === type);
    const b = pair.mainB.trialParams.filter((t) => t.trial_type === type);
    const scopes = {
      main_a: { counts: balanceCounts(a, type), violations: blockInvariantViolations(a, type) },
      main_b: { counts: balanceCounts(b, type), violations: blockInvariantViolations(b, type) },
      pool: {
        counts: balanceCounts([...a, ...b], type),
        violations: poolInvariantViolations(a, b, type),
      },
    };
    for (const [scope, s] of Object.entries(scopes))
      s.violations.forEach((v) => failures.push(`${type} ${scope}: ${v}`));
    perTask[type] = scopes;
  }
  const planViolations = planInvariantViolations(plan);
  planViolations.forEach((v) => failures.push(`plan: ${v}`));

  const seqA = pair.mainA.schedule;
  const seqB = pair.mainB.schedule;
  const all = [...seqA, ...seqB];
  const run = longestRun(all);
  if (run > 2) failures.push(`session: longest same-task run is ${run} (max 2)`);
  const reminders = (block) =>
    block.trialParams.flatMap((p, i) => (p.trial_meta?.pattern_reminder ? [i + 1] : []));
  const digits = (s) => s.map((t) => TASK_DIGIT[t]).join('');
  return {
    perTask,
    planViolations,
    sequence: {
      main_a: digits(seqA),
      main_b: digits(seqB),
      longest_run: run,
      legend: Object.entries(TASK_DIGIT)
        .map(([t, d]) => `${d}=${TASK_LABELS[t]}`)
        .join('  '),
    },
    reminders: { main_a: reminders(pair.mainA), main_b: reminders(pair.mainB) },
    rests: {
      main_a_after_block_trial: rests.restsA,
      main_b_after_block_trial: rests.restsB,
      between_blocks_after_block_trial: seqA.length,
    },
    failures,
    verdict: failures.length === 0 ? 'ALL EXACT BALANCES PASS' : `${failures.length} FAILURE(S)`,
  };
}
