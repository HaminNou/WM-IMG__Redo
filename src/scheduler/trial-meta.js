/**
 * Identity fields stamped on every row of a trial.
 *
 * `trial_index_in_block` (written by the condition composers) is the index of
 * the trial in its condition's 24-trial pool. It is not the order of
 * presentation and it repeats across conditions, so it cannot identify a
 * trial on its own. These fields identify the trial in the session and give
 * its place in the presentation order.
 *
 *   trial_uid           string, unique within the main task (and within a
 *                       practice sub-block); e.g. main_a-007-i_d
 *   condition           d_only | t_only | i_only | i_d | i_t
 *   block_label         practice | main_a | main_b
 *   presentation_index  1..120 over the whole main task, null in practice
 *   block_position      0-based position within the block, in presentation order
 *   pool_index          index in the condition's 24-trial pool (the value that
 *                       trial_index_in_block carries)
 */
export const CONDITIONS = Object.freeze(['d_only', 't_only', 'i_only', 'i_d', 'i_t']);

function pad(n, width) {
  return String(n).padStart(width, '0');
}

export function buildTrialMeta({
  condition,
  block_label,
  block_position,
  presentation_index = null,
  pool_index,
}) {
  if (!CONDITIONS.includes(condition)) {
    throw new Error(`buildTrialMeta: unknown condition '${condition}'`);
  }
  const isPractice = block_label === 'practice';
  const trial_uid = isPractice
    ? `practice-${condition}-${pad(block_position + 1, 2)}`
    : `${block_label}-${pad(presentation_index ?? block_position + 1, 3)}-${condition}`;
  return Object.freeze({
    trial_uid,
    condition,
    block_label,
    is_practice: isPractice,
    presentation_index: isPractice ? null : (presentation_index ?? block_position + 1),
    block_position,
    pool_index,
  });
}
