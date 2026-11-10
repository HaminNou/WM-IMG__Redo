/**
 * A minimal in-memory stand-in for `navigator.locks`, shared by several "tabs" in a test.
 * Only what src/study-lock.js uses: request(name, {ifAvailable}, callback). A lock is held
 * until the callback's promise settles; `release()` simulates the tab closing.
 */
export function createLockManager() {
  const held = new Map(); /* name -> release function */
  return {
    held,
    request(name, options, callback) {
      if (held.has(name)) {
        if (options?.ifAvailable) return Promise.resolve(callback(null));
        return Promise.reject(new Error('fake locks: only ifAvailable is supported'));
      }
      held.set(name, true);
      return Promise.resolve(callback({ name })).finally(() => held.delete(name));
    },
    /** The holder's tab closed. */
    release(name) {
      held.delete(name);
    },
  };
}
