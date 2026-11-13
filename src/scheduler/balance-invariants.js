/**
 * Validators for the block-exact counterbalance of the main-task plan (pure: no
 * jsPsych, no PRNG). They recompute every count from the trial-parameter objects
 * and return a list of named violations (empty list = exact). The `assert*`
 * wrappers throw, so a plan that is not exact is never shipped.
 *
 * What is checked is listed in `balanced-pool.js`. Violation strings start with a
 * stable code (`slot_ms:`, `mem_slot_label:` ...) followed by the numbers. Which CELL
 * carries a stimulus is deliberately NOT balanced (independent draws, `cell-draw.js`); only
 * the hard cell rules (distinctness, foil / star / dummy exclusions, tone spacing, labels
 * that match the cell) are checked.
 *
 *   blockInvariantViolations(trials, type, {size})   one 12-trial half of one condition
 *   poolInvariantViolations(trialsA, trialsB, type)  the two halves together (24 trials)
 *   planInvariantViolations(plan)                    a whole `generateMainPlan` result:
 *       the SHIPPED per-block trial lists (after the order planner), every pool,
 *       the block schedules, run rules and the identity of the halves with the blocks.
 */
import { onPatternCells, offPatternCells, isCentre } from '../grid.js';
import { toneForCell } from '../audio/tones.js';
import { MIN_TONE_GAP_RANKS } from './tone-spacing.js';
import { ROTATION_STRATA, rotationStratumIndex, orderViolations } from './rotation-balance.js';
import { enumerateValidSequences } from './within-trial.js';

const TYPES = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];
const PROBE_TYPES = ['T_on', 'T_off', 'F_on', 'F_off'];
const ON = new Set(onPatternCells());
const OFF = new Set(offPatternCells());
const SHADES = ['white', 'gray'];
const cellLabel = (c) => (ON.has(c) ? 'on' : OFF.has(c) ? 'off' : 'centre');

const hasMemory = (t) => t !== 'i_only';
const hasStars = (t) => t.startsWith('i_');
const isTone = (t) => t === 't_only' || t === 'i_t';
const hasRotation = (t) => t !== 't_only';
const angleOf = (t) => t.rotation_deg ?? t.display_rotation_deg;

const zeros = (n) => Array(n).fill(0);
const grid = (r, c) => Array.from({ length: r }, () => zeros(c));
const key = (s) => s.join('');
/* NaN for a cell without a tone (the centre): every gap comparison is then false, and the
 * centre-cell rule reports the cell instead of this function throwing. */
const rankOf = (c) => {
  try {
    return toneForCell(c).rank;
  } catch {
    return NaN;
  }
};

function allEqual(arr, v) {
  return arr.every((x) => x === v);
}

/**
 * Violations of the per-block (12-trial) invariants of one condition.
 * @param {object[]} trials  the condition's trials of one block (any order)
 * @param {string} type
 * @param {{size?: number}} [opts]
 * @returns {string[]}
 */
