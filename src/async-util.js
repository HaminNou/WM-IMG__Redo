/**
 * Small async helpers.
 */

/**
 * Resolve with `promise`, or reject with an Error after `ms` milliseconds.
 * The timer is cleared as soon as `promise` settles.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]   named in the timeout error
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label) {
  let timer = null;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label ?? 'operation'} timed out after ${ms} ms`)),
      ms
    );
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
