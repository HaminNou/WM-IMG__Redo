/**
 * INDEPENDENT ORACLE for the block-exact design (test helper).
 *
 * Ported from the combinatorial designer's standalone checker (/tmp/D1/check.mjs). It shares no
 * code with src/scheduler/balanced-pool.js (the generator) or with
 * src/scheduler/balance-invariants.js (the shipped validator): it re-derives every count from the
 * emitted trial objects with its own loops, using only the grid sets and the cell -> tone rank table.
 */
/* eslint-disable */
/* Independent checker: re-derives every balance from the emitted trial objects only
 * (uses only the grid on/off sets and the cell->tone rank table; none of gen.mjs's code). */
import { onPatternCells, offPatternCells } from '../../src/grid.js';
import { toneForCell } from '../../src/audio/tones.js';
import { config } from '../../src/config.js';
/* probe label straight from the configured gray-pattern cells (centre = 12 is not a stimulus cell) */
const CFG_ON = new Set(config.pattern.gray_pattern_cells.filter((c) => c !== 12));
const cfgLab = (c) => (c === 12 ? 'centre' : CFG_ON.has(c) ? 'on' : 'off');
const ON = new Set(onPatternCells()),
  OFF = new Set(offPatternCells());
const STR = [
  [-90, -61],
  [-60, -31],
  [-30, -1],
  [0, 30],
  [31, 60],
  [61, 90],
];
const lab = (c) => (ON.has(c) ? 'on' : OFF.has(c) ? 'off' : 'centre');
const sum = (a) => a.reduce((x, y) => x + y, 0);
const Z = (n, m = 0) => Array.from({ length: n }, () => (m ? Array(m).fill(0) : 0));

