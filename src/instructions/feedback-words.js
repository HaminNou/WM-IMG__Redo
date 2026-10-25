/**
 * The colour words ("green" / "red") the instruction decks use to describe
 * trial feedback. The words are drawn in the exact feedback hex the
 * participant sees on a live trial and in the demos, on a near-black chip,
 * so the word itself is legible on the gray instruction card (the bare hex
 * is only about 1.6:1 against #D3D3D3). The live feedback stimulus is
 * unchanged; only the deck wording is styled.
 *
 * One definition for every deck keeps the five decks identical.
 */
import { FEEDBACK_COLOR_CORRECT_TEXT, FEEDBACK_COLOR_WRONG_TEXT } from '../conditions/shared.js';

/** Chip background; contrast with the green and red words is checked in tests. */
export const FEEDBACK_WORD_CHIP = '#111111';

const chip = (colour, word) =>
  `<span style="color: ${colour}; background: ${FEEDBACK_WORD_CHIP}; padding: 0 0.4em; border-radius: 3px;"><strong>${word}</strong></span>`;

export const FEEDBACK_GREEN = chip(FEEDBACK_COLOR_CORRECT_TEXT, 'green');
export const FEEDBACK_RED = chip(FEEDBACK_COLOR_WRONG_TEXT, 'red');
