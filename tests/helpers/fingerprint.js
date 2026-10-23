/**
 * Pre-registration fingerprinting — locks the runtime config to the value
 * frozen in `pre-reg/pre-reg.json` at OSF pre-reg lock time.
 *
 * The strategy is deliberately low-tech: we canonicalise the config to a
 * stably-ordered JSON string and compare exact strings. No hash, no schema
 * validation library — just `JSON.stringify` with sorted keys. Reasons:
 *   1. The output is human-diffable. When a future config edit causes the
 *      pre-reg test to fail, the diff between live and frozen canonical
 *      strings tells the experimenter exactly which key drifted.
 *   2. No crypto dependency. Works identically in Node (test runtime) and the
 *      browser (if ever needed at session start). Hashing would force us to
 *      either bundle a SHA-256 polyfill or split into two code paths.
 *   3. Frozen objects (`Object.freeze`) survive — `JSON.stringify` reads
 *      enumerable own properties regardless of mutability.
 *
 * Domain non-negotiable anchor: this module enforces "the deployed commit
 * SHA must match the OSF pre-registration record" (config.js header) by
 * giving the test suite a way to assert "the live config is byte-identical
 * to the pre-registered freeze".
 */

/**
 * Recursively sort object keys so that two semantically-identical configs
 * produce byte-identical JSON. Arrays preserve order (order is meaningful in
 * arrays — e.g., `gray_pattern_cells` is a set but the order matters for the
 * tests). Numbers, strings,
 * booleans, and `null` pass through unchanged.
 *
 * @param {*} value  any JSON-compatible value
 * @returns {*}      a structurally-equivalent value with sorted object keys
 */
export function canonicaliseValue(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicaliseValue);
  if (typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicaliseValue(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonicalise a config object to a stably-formatted JSON string. The output
 * is what gets stored in `pre-reg.json` under `config_canonical_json` and
 * compared against the live config at test time.
 *
 * @param {object} config  the runtime config (from `src/config.js`)
 * @param {object} [opts]
 * @param {number} [opts.indent=2]  JSON indentation; 2 for human-readable diffs
 * @returns {string}       canonical JSON string
 */
export function canonicaliseConfig(config, { indent = 2 } = {}) {
  return JSON.stringify(canonicaliseValue(config), null, indent);
}
