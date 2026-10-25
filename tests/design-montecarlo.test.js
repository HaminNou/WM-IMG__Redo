/**
 * Monte-Carlo audit of the main-task plan across many seeds.
 *
 * Every seed builds the real plan (`generateMainPlan`, the same code path as
 * the runtime) and checks the counterbalances claimed in
 * pre-reg/pre-reg.json#counterbalance_invariants plus the structural rules
 * that make the five conditions comparable (in particular I+T against I+D
 * and I-only: same slot structure, same angle design, same label balance,
 * same star-cell rules).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createPRNG } from '../src/prng.js';
import { generateMainPlan, TRIAL_TYPES } from '../src/scheduler/main-plan.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import {
  ROTATION_STRATA,
  rotationStratumIndex,
  orderViolations,
} from '../src/scheduler/rotation-balance.js';
import { onPatternCells, offPatternCells } from '../src/grid.js';
import { toneForCell } from '../src/audio/tones.js';
import { MIN_TONE_GAP_RANKS } from '../src/scheduler/tone-spacing.js';

const N_SEEDS = 120;
const MEMORY_TYPES = ['d_only', 't_only', 'i_d', 'i_t'];
const STAR_TYPES = ['i_only', 'i_d', 'i_t'];
const DUAL_TYPES = ['i_d', 'i_t'];
const ON = new Set(onPatternCells());
const OFF = new Set(offPatternCells());

function count(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}
function allEqual(map, expected, keysExpected) {
  if (map.size !== keysExpected) return false;
  for (const v of map.values()) if (v !== expected) return false;
  return true;
}

/** Return a list of human-readable violations for one pool of 24 trials. */
function auditPool(type, pool) {
  const bad = [];
  const fail = (m) => bad.push(`${type}: ${m}`);
  if (pool.length !== 24) fail(`pool size ${pool.length}`);

  const shades = new Map();
  const slotM = Array(6).fill(0);
  const seqStrings = new Set();
  for (const t of pool) {
    count(shades, t.background_shade);
    t.sequence.forEach((c, i) => {
      if (c === 'M') slotM[i] += 1;
    });
    const s = t.sequence.join('');
    seqStrings.add(s);
    if (t.sequence.filter((c) => c === 'M').length !== 3) fail(`sequence ${s} not 3M+3S`);
    if (/MMM|SSS/.test(s)) fail(`sequence ${s} has a run of 3`);
  }
  if (!allEqual(shades, 12, 2)) fail(`shade split ${JSON.stringify([...shades])}`);
  if (!slotM.every((n) => n === 12)) fail(`slot M counts ${slotM}`);

  /* rotation design */
  const angleKey = type === 'd_only' ? 'display_rotation_deg' : 'rotation_deg';
  if (type !== 't_only') {
    const angles = pool.map((t) => t[angleKey]);
    if (angles.some((a) => typeof a !== 'number' || Math.abs(a) > 90 || !Number.isInteger(a)))
      fail(`bad angle in ${angles}`);
    if (new Set(angles).size !== 24) fail('angle repeated within pool');
    if (angles.filter((a) => a < 0).length !== 12) fail('not 12 counter-clockwise angles');
    const strata = new Map();
    for (const a of angles) count(strata, rotationStratumIndex(a));
    if (!allEqual(strata, 4, ROTATION_STRATA.length)) fail('strata not 4 each');
  } else if (pool.some((t) => 'rotation_deg' in t || 'display_rotation_deg' in t)) {
    fail('t_only trial carries a rotation');
  }

  if (MEMORY_TYPES.includes(type)) {
    const probeCell = new Map(); /* type|position */
    const probeType = new Map();
    const encPos = new Map(); /* encoding_position|probe_position */
    const onPerEnc = [0, 0, 0];
    const offPerEnc = [0, 0, 0];
    for (const t of pool) {
      const cells = t.memory_items.map((m) => m.cell);
      if (new Set(cells).size !== 3) fail('duplicate memory cell');
      t.memory_items.forEach((m) => {
        if (m.pattern_label === 'on' ? !ON.has(m.cell) : !OFF.has(m.cell))
          fail('item label/cell mismatch');
        (m.pattern_label === 'on' ? onPerEnc : offPerEnc)[m.encoding_position] += 1;
      });
      const targets = t.probes.filter((p) => p.is_target).length;
      if (targets < 1 || targets > 2) fail(`targets per trial = ${targets}`);
      for (const p of t.probes) {
        count(probeCell, `${p.type}|${p.probe_position}`);
        count(probeType, p.type);
        count(encPos, `${p.encoding_position}|${p.probe_position}`);
        if (p.is_target) {
          if (p.cell !== t.memory_items[p.encoding_position].cell)
            fail('target cell != encoded cell');
        } else {
          if (cells.includes(p.cell)) fail('foil on an encoded cell');
          if (p.pattern_label === 'on' ? !ON.has(p.cell) : !OFF.has(p.cell))
            fail('foil label/cell mismatch');
        }
      }
      if (
        new Set(t.probes.filter((p) => !p.is_target).map((p) => p.cell)).size !==
        t.probes.filter((p) => !p.is_target).length
      )
        fail('two identical foil cells in a trial');
      if (type === 't_only' || type === 'i_t') {
        const ranks = cells.map((c) => toneForCell(c).rank);
        for (let i = 0; i < 3; i++)
          for (let j = i + 1; j < 3; j++)
            if (Math.abs(ranks[i] - ranks[j]) < MIN_TONE_GAP_RANKS)
              fail('encoded tones closer than gap');
        for (const p of t.probes)
          if (!p.is_target)
            for (const r of ranks)
              if (Math.abs(toneForCell(p.cell).rank - r) < MIN_TONE_GAP_RANKS)
                fail('foil tone within gap');
      }
    }
    if (!allEqual(probeCell, 6, 12)) fail('probe type x position not 6 each');
    if (!allEqual(probeType, 18, 4)) fail('probe type totals not 18');
    if (DUAL_TYPES.includes(type) && !allEqual(encPos, 8, 9))
      fail('enc pos x probe pos not 8 each');
    if (!onPerEnc.every((n) => n === 12) || !offPerEnc.every((n) => n === 12))
      fail(`memory labels per encoding position on=${onPerEnc} off=${offPerEnc}`);
  }

  if (STAR_TYPES.includes(type)) {
    const onPerStar = [0, 0, 0];
    const offPerStar = [0, 0, 0];
    for (const t of pool) {
      const starCells = t.stars.map((s) => s.cell);
      if (new Set(starCells).size !== 3) fail('duplicate star cell');
      t.stars.forEach((s) => {
        (s.pattern_label === 'on' ? onPerStar : offPerStar)[s.probe_position] += 1;
        if (s.pattern_label === 'on' ? !ON.has(s.cell) : !OFF.has(s.cell))
          fail('star label/cell mismatch');
        if (s.is_on_pattern !== (s.pattern_label === 'on')) fail('star is_on_pattern inconsistent');
      });
      if (DUAL_TYPES.includes(type)) {
        const mem = new Set(t.memory_items.map((m) => m.cell));
        const foils = new Set(t.probes.filter((p) => !p.is_target).map((p) => p.cell));
        for (const c of starCells) {
          if (mem.has(c)) fail('star on a memory cell');
          if (foils.has(c)) fail('star on a foil cell');
        }
      }
    }
    if (!onPerStar.every((n) => n === 12) || !offPerStar.every((n) => n === 12))
      fail(`star labels per position on=${onPerStar} off=${offPerStar}`);
  }
  return bad;
}

