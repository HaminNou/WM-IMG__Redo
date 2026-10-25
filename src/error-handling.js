/**
 * Global failure net.
 *
 * Without it an exception thrown outside a handled path vanishes into the
 * console: the analyst never learns that a session hit an error, and the
 * participant sees nothing. Two listeners (`error`, `unhandledrejection`)
 * write one `runtime_error` row per distinct problem through the normal
 * storage path. The rows are small and carry no stack, no URL and no free
 * text from the page: a message cut to 300 characters, the file name and
 * line of the source, and the phase of the running trial.
 *
 * What is NOT done here, on purpose: nothing is shown to the participant. A
 * stray error in a timer or a listener usually leaves the trial intact (every
 * trial has its own time limit), so interrupting the session for each one
 * would cost more data than it saves. The one failure that does end the
 * session, a rejection of `jsPsych.run`, is handled in `runner.js` with the
 * screens from `fatal-screens.js`.
 *
 * The handlers never throw, log at most MAX_ROWS rows, and skip a repeat of the
 * same error within DEDUPE_MS, so an error inside an animation frame cannot
 * flood storage.
 */
import { rowClock } from './clock.js';

export const MESSAGE_MAX = 300;
export const MAX_ROWS = 25;
export const DEDUPE_MS = 5000;

/* Messages the browser raises that say nothing about this study. */
const BENIGN_MESSAGE = [/ResizeObserver loop/i, /^Script error\.?$/i];
/* Errors that come from browser extensions, not from this page. */
const EXTENSION_URL = /(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i;

/** @param {unknown} value @returns {{name: string, message: string}} */
export function describeError(value) {
  if (value && typeof value === 'object') {
    const v = /** @type {{name?: unknown, message?: unknown}} */ (value);
    return {
      name: typeof v.name === 'string' && v.name ? v.name : 'Error',
      message: typeof v.message === 'string' ? v.message : String(value),
    };
  }
  return { name: typeof value === 'string' ? 'string' : typeof value, message: String(value) };
}

/** File name and position only: `main-abc123.js:12:34`. No host, path or query. */
export function sourceLabel(filename, line, col) {
  if (!filename || typeof filename !== 'string') return null;
  const clean = filename.split('?')[0].split('#')[0];
  const base = clean.slice(clean.lastIndexOf('/') + 1) || clean;
  const pos = [line, col].filter((n) => Number.isFinite(n) && n > 0);
  return [base, ...pos].join(':').slice(0, 120);
}

/**
 * True for errors that are not about this study and should not be logged.
 *
 * @param {{message?: string, name?: string, filename?: string|null, stack?: string|null}} e
 */
export function isBenignError({ message = '', name = '', filename = '', stack = '' } = {}) {
  if (name === 'AbortError') return true;
  if (BENIGN_MESSAGE.some((re) => re.test(message))) return true;
  if (filename && EXTENSION_URL.test(filename)) return true;
  if (stack && EXTENSION_URL.test(stack)) return true;
  return false;
}

/**
 * @param {object} opts
 * @param {(row: object) => unknown} opts.logRow       writes one row (normally storage.appendTrialRow)
 * @param {() => string|null} [opts.getPhase]          phase of the running trial, if known
 * @param {EventTarget} [opts.target]                  default `window`
 * @param {() => number} [opts.now]                    default `performance.now`
 * @returns {{uninstall: () => void, getLoggedCount: () => number}}
 */
export function installGlobalErrorHandlers({
  logRow,
  getPhase = () => null,
  target = typeof window !== 'undefined' ? window : undefined,
  now = () => performance.now(),
} = {}) {
  if (!target || typeof logRow !== 'function') {
    return { uninstall() {}, getLoggedCount: () => 0 };
  }
  let logged = 0;
  const lastSeen = new Map();

  const record = (kind, details) => {
    try {
      const { name, message } = describeError(details.error);
      const text = (details.message || message || '').slice(0, MESSAGE_MAX);
      if (
        isBenignError({ message: text, name, filename: details.filename, stack: details.stack })
      ) {
        return;
      }
      if (logged >= MAX_ROWS) return;
      const source = sourceLabel(details.filename, details.line, details.col);
      const key = `${kind}|${text}|${source}`;
      const t = now();
      const prev = lastSeen.get(key);
      if (prev !== undefined && t - prev < DEDUPE_MS) return;
      lastSeen.set(key, t);
      logged += 1;
      let phase = null;
      try {
        phase = getPhase() ?? null;
      } catch {
        phase = null;
      }
      let clock = {};
      try {
        clock = rowClock();
      } catch {
        clock = {};
      }
      const written = logRow({
        phase: 'runtime_error',
        kind,
        error_name: name,
        message: text,
        source,
        trial_phase: phase,
        ts: t,
        ...clock,
      });
      if (written && typeof written.catch === 'function') written.catch(() => {});
    } catch {
      /* A failure net must never be the cause of a failure. */
    }
  };

  const onError = (e) =>
    record('error', {
      error: e?.error,
      message: typeof e?.message === 'string' ? e.message : '',
      filename: e?.filename,
      line: e?.lineno,
      col: e?.colno,
      stack: typeof e?.error?.stack === 'string' ? e.error.stack : null,
    });
  const onRejection = (e) =>
    record('unhandledrejection', {
      error: e?.reason,
      message: '',
      filename: null,
      stack: typeof e?.reason?.stack === 'string' ? e.reason.stack : null,
    });

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return {
    uninstall() {
      target.removeEventListener('error', onError);
      target.removeEventListener('unhandledrejection', onRejection);
    },
    getLoggedCount: () => logged,
  };
}
