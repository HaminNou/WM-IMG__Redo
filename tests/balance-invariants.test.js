/**
 * The block / pool validators (src/scheduler/balance-invariants.js) and their NEGATIVE controls.
 *
 * Every control corrupts ONE property of a valid generated half-pool and expects (a) the shipped
 * validator to report the named violation and (b) the independent oracle
 * (tests/helpers/block-oracle.js, ported from the designer's standalone checker) to reject it too,
 * so neither validator can silently pass a corrupted plan.
 */
import { describe, it, expect } from 'vitest';
import { createPRNG } from '../src/prng.js';
import { generateBalancedPool } from '../src/scheduler/balanced-pool.js';
import {
  blockInvariantViolations,
  poolInvariantViolations,
  assertBlockInvariants,
  assertPoolInvariants,
  planInvariantViolations,
} from '../src/scheduler/balance-invariants.js';
import { onPatternCells, offPatternCells } from '../src/grid.js';
import { toneForCell } from '../src/audio/tones.js';
import { checkBlock, checkPool, checkPlanMeta } from './helpers/block-oracle.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';

const TYPES = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];
const ON = onPatternCells();
const OFF = offPatternCells();
const clone = (x) => JSON.parse(JSON.stringify(x));
const pool = (type, seed = 'neg') => generateBalancedPool(type, createPRNG(`${seed}|${type}`));
/* an oracle that throws on an impossible input (centre cell has no tone) counts as a rejection */
const oracle = (blk, type) => {
  try {
    return checkBlock(blk, type, { histOK: true }).viol;
  } catch (e) {
    return [`threw: ${e.message}`];
  }
};

describe('valid pools pass both validators', () => {
  for (const type of TYPES) {
    it(type, () => {
      const { halfA, halfB } = pool(type, 'valid');
      expect(blockInvariantViolations(halfA, type)).toEqual([]);
      expect(blockInvariantViolations(halfB, type)).toEqual([]);
      expect(poolInvariantViolations(halfA, halfB, type)).toEqual([]);
      expect(oracle(halfA, type)).toEqual([]);
      expect(oracle(halfB, type)).toEqual([]);
      expect(checkPool(halfA, halfB, type).viol).toEqual([]);
      expect(() => assertBlockInvariants(halfA, type)).not.toThrow();
      expect(() => assertPoolInvariants(halfA, halfB, type)).not.toThrow();
    });
  }
});

