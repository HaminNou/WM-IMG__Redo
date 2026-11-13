/**
 * Experimenter print of the WHOLE session plan at the start of the session (debug mode only).
 *
 *   printSessionPlan({ seed, mainPair })   once, right after the banner and before consent:
 *       HEADER, BALANCINGS (per task, per half and pool, plus the validators' verdict), TRIALS
 *       (practice, Main A, Main B: an overview table and one collapsed group per trial) and
 *       `window.__WM_PLAN__` / `window.__WM_PLAN_DOWNLOAD__()`.
 *
 * Rules: off unless the trace is on (debug mode): the first statement returns, nothing is built.
 * It only READS the generated trial params (the same objects the trial nodes use) and never
 * generates, scores or changes anything. Styles and symbols come from trace.js. Never throws.
 */
import { isTraceOn, SYMBOLS, STYLES, TASK_LABELS } from './trace.js';
import { getPracticePlan } from './plan-store.js';
import { TASKS, PROBE_TYPES, trialRecord, summarisePlan } from './plan-model.js';
import { config } from '../config.js';
import { BUILD_COMMIT, BUILD_TIME } from '../build-info.js';
import {
  REST_AFTER_WITHIN_BLOCK_TRIALS_A,
  REST_AFTER_WITHIN_BLOCK_TRIALS_B,
} from '../scheduler/main-blocks.js';

const KIND_SYMBOL = {
  dot: SYMBOLS.dot,
  tone: SYMBOLS.tone,
  star: SYMBOLS.star,
  hidden: SYMBOLS.hidden,
  dummy: SYMBOLS.hidden,
};
const SCOPES = [
  ['main_a', 'Main A (12 trials)'],
  ['main_b', 'Main B (12 trials)'],
  ['pool', 'POOL A+B (24 trials)'],
];

/** `[formatString, ...css]` from parts (string or `[text, styleKey]`), styles from the one table in trace.js. */
function styled(parts) {
  let f = '';
  const css = [];
  for (const p of parts) {
    const [text, style] = Array.isArray(p) ? p : [p, 'none'];
    f += `%c${String(text).replace(/%/g, '%%')}`;
    css.push(STYLES[style] ?? '');
  }
  return [f, ...css];
}
const line = (parts) => console.log(...styled(parts));
const sep = (text) => line([[`══════ ${text} ══════`, 'banner']]);
const tagText = (on) => (on === true ? 'ON' : on === false ? 'OFF' : '-');

/* ------------------------------------------------------------- tables */

function overviewRows(records) {
  return records.map((r) => ({
    'trial n': `${r.n}/${r.total}`,
    uid: r.uid,
    task: r.task_label,
    shade: r.shade,
    rotation: r.rotation,
    reminder: r.reminder ? 'yes' : 'no',
    seq: r.seq,
    probes: r.probes || '-',
    targets: r.targets,
    'mem ON': r.mem_on,
    'star ON': r.star_on,
    'pool idx (0-based)': r.pool_index,
  }));
}

function encodingRows(r) {
  return r.encoding.map((s) => ({
    slot: s.slot,
    'serial pos': s.slot,
    kind: `${KIND_SYMBOL[s.kind] ?? '?'} ${s.kind === 'dummy' ? 'HIDDEN' : s.kind.toUpperCase()}`,
    item: s.ordinal ?? '-',
    'cell (0-24)': s.cell ?? '-',
    'row/col': s.row === undefined ? '-' : `r${s.row},c${s.col}`,
    'ON/OFF': tagText(s.on_pattern),
    'tone idx (0-23)': s.tone_index ?? '-',
    Hz: s.freq_hz ?? '-',
    'onset ms': s.onset_ms,
    'tested as': s.tested,
  }));
}

function recallRows(r) {
  return r.recall.map((p) => ({
    'test #': p.test,
    probe: p.probe,
    'T/F': p.role === 'TARGET' ? `${SYMBOLS.target} TARGET` : `${SYMBOLS.foil} FOIL`,
    kind: `${KIND_SYMBOL[p.kind]} ${p.kind.toUpperCase()}`,
    'cell (0-24)': p.cell,
    'row/col': `r${p.row},c${p.col}`,
    'ON/OFF': tagText(p.on_pattern),
    'tone idx (0-23)': p.tone_index ?? '-',
    Hz: p.freq_hz ?? '-',
    'refers to': p.refers_to,
    'correct answer': p.answer,
  }));
}

function trialTitle(r) {
  const head = r.label === 'practice' ? 'PRACTICE' : 'TRIAL';
  return `${head} ${r.n}/${r.total}  ${r.task_label}  ${r.block} #${r.block_no}  rot ${r.rotation}  shade=${r.shade}  seq ${r.seq}`;
}

