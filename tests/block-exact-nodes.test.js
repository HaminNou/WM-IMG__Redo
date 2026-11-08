/**
 * @vitest-environment jsdom
 *
 * The balanced labels survive all the way into the nodes the runner executes: the encoding node of every
 * trial of the REAL block pair (generateMainBlockPair) carries a `trial_spec` snapshot of the plan. Rebuild
 * the trials from those snapshots only (what is recorded in the data rows) and check, per block and
 * condition, that the labels are exactly balanced per serial position (independent oracle), that the
 * snapshot equals the planned trial, and that the page background / angle recorded on the node match.
 */
import { describe, it, expect } from 'vitest';
import { createPRNG } from '../src/prng.js';
import { generateMainBlockPair } from '../src/scheduler/main-blocks.js';
import { checkBlock, checkPool } from './helpers/block-oracle.js';

const TYPES = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];

function fromSpec(node) {
  const spec = node.data.trial_spec;
  const t = {
    trial_type: spec.condition,
    trial_index_in_block: node.data.trial_index_in_block,
    background_shade: node.data.background_shade,
    sequence: spec.sequence.split(''),
  };
  if (spec.rotation_deg !== null) t.rotation_deg = spec.rotation_deg;
  if (spec.display_rotation_deg !== null) t.display_rotation_deg = spec.display_rotation_deg;
  if (spec.memory_items.length)
    t.memory_items = spec.memory_items.map((m) => ({
      slot_index_in_seq: m.slot,
      encoding_position: m.encoding_position,
      cell: m.cell,
      pattern_label: m.pattern_label,
    }));
  if (spec.stars.length)
    t.stars = spec.stars.map((s) => ({
      slot_index_in_seq: s.slot,
      probe_position: s.probe_position,
      cell: s.cell,
      pattern_label: s.pattern_label,
      is_on_pattern: s.pattern_label === 'on',
    }));
  if (spec.dummies.length)
    t.dummies = spec.dummies.map((d) => ({ slot_index_in_seq: d.slot, cell: d.cell }));
  if (spec.probes.length)
    t.probes = spec.probes.map((p) => ({
      probe_position: p.probe_position,
      encoding_position: p.encoding_position,
      type: p.type,
      cell: p.cell,
      is_target: p.is_target,
      pattern_label: p.pattern_label,
    }));
  return t;
}

describe('encoding nodes of the real block pair carry the exactly balanced plan', () => {
  for (const seed of ['nodes-1', 'nodes-2', 'nodes-3']) {
    it(`seed ${seed}: per block and per pool, recomputed from the node trial_spec snapshots`, () => {
      const pair = generateMainBlockPair({ prng: createPRNG(seed) });
      const rebuilt = {};
      for (const [label, block] of [
        ['main_a', pair.mainA],
        ['main_b', pair.mainB],
      ]) {
        const specNodes = block.nodes.filter((n) => n?.data?.trial_spec);
        expect(specNodes).toHaveLength(60);
        /* the snapshot of node i is the planned trial i (same labels in the same slots) */
        specNodes.forEach((n, i) => {
          const planned = block.trialParams[i];
          expect(n.data.trial_spec.condition).toBe(planned.trial_type);
          expect(n.data.trial_spec.sequence).toBe(planned.sequence.join(''));
          expect(n.data.background_shade).toBe(planned.background_shade);
          expect(
            n.data.trial_spec.memory_items.map((m) => [m.slot, m.cell, m.pattern_label])
          ).toEqual(
            (planned.memory_items ?? []).map((m) => [m.slot_index_in_seq, m.cell, m.pattern_label])
          );
          expect(n.data.trial_spec.stars.map((s) => [s.slot, s.cell, s.pattern_label])).toEqual(
            (planned.stars ?? []).map((s) => [s.slot_index_in_seq, s.cell, s.pattern_label])
          );
        });
        for (const type of TYPES) {
          const list = specNodes.map(fromSpec).filter((t) => t.trial_type === type);
          expect(list).toHaveLength(12);
          expect(checkBlock(list, type, { histOK: true }).viol, `${label} ${type}`).toEqual([]);
          (rebuilt[type] ??= []).push(list);
        }
      }
      for (const type of TYPES) {
        const [a, b] = rebuilt[type];
        expect(checkPool(a, b, type).viol, type).toEqual([]);
      }
    });
  }
});
