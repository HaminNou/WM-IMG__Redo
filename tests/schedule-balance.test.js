/**
 * Counterbalance checks for the main-task schedule, run over many seeds.
 *
 * Per condition (24-trial pool) and per session:
 *   - probe type x probe position: 6 in each of the 12 cells
 *   - encoding position x probe position: 8 in each of the 9 cells (all probes)
 *     and 4 in each cell among target probes, 2 per target class
 *   - memory items: 12 on / 12 off at each encoding position
 *   - slot sequences: valid, 14 sequences each used once or twice,
 *     M on exactly 12 trials at each of the 6 slots
 *   - stars: 12 on / 12 off at each serial position, 6 on / 6 off at each
 *     S-slot, 6 on / 6 off in each of the six 30-degree angle strata
 *   - rotation (imagery conditions and the display angle of d_only): 4 angles
 *     per stratum, 12 clockwise / 12 counter-clockwise, all distinct, none
 *     equal to 0
 *   - background: 12 white / 12 gray per condition, 6 / 6 per half
 *   - cells: no star, dot, probe or placeholder collides within a trial
 * Per block:
 *   - 12 trials of each condition, no run of more than 2 of one condition,
 *     also across the Main A / Main B boundary
 *   - no more than 6 same-direction rotations in a row, consecutive angles
 *     at least 3 degrees apart, no more than 6 trials of one background in a row
 *   - presentation_index 1..120 and trial_uid unique over the session
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools, enumerateValidSequences } from '../src/scheduler/within-trial.js';
import { generateMainBlockPair } from '../src/scheduler/main-blocks.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';
import { onPatternCells } from '../src/grid.js';
import { rotationStratumIndex, orderViolations } from '../src/scheduler/rotation-balance.js';

const TYPES = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];
const MEMORY = ['d_only', 't_only', 'i_d', 'i_t'];
const IMAGERY = ['i_only', 'i_d', 'i_t'];
const PROBE_TYPES = ['T_on', 'T_off', 'F_on', 'F_off'];
const SEEDS = Array.from({ length: 40 }, (_, i) => `balance-seed-${i}`);
const ON = new Set(onPatternCells());

function build(seed) {
  setSessionPRNG(seed);
  resetSequencePools();
  return generateMainBlockPair();
}

function count2d(rows, cols, cells) {
  const m = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (const [r, c] of cells) m[r][c] += 1;
  return m;
}
const all = (m, v) => m.every((row) => row.every((x) => x === v));

describe('per-condition pool, 24 trials', () => {
  for (const seed of SEEDS) {
    it(`balance holds for ${seed}`, () => {
      const pair = build(seed);
      const valid = new Set(enumerateValidSequences().map((s) => s.join('')));
      for (const type of TYPES) {
        const pool = pair.trialParamsByType[type].all;
        expect(pool).toHaveLength(24);

        /* sequences */
        const use = {};
        const mAtSlot = Array(6).fill(0);
        for (const p of pool) {
          const key = p.sequence.join('');
          expect(valid.has(key)).toBe(true);
          use[key] = (use[key] ?? 0) + 1;
          p.sequence.forEach((c, i) => c === 'M' && mAtSlot[i]++);
        }
        expect(mAtSlot).toEqual(Array(6).fill(12));
        expect(Object.keys(use)).toHaveLength(14);
        expect(Math.max(...Object.values(use))).toBeLessThanOrEqual(2);

        /* background */
        expect(pool.filter((p) => p.background_shade === 'white')).toHaveLength(12);
        for (const half of ['halfA', 'halfB']) {
          expect(
            pair.trialParamsByType[type][half].filter((p) => p.background_shade === 'white')
          ).toHaveLength(6);
        }

        if (MEMORY.includes(type)) {
          const typePos = count2d(
            4,
            3,
            pool.flatMap((p) =>
              p.probes.map((q) => [PROBE_TYPES.indexOf(q.type), q.probe_position])
            )
          );
          expect(all(typePos, 6)).toBe(true);
          const encPos = count2d(
            3,
            3,
            pool.flatMap((p) => p.probes.map((q) => [q.encoding_position, q.probe_position]))
          );
          expect(all(encPos, 8)).toBe(true);
          for (const cls of ['T_on', 'T_off']) {
            const t = count2d(
              3,
              3,
              pool.flatMap((p) =>
                p.probes
                  .filter((q) => q.type === cls)
                  .map((q) => [q.encoding_position, q.probe_position])
              )
            );
            expect(all(t, 2)).toBe(true);
          }
          for (let pos = 0; pos < 3; pos++) {
            const on = pool.filter((p) => p.memory_items[pos].pattern_label === 'on').length;
            expect(on).toBe(12);
          }
          for (const p of pool) {
            for (const q of p.probes) {
              if (q.is_target) {
                expect(q.cell).toBe(p.memory_items[q.encoding_position].cell);
              }
            }
          }
        }

        if (type === 'd_only') {
          const angles = pool.map((p) => p.display_rotation_deg);
          expect(new Set(angles).size).toBe(24);
          expect(angles.filter((a) => a > 0)).toHaveLength(12);
          expect(angles.every((a) => a >= -90 && a <= 90 && a !== 0)).toBe(true);
          const perStratum = Array(6).fill(0);
          angles.forEach((a) => perStratum[rotationStratumIndex(a)]++);
          expect(perStratum).toEqual(Array(6).fill(4));
        }

        if (IMAGERY.includes(type)) {
          const slotOn = Array(6).fill(0);
          const posOn = Array(3).fill(0);
          const strOn = Array(6).fill(0);
          for (const p of pool) {
            const g = rotationStratumIndex(p.rotation_deg);
            for (const s of p.stars) {
              if (s.pattern_label === 'on') {
                slotOn[s.slot_index_in_seq]++;
                posOn[s.probe_position]++;
                strOn[g]++;
              }
            }
          }
          expect(slotOn).toEqual(Array(6).fill(6));
          expect(posOn).toEqual(Array(3).fill(12));
          expect(strOn).toEqual(Array(6).fill(6));

          const angles = pool.map((p) => p.rotation_deg);
          expect(new Set(angles).size).toBe(24);
          expect(angles.filter((a) => a > 0)).toHaveLength(12);
          expect(angles.every((a) => a >= -90 && a <= 90 && a !== 0)).toBe(true);
          const perStratum = Array(6).fill(0);
          angles.forEach((a) => perStratum[rotationStratumIndex(a)]++);
          expect(perStratum).toEqual(Array(6).fill(4));
        }

        /* cell collisions inside a trial */
        for (const p of pool) {
          const items = (p.memory_items ?? []).map((x) => x.cell);
          const stars = (p.stars ?? []).map((x) => x.cell);
          const dummies = (p.dummies ?? []).map((x) => x.cell);
          const foils = (p.probes ?? []).filter((q) => !q.is_target).map((q) => q.cell);
          const shown = [...items, ...stars, ...dummies];
          expect(new Set(shown).size).toBe(shown.length);
          for (const f of foils) expect(shown.includes(f)).toBe(false);
          expect(new Set(foils).size).toBe(foils.length);
          for (const c of [...shown, ...foils]) expect(c).not.toBe(12);
          for (const q of p.probes ?? []) expect(ON.has(q.cell)).toBe(q.pattern_label === 'on');
        }
      }
    });
  }
});

