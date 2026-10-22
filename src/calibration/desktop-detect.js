/**
 * Pure environment classifier for the desktop-only gate.
 *
 * Lives in its own module (separate from `desktop-gate.js`) so unit tests
 * can import it without dragging in jsPsych's static `window` references.
 * `desktop-gate.js` re-exports the public API and adds the jsPsych nodes.
 *
 * Detection strategy:
 *   1. User agent gives the strongest signal — iPhone / iPad / Android +
 *      generic "Mobile" all map to fail.
 *   2. iPadOS 13+ disguises itself as Macintosh; we disambiguate by
 *      checking `navigator.maxTouchPoints > 1` against a Mac UA (real Macs
 *      report 0).
 *   3. As a capability fallback for unknown devices, both
 *      `(hover: hover)` AND `(pointer: fine)` returning false flags
 *      "input is exclusively coarse touch" — characteristic of modern phones.
 */

/**
 * Pure environment classifier — does the supplied snapshot describe a
 * desktop / laptop class device?
 *
 * @param {object}  env
 * @param {string}  [env.userAgent]
 * @param {boolean|null} [env.hasHover]         result of matchMedia('(hover: hover)').matches
 * @param {boolean|null} [env.hasFinePointer]   result of matchMedia('(pointer: fine)').matches
 * @param {number}  [env.maxTouchPoints]        navigator.maxTouchPoints
 * @returns {{isDesktop: boolean, reasons: string[], userAgent: string,
 *            hasHover: boolean|null, hasFinePointer: boolean|null,
 *            maxTouchPoints: number}}
 */
export function evaluateEnvironment({
  userAgent = '',
  hasHover = null,
  hasFinePointer = null,
  maxTouchPoints = 0,
} = {}) {
  const ua = String(userAgent).toLowerCase();
  const touchPoints = Number.isFinite(maxTouchPoints) ? maxTouchPoints : 0;
  const reasons = [];

  if (/\biphone\b/.test(ua)) reasons.push('iphone');
  if (/\bipod\b/.test(ua)) reasons.push('ipod');
  if (/\bipad\b/.test(ua)) reasons.push('ipad');
  /* iPadOS 13+ ships a "Macintosh" UA. A real Mac reports maxTouchPoints=0;
   * any Mac UA with touch points is an iPad in disguise. */
  if (/macintosh/.test(ua) && touchPoints > 1) reasons.push('ipad_macos_disguised');
  if (/android/.test(ua)) reasons.push('android');
  /* Generic "Mobile" token — catches Windows Phone, KaiOS, etc. without
   * double-counting iOS / Android (those are already flagged above). */
  if (/mobile/.test(ua) && !/iphone|ipad|ipod|android/.test(ua)) {
    reasons.push('mobile_ua');
  }

  /* Capability fallback for unknown UAs. Only fires when BOTH signals are
   * explicitly false — `null` means unsupported / unknown and is treated as
   * "no information" rather than a fail. */
  if (hasHover === false && hasFinePointer === false) {
    reasons.push('no_hover_no_fine_pointer');
  }

  return {
    isDesktop: reasons.length === 0,
    reasons,
    userAgent: String(userAgent),
    hasHover,
    hasFinePointer,
    maxTouchPoints: touchPoints,
  };
}

/**
 * Read the live environment in the browser. Each lookup is wrapped against
 * older browsers that may not expose `matchMedia` or `maxTouchPoints`.
 *
 * Browser-only — `desktop-gate.js` calls this from inside a jsPsych trial
 * func, so we know `window` is defined when this runs. Tests don't exercise
 * this function (it's a thin wrapper over the global navigator/matchMedia
 * API; the classifier `evaluateEnvironment` is what carries the logic).
 */
export function readEnvironment() {
  const ua = typeof navigator !== 'undefined' ? (navigator.userAgent ?? '') : '';
  let hasHover = null;
  let hasFinePointer = null;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      hasHover = window.matchMedia('(hover: hover)').matches;
    } catch {
      hasHover = null;
    }
    try {
      hasFinePointer = window.matchMedia('(pointer: fine)').matches;
    } catch {
      hasFinePointer = null;
    }
  }
  const touchPoints =
    typeof navigator !== 'undefined' && Number.isFinite(navigator.maxTouchPoints)
      ? navigator.maxTouchPoints
      : 0;
  return {
    userAgent: ua,
    hasHover,
    hasFinePointer,
    maxTouchPoints: touchPoints,
  };
}