function runLengthViolations(schedule, cap, tail) {
  let v = 0;
  let last = tail?.type ?? null;
  let run = tail?.length ?? 0;
  for (const s of schedule) {
    run = s === last ? run + 1 : 1;
    last = s;
    if (run > cap) v += 1;
  }
  return v;
}

function auditPlan(plan) {
  const bad = [];
  for (const type of TRIAL_TYPES) {
    bad.push(...auditPool(type, plan.trialParamsByType[type].all));
    for (const half of ['halfA', 'halfB']) {
      const h = plan.trialParamsByType[type][half];
      if (h.length !== 12) bad.push(`${type} ${half} size ${h.length}`);
      const white = h.filter((t) => t.background_shade === 'white').length;
      if (white !== 6) bad.push(`${type} ${half} white=${white}`);
    }
  }
  for (const [label, block, tail] of [
    ['main_a', plan.mainA, null],
    ['main_b', plan.mainB, plan.mainA.schedule.slice(-1)],
  ]) {
    if (block.schedule.length !== 60) bad.push(`${label} length ${block.schedule.length}`);
    for (const type of TRIAL_TYPES)
      if (block.schedule.filter((s) => s === type).length !== 12)
        bad.push(`${label} count ${type}`);
    const t =
      tail &&
      (() => {
        const s = plan.mainA.schedule;
        let n = 0;
        for (let i = s.length - 1; i >= 0 && s[i] === s[s.length - 1]; i--) n += 1;
        return { type: s[s.length - 1], length: n };
      })();
    if (runLengthViolations(block.schedule, 2, t || null)) bad.push(`${label} run-length cap`);
    if (orderViolations(block.trialParams)) bad.push(`${label} order violations`);
    block.trialParams.forEach((p, i) => {
      if (p.trial_type !== block.schedule[i]) bad.push(`${label} trial ${i} type mismatch`);
    });
  }
  /* the shade / rotation run limits hold across the Main A -> Main B boundary too */
  if (orderViolations([...plan.mainA.trialParams, ...plan.mainB.trialParams]))
    bad.push('order violations across the Main A / Main B boundary');
  /* each trial appears exactly once over the two blocks */
  const uids = new Set(
    [...plan.mainA.trialParams, ...plan.mainB.trialParams].map((t) => t.trial_meta.trial_uid)
  );
  if (uids.size !== 120) bad.push(`unique trial_uid ${uids.size}`);
  return bad;
}

