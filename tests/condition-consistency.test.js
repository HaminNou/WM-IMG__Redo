// @vitest-environment jsdom
/**
 * Cross-condition consistency of the trial builders. The five conditions are
 * one task with different loads, so everything that is not the manipulated
 * load must be the same in code: node order, phase naming, fixed durations,
 * response keys, and the rotation of every post-encoding frame (one rule,
 * `postEncodingRotationDeg`). I+T is compared against I+D and I-only
 * node by node.
 */
import { describe, expect, it } from 'vitest';
import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { generateDualBlock } from '../src/scheduler/dual-block.js';
import { generateImageryBlock } from '../src/scheduler/imagery-block.js';
import { generateMemoryBlock } from '../src/scheduler/memory-block.js';
import { iDTrial } from '../src/conditions/i_d.js';
import { iTTrial } from '../src/conditions/i_t.js';
import { iOnlyTrial } from '../src/conditions/i_only.js';
import { dOnlyTrial } from '../src/conditions/d_only.js';
import { tOnlyTrial } from '../src/conditions/t_only.js';
import { postEncodingRotationDeg } from '../src/conditions/trial-record.js';
import { RETENTION_MS, PROBE_RESPONSE_MS, PROBE_OFFSET_MS } from '../src/conditions/shared.js';

const BUILDERS = {
  i_only: {
    compose: iOnlyTrial,
    gen: () => generateImageryBlock({ blockSize: 24 }),
  },
  i_d: { compose: iDTrial, gen: () => generateDualBlock({ trialType: 'i_d', blockSize: 24 }) },
  i_t: { compose: iTTrial, gen: () => generateDualBlock({ trialType: 'i_t', blockSize: 24 }) },
  d_only: {
    compose: dOnlyTrial,
    gen: () => generateMemoryBlock({ trialType: 'd_only', blockSize: 24 }),
  },
  t_only: {
    compose: tOnlyTrial,
    gen: () => generateMemoryBlock({ trialType: 't_only', blockSize: 24 }),
  },
};

function build(cond, seed = 'consistency') {
  setSessionPRNG(`${seed}-${cond}`);
  resetSequencePools();
  const block = BUILDERS[cond].gen();
  return block.map((params) => ({ params, nodes: BUILDERS[cond].compose(params) }));
}

const trials = Object.fromEntries(Object.keys(BUILDERS).map((c) => [c, build(c)]));
const strip = (cond, phase) => phase.replace(new RegExp(`^${cond}_`), '');
const skeleton = (cond, nodes) =>
  nodes.map((n) => ({
    phase: strip(cond, n.data.phase),
    trial_duration: n.trial_duration ?? null,
  }));

describe('every condition builds the same kinds of nodes', () => {
  it.each(Object.keys(BUILDERS))('%s: every node is tagged <condition>_<phase>', (cond) => {
    for (const { nodes } of trials[cond]) {
      for (const n of nodes) expect(n.data.phase.startsWith(`${cond}_`)).toBe(true);
    }
  });

  it.each(Object.keys(BUILDERS))('%s: fixed durations come from the shared constants', (cond) => {
    for (const { nodes } of trials[cond]) {
      for (const n of nodes) {
        const phase = strip(cond, n.data.phase);
        if (phase === 'retention') expect(n.trial_duration).toBe(RETENTION_MS);
        if (phase === 'probe') expect(n.trial_duration).toBe(PROBE_RESPONSE_MS + PROBE_OFFSET_MS);
        if (phase === 'iti') expect(n.trial_duration).toBe(800);
      }
    }
  });

  it('every condition has the same encoding-window length', () => {
    const lengths = new Set(
      Object.keys(BUILDERS).map((cond) => {
        const enc = trials[cond][0].nodes.find((n) => n.data.phase === `${cond}_encoding`);
        return enc.trial_duration;
      })
    );
    expect([...lengths]).toHaveLength(1);
  });

  it('I+T has exactly the node sequence and durations of I+D', () => {
    for (let i = 0; i < 24; i++) {
      expect(skeleton('i_t', trials.i_t[i].nodes)).toEqual(skeleton('i_d', trials.i_d[i].nodes));
    }
  });

  it('I-only is the I+D / I+T preamble + encoding + ITI, with no retention or probes', () => {
    const imagery = skeleton('i_d', trials.i_d[0].nodes);
    const iOnly = skeleton('i_only', trials.i_only[0].nodes);
    expect(iOnly.map((n) => n.phase)).toEqual([
      'trial_start',
      'arrow_cue',
      'imagination',
      'encoding',
      'iti',
    ]);
    expect(iOnly.slice(0, 4)).toEqual(imagery.slice(0, 4));
    expect(iOnly[4]).toEqual(imagery[imagery.length - 1]);
  });

  it('the two memory-only conditions share the dual-task trial skeleton (minus the imagery preamble)', () => {
    const dual = skeleton('i_d', trials.i_d[0].nodes).slice(3);
    for (const cond of ['d_only', 't_only']) {
      const memOnly = skeleton(cond, trials[cond][0].nodes);
      expect(memOnly[0].phase).toBe('trial_start');
      expect(memOnly.slice(1)).toEqual(dual);
    }
  });
});

