// @vitest-environment jsdom
/**
 * All 120 trials (about 10 s) of one plan run through the REAL condition
 * timelines on a fake clock (tests/helpers/real-rows.js) with a scripted participant. The encoding rows
 * written to the data record carry `trial_spec`; the block-exact balance (per block and per pool, per
 * condition) is recomputed from those recorded rows alone with the independent oracle, and every planned
 * label must equal the recorded one.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/audio/context.js', () => ({
  getAudioContext: () => ({ currentTime: performance.now() / 1000, state: 'running' }),
  audioContextInfo: () => ({
    sample_rate_hz: 48000,
    state: 'running',
    base_latency_ms: 10,
    output_latency_ms: 20,
  }),
  ensureRunning: async () => {},
  unlockAudio: async () => {},
}));
vi.mock('../src/audio/tones.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, playToneByCell: vi.fn(() => Promise.resolve()) };
});

import { _resetStorageForTests, initStorage } from '../src/storage.js';
import { setSessionPRNG } from '../src/prng.js';
import { generateMainPlan } from '../src/scheduler/main-plan.js';
import { runTrial, REAL_FAKE_TIMERS } from './helpers/real-rows.js';
import { checkBlock, checkPool } from './helpers/block-oracle.js';

const TYPES = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];

function fromSpec(spec, row) {
  const t = {
    trial_type: spec.condition,
    trial_index_in_block: row.trial_index_in_block,
    background_shade: row.background_shade,
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

describe('a whole 120-trial session, recorded rows only', () => {
  it('per-block and per-pool balance recomputed from the recorded encoding rows is exact', async () => {
    _resetStorageForTests();
    await initStorage({ backend: 'memory' });
    vi.useFakeTimers({ toFake: REAL_FAKE_TIMERS });
    setSessionPRNG('full-session-1');
    const plan = generateMainPlan({});
    const recorded = { main_a: {}, main_b: {} };
    let encodingRows = 0;
    for (const [label, block] of [
      ['main_a', plan.mainA],
      ['main_b', plan.mainB],
    ]) {
      for (let i = 0; i < block.trialParams.length; i++) {
        const type = block.schedule[i];
        const params = block.trialParams[i];
        const { rows } = await runTrial(type, params);
        const enc = rows.filter((r) => r.phase === `${type}_encoding`);
        expect(enc).toHaveLength(1);
        encodingRows++;
        const t = fromSpec(enc[0].trial_spec, enc[0]);
        /* recorded = planned */
        expect(enc[0].trial_spec.sequence).toBe(params.sequence.join(''));
        expect(enc[0].background_shade).toBe(params.background_shade);
        (recorded[label][type] ??= []).push(t);
      }
    }
    expect(encodingRows).toBe(120);
    for (const type of TYPES) {
      for (const label of ['main_a', 'main_b']) {
        expect(recorded[label][type]).toHaveLength(12);
        expect(
          checkBlock(recorded[label][type], type, { histOK: true }).viol,
          `${label} ${type}`
        ).toEqual([]);
      }
      expect(checkPool(recorded.main_a[type], recorded.main_b[type], type).viol, type).toEqual([]);
    }
  }, 3_600_000);
});
