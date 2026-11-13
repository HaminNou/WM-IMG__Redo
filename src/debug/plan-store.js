/**
 * The one place that holds the practice trial plans, so that the plan print (plan-print.js) and the
 * timeline that runs share the SAME objects. The practice trials are generated lazily inside
 * `singleTypePractice` (called by `assembleInstructionsAndPractice`); that function hands each
 * type's `trialParams` to `recordPracticePlan`, and the print reads them back. Nothing is generated
 * or changed here, only references are kept, and only in debug mode (otherwise this is a no-op).
 */
import { isDebugMode } from './debug-mode.js';

const practiceByType = new Map();

/** Keep the trial params of one practice mini-block (debug mode only; a later call for a type replaces it). */
export function recordPracticePlan(trialType, trialParams) {
  try {
    if (!isDebugMode()) return;
    practiceByType.set(trialType, trialParams);
  } catch {
    /* never breaks the build of the timeline */
  }
}

/** Practice trial params in the order they run (Task 1..5), or [] when none were recorded. */
export function getPracticePlan() {
  const order = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];
  return order.flatMap((t) => practiceByType.get(t) ?? []);
}

/** Test helper. */
export function _resetPlanStoreForTests() {
  practiceByType.clear();
}