describe('imagery preamble is identical in I-only, I+D and I+T', () => {
  const preamble = (cond) =>
    trials[cond].map(({ params, nodes }) =>
      nodes.slice(0, 3).map((n) => ({
        phase: strip(cond, n.data.phase),
        trial_duration: n.trial_duration ?? null,
        frame_rotation_deg: n.data.frame_rotation_deg ?? null,
        rotation_deg: n.data.rotation_deg,
        expected_rotation_deg: params.rotation_deg,
        data_keys: Object.keys(n.data).sort(),
      }))
    );

  it('same data keys, durations and frame rotation; trial angle carried on every node', () => {
    const base = preamble('i_d');
    for (const cond of ['i_only', 'i_t']) {
      const other = preamble(cond);
      for (let i = 0; i < 24; i++) {
        /* Angles are drawn per condition; only the structure must match. */
        const structure = ({ rotation_deg: _a, expected_rotation_deg: _b, ...r }) => r;
        expect(other[i].map(structure)).toEqual(base[i].map(structure));
        for (const node of other[i]) expect(node.rotation_deg).toBe(node.expected_rotation_deg);
      }
    }
  });
});

describe('post-encoding frames follow one rotation rule', () => {
  const expectedRotation = (cond, params) =>
    cond === 'd_only'
      ? params.display_rotation_deg
      : cond === 'i_d' || cond === 'i_t'
        ? params.rotation_deg
        : 0;

  it.each(['i_d', 'i_t', 'd_only', 't_only'])(
    '%s: retention and all three probes are drawn at the encoding angle',
    (cond) => {
      for (const { params, nodes } of trials[cond]) {
        const post = nodes.filter((n) => /_(retention|probe)$/.test(n.data.phase));
        expect(post).toHaveLength(4);
        for (const n of post)
          expect(n.data.frame_rotation_deg).toBe(expectedRotation(cond, params));
        expect(postEncodingRotationDeg(params)).toBe(expectedRotation(cond, params));
      }
    }
  );

  it('I+T and I+D never leave the post-encoding frame upright when the trial angle is not 0', () => {
    for (const cond of ['i_d', 'i_t']) {
      for (const { params, nodes } of trials[cond]) {
        expect(params.rotation_deg).not.toBe(0);
        for (const n of nodes.filter((x) => /_(retention|probe)$/.test(x.data.phase))) {
          expect(n.data.frame_rotation_deg).not.toBe(0);
        }
      }
    }
  });

  it('upright for the gate, arrow cue, imagination and ITI everywhere', () => {
    for (const cond of Object.keys(BUILDERS)) {
      for (const { nodes } of trials[cond]) {
        for (const n of nodes.filter((x) => /_(arrow_cue|imagination|iti)$/.test(x.data.phase))) {
          expect(n.data.frame_rotation_deg).toBe(0);
        }
      }
    }
  });

  it('postEncodingRotationDeg: trial angle, else display angle, else upright', () => {
    expect(postEncodingRotationDeg({ rotation_deg: -33 })).toBe(-33);
    expect(postEncodingRotationDeg({ rotation_deg: 41, display_rotation_deg: 7 })).toBe(41);
    expect(postEncodingRotationDeg({ display_rotation_deg: 7 })).toBe(7);
    expect(postEncodingRotationDeg({ rotation_deg: null })).toBe(0);
    expect(postEncodingRotationDeg({})).toBe(0);
    expect(postEncodingRotationDeg(undefined)).toBe(0);
  });
});
