/**
 * SHA-256 hashes of the participant-facing wording, computed from the strings
 * the task builds, so a session's data identifies the text it was shown.
 * The hashes are written to the `session_info` row.
 */
import { consentBodyHtml } from './calibration/consent-text.js';
import { instructionDeckTexts } from './instructions/index.js';
import { STRATEGY_SCALE, STRATEGY_ITEMS, STRATEGY_SECTIONS } from './questionnaire/strategy.js';
import { MUSIC_EXPERIENCE_ITEMS } from './questionnaire/music-experience.js';

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

let computed = null;

/**
 * Hash the consent text, each instruction deck and the item text of the
 * strategy and music questionnaires.
 *
 * @returns {Promise<{
 *   consent_text_sha256: string,
 *   instruction_deck_sha256: Record<string, string>,
 *   strategy_items_sha256: string,
 *   music_items_sha256: string,
 * }>}
 */
export async function computeContentHashes() {
  const decks = instructionDeckTexts();
  const instruction_deck_sha256 = {};
  for (const [name, text] of Object.entries(decks)) {
    instruction_deck_sha256[name] = await sha256Hex(text);
  }
  computed = {
    consent_text_sha256: await sha256Hex(consentBodyHtml()),
    instruction_deck_sha256,
    strategy_items_sha256: await sha256Hex(
      JSON.stringify({ scale: STRATEGY_SCALE, sections: STRATEGY_SECTIONS, items: STRATEGY_ITEMS })
    ),
    music_items_sha256: await sha256Hex(JSON.stringify(MUSIC_EXPERIENCE_ITEMS)),
  };
  return computed;
}

/** The hashes from the last `computeContentHashes()`, or `null` before it has run. */
export function getContentHashes() {
  return computed;
}
