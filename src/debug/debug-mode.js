/**
 * Experimenter-only debug mode: the single switch behind the console trace
 * (trace.js) and the secret grid reveal (reveal.js).
 *
 * These tools expose the answers (targets, patterns), so they must be OFF for
 * every real participant. Debug mode is ON only when ALL of these hold:
 *
 *   0. the BUILD allows it: the site was built with `VITE_ENABLE_DEBUG=1`
 *      (`npm run build:debug`) or this is a Vite dev server. The normal production
 *      build (`npm run build`, what is deployed for participants) does NOT allow it:
 *      there, no URL flag can turn the trace or the reveal on, and
 *   1. the URL query string contains `debug=1` (the URL is the ONLY source:
 *      never storage, cookies, Prolific parameters or anything a participant
 *      or the platform could set), and
 *   2. the session is an experimenter session: the URL also carries `pilot=1`
 *      (see pilot-mode.js), or this is a Vite dev build (`import.meta.env.DEV`),
 *      or the page is served from localhost / 127.0.0.1 / [::1].
 *
 * `debug=1` alone on a Prolific-style URL therefore does nothing.
 *
 * Like `pilot`, this is a RUNTIME flag, not a config field: the pre-registration
 * check compares the live config byte-for-byte with the locked config.
 */
import { readPilotMode } from '../pilot-mode.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

let memo = null;

function truthy(v) {
  return typeof v === 'string' && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function ambientSearch() {
  return typeof window !== 'undefined' && window.location ? (window.location.search ?? '') : '';
}

function ambientHostname() {
  return typeof window !== 'undefined' && window.location ? (window.location.hostname ?? '') : '';
}

/* Does this build allow debug at all? Vite replaces `import.meta.env.VITE_ENABLE_DEBUG` at build
 * time, so in the normal production build this is a constant `false`. */
function ambientBuildAllowsDebug() {
  try {
    return import.meta.env.VITE_ENABLE_DEBUG === '1' || import.meta.env.DEV === true;
  } catch {
    return false;
  }
}

function ambientIsDev() {
  try {
    return import.meta.env?.DEV === true;
  } catch {
    return false;
  }
}

/**
 * Is experimenter debug mode on?
 *
 * Without arguments the answer is computed from the live page once and
 * memoised (the URL does not change during a session). With an argument the
 * answer is computed fresh from the injected values and is NOT memoised; this
 * is for tests.
 *
 * @param {object} [inject]
 * @param {string} [inject.search]    URL search string (default: `location.search`).
 * @param {string} [inject.hostname]  host name (default: `location.hostname`).
 * @param {boolean} [inject.isPilot]  pilot flag (default: read from the URL via readPilotMode).
 * @param {boolean} [inject.isDev]    dev-build flag (default: `import.meta.env.DEV`).
 * @param {boolean} [inject.buildEnabled] does the build allow debug (default: built with
 *                                    `VITE_ENABLE_DEBUG=1`, or a dev server).
 * @returns {boolean}
 */
export function isDebugMode(inject) {
  if (inject === undefined && memo !== null) return memo;
  let result = false;
  try {
    const i = inject ?? {};
    const search = i.search ?? ambientSearch();
    const requested = truthy(new URLSearchParams(search).get('debug'));
    const buildEnabled = i.buildEnabled ?? ambientBuildAllowsDebug();
    if (requested && buildEnabled === true) {
      const hostname = String(i.hostname ?? ambientHostname()).toLowerCase();
      const isPilot = i.isPilot ?? readPilotMode({ search, env: {} }).is_pilot_run;
      const isDev = i.isDev ?? ambientIsDev();
      result = isPilot === true || isDev === true || LOCAL_HOSTS.has(hostname);
    }
  } catch {
    result = false;
  }
  if (inject === undefined) memo = result;
  return result;
}

/**
 * Session-level stamp, written next to `is_pilot_run` so an analyst can
 * exclude any session in which the answers could have been visible.
 *
 * @param {object} [inject] same as {@link isDebugMode}
 * @returns {{debug_mode: boolean}}
 */
export function debugSessionStamp(inject) {
  return { debug_mode: isDebugMode(inject) };
}

/** Test helper: forget the memoised answer. */
export function _resetDebugModeForTests() {
  memo = null;
}
