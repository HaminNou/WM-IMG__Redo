/**
 * One live tab per browser.
 *
 * A second tab of the study must neither start a second run nor delete the first tab's
 * data. Each page takes a Web Lock for its whole lifetime (the browser releases it when the
 * page closes or crashes), so "is another tab live" has a reliable answer:
 *
 *   'held'        this page holds the lock; no other live tab exists;
 *   'busy'        another live tab holds it;
 *   'unavailable' the Locks API is missing (or failed); liveness is unknown, so the caller
 *                 must only clear runs that have been idle for a long time.
 */
export const STUDY_LOCK_NAME = 'wm-img-study-live-run';

/** Longest idle time after which a run may be treated as abandoned when liveness is unknown. */
export const SAFE_IDLE_MS = 30 * 60 * 1000;

/** A restart releases the old page's lock a moment after the new page starts; allow for it. */
const RETRY_DELAYS_MS = [250, 500, 1000];

export const STUDY_OPEN_ELSEWHERE = 'study_open_elsewhere';

export const STUDY_OPEN_ELSEWHERE_TEXT =
  'The study is already open in another tab or window. Please close this tab and continue in the original one.';

export class StudyOpenElsewhereError extends Error {
  constructor() {
    super(STUDY_OPEN_ELSEWHERE_TEXT);
    this.name = 'StudyOpenElsewhereError';
    this.code = STUDY_OPEN_ELSEWHERE;
  }
}

async function tryOnce(locks) {
  return new Promise((resolve, reject) => {
    try {
      Promise.resolve(
        locks.request(STUDY_LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve('busy');
            return undefined;
          }
          resolve('held');
          /* Never settles: the lock is held until the page is gone. */
          return new Promise(() => {});
        })
      ).catch(reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * @param {object} [opts]
 * @param {{request: Function}|null} [opts.locks]   test hook; default `navigator.locks`
 * @param {number[]} [opts.retryDelaysMs]
 * @returns {Promise<'held'|'busy'|'unavailable'>}
 */
export async function acquireStudyLock({
  locks = typeof navigator !== 'undefined' ? navigator.locks : undefined,
  retryDelaysMs = RETRY_DELAYS_MS,
} = {}) {
  if (!locks || typeof locks.request !== 'function') return 'unavailable';
  try {
    let result = await tryOnce(locks);
    for (const delay of retryDelaysMs) {
      if (result !== 'busy') break;
      await new Promise((r) => setTimeout(r, delay));
      result = await tryOnce(locks);
    }
    return result;
  } catch {
    return 'unavailable';
  }
}