function printTrials(title, records) {
  if (records.length === 0) return;
  console.group(...styled([[` ${title} `, 'sub'], `  ${records.length} trials`]));
  console.table(overviewRows(records));
  for (const r of records) {
    console.groupCollapsed(...styled([[trialTitle(r), 'head']]));
    line([['ENCODING (planned, 6 slots, onsets on the encoding clock)', 'label']]);
    console.table(encodingRows(r));
    if (r.recall.length) {
      line([['RECALL (3 probes in test order)', 'label']]);
      console.table(recallRows(r));
    } else {
      line([['RECALL none in this task (stars only)', 'dim']]);
    }
    console.groupEnd();
  }
  console.groupEnd();
}

/* ---------------------------------------------------------- balancings */

const rowOf = (name, arr, prefix) => ({
  measure: name,
  ...Object.fromEntries(arr.map((v, i) => [`${prefix} ${i + 1}`, v])),
});

function printBalanceTables(type, scopeLabel, c) {
  const memory = type !== 'i_only';
  const stars = type.startsWith('i_');
  console.group(...styled([[scopeLabel, 'label'], `  n=${c.n}`]));
  const slotRows = [rowOf('M slots', c.slots.M, 'slot'), rowOf('S slots', c.slots.S, 'slot')];
  if (memory)
    slotRows.push(
      rowOf('memory items', c.slots.memN, 'slot'),
      rowOf('memory ON', c.slots.memOn, 'slot'),
      rowOf('T_on probed', c.slots.T_on, 'slot'),
      rowOf('T_off probed', c.slots.T_off, 'slot')
    );
  if (stars)
    slotRows.push(rowOf('stars', c.slots.starN, 'slot'), rowOf('stars ON', c.slots.starOn, 'slot'));
  line([['per serial slot (1-6)', 'dim']]);
  console.table(slotRows);

  const posRows = [];
  if (memory) {
    posRows.push(rowOf('memory ON by encoding ordinal', c.ordinals.memOn, 'k'));
    for (const t of PROBE_TYPES) posRows.push(rowOf(`${t} by test #`, c.probeByPos[t], 'k'));
    c.encByPos.forEach((r, k) => posRows.push(rowOf(`encoding ordinal ${k + 1} x test #`, r, 'k')));
  }
  if (stars) posRows.push(rowOf('star ON by star ordinal', c.ordinals.starOn, 'k'));
  if (posRows.length) {
    line([['per ordinal / test position (1-3)', 'dim']]);
    console.table(posRows);
  }

  const histRows = [];
  const hrow = (name, h) => ({
    measure: name,
    ...Object.fromEntries(h.map((v, k) => [`n=${k}`, v])),
  });
  if (memory)
    histRows.push(
      hrow('targets per trial', c.hist.targets),
      hrow('memory ON per trial', c.hist.memOn)
    );
  if (stars) histRows.push(hrow('stars ON per trial', c.hist.starOn));
  if (histRows.length) {
    line([
      [
        `histograms, trials with n = 0..3 (pinned ${c.n === 24 ? '3,9,9,3' : '2,4,4,2 or 1,5,5,1'})`,
        'dim',
      ],
    ]);
    console.table(histRows);
  }

  const misc = [{ measure: 'shade (n trials)', white: c.shade.white, gray: c.shade.gray }];
  if (memory)
    misc.push({
      measure: 'memory items OFF / ON',
      white: c.cross.mem.white.join(' / '),
      gray: c.cross.mem.gray.join(' / '),
    });
  if (stars)
    misc.push({
      measure: 'stars OFF / ON',
      white: c.cross.star.white.join(' / '),
      gray: c.cross.star.gray.join(' / '),
    });
  line([['background shade and its crossing with the on/off labels', 'dim']]);
  console.table(misc);

  if (c.strata.some((s) => s.angles.length)) {
    line([['rotation strata (angles in degrees; negative = counter-clockwise)', 'dim']]);
    console.table(
      c.strata.map((s, i) => ({
        'stratum (1-6)': i + 1,
        range: s.range,
        n: s.angles.length,
        angles: s.angles.join(', '),
      }))
    );
  }
  console.groupEnd();
}

function printBalancings(summary) {
  sep('BALANCINGS');
  for (const type of TASKS) {
    console.groupCollapsed(...styled([[` ${TASK_LABELS[type]} `, 'sub'], `  (${type})`]));
    for (const [scope, label] of SCOPES) {
      const s = summary.perTask[type][scope];
      printBalanceTables(type, label, s.counts);
      if (s.violations.length === 0) line([[`${SYMBOLS.ok} ${label}: validator PASS`, 'ok']]);
      else s.violations.forEach((v) => line([[`${SYMBOLS.bad} ${label}: ${v}`, 'bad']]));
    }
    console.groupEnd();
  }
  console.group(...styled([[' SESSION ', 'sub'], '  task order, reminders, rests']));
  line([['legend ', 'label'], summary.sequence.legend]);
  line([['Main A ', 'label'], summary.sequence.main_a]);
  line([['Main B ', 'label'], summary.sequence.main_b]);
  line([
    ['longest same-task run ', 'label'],
    `${summary.sequence.longest_run} (allowed: 2, boundary included)  `,
    summary.sequence.longest_run <= 2 ? [SYMBOLS.ok, 'ok'] : [SYMBOLS.bad, 'bad'],
  ]);
  line([['reminders Main A (block trial no.) ', 'label'], summary.reminders.main_a.join(', ')]);
  line([['reminders Main B (block trial no.) ', 'label'], summary.reminders.main_b.join(', ')]);
  line([
    ['rests ', 'label'],
    `Main A after block trial ${summary.rests.main_a_after_block_trial.join(', ')}; ` +
      `between blocks after ${summary.rests.between_blocks_after_block_trial}; ` +
      `Main B after block trial ${summary.rests.main_b_after_block_trial.join(', ')}`,
  ]);
  console.groupEnd();
  if (summary.failures.length === 0) line([[` ${summary.verdict} `, 'ok']]);
  else {
    console.error(`${SYMBOLS.warn} PLAN BALANCE FAILURES (${summary.failures.length})`);
    summary.failures.forEach((f) => console.error(`${SYMBOLS.bad} ${f}`));
  }
}