/* returns {viol: string[], m: metrics} ; viol empty <=> every EXACT-per-block requirement holds */
export function checkBlock(
  tr,
  type,
  { onRange = null, slotPosExact = false, histOK = false } = {}
) {
  const v = [];
  const bad = (s) => v.push(s);
  const mem = type !== 'i_only',
    star = type.startsWith('i_'),
    tone = type === 't_only' || type === 'i_t';
  if (tr.length !== 12) bad('size');
  const mSlot = Z(6),
    sSlot = Z(6),
    memOn = Z(6),
    memN = Z(6),
    stOn = Z(6),
    stN = Z(6);
  const memOrdOn = Z(3),
    memOrdN = Z(3),
    stOrdOn = Z(3),
    stOrdN = Z(3);
  const tpos = Z(4, 3),
    opos = Z(3, 3),
    cop = [Z(3, 3), Z(3, 3)];
  const slotTgt = Z(6),
    slotTon = Z(6),
    slotPos = Z(6, 3);
  const strStarOn = Z(6),
    strStarN = Z(6),
    strN = Z(6),
    strMemOn = Z(6),
    strMemN = Z(6);
  const shade = { white: 0, gray: 0 };
  /* crossings with the page background (shade index 0 white, 1 gray) */
  const memShade = Z(2, 2), // [shade][off, on]
    stShade = Z(2, 2),
    typeShade = Z(2, 4), // [shade][probe type]
    tposShade = [Z(4, 3), Z(4, 3)]; // [shade][type][test position]
  const onCounts = [],
    targetCounts = [],
    stOnCounts = [];
  const encUse = {},
    foilUse = {},
    starUse = {};
  for (const t of tr) {
    const q = t.sequence;
    if (q.length !== 6 || q.filter((c) => c === 'M').length !== 3) bad('seq composition');
    for (let i = 2; i < 6; i++) if (q[i] === q[i - 1] && q[i] === q[i - 2]) bad('seq run>2');
    shade[t.background_shade]++;
    const sh = t.background_shade === 'white' ? 0 : 1;
    const all = []; // every stimulus cell in encoding stream
    const slotsSeen = new Set();
    const stim = (obj, kind) => {
      if (slotsSeen.has(obj.slot_index_in_seq)) bad('slot reused');
      slotsSeen.add(obj.slot_index_in_seq);
      all.push(obj.cell);
    };
    const mi = t.memory_items ?? [],
      st = t.stars ?? [],
      du = t.dummies ?? [];
    mi.forEach((m, e) => {
      if (q[m.slot_index_in_seq] !== 'M' || m.encoding_position !== e) bad('mem slot/ord');
      stim(m);
    });
    st.forEach((s, k) => {
      if (q[s.slot_index_in_seq] !== 'S' || s.probe_position !== k) bad('star slot/ord');
      stim(s);
    });
    du.forEach((d) => {
      const want = mem && star ? null : mem ? 'S' : 'M';
      if (want === null || q[d.slot_index_in_seq] !== want) bad('dummy slot');
      stim(d);
    });
    if (new Set(all).size !== all.length) bad('cell reused within encoding stream');
    if (all.length !== 6) bad('stream length');
    if (all.includes(12)) bad('centre cell used');
    q.forEach((c, i) => (c === 'M' ? mSlot[i]++ : sSlot[i]++));
    const g = HAS_ROT(type)
      ? STR.findIndex(
          ([l, h]) =>
            (t.rotation_deg ?? t.display_rotation_deg) >= l &&
            (t.rotation_deg ?? t.display_rotation_deg) <= h
        )
      : 0;
    if (HAS_ROT(type) && g < 0) bad('angle out of range');
    else strN[g]++;
    let onC = 0;
    mi.forEach((m) => {
      if (lab(m.cell) !== m.pattern_label) bad('mem label vs cell');
      const o = m.pattern_label === 'on' ? 1 : 0;
      onC += o;
      memShade[sh][o]++;
      memOn[m.slot_index_in_seq] += o;
      memN[m.slot_index_in_seq]++;
      memOrdOn[m.encoding_position] += o;
      memOrdN[m.encoding_position]++;
      if (HAS_ROT(type)) {
        strMemOn[g] += o;
        strMemN[g]++;
      }
      encUse[m.cell] = (encUse[m.cell] ?? 0) + 1;
    });
    if (mem) onCounts.push(onC);
    let sOnC = 0;
    st.forEach((s) => {
      if (lab(s.cell) !== s.pattern_label || (s.pattern_label === 'on') !== s.is_on_pattern)
        bad('star label vs cell');
      const o = s.pattern_label === 'on' ? 1 : 0;
      sOnC += o;
      stShade[sh][o]++;
      stOn[s.slot_index_in_seq] += o;
      stN[s.slot_index_in_seq]++;
      stOrdOn[s.probe_position] += o;
      stOrdN[s.probe_position]++;
      strStarOn[g] += o;
      strStarN[g]++;
      starUse[s.cell] = (starUse[s.cell] ?? 0) + 1;
    });
    if (star) stOnCounts.push(sOnC);
    if (mem) {
      const pr = t.probes;
      if (pr.length !== 3) bad('probe count');
      const encCells = mi.map((m) => m.cell);
      let tg = 0;
      const cnt = {};
      const encOrds = new Set(pr.map((p) => p.encoding_position));
      if (encOrds.size !== 3) bad('ord perm');
      pr.forEach((p, j) => {
        if (p.probe_position !== j) bad('probe pos');
        const ti = ['T_on', 'T_off', 'F_on', 'F_off'].indexOf(p.type);
        if (ti < 0) bad('probe type');
        cnt[p.type] = (cnt[p.type] ?? 0) + 1;
        tpos[ti][j]++;
        typeShade[sh][ti]++;
        tposShade[sh][ti][j]++;
        opos[p.encoding_position][j]++;
        if (p.is_target !== ti <= 1) bad('is_target');
        if (lab(p.cell) !== (ti === 0 || ti === 2 ? 'on' : 'off')) bad('probe label vs cell');
        /* the stored pattern_label must agree with the probed cell AND the type suffix */
        if (
          p.pattern_label !== (ti === 0 || ti === 2 ? 'on' : 'off') ||
          p.pattern_label !== cfgLab(p.cell)
        )
          bad('probe pattern_label');
        if (ti <= 1) {
          tg++;
          cop[ti][p.encoding_position][j]++;
          const it = mi[p.encoding_position];
          if (p.cell !== it.cell) bad('target cell != item cell');
          if (it.pattern_label !== (ti === 0 ? 'on' : 'off')) bad('target pin label');
          const s = it.slot_index_in_seq;
          slotTgt[s]++;
          if (ti === 0) slotTon[s]++;
          slotPos[s][j]++;
        } else {
          if (encCells.includes(p.cell)) bad('foil on encoded cell');
          if (st.some((s) => s.cell === p.cell)) bad('foil on star cell');
          if (du.some((d) => d.cell === p.cell)) bad('foil on dummy cell');
          if (
            tone &&
            encCells.some((c) => Math.abs(toneForCell(c).rank - toneForCell(p.cell).rank) < 3)
          )
            bad('foil tone spacing');
          foilUse[p.cell] = (foilUse[p.cell] ?? 0) + 1;
        }
      });
      const foils = pr.filter((p) => !p.is_target).map((p) => p.cell);
      if (new Set(foils).size !== foils.length) bad('foil repeat');
      targetCounts.push(tg);
      if (Math.max(...Object.values(cnt)) > 2) bad('type cap');
      if (tone) {
        for (let i = 0; i < 3; i++)
          for (let j = i + 1; j < 3; j++)
            if (Math.abs(toneForCell(mi[i].cell).rank - toneForCell(mi[j].cell).rank) < 3)
              bad('encoded tone spacing');
      }
      if (st.some((s) => encCells.includes(s.cell))) bad('star on item cell');
      if (st.some((s) => pr.some((p) => p.cell === s.cell))) bad('star on probe cell');
    }
    if (onRange && mem && (onC < onRange[0] || onC > onRange[1])) bad('mem on-count range');
    if (onRange && star && (sOnC < onRange[0] || sOnC > onRange[1])) bad('star on-count range');
  }
  const hist = (a) => [0, 1, 2, 3].map((k) => a.filter((x) => x === k).length);
  const all = (a, x) => a.every((y) => y === x);
  if (!all(mSlot, 6) || !all(sSlot, 6)) bad('slot M/S not 6/6');
  if (mem) {
    if (!all(memN, 6) || !all(memOn, 3)) bad('mem per-slot on != 3/6');
    if (!all(memOrdOn, 6)) bad('mem per-ordinal on != 6');
    if (!tpos.flat().every((x) => x === 3)) bad('type x pos != 3');
    if (!opos.flat().every((x) => x === 4)) bad('ord x pos != 4');
    if (!cop.flat(2).every((x) => x === 1)) bad('class x ord x pos != 1');
    if (!all(slotTgt, 3)) bad('targets per slot != 3');
    if (!slotTon.every((x) => x === 1 || x === 2)) bad('T_on per slot not in {1,2}');
    if (sum(slotTon) !== 9) bad('T_on total');
    if (slotPosExact && !slotPos.flat().every((x) => x === 1)) bad('slot x testpos != 1');
    if (!memShade.flat().every((x) => x === 9)) bad('mem label x shade != 9');
    if (!typeShade.flat().every((x) => x === 4 || x === 5)) bad('probe type x shade not 4/5');
    if (!tposShade.flat(2).every((x) => x === 1 || x === 2))
      bad('probe type x pos x shade not 1/2');
    if (HAS_ROT(type) && !(strMemN.every((x) => x === 6) && strMemOn.every((x) => x === 3)))
      bad('mem label x stratum != 3 of 6');
  }
  if (star) {
    if (!all(stN, 6) || !all(stOn, 3)) bad('star per-slot on != 3/6');
    if (!all(stOrdOn, 6)) bad('star per-ordinal on != 6');
    if (!all(strStarN, 6) || !all(strStarOn, 3)) bad('star per-stratum on != 3/6');
    if (!stShade.flat().every((x) => x === 9)) bad('star label x shade != 9');
  }
  if (HAS_ROT(type) && !all(strN, 2)) bad('strata != 2');
  if (shade.white !== 6 || shade.gray !== 6) bad('shade != 6/6');
  if (histOK) {
    const okH = (h) => h.join() === '2,4,4,2' || h.join() === '1,5,5,1';
    if (mem && !okH(hist(onCounts))) bad('mem on-count hist not (2,4,4,2)/(1,5,5,1)');
    if (mem && !okH(hist(targetCounts))) bad('targets-per-trial hist not (2,4,4,2)/(1,5,5,1)');
    if (star && !okH(hist(stOnCounts))) bad('star on-count hist not (2,4,4,2)/(1,5,5,1)');
  }
  return {
    viol: v,
    m: {
      slotTon,
      slotPos,
      onHist: mem ? hist(onCounts) : null,
      starOnHist: star ? hist(stOnCounts) : null,
      strMemOn: HAS_ROT(type) && mem ? strMemOn : null,
      encUse,
      foilUse,
      starUse,
    },
  };
}
function HAS_ROT(t) {
  return t !== 't_only';
}

