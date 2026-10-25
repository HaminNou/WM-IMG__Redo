/**
 * Scoring of the typed-instruction attention checks, over DISTINCT checks.
 *
 * Pure (no DOM, no jsPsych), so the runtime summary row (`attention-checks.js`),
 * the batch-decision tool (`scripts/pilot-summary.js`) and the exporter
 * (`scripts/csv-export.js`, through `scripts/participant-rules.js`) all apply one
 * definition of "fails more than 1 of the 3 checks" (pre-reg.json ->
 * exclusion_rules -> instructional_attention_checks).
 *
 * The practice loop repeats all three checks whenever practice accuracy is below
 * criterion, so a check can be administered more than once. Counting every
 * administered row would let one repeated miss count twice. Instead each check id
 * counts once, and it counts as failed if it was failed the FIRST time it was
 * shown. The verdict on the final administration is returned beside it so the
 * analyst can use either.
 */

/**
 * @param {object[]} rows  data rows in chronological order (any phase)
 * @param {number}   maxFailures  strict-greater-than exclusion threshold
 * @returns {{
 *   total: number, passed: number, failed: number, failed_first: number,
 *   failed_final: number, administrations: number, threshold: number,
 *   excluded: boolean, excluded_final: boolean, ids: string[],
 *   per_check: {id: string, administrations: number,
 *               passed_first: boolean|null, passed_final: boolean|null}[]
 * }}
 */
export function scoreAttentionChecks(rows, maxFailures) {
  const byId = new Map();
  (rows ?? []).forEach((r, i) => {
    if (r?.phase !== 'attention_check') return;
    /* A row without an id must not collapse into another check. */
    const id = r.attention_check_id ?? `unnamed_${i}`;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(r);
  });
  const verdict = (r) =>
    r.attention_check_passed === true ? true : r.attention_check_passed === false ? false : null;
  const perCheck = [...byId.entries()].map(([id, list]) => ({
    id,
    administrations: list.length,
    passed_first: verdict(list[0]),
    passed_final: verdict(list[list.length - 1]),
  }));
  const failedFirst = perCheck.filter((c) => c.passed_first === false).length;
  const failedFinal = perCheck.filter((c) => c.passed_final === false).length;
  return {
    total: perCheck.length,
    passed: perCheck.filter((c) => c.passed_first === true).length,
    failed: failedFirst,
    failed_first: failedFirst,
    failed_final: failedFinal,
    administrations: perCheck.reduce((n, c) => n + c.administrations, 0),
    threshold: maxFailures,
    excluded: failedFirst > maxFailures,
    excluded_final: failedFinal > maxFailures,
    ids: perCheck.map((c) => c.id),
    per_check: perCheck,
  };
}
