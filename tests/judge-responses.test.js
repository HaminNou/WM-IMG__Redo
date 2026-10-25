// @vitest-environment jsdom
/**
 * Direct tests of the scoring functions behind `probe_correct` and
 * `star_correct` (`judgeProbeResponse`, `judgeStarResponse`) and of the two
 * response keys. Every accuracy, the practice gate and the single-task floor
 * are built on these, and an inverted judge survived the whole suite before
 * this file existed (final-check audit F7).
 *
 * The expected values are written out by hand, not derived from the code:
 * the RIGHT arrow means "Yes" (a probe was shown/heard) and "On-pattern" (a
 * star was on the imagery pattern); the LEFT arrow means "No" / "Off-pattern".
 */
import { describe, expect, it } from 'vitest';
import {
  KEY_NO,
  KEY_OFF,
  KEY_ON,
  KEY_YES,
  judgeProbeResponse,
  judgeStarResponse,
} from '../src/conditions/shared.js';

describe('response keys', () => {
  it('RIGHT arrow is Yes / On-pattern and LEFT arrow is No / Off-pattern, in lower case', () => {
    expect(KEY_YES).toBe('arrowright');
    expect(KEY_NO).toBe('arrowleft');
    expect(KEY_ON).toBe('arrowright');
    expect(KEY_OFF).toBe('arrowleft');
  });
});

describe('judgeProbeResponse', () => {
  const cases = [
    // key, isTarget, responded, said_yes, correct
    ['arrowright', true, true, true, true],
    ['arrowright', false, true, true, false],
    ['arrowleft', true, true, false, false],
    ['arrowleft', false, true, false, true],
  ];
  it.each(cases)(
    'key %s, isTarget %s -> responded %s, said_yes %s, correct %s',
    (key, target, responded, saidYes, correct) => {
      expect(judgeProbeResponse(key, target)).toEqual({ responded, said_yes: saidYes, correct });
    }
  );

  it('is case-insensitive about the key name', () => {
    expect(judgeProbeResponse('ArrowRight', true).correct).toBe(true);
    expect(judgeProbeResponse('ARROWLEFT', false).correct).toBe(true);
  });

  it.each([null, undefined, '', ' ', 'space', 'a', 'arrowup', 'arrowdown', 'enter'])(
    'any non-answer key (%s) is not a response and never correct, for a target and for a foil',
    (key) => {
      for (const target of [true, false]) {
        expect(judgeProbeResponse(key, target)).toEqual({ responded: false, correct: false });
      }
    }
  );
});

describe('judgeStarResponse', () => {
  const cases = [
    // key, isOnPattern, responded, said_on, correct
    ['arrowright', true, true, true, true],
    ['arrowright', false, true, true, false],
    ['arrowleft', true, true, false, false],
    ['arrowleft', false, true, false, true],
  ];
  it.each(cases)(
    'key %s, on-pattern %s -> responded %s, said_on %s, correct %s',
    (key, onPattern, responded, saidOn, correct) => {
      expect(judgeStarResponse(key, onPattern)).toEqual({ responded, said_on: saidOn, correct });
    }
  );

  it('is case-insensitive about the key name', () => {
    expect(judgeStarResponse('ArrowRight', true).correct).toBe(true);
    expect(judgeStarResponse('ARROWLEFT', false).correct).toBe(true);
  });

  it.each([null, undefined, '', ' ', 'space', 'a', 'arrowup', 'arrowdown', 'enter'])(
    'any non-answer key (%s) is not a response and never correct, for an on-pattern and an off-pattern star',
    (key) => {
      for (const on of [true, false]) {
        expect(judgeStarResponse(key, on)).toEqual({ responded: false, correct: false });
      }
    }
  );

  it('the star judge and the probe judge agree on what each key means', () => {
    for (const truth of [true, false]) {
      for (const key of ['arrowright', 'arrowleft']) {
        expect(judgeStarResponse(key, truth).correct).toBe(judgeProbeResponse(key, truth).correct);
      }
    }
  });
});