export function blockInvariantViolations(trials, type, { size = 12 } = {}) {
  const v = [];
  const bad = (code, detail = '') => v.push(detail ? `${code}: ${detail}` : code);
  if (!TYPES.includes(type)) return [`type: unknown trial type '${type}'`];
  if (trials.length !== size) bad('size', `${trials.length} trials, expected ${size}`);
  const half = size / 2;
  const mem = hasMemory(type);
  const star = hasStars(type);
  const tone = isTone(type);
  const rot = hasRotation(type);

  const mSlot = zeros(6);
  const memN = zeros(6);
  const memOn = zeros(6);
  const starN = zeros(6);
  const starOn = zeros(6);
  const memOrdOn = zeros(3);
  const starOrdOn = zeros(3);
  const strataN = zeros(6);
  const starStratumOn = zeros(6);
  const starStratumN = zeros(6);
  const typeByPos = grid(4, 3);
  const ordByPos = grid(3, 3);
  const classOrdPos = [grid(3, 3), grid(3, 3)];
  const slotTargets = zeros(6);
  const slotTon = zeros(6);
  const shades = { white: 0, gray: 0 };
  const memStratumOn = zeros(6);
  const memStratumN = zeros(6);
  const memShade = grid(2, 2); /* [shade][on] memory items */
  const starShade = grid(2, 2);
  const typeShade = grid(4, 2);
  const typePosShade = [grid(4, 3), grid(4, 3)];
  const memOnCounts = [];
  const targetCounts = [];
  const starOnCounts = [];
  const seqKeys = [];

  for (const t of trials) {
    if (t.trial_type !== type) bad('trial_type', `${t.trial_type} in a ${type} block`);
    const seq = t.sequence;
    const sk = key(seq);
    seqKeys.push(sk);
    if (seq.length !== 6 || seq.filter((c) => c === 'M').length !== 3)
      bad('sequence', `${sk} is not 3 M + 3 S`);
    if (/MMM|SSS/.test(sk)) bad('sequence', `${sk} has a run of 3`);
    const sh = SHADES.indexOf(t.background_shade);
    if (sh >= 0) shades[t.background_shade]++;
    else bad('shade', `unknown shade ${t.background_shade}`);
    seq.forEach((c, i) => {
      if (c === 'M') mSlot[i]++;
    });

    const items = t.memory_items ?? [];
    const stars = t.stars ?? [];
    const dummies = t.dummies ?? [];
    const probes = t.probes ?? [];
    if (mem !== items.length > 0 || (mem && items.length !== 3))
      bad('mem_items', `${items.length} memory items in ${type}`);
    if (star !== stars.length > 0 || (star && stars.length !== 3))
      bad('stars', `${stars.length} stars in ${type}`);
    if (mem !== probes.length > 0 || (mem && probes.length !== 3))
      bad('probes', `${probes.length} probes in ${type}`);

    /* the encoding stream: every item / star / dummy sits in its own slot, on its own cell */
    const streamCells = [];
    const slotsSeen = new Set();
    const note = (o) => {
      if (slotsSeen.has(o.slot_index_in_seq)) bad('slot_reuse', `slot ${o.slot_index_in_seq}`);
      slotsSeen.add(o.slot_index_in_seq);
      streamCells.push(o.cell);
    };
    items.forEach((m, e) => {
      if (seq[m.slot_index_in_seq] !== 'M' || m.encoding_position !== e)
        bad('mem_slot', `item ${e} at slot ${m.slot_index_in_seq} of ${sk}`);
      note(m);
    });
    stars.forEach((s, k) => {
      if (seq[s.slot_index_in_seq] !== 'S' || s.probe_position !== k)
        bad('star_slot', `star ${k} at slot ${s.slot_index_in_seq} of ${sk}`);
      note(s);
    });
    const dummySeq = mem && star ? null : mem ? 'S' : 'M';
    dummies.forEach((d) => {
      if (dummySeq === null || seq[d.slot_index_in_seq] !== dummySeq) bad('dummy_slot', sk);
      note(d);
    });
    if (streamCells.length !== 6) bad('stream_length', `${streamCells.length} stimuli`);
    if (new Set(streamCells).size !== streamCells.length) bad('cell_reuse', 'encoding stream');
    if (streamCells.some(isCentre)) bad('centre_cell', 'a stimulus on the centre cell');

    if (rot) {
      const a = angleOf(t);
      const g = typeof a === 'number' ? rotationStratumIndex(a) : -1;
      if (g < 0) bad('angle', `${a} outside every stratum`);
      else strataN[g]++;
      if (type === 'd_only' ? 'rotation_deg' in t : 'display_rotation_deg' in t)
        bad('angle_field', 'wrong rotation field for the type');
    } else if ('rotation_deg' in t || 'display_rotation_deg' in t) bad('angle', 't_only rotated');

    /* memory items */
    let onC = 0;
    for (const m of items) {
      const lab = ON.has(m.cell) ? 'on' : OFF.has(m.cell) ? 'off' : 'centre';
      if (lab !== m.pattern_label) bad('mem_label_cell', `cell ${m.cell} is ${lab}`);
      const o = m.pattern_label === 'on' ? 1 : 0;
      onC += o;
      memN[m.slot_index_in_seq]++;
      memOn[m.slot_index_in_seq] += o;
      memOrdOn[m.encoding_position] += o;
      if (sh >= 0) memShade[sh][o]++;
      if (rot && typeof angleOf(t) === 'number' && rotationStratumIndex(angleOf(t)) >= 0) {
        memStratumN[rotationStratumIndex(angleOf(t))]++;
        memStratumOn[rotationStratumIndex(angleOf(t))] += o;
      }
    }
    if (mem) memOnCounts.push(onC);
    if (mem && tone) {
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++)
          if (Math.abs(rankOf(items[i].cell) - rankOf(items[j].cell)) < MIN_TONE_GAP_RANKS)
            bad('tone_spacing_encoded', sk);
    }

    /* stars */
    let sOn = 0;
    for (const s of stars) {
      const lab = ON.has(s.cell) ? 'on' : OFF.has(s.cell) ? 'off' : 'centre';
      if (lab !== s.pattern_label || (s.pattern_label === 'on') !== s.is_on_pattern)
        bad('star_label_cell', `cell ${s.cell} is ${lab}`);
      const o = s.pattern_label === 'on' ? 1 : 0;
      sOn += o;
      starN[s.slot_index_in_seq]++;
      starOn[s.slot_index_in_seq] += o;
      if (sh >= 0) starShade[sh][o]++;
      starOrdOn[s.probe_position] += o;
      const g = rot ? rotationStratumIndex(angleOf(t)) : -1;
      if (g >= 0) {
        starStratumN[g]++;
        starStratumOn[g] += o;
      }
    }
    if (star) starOnCounts.push(sOn);

    /* probes */
    if (mem && probes.length === 3) {
      const encCells = items.map((m) => m.cell);
      const counts = {};
      let targets = 0;
      const ords = new Set(probes.map((p) => p.encoding_position));
      if (ords.size !== 3) bad('probe_ordinals', 'encoding positions are not a permutation');
      probes.forEach((p, j) => {
        const ti = PROBE_TYPES.indexOf(p.type);
        if (p.probe_position !== j || ti < 0) bad('probe_fields', `probe ${j} ${p.type}`);
        if (ti < 0) return;
        counts[p.type] = (counts[p.type] ?? 0) + 1;
        typeByPos[ti][j]++;
        if (sh >= 0) {
          typeShade[ti][sh]++;
          typePosShade[sh][ti][j]++;
        }
        ordByPos[p.encoding_position][j]++;
        if (p.is_target !== ti <= 1) bad('is_target', `probe ${j}`);
        const typeLabel = ti === 0 || ti === 2 ? 'on' : 'off';
        if (cellLabel(p.cell) !== typeLabel) bad('probe_label_cell', `probe ${j} cell ${p.cell}`);
        if (p.pattern_label !== typeLabel || p.pattern_label !== cellLabel(p.cell))
          bad(
            'probe_pattern_label',
            `probe ${j} label ${p.pattern_label} for ${p.type} on cell ${p.cell}`
          );
        if (ti <= 1) {
          targets++;
          classOrdPos[ti][p.encoding_position][j]++;
          const item = items[p.encoding_position];
          if (!item || p.cell !== item.cell) bad('target_cell', `probe ${j}`);
          else {
            if (item.pattern_label !== (ti === 0 ? 'on' : 'off')) bad('target_label', `probe ${j}`);
            slotTargets[item.slot_index_in_seq]++;
            if (ti === 0) slotTon[item.slot_index_in_seq]++;
          }
        } else {
          if (encCells.includes(p.cell)) bad('foil_on_encoded', `probe ${j}`);
          if (stars.some((s) => s.cell === p.cell)) bad('foil_on_star', `probe ${j}`);
          if (dummies.some((d) => d.cell === p.cell)) bad('foil_on_dummy', `probe ${j}`);
          if (
            tone &&
            encCells.some((c) => Math.abs(rankOf(c) - rankOf(p.cell)) < MIN_TONE_GAP_RANKS)
          )
            bad('tone_spacing_foil', `probe ${j}`);
        }
      });
      const foils = probes.filter((p) => !p.is_target).map((p) => p.cell);
      if (new Set(foils).size !== foils.length) bad('foil_repeat', sk);
      if (targets < 0 || targets > 3) bad('targets_per_trial', `${targets}`);
      targetCounts.push(targets);
      if (Math.max(...Object.values(counts)) > 2) bad('probe_type_cap', 'a probe type 3 times');
      if (stars.some((s) => encCells.includes(s.cell))) bad('star_on_item', sk);
      if (stars.some((s) => probes.some((p) => p.cell === s.cell))) bad('star_on_probe', sk);
      if (dummies.some((d) => probes.some((p) => p.cell === d.cell))) bad('dummy_on_probe', sk);
    }
  }

  /* ---- block-level exactness ---- */
  if (!allEqual(mSlot, half)) bad('slot_ms', `M per slot ${mSlot}, expected ${half} at every slot`);
  /* the 12 strings are 6 complete complement pairs, each string once */
  const distinct = new Set(seqKeys);
  if (distinct.size !== trials.length) bad('sequence_repeat', 'a string occurs twice in a block');
  for (const sk of distinct) {
    const comp = sk
      .split('')
      .map((c) => (c === 'M' ? 'S' : 'M'))
      .join('');
    if (!distinct.has(comp)) bad('sequence_pairs', `${sk} without its complement`);
  }
  if (shades.white !== half || shades.gray !== half)
    bad('shade', `white ${shades.white} / gray ${shades.gray}`);
  if (mem) {
    /* crossings with the page background: 18 memory items per shade, 9 on / 9 off */
    if (!memShade.flat().every((x) => x === half * 1.5))
      bad('mem_label_x_shade', `[white off,on],[gray off,on] = ${memShade}`);
    if (!typeShade.flat().every((x) => x === 4 || x === 5))
      bad('probe_type_x_shade', `${typeShade}`);
    if (!typePosShade.flat(2).every((x) => x === 1 || x === 2))
      bad('probe_type_x_position_x_shade', `${typePosShade.flat(2)}`);
    if (typeShade.flat().reduce((a, b) => a + b, 0) !== size * 3)
      bad('probe_type_x_shade', 'probe count');
  }
  if (rot) {
    if (!allEqual(strataN, size / 6)) bad('strata', `per stratum ${strataN}`);
    const negative = trials.filter((t) => angleOf(t) < 0).length;
    if (negative !== half) bad('angle_sign', `${negative} negative angles`);
    if (new Set(trials.map(angleOf)).size !== trials.length) bad('angle_repeat', 'within a block');
  }
  const histOf = (counts) => [0, 1, 2, 3].map((k) => counts.filter((x) => x === k).length);
  const histOk = (h) => h.join() === '2,4,4,2' || h.join() === '1,5,5,1';
  if (mem) {
    if (!allEqual(memN, half)) bad('mem_slot_occupancy', `${memN}`);
    if (!allEqual(memOn, half / 2))
      bad('mem_slot_label', `on per slot ${memOn}, expected ${half / 2}`);
    if (!allEqual(memOrdOn, half)) bad('mem_ordinal_label', `on per ordinal ${memOrdOn}`);
    if (!typeByPos.flat().every((x) => x === size / 4))
      bad('probe_type_x_position', `${typeByPos}`);
    if (!ordByPos.flat().every((x) => x === size / 3)) bad('ordinal_x_position', `${ordByPos}`);
    if (!classOrdPos.flat(2).every((x) => x === size / 12))
      bad('class_x_ordinal_x_position', 'not 1 per cell');
    if (!allEqual(slotTargets, size / 4)) bad('targets_per_slot', `${slotTargets}`);
    if (!slotTon.every((x) => x === 1 || x === 2)) bad('t_on_per_slot', `${slotTon}`);
    if (slotTon.reduce((a, b) => a + b, 0) !== size * 0.75) bad('t_on_total', `${slotTon}`);
    if (!histOk(histOf(memOnCounts))) bad('mem_on_histogram', `${histOf(memOnCounts)}`);
    /* targets per trial: 0..3, with the pinned histogram (a probe of a trial may be all targets or all
     * foils, but how many trials have each count is exact, so the totals stay balanced) */
    if (!histOk(histOf(targetCounts))) bad('targets_histogram', `${histOf(targetCounts)}`);
    if (rot && (!allEqual(memStratumN, half) || !allEqual(memStratumOn, half / 2)))
      bad('mem_label_x_stratum', `on per stratum ${memStratumOn} of ${memStratumN}`);
  }
  if (star) {
    if (!allEqual(starN, half)) bad('star_slot_occupancy', `${starN}`);
    if (!allEqual(starOn, half / 2))
      bad('star_slot_label', `on per slot ${starOn}, expected ${half / 2}`);
    if (!allEqual(starOrdOn, half)) bad('star_ordinal_label', `on per ordinal ${starOrdOn}`);
    if (!allEqual(starStratumN, half) || !allEqual(starStratumOn, half / 2))
      bad('star_stratum_label', `on per stratum ${starStratumOn} of ${starStratumN}`);
    if (!histOk(histOf(starOnCounts))) bad('star_on_histogram', `${histOf(starOnCounts)}`);
    if (!starShade.flat().every((x) => x === half * 1.5))
      bad('star_label_x_shade', `[white off,on],[gray off,on] = ${starShade}`);
  }
  return v;
}