describe('blocks and session', () => {
  for (const seed of SEEDS) {
    it(`order and identity hold for ${seed}`, () => {
      const pair = build(seed);
      const blocks = [pair.mainA, pair.mainB];
      for (const b of blocks) {
        expect(b.schedule).toHaveLength(60);
        for (const t of TYPES) expect(b.schedule.filter((x) => x === t)).toHaveLength(12);
        expect(orderViolations(b.trialParams)).toBe(0);
      }
      const seq = [...pair.mainA.schedule, ...pair.mainB.schedule];
      let run = 1;
      for (let i = 1; i < seq.length; i++) {
        run = seq[i] === seq[i - 1] ? run + 1 : 1;
        expect(run).toBeLessThanOrEqual(2);
      }
      const params = [...pair.mainA.trialParams, ...pair.mainB.trialParams];
      expect(params.map((p) => p.trial_meta.presentation_index)).toEqual(
        Array.from({ length: 120 }, (_, i) => i + 1)
      );
      expect(new Set(params.map((p) => p.trial_meta.trial_uid)).size).toBe(120);
      params.forEach((p) => expect(p.trial_meta.condition).toBe(p.trial_type));
    });
  }

  it('the pure plan equals the plan used by the runtime for the same seed', () => {
    setSessionPRNG('plan-equality');
    resetSequencePools();
    const plan = generateMainPlan();
    const pair = build('plan-equality');
    expect(pair.mainA.trialParams).toEqual(plan.mainA.trialParams);
    expect(pair.mainB.trialParams).toEqual(plan.mainB.trialParams);
  });

  it('is reproducible from the seed and differs between seeds', () => {
    const a = JSON.stringify(build('same').mainA.trialParams);
    const b = JSON.stringify(build('same').mainA.trialParams);
    const c = JSON.stringify(build('other').mainA.trialParams);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
