/**
 * Wording of a rest length for participant-facing text, derived from the config value so the
 * screens never state a number that differs from the timer.
 *
 *   restLengthPhrase(30)  -> '30-second'
 *   restLengthPhrase(600) -> '10-minute'
 *   restLengthPhrase(90)  -> '90-second'  (only whole minutes are written as minutes)
 *
 * No imports: the voiceover harvester loads `runner-intros.js` and must not pull in the uploader.
 */
export function restLengthPhrase(seconds) {
  const s = Number(seconds);
  if (Number.isInteger(s) && s >= 60 && s % 60 === 0) return `${s / 60}-minute`;
  return `${s}-second`;
}

/**
 * Same, as a noun phrase: restDurationText(600) -> '10 minutes', (60) -> '1 minute',
 * (90) -> '90 seconds'.
 */
export function restDurationText(seconds) {
  const s = Number(seconds);
  if (Number.isInteger(s) && s >= 60 && s % 60 === 0) {
    const m = s / 60;
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  return `${s} second${s === 1 ? '' : 's'}`;
}