/**
 * Violations of the pool-level (24-trial) invariants of one condition.
 * Includes the block checks of both halves.
 */
export function poolInvariantViolations(trialsA, trialsB, type) {
  const v = [];
  const bad = (code, detail = '') => v.push(detail ? `${code}: ${detail}` : code);
  for (const x of blockInvariantViolations(trialsA, type)) bad('blockA', x);
  for (const x of blockInvariantViolations(trialsB, type)) bad('blockB', x);
  const both = [...trialsA, ...trialsB];
  const mem = hasMemory(type);
  const star = hasStars(type);

  /* the two halves leave out different complement pairs; every string is used, none more than twice */
  const seqUse = {};
  for (const t of both) seqUse[key(t.sequence)] = (seqUse[key(t.sequence)] ?? 0) + 1;
  const validKeys = enumerateValidSequences().map(key);
  if (validKeys.some((k) => !seqUse[k]) || Object.keys(seqUse).length !== validKeys.length)
    bad('pool_sequences', 'not all 14 valid strings are used');
  if (Math.max(...Object.values(seqUse)) > 2) bad('pool_sequences', 'a string used 3 times');
  const omitted = (half) => {
    const used = new Set(half.map((t) => key(t.sequence)));
    return validKeys.filter((k) => !used.has(k)).join('/');
  };
  if (omitted(trialsA) === omitted(trialsB))
    bad('pool_omitted_pairs', 'both halves omit the same pair');

  if (both.filter((t) => t.background_shade === SHADES[0]).length !== 12)
    bad('pool_shade', 'not 12/12');
  if (hasRotation(type)) {
    const angles = both.map(angleOf);
    if (new Set(angles).size !== 24) bad('pool_angle_repeat');
    if (angles.filter((a) => a < 0).length !== 12) bad('pool_angle_sign');
    const per = zeros(ROTATION_STRATA.length);
    angles.forEach((a) => per[rotationStratumIndex(a)]++);
    if (!allEqual(per, 4)) bad('pool_strata', `${per}`);
  }

  if (mem) {
    const memOn = zeros(6);
    const memOrdOn = zeros(3);
    const tByPos = grid(4, 3);
    const oByPos = grid(3, 3);
    const cop = [grid(3, 3), grid(3, 3)];
    const slotTon = zeros(6);
    const slotTargets = zeros(6);
    const histCounts = [];
    const targetCounts = [];
    const stratumOn = zeros(6);
    const memShade = grid(2, 2);
    const typeShade = grid(4, 2);
    const typePosShade = [grid(4, 3), grid(4, 3)];
    for (const t of both) {
      let onC = 0;
      const sh = SHADES.indexOf(t.background_shade);
      for (const m of t.memory_items) {
        const o = m.pattern_label === 'on' ? 1 : 0;
        onC += o;
        memOn[m.slot_index_in_seq] += o;
        memOrdOn[m.encoding_position] += o;
        memShade[sh][o]++;
        if (hasRotation(type)) stratumOn[rotationStratumIndex(angleOf(t))] += o;
      }
      histCounts.push(onC);
      targetCounts.push(t.probes.filter((p) => p.is_target).length);
      for (const p of t.probes) {
        const ti = PROBE_TYPES.indexOf(p.type);
        typeShade[ti][sh]++;
        typePosShade[sh][ti][p.probe_position]++;
        tByPos[ti][p.probe_position]++;
        oByPos[p.encoding_position][p.probe_position]++;
        if (ti <= 1) {
          cop[ti][p.encoding_position][p.probe_position]++;
          const s = t.memory_items[p.encoding_position].slot_index_in_seq;
          slotTargets[s]++;
          if (ti === 0) slotTon[s]++;
        }
      }
    }
    if (!allEqual(memOn, 6)) bad('pool_mem_slot_label', `${memOn}`);
    if (!allEqual(memOrdOn, 12)) bad('pool_mem_ordinal_label', `${memOrdOn}`);
    if (!tByPos.flat().every((x) => x === 6)) bad('pool_probe_type_x_position');
    if (!oByPos.flat().every((x) => x === 8)) bad('pool_ordinal_x_position');
    if (!cop.flat(2).every((x) => x === 2)) bad('pool_class_x_ordinal_x_position');
    if (!allEqual(slotTon, 3) || !allEqual(slotTargets, 6))
      bad('pool_t_on_t_off_per_slot', `T_on ${slotTon} of ${slotTargets}`);
    const h = [0, 1, 2, 3].map((k) => histCounts.filter((x) => x === k).length);
    if (h.join() !== '3,9,9,3') bad('pool_mem_on_histogram', `${h}`);
    const th = [0, 1, 2, 3].map((k) => targetCounts.filter((x) => x === k).length);
    if (th.join() !== '3,9,9,3') bad('pool_targets_histogram', `${th}`);
    if (!memShade.flat().every((x) => x === 18)) bad('pool_mem_label_x_shade', `${memShade}`);
    if (!typeShade.flat().every((x) => x === 9)) bad('pool_probe_type_x_shade', `${typeShade}`);
    if (!typePosShade.flat(2).every((x) => x === 3))
      bad('pool_probe_type_x_position_x_shade', `${typePosShade.flat(2)}`);
    if (hasRotation(type) && !allEqual(stratumOn, 6))
      bad('pool_mem_label_x_stratum', `${stratumOn}`);
  }
  if (star) {
    const starOn = zeros(6);
    const ordOn = zeros(3);
    const stratumOn = zeros(6);
    const starShade = grid(2, 2);
    const histCounts = [];
    for (const t of both) {
      let n = 0;
      for (const s of t.stars) {
        const o = s.pattern_label === 'on' ? 1 : 0;
        n += o;
        starOn[s.slot_index_in_seq] += o;
        ordOn[s.probe_position] += o;
        stratumOn[rotationStratumIndex(angleOf(t))] += o;
        starShade[SHADES.indexOf(t.background_shade)][o]++;
      }
      histCounts.push(n);
    }
    if (!allEqual(starOn, 6)) bad('pool_star_slot_label', `${starOn}`);
    if (!allEqual(ordOn, 12)) bad('pool_star_ordinal_label', `${ordOn}`);
    if (!allEqual(stratumOn, 6)) bad('pool_star_stratum_label', `${stratumOn}`);
    const h = [0, 1, 2, 3].map((k) => histCounts.filter((x) => x === k).length);
    if (h.join() !== '3,9,9,3') bad('pool_star_on_histogram', `${h}`);
    if (!starShade.flat().every((x) => x === 18)) bad('pool_star_label_x_shade', `${starShade}`);
  }
  return v;
}