/* ------------------------------------------------------------- exposure */

function download(plan) {
  const text = JSON.stringify(plan, null, 1);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `wm-plan_${String(plan.seed).replace(/[^\w.-]+/g, '_')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function expose(plan) {
  if (typeof window === 'undefined') return;
  window.__WM_PLAN__ = plan;
  window.__WM_PLAN_DOWNLOAD__ = () => download(plan);
}

/* ---------------------------------------------------------------- entry */

/**
 * Print the whole plan (debug mode only; otherwise returns null at once).
 * @param {object} opts
 * @param {string} opts.seed       `PID|STUDY|SESSION`
 * @param {object} opts.mainPair   result of generateMainBlockPair()
 * @param {object[]} [opts.practice] practice trial params (default: the recorded practice plan)
 * @returns {object|null} the plan object also exposed as window.__WM_PLAN__
 */
export function printSessionPlan({ seed, mainPair, practice } = {}) {
  if (!isTraceOn()) return null;
  try {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const practiceParams = practice ?? getPracticePlan();
    const summaries = summarisePlan(mainPair, {
      restsA: [...REST_AFTER_WITHIN_BLOCK_TRIALS_A],
      restsB: [...REST_AFTER_WITHIN_BLOCK_TRIALS_B],
    });
    const nA = mainPair.mainA.trialParams.length;
    const total = nA + mainPair.mainB.trialParams.length;
    const rec = (list, offset, count, label) =>
      list.map((p, i) => trialRecord(p, { n: offset + i + 1, total: count ?? total, label }));
    const practiceRecords = rec(practiceParams, 0, practiceParams.length, 'practice');
    const recordsA = rec(mainPair.mainA.trialParams, 0, total, 'main_a');
    const recordsB = rec(mainPair.mainB.trialParams, nA, total, 'main_b');
    summaries.records = { practice: practiceRecords, main_a: recordsA, main_b: recordsB };

    console.group(
      ...styled([
        [' SESSION PLAN ', 'banner'],
        '  experimenter use only: this is every trial of the session',
      ])
    );
    sep('HEADER');
    line([['seed    ', 'label'], String(seed ?? '(none)')]);
    line([['build   ', 'label'], `${config.build_id} (${BUILD_COMMIT}, ${BUILD_TIME})`]);
    line([
      ['plan    ', 'label'],
      'generation time and attempts: not recorded (the plan is built before this print)',
    ]);
    line([
      ['trials  ', 'label'],
      `practice ${practiceParams.length} (${practiceParams.length / 5} per task, Task 1-5)  ·  Main A ${nA}  ·  Main B ${total - nA}  ·  ` +
        TASKS.map((t) => `${TASK_LABELS[t]} ${total / 5}`).join(', ') +
        ' in total',
    ]);
    line([
      ['legend  ', 'label'],
      `${SYMBOLS.dot} dot ${SYMBOLS.tone} tone ${SYMBOLS.star} star ${SYMBOLS.hidden} hidden placeholder  T target  F foil  ON/OFF = cell on/off the pattern; counts and ordinals are 1-based, cell and tone ids 0-based`,
    ]);
    line([
      ['console ', 'label'],
      'window.__WM_PLAN__ = {seed, practice, mainA, mainB, summaries}   window.__WM_PLAN_DOWNLOAD__() saves it as JSON',
    ]);
    printBalancings(summaries);
    sep('TRIALS');
    printTrials('PRACTICE', practiceRecords);
    printTrials('MAIN A', recordsA);
    printTrials('MAIN B', recordsB);
    console.groupEnd();

    const plan = {
      seed,
      build: { id: config.build_id, commit: BUILD_COMMIT, time: BUILD_TIME },
      practice: practiceParams,
      mainA: { schedule: mainPair.mainA.schedule, trialParams: mainPair.mainA.trialParams },
      mainB: { schedule: mainPair.mainB.schedule, trialParams: mainPair.mainB.trialParams },
      summaries,
    };
    expose(plan);
    plan.print_ms = Math.round((performance?.now?.() ?? Date.now()) - t0);
    return plan;
  } catch (err) {
    try {
      console.warn('[plan-print] failed:', err);
    } catch {
      /* nothing */
    }
    return null;
  }
}