describe('main-plan Monte Carlo audit', () => {
  beforeEach(() => resetSequencePools());

  it(`holds every counterbalance for ${N_SEEDS} seeds`, () => {
    const failures = [];
    for (let s = 0; s < N_SEEDS; s++) {
      let plan;
      try {
        plan = generateMainPlan({ prng: createPRNG(`mc-seed-${s}`) });
      } catch (e) {
        failures.push(`seed ${s}: generation threw ${e.message}`);
        continue;
      }
      const bad = auditPlan(plan);
      if (bad.length) failures.push(`seed ${s}: ${bad.slice(0, 4).join('; ')}`);
    }
    expect(failures, failures.slice(0, 8).join('\n')).toEqual([]);
  }, 300000);

  it('I+T and I+D have the same structural distributions (consistency across dual-task conditions)', () => {
    const slotBySeq = { i_d: new Map(), i_t: new Map() };
    const labelBalance = { i_d: 0, i_t: 0 };
    const memCellUse = { i_d: new Map(), i_t: new Map() };
    const starCellUse = { i_d: new Map(), i_t: new Map() };
    for (let s = 0; s < 60; s++) {
      const plan = generateMainPlan({ prng: createPRNG(`cons-${s}`) });
      for (const type of DUAL_TYPES) {
        for (const t of plan.trialParamsByType[type].all) {
          count(slotBySeq[type], t.sequence.join(''));
          t.memory_items.forEach((m) => count(memCellUse[type], m.cell));
          t.stars.forEach((st) => count(starCellUse[type], st.cell));
          labelBalance[type] += t.memory_items.filter((m) => m.pattern_label === 'on').length;
        }
      }
    }
    /* same total of on items (36 per pool by construction) */
    expect(labelBalance.i_d).toBe(labelBalance.i_t);
    /* same set of M/S sequences available */
    expect([...slotBySeq.i_d.keys()].sort()).toEqual([...slotBySeq.i_t.keys()].sort());
    /* memory cells: report how different the cell distributions are */
    const total = 60 * 72;
    let maxGap = 0;
    for (const c of [...ON, ...OFF]) {
      const a = (memCellUse.i_d.get(c) ?? 0) / total;
      const b = (memCellUse.i_t.get(c) ?? 0) / total;
      maxGap = Math.max(maxGap, Math.abs(a - b));
    }
    /* informational: the tone-spacing rule makes I+T cell use non-uniform */
    expect(maxGap).toBeLessThan(0.08);
  }, 300000);

  it('the audit itself detects corrupted pools (negative control)', () => {
    const plan = generateMainPlan({ prng: createPRNG('neg') });
    expect(auditPlan(plan)).toEqual([]);
    const pool = plan.trialParamsByType.i_t.all.slice();
    /* flip one background shade */
    const t0 = pool[0];
    pool[0] = { ...t0, background_shade: t0.background_shade === 'white' ? 'gray' : 'white' };
    expect(auditPool('i_t', pool).join()).toMatch(/shade/);
    /* move a foil onto an encoded cell */
    const pool2 = plan.trialParamsByType.i_d.all.map((t) => ({
      ...t,
      probes: t.probes.map((p) => ({ ...p })),
    }));
    const foil = pool2[0].probes.find((p) => !p.is_target);
    foil.cell = pool2[0].memory_items[0].cell;
    expect(auditPool('i_d', pool2).join()).toMatch(/foil on an encoded cell/);
    /* a star on a memory cell */
    const pool3 = plan.trialParamsByType.i_t.all.map((t) => ({
      ...t,
      stars: t.stars.map((x) => ({ ...x })),
    }));
    pool3[1].stars[0].cell = pool3[1].memory_items[0].cell;
    expect(auditPool('i_t', pool3).join()).toMatch(/star on a memory cell/);
  });

  it('is reproducible from the seed and differs between seeds', () => {
    const a = generateMainPlan({ prng: createPRNG('same') });
    const b = generateMainPlan({ prng: createPRNG('same') });
    const c = generateMainPlan({ prng: createPRNG('other') });
    const sig = (p) => JSON.stringify([p.mainA.trialParams, p.mainB.trialParams]);
    expect(sig(a)).toBe(sig(b));
    expect(sig(a)).not.toBe(sig(c));
  });
});
