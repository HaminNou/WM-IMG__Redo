/**
 * Display-colour escape hatch — manual override the participant can engage
 * if their browser is repainting our designed light surface despite the
 * page-level `color-scheme: light only` lock (see `index.html`).
 *
 * The lock is implemented as a single class on `<html>` (`display-colour-locked`)
 * paired with `!important` CSS rules in `index.html`. We use a class —
 * not inline style — so the override survives the per-trial background
 * flips driven by `page-background.js`: when the trial body re-paints
 * the inline `backgroundColor`, the trial-bg attribute selectors carrying
 * `!important` still win.
 *
 * The class is sticky for the rest of the session. Participants who
 * needed to engage it once almost certainly need it for every screen,
 * and toggling it on and off mid-session would add noise we don't want
 * in the stimulus record.
 *
 * One read accessor (`isDisplayColourLocked`) is exposed so downstream
 * trials can stamp the lock state into their own data rows if helpful.
 * The screen-calibration trial is the canonical place where the
 * participant first engages it; that trial owns the data row recording
 * the choice.
 */
const LOCK_CLASS = 'display-colour-locked';

/**
 * Engage the override. Idempotent — calling twice does nothing extra.
 * Returns `true` if the call changed the state, `false` if the lock was
 * already engaged or the call was made in a non-DOM environment (Node
 * tests).
 */
export function lockDisplayColours() {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  if (root.classList.contains(LOCK_CLASS)) return false;
  root.classList.add(LOCK_CLASS);
  return true;
}

/**
 * Read accessor. Returns `false` in Node test environments where there
 * is no `document`, so callers can safely stamp the result without an
 * extra guard.
 */
export function isDisplayColourLocked() {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains(LOCK_CLASS);
}

export const DISPLAY_COLOUR_LOCK_CLASS = LOCK_CLASS;
