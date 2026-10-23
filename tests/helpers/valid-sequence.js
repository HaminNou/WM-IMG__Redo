import { enumerateValidSequences } from '../../src/scheduler/within-trial.js';

const VALID = new Set(enumerateValidSequences().map((s) => s.join('')));

/** True when `seq` is one of the 14 valid within-trial M/S sequences. */
export function isValidSequence(seq) {
  return Array.isArray(seq) && VALID.has(seq.join(''));
}
