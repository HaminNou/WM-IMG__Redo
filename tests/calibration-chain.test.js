/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { assembleCalibrationChain } from '../src/calibration/index.js';

const flat = (n) =>
  Array.isArray(n.timeline) ? n.timeline.flatMap(flat) : [n?.data?.phase ?? '<untagged>'];
const phases = () => assembleCalibrationChain().flatMap(flat);

// Steps of the original Experiment 2 calibration chain, in its order.
const ORIGINAL_STEPS = [
  'desktop_gate',
  'consent',
  'demographics',
  'viewing_distance',
  'display_mode_check',
  'screen_calibration',
  'speaker_volume_instruction',
  'enter_fullscreen',
  'visibility_recorder_start',
  'tone_audibility_and_comfort',
  'tone_audibility_fail',
];
// Steps added by the rerun and kept.
const RERUN_ADDITIONS = ['timing_probe', 'timing_probe_hint', 'timing_probe_fail'];

describe('calibration chain', () => {
  it('runs the original steps in the original relative order', () => {
    const p = phases();
    const idx = ORIGINAL_STEPS.map((s) => p.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('has the volume instruction, then the tone sweep, with no step between them except fullscreen', () => {
    const p = phases();
    expect(
      p.slice(p.indexOf('speaker_volume_instruction'), p.indexOf('tone_audibility_fail') + 1)
    ).toEqual([
      'speaker_volume_instruction',
      'enter_fullscreen',
      'visibility_recorder_start',
      'tone_audibility_and_comfort',
      'tone_audibility_fail',
    ]);
  });

  it('keeps exactly the rerun additions (timing probe), after the tone sweep', () => {
    const p = phases();
    for (const s of RERUN_ADDITIONS) expect(p).toContain(s);
    expect(p.indexOf('timing_probe')).toBeGreaterThan(p.indexOf('tone_audibility_fail'));
    expect(p.slice(p.indexOf('tone_audibility_fail') + 1)).toEqual(RERUN_ADDITIONS);
  });

  it('contains no headphone-check or pitch-check node', () => {
    expect(phases().filter((s) => /headphone|pitch|audio_check/i.test(s))).toEqual([]);
  });

  it('has no untagged node', () => {
    expect(phases()).not.toContain('<untagged>');
  });
});