/* pool-level checks: the CURRENT pool balances must hold exactly on A+B */
export function checkPool(A, B, type) {
  const v = [];
  const bad = (s) => v.push(s);
  const tr = [...A, ...B];
  const mem = type !== 'i_only',
    star = type.startsWith('i_');
  const mSlot = Z(6),
    memOn = Z(6),
    stOn = Z(6),
    memOrdOn = Z(3),
    stOrdOn = Z(3),
    strStar = Z(6),
    strN = Z(6);
  const tpos = Z(4, 3),
    opos = Z(3, 3),
    cop = [Z(3, 3), Z(3, 3)],
    slotTon = Z(6),
    slotTgt = Z(6);
  const angles = [];
  const shade = { white: 0, gray: 0 };
  const memShade = Z(2, 2),
    stShade = Z(2, 2),
    typeShade = Z(2, 4),
    tposShade = [Z(4, 3), Z(4, 3)],
    strMemOn = Z(6);
  const seqCount = {};
  for (const t of tr) {
    seqCount[t.sequence.join('')] = (seqCount[t.sequence.join('')] ?? 0) + 1;
    shade[t.background_shade]++;
    const sh = t.background_shade === 'white' ? 0 : 1;
    t.sequence.forEach((c, i) => c === 'M' && mSlot[i]++);
    const a = t.rotation_deg ?? t.display_rotation_deg;
    let g = 0;
    if (a !== undefined) {
      angles.push(a);
      g = STR.findIndex(([l, h]) => a >= l && a <= h);
      strN[g]++;
    }
    (t.memory_items ?? []).forEach((m) => {
      const o = m.pattern_label === 'on' ? 1 : 0;
      memOn[m.slot_index_in_seq] += o;
      memOrdOn[m.encoding_position] += o;
      memShade[sh][o]++;
      if (a !== undefined) strMemOn[g] += o;
    });
    (t.stars ?? []).forEach((s) => {
      const o = s.pattern_label === 'on' ? 1 : 0;
      stOn[s.slot_index_in_seq] += o;
      stOrdOn[s.probe_position] += o;
      strStar[g] += o;
      stShade[sh][o]++;
    });
    (t.probes ?? []).forEach((p, j) => {
      const ti = ['T_on', 'T_off', 'F_on', 'F_off'].indexOf(p.type);
      tpos[ti][j]++;
      typeShade[sh][ti]++;
      tposShade[sh][ti][j]++;
      opos[p.encoding_position][j]++;
      if (ti <= 1) {
        cop[ti][p.encoding_position][j]++;
        const s = t.memory_items[p.encoding_position].slot_index_in_seq;
        slotTgt[s]++;
        if (ti === 0) slotTon[s]++;
      }
    });
  }
  const all = (a, x) => a.every((y) => y === x);
  if (!all(mSlot, 12)) bad('pool: M per slot != 12');
  if (shade.white !== 12) bad('pool: shade 12/12');
  if (new Set(angles).size !== angles.length) bad('pool: angle repeated');
  if (angles.length && (!all(strN, 4) || angles.filter((x) => x < 0).length !== 12))
    bad('pool: strata 4 / sign 12');
  if (Object.values(seqCount).some((c) => c > 2) || Object.keys(seqCount).length !== 14)
    bad('pool: sequence use not all-14, <=2');
  if (mem) {
    if (!all(memOn, 6)) bad('pool: mem per-slot on != 6/12');
    if (!all(memOrdOn, 12)) bad('pool: mem ordinal on != 12');
    if (!tpos.flat().every((x) => x === 6)) bad('pool: type x pos != 6');
    if (!opos.flat().every((x) => x === 8)) bad('pool: ord x pos != 8');
    if (!cop.flat(2).every((x) => x === 2)) bad('pool: class x ord x pos != 2');
    if (!all(slotTon, 3) || !all(slotTgt, 6)) bad('pool: T_on/T_off per slot != 3/3');
    if (!memShade.flat().every((x) => x === 18)) bad('pool: mem label x shade != 18');
    if (!typeShade.flat().every((x) => x === 9)) bad('pool: probe type x shade != 9');
    if (!tposShade.flat(2).every((x) => x === 3)) bad('pool: probe type x pos x shade != 3');
    if (HAS_ROT(type) && !all(strMemOn, 6)) bad('pool: mem label x stratum != 6 of 12');
  }
  if (star) {
    if (!all(stOn, 6)) bad('pool: star per-slot on != 6/12');
    if (!all(stOrdOn, 12)) bad('pool: star ordinal on != 12');
    if (!all(strStar, 6)) bad('pool: star per-stratum on != 6 of 12');
    if (!stShade.flat().every((x) => x === 18)) bad('pool: star label x shade != 18');
  }
  /* cell-usage metrics (soft) */
  const use = (key) => {
    const u = {};
    for (const t of tr) for (const m of key(t)) u[m] = (u[m] ?? 0) + 1;
    return u;
  };
  const encU = use((t) => (t.memory_items ?? []).map((m) => m.cell));
  const foilU = use((t) => (t.probes ?? []).filter((p) => !p.is_target).map((p) => p.cell));
  const starU = use((t) => (t.stars ?? []).map((s) => s.cell));
  const spread = (u, cells) => {
    const x = cells.map((c) => u[c] ?? 0);
    return [Math.min(...x), Math.max(...x)];
  };
  const all24 = [...ON, ...OFF];
  return {
    viol: v,
    m: { enc: spread(encU, all24), foil: spread(foilU, all24), star: spread(starU, all24) },
  };
}

/* Plan-level identity stamp (independent re-derivation): returns the list of problems. */
export function checkPlanMeta(plan) {
  const viol = [];
  const uids = [];
  for (const [label, blk, off] of [
    ['main_a', plan.mainA, 0],
    ['main_b', plan.mainB, 60],
  ]) {
    blk.trialParams.forEach((p, i) => {
      const m = p.trial_meta ?? {};
      const n = off + i + 1;
      if (m.presentation_index !== n) viol.push(`presentation_index ${label}#${i}`);
      if (m.block_position !== i) viol.push(`block_position ${label}#${i}`);
      if (m.trial_uid !== `${label}-${String(n).padStart(3, '0')}-${p.trial_type}`)
        viol.push(`trial_uid ${label}#${i}`);
      uids.push(m.trial_uid);
    });
  }
  if (new Set(uids).size !== 120) viol.push('trial_uid not unique');
  return viol;
}