/* The content of a trial without its plan identity (`trial_meta`). */
const content = (t) => {
  const rest = { ...t };
  delete rest.trial_meta;
  return JSON.stringify(rest);
};

function runViolations(schedule, cap) {
  let run = 0;
  let n = 0;
  schedule.forEach((s, i) => {
    run = i > 0 && s === schedule[i - 1] ? run + 1 : 1;
    if (run > cap) n++;
  });
  return n;
}

/**
 * Violations of a whole `generateMainPlan` result. The per-block and per-pool
 * invariants are evaluated on the trial lists that are actually shipped (the
 * ordered `mainA` / `mainB` trial parameters), not only on the pools they came
 * from; the pools must in addition equal the shipped trials of their type
 * (nothing may move a label between slots or blocks after generation).
 */
export function planInvariantViolations(plan) {
  const v = [];
  const bad = (code, detail = '') => v.push(detail ? `${code}: ${detail}` : code);
  const blocks = { main_a: plan.mainA, main_b: plan.mainB };
  for (const [label, block] of Object.entries(blocks)) {
    if (!block || block.schedule?.length !== 60) bad('plan_block_length', label);
    if (!block) continue;
    for (const type of TYPES)
      if (block.schedule.filter((s) => s === type).length !== 12)
        bad('plan_block_counts', `${label} ${type}`);
    block.trialParams.forEach((p, i) => {
      if (p.trial_type !== block.schedule[i])
        bad('plan_schedule_mismatch', `${label} position ${i}`);
    });
  }
  if (v.length) return v;
  const seq = [...plan.mainA.schedule, ...plan.mainB.schedule];
  if (runViolations(seq, 2))
    bad('plan_run_cap', 'more than 2 of one condition in a row (incl. boundary)');
  if (orderViolations([...plan.mainA.trialParams, ...plan.mainB.trialParams]))
    bad('plan_order_rules', 'rotation-direction / angle-step / shade run rules');
  /* the identity stamped on every trial must agree with its place in the shipped order */
  for (const [label, block, offset] of [
    ['main_a', plan.mainA, 0],
    ['main_b', plan.mainB, 60],
  ])
    block.trialParams.forEach((p, i) => {
      const m = p.trial_meta;
      if (!m) {
        bad('plan_trial_meta', `${label} position ${i}: no trial_meta`);
        return;
      }
      const want = {
        condition: p.trial_type,
        block_label: label,
        is_practice: false,
        block_position: i,
        presentation_index: offset + i + 1,
        trial_uid: `${label}-${String(offset + i + 1).padStart(3, '0')}-${p.trial_type}`,
        pool_index: p.trial_index_in_block,
      };
      for (const [k, x] of Object.entries(want))
        if (m[k] !== x)
          bad('plan_trial_meta', `${label} position ${i}: ${k} is ${m[k]}, expected ${x}`);
    });
  const uids = new Set(
    [...plan.mainA.trialParams, ...plan.mainB.trialParams].map((t) => t.trial_meta?.trial_uid)
  );
  if (uids.size !== 120) bad('plan_trial_uid', `${uids.size} unique`);

  for (const type of TYPES) {
    const shippedA = plan.mainA.trialParams.filter((t) => t.trial_type === type);
    const shippedB = plan.mainB.trialParams.filter((t) => t.trial_type === type);
    for (const x of poolInvariantViolations(shippedA, shippedB, type)) bad(`shipped ${type}`, x);
    const pool = plan.trialParamsByType?.[type];
    const same = (shipped, pooled) => {
      const a = shipped.map(content).sort();
      const b = (pooled ?? []).map(content).sort();
      return a.length === b.length && a.every((x, i) => x === b[i]);
    };
    if (!same(shippedA, pool?.halfA) || !same(shippedB, pool?.halfB))
      bad('plan_pool_identity', `${type}: shipped trials differ from the generated halves`);
    if (!same([...shippedA, ...shippedB], pool?.all))
      bad('plan_pool_identity', `${type}: 'all' is not halfA + halfB`);
    /* the half a trial was generated in must be the block it is shipped in */
    for (const [label, list, lo] of [
      ['main_a', shippedA, 0],
      ['main_b', shippedB, 12],
    ]) {
      for (const t of list)
        if (t.trial_meta.pool_index < lo || t.trial_meta.pool_index >= lo + 12)
          bad('plan_pool_index', `${type} ${label} pool_index ${t.trial_meta.pool_index}`);
      if (new Set(list.map((t) => t.trial_meta.pool_index)).size !== 12)
        bad('plan_pool_index', `${type} ${label}: pool_index is not a permutation of the half`);
    }
  }
  return v;
}

const asError = (what, list) =>
  new Error(`${what}: ${list.length} violation(s): ${list.slice(0, 6).join('; ')}`);

export function assertBlockInvariants(trials, type, opts) {
  const list = blockInvariantViolations(trials, type, opts);
  if (list.length) throw asError(`block invariants (${type})`, list);
}
export function assertPoolInvariants(trialsA, trialsB, type) {
  const list = poolInvariantViolations(trialsA, trialsB, type);
  if (list.length) throw asError(`pool invariants (${type})`, list);
}
export function assertPlanInvariants(plan) {
  const list = planInvariantViolations(plan);
  if (list.length) throw asError('plan invariants', list);
}
