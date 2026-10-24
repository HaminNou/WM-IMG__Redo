/**
 * Fields added to every trial row when the trial finishes: display-guard
 * events since the previous trial, the playback gain in force, the wall
 * clock, and the practice pass for practice trials.
 */
import { consumeGuardFlags } from './calibration/display-guard.js';
import { getUserPlaybackGain } from './audio/dsp.js';
import { getPracticeIteration } from './scheduler/trial-meta.js';

export function stampFinishedTrial(data) {
  Object.assign(data, consumeGuardFlags());
  data.user_gain = getUserPlaybackGain();
  data.wall_ms = Date.now();
  if (data.block_label === 'practice') data.practice_iteration = getPracticeIteration();
}