/* name, applies-to predicate, mutation (returns nothing; mutates a plain-object copy of half A), expected code */
const hasMem = (t) => t !== 'i_only';
const hasStar = (t) => t.startsWith('i_');
const isTone = (t) => t === 't_only' || t === 'i_t';
const rotates = (t) => t !== 't_only';
const angleKey = (t) => (t === 'd_only' ? 'display_rotation_deg' : 'rotation_deg');
const other = (c, set) => set.find((x) => x !== c);
const CONTROLS = [
  {
    name: 'memory label flipped on the item only (label no longer matches the cell)',
    when: hasMem,
    code: /mem_label_cell/,
    mutate: (b) => {
      const m = b[0].memory_items[0];
      m.pattern_label = m.pattern_label === 'on' ? 'off' : 'on';
    },
  },
  {
    name: 'one memory item moved to a cell of the other label consistently (per-slot balance breaks)',
    when: hasMem,
    code: /mem_slot_label|mem_ordinal_label|mem_on_histogram|target_/,
    mutate: (b) => {
      const m = b[0].memory_items[2];
      const toOn = m.pattern_label === 'off';
      const used = new Set(b[0].memory_items.map((x) => x.cell));
      m.cell = (toOn ? ON : OFF).find((c) => !used.has(c));
      m.pattern_label = toOn ? 'on' : 'off';
    },
  },
  {
    name: 'star label flipped on the star only',
    when: hasStar,
    code: /star_label_cell/,
    mutate: (b) => {
      const s = b[0].stars[0];
      s.pattern_label = s.pattern_label === 'on' ? 'off' : 'on';
      s.is_on_pattern = !s.is_on_pattern;
    },
  },
  {
    name: 'one star moved to a cell of the other label consistently (per-slot star balance breaks)',
    when: hasStar,
    code: /star_slot_label|star_ordinal_label|star_stratum_label|star_on_histogram/,
    mutate: (b) => {
      const s = b[0].stars[1];
      const toOn = s.pattern_label === 'off';
      const used = new Set([
        ...(b[0].memory_items ?? []).map((x) => x.cell),
        ...(b[0].probes ?? []).map((x) => x.cell),
        ...b[0].stars.map((x) => x.cell),
        ...(b[0].dummies ?? []).map((x) => x.cell),
      ]);
      s.cell = (toOn ? ON : OFF).find((c) => !used.has(c));
      s.pattern_label = toOn ? 'on' : 'off';
      s.is_on_pattern = toOn;
    },
  },
  {
    name: 'one background shade flipped',
    when: () => true,
    code: /shade/,
    mutate: (b) => {
      b[0].background_shade = b[0].background_shade === 'white' ? 'gray' : 'white';
    },
  },
  {
    name: 'a trial replaced by a non-complement M/S string',
    when: () => true,
    code: /slot_ms|sequence_pairs|sequence_repeat|mem_slot|star_slot|dummy_slot/,
    mutate: (b) => {
      b[0].sequence =
        b[0].sequence[0] === 'M' ? ['M', 'M', 'S', 'S', 'M', 'S'] : ['S', 'S', 'M', 'M', 'S', 'M'];
    },
  },
  {
    name: 'a trial duplicated over another (a string occurs twice, slot occupancy breaks)',
    when: () => true,
    code: /sequence_repeat|slot_ms|sequence_pairs/,
    mutate: (b) => {
      b[1] = { ...clone(b[0]), trial_index_in_block: 1 };
    },
  },
  {
    name: 'a probe type duplicated (type x position breaks)',
    when: hasMem,
    code: /probe_type_x_position|probe_type_cap|probe_fields|probe_label_cell|is_target|targets_per/,
    mutate: (b) => {
      const p = b[0].probes.find((x) => !x.is_target);
      p.type = p.type === 'F_on' ? 'F_off' : 'F_on';
    },
  },
  {
    name: 'two probes of a trial swap their test positions',
    when: hasMem,
    code: /probe_fields|ordinal_x_position|probe_type_x_position|class_x_ordinal/,
    mutate: (b) => {
      const [p, q] = b[0].probes;
      [p.probe_position, q.probe_position] = [q.probe_position, p.probe_position];
    },
  },
  {
    name: 'a target probe pointing at another item (probed-target slot balance breaks)',
    when: hasMem,
    code: /target_cell|ordinal|targets_per_slot|class_x/,
    mutate: (b) => {
      const p = b[0].probes.find((x) => x.is_target);
      p.encoding_position = (p.encoding_position + 1) % 3;
    },
  },
  {
    name: 'a foil placed on an encoded cell',
    when: hasMem,
    code: /foil_on_encoded/,
    mutate: (b) => {
      b[0].probes.find((x) => !x.is_target).cell = b[0].memory_items[0].cell;
    },
  },
  {
    name: 'a star placed on a memory-item cell',
    when: (t) => t === 'i_d' || t === 'i_t',
    code: /star_on_item|cell_reuse/,
    mutate: (b) => {
      b[0].stars[0].cell = b[0].memory_items[0].cell;
    },
  },
  {
    name: 'a rotation angle moved to another stratum',
    when: rotates,
    code: /strata|angle_sign|star_stratum_label/,
    mutate: (b, type) => {
      b[0][angleKey(type)] = b[0][angleKey(type)] < 0 ? 75 : -75;
    },
  },
  {
    name: 'a rotation angle repeated',
    oracleToo: false /* the oracle checks repeats on the pool only */,
    when: rotates,
    code: /angle_repeat/,
    mutate: (b, type) => {
      b[1][angleKey(type)] = b[0][angleKey(type)];
    },
  },
  {
    name: 'a rotation angle outside every stratum',
    when: rotates,
    code: /angle:/,
    mutate: (b, type) => {
      b[0][angleKey(type)] = 120;
    },
  },
  {
    name: 't_only trial given a rotation',
    oracleToo: false /* the oracle does not look at t_only angles */,
    when: (t) => t === 't_only',
    code: /angle/,
    mutate: (b) => {
      b[0].rotation_deg = 10;
    },
  },
  {
    name: 'trial removed (size)',
    when: () => true,
    code: /size/,
    mutate: (b) => {
      b.pop();
    },
  },
  {
    name: 'a stimulus on the centre cell',
    when: hasMem,
    code: /centre_cell|cell_reuse|label/,
    mutate: (b) => {
      b[0].memory_items[0].cell = 12;
    },
  },
  {
    name: 'two encoded tones closer than 3 ranks',
    when: isTone,
    code: /tone_spacing_encoded|target_cell|mem_label_cell/,
    mutate: (b) => {
      const a = b[0].memory_items[0];
      const bItem = b[0].memory_items[1];
      const near = [...ON, ...OFF].find(
        (c) =>
          c !== a.cell &&
          Math.abs(toneForCell(c).rank - toneForCell(a.cell).rank) <= 2 &&
          (ON.includes(c) ? 'on' : 'off') === bItem.pattern_label &&
          !b[0].memory_items.some((m) => m.cell === c)
      );
      bItem.cell = near;
      for (const p of b[0].probes) if (p.is_target && p.encoding_position === 1) p.cell = near;
    },
  },
  {
    name: 'a foil tone within 2 ranks of an encoded tone',
    when: isTone,
    code: /tone_spacing_foil/,
    mutate: (b) => {
      const foil = b[0].probes.find((x) => !x.is_target);
      const enc = b[0].memory_items.map((m) => m.cell);
      const rank = (c) => toneForCell(c).rank;
      const near = (foil.pattern_label === 'on' ? ON : OFF).find(
        (c) =>
          !enc.includes(c) &&
          enc.some((e) => Math.abs(rank(c) - rank(e)) <= 2) &&
          !b[0].probes.some((p) => p !== foil && p.cell === c) &&
          !(b[0].stars ?? []).some((s) => s.cell === c)
      );
      foil.cell = near;
    },
  },
  {
    name: 'a trial with three targets',
    when: hasMem,
    code: /targets_per_trial|probe_type_cap|target_|is_target|probe_type_x_position|targets_per_slot/,
    mutate: (b) => {
      const trial = b[0];
      trial.probes.forEach((p, j) => {
        const e = p.encoding_position;
        p.is_target = true;
        p.cell = trial.memory_items[e].cell;
        p.type = trial.memory_items[e].pattern_label === 'on' ? 'T_on' : 'T_off';
        p.pattern_label = trial.memory_items[e].pattern_label;
        void j;
      });
    },
  },
  {
    name: 'two items swap ordinals inside a trial',
    when: hasMem,
    code: /mem_slot|ordinal|target|probe/,
    mutate: (b) => {
      const mi = b[0].memory_items;
      [mi[0].encoding_position, mi[1].encoding_position] = [
        mi[1].encoding_position,
        mi[0].encoding_position,
      ];
    },
  },
  {
    name: 'a foil probe moved onto a dummy cell (Step 3 gap m1)',
    when: (t) => t === 'd_only' || t === 't_only',
    code: /foil_on_dummy/,
    mutate: (b) => {
      const t = b.find((x) => x.dummies?.length && x.probes.some((p) => !p.is_target));
      t.probes.find((p) => !p.is_target).cell = t.dummies[0].cell;
    },
  },
  {
    name: 'probe pattern_label contradicts the probed cell and the type suffix (gap m2)',
    when: hasMem,
    code: /probe_pattern_label/,
    mutate: (b) => {
      const p = b[0].probes[0];
      p.pattern_label = p.pattern_label === 'on' ? 'off' : 'on';
    },
  },
];

describe('negative controls: one corrupted property is named and rejected by both validators', () => {
  let tested = 0;
  for (const type of TYPES) {
    for (const c of CONTROLS) {
      if (!c.when(type)) continue;
      it(`${type}: ${c.name}`, () => {
        const { halfA } = pool(type);
        const copy = clone(halfA);
        c.mutate(copy, type);
        tested++;
        const mine = blockInvariantViolations(copy, type);
        expect(mine.length, `${type}/${c.name}: shipped validator missed it`).toBeGreaterThan(0);
        expect(mine.join('\n')).toMatch(c.code);
        if (c.oracleToo !== false)
          expect(oracle(copy, type).length, `${type}/${c.name}: oracle missed it`).toBeGreaterThan(
            0
          );
        expect(() => assertBlockInvariants(copy, type)).toThrow(/block invariants/);
      });
    }
  }
  it('ran at least 80 negative controls', () => {
    const n = TYPES.reduce((s, t) => s + CONTROLS.filter((c) => c.when(t)).length, 0);
    expect(n).toBeGreaterThanOrEqual(80);
  });
});

describe('pool-level controls', () => {
  it('both halves leaving out the same pair is rejected', () => {
    const { halfA } = pool('i_d');
    const copy = clone(halfA).map((t, i) => ({ ...t, trial_index_in_block: 12 + i }));
    const v = poolInvariantViolations(halfA, copy, 'i_d');
    expect(v.join('\n')).toMatch(/pool_omitted_pairs/);
    expect(v.join('\n')).toMatch(/pool_angle_repeat/);
  });
  it('halves of two different pools do not form an exact pool', () => {
    const a = pool('i_t', 'one').halfA;
    const b = pool('i_t', 'two').halfB;
    expect(poolInvariantViolations(a, b, 'i_t').length).toBeGreaterThan(0);
    expect(checkPool(a, b, 'i_t').viol.length).toBeGreaterThan(0);
  });
  it('a probed-target label moved between slots across halves is rejected at the pool level only', () => {
    /* swap whole trials of half B into half A: each half stays a valid-looking list of trials but the
     * block-level counts break, and the pool-level T_on / T_off per slot no longer sums to 3 / 3 */
    const { halfA, halfB } = pool('d_only', 'swap');
    const a = clone(halfA);
    const b = clone(halfB);
    [a[0], b[0]] = [b[0], a[0]];
    expect(poolInvariantViolations(a, b, 'd_only').length).toBeGreaterThan(0);
    expect(blockInvariantViolations(a, 'd_only').length).toBeGreaterThan(0);
  });
  it('an unknown type is reported rather than crashing', () => {
    expect(blockInvariantViolations([], 'x_only')[0]).toMatch(/unknown trial type/);
  });
});

/* Step 3 gap m3: the identity stamped on each trial of a whole plan. */
describe('plan-level trial_meta controls', () => {
  const MUTATIONS = [
    ['presentation_index', (m) => (m.presentation_index += 1), /presentation_index/],
    ['block_position', (m) => (m.block_position += 1), /block_position/],
    ['trial_uid', (m) => (m.trial_uid = 'main_a-999-d_only'), /trial_uid/],
  ];
  const base = generateMainPlan({ prng: createPRNG('meta-controls') });
  it('an unmodified plan passes both checks', () => {
    expect(planInvariantViolations(base)).toEqual([]);
    expect(checkPlanMeta(base)).toEqual([]);
  });
  for (const [field, mutate, re] of MUTATIONS) {
    it(`${field} inconsistent with position is named by the validator and the oracle`, () => {
      const plan = {
        ...base,
        mainB: {
          ...base.mainB,
          trialParams: base.mainB.trialParams.map((p, i) =>
            i === 7 ? { ...p, trial_meta: { ...p.trial_meta } } : p
          ),
        },
      };
      mutate(plan.mainB.trialParams[7].trial_meta);
      expect(planInvariantViolations(plan).join('\n')).toMatch(/plan_trial_meta|plan_trial_uid/);
      expect(planInvariantViolations(plan).join('\n')).toMatch(re);
      expect(checkPlanMeta(plan).join('\n')).toMatch(re);
    });
  }
});
