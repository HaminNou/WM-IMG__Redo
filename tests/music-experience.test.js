/**
 * @vitest-environment jsdom
 *
 * Tests for the post-experiment music-experience questionnaire
 * (`src/questionnaire/music-experience.js`).
 *
 * The questionnaire is an 8-item instrument: the 7-item Goldsmiths Musical
 * Sophistication Index (Gold-MSI) v1.0 Musical Training (MT) subscale
 * (Müllensiefen, Gingras, Musil & Stewart 2014, *PLOS ONE* 9(2) e89642,
 * File S1: "Musical Training (7 items, alpha = .903)") plus one
 * absolute-pitch item, because AP poses a design-specific risk for our tone
 * bank that Gold-MSI does not cover.
 *
 * Locked invariants exercised:
 *   1. Exactly 8 items; ids are me_q01..me_q08 in fixed order; the first
 *      seven map to Gold-MSI MT01..MT07 in the order of File S1.
 *   2. The seven item texts equal the File S1 wording (checked below against
 *      the strings printed in S1, after the documented spelling and
 *      punctuation normalisation; the hours item is a documented reword).
 *   3. All seven MT items score on one 1..7 scale with both endpoints. The
 *      two negatively phrased items ("never been complimented", "would not
 *      consider myself a musician") are reverse-keyed: raw 1 scores 7, 4
 *      scores 4, 7 scores 1 (Gold-MSI documentation, section 2.3). The AP
 *      item carries `score: null` so it is excluded from the composite.
 *   4. The form-node's markup contains a labelled `<select>` control for
 *      every item, with a blank-default option that forces a choice.
 *   5. `on_finish` mirrors the form's `response` object onto
 *      `data.music_experience_responses` keyed by item id (raw option
 *      values, strings or null).
 *   6. `goldMsiMtComposite` sums the seven item scores (reversal applied),
 *      range 7..49, and returns null when any of the seven is blank.
 *   7. `scoreMusicExperience` extracts per-item codes, computes the
 *      composite, flags `complete` only when all 8 items are answered, and
 *      ignores rows whose phase is not `music_experience`.
 *   8. The composer wires the music-experience pair into
 *      `assembleQuestionnaireChain` AFTER every strategy-questionnaire
 *      section.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MUSIC_EXPERIENCE_ITEMS,
  musicExperienceTimeline,
  scoreMusicExperience,
  goldMsiMtComposite,
} from '../src/questionnaire/music-experience.js';
import { assembleQuestionnaireChain } from '../src/questionnaire/index.js';

/* The seven Musical Training items exactly as printed in File S1 of
 * Müllensiefen et al. (2014), in S1 order. Source: the paper's supplementary
 * File S1 (pone.0089642.s001.docx), "Musical Training (7 items, α=.903)". */
const S1_MT_ITEMS = Object.freeze([
  'I engaged in regular, daily practice of a musical instrument (including voice) for ___ years',
  'I can play the following number of musical instruments (including voice)',
  'I have never been complimented for my talents as a musical performer',
  'At the peak of my interest, I practised ___ hours on my primary instrument (including voice)',
  'I have had formal training in music theory for ___ years',
  'During my life time I have had formal training on a musical instrument (including voice) for ___ years',
  'I would not consider myself a musician',
]);
const NEGATIVELY_PHRASED = Object.freeze(['me_q03', 'me_q07']);

/* Spelling/punctuation normalisation that the program applies on purpose:
 * US 'practiced'; the blank '___' and trailing punctuation are layout. */
const norm = (t) =>
  t
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/practised/g, 'practiced')
    .replace(/_+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/* A valid full answer set (raw option values). */
const RESP = Object.freeze({
  me_q01: '4-5',
  me_q02: '2',
  me_q03: '3',
  me_q04: '1.5',
  me_q05: '2',
  me_q06: '6-9',
  me_q07: '2',
  me_q08: 'no',
});

/* Response set that scores 1 on every MT item (the least musical profile):
 * the lowest bin of each ranged item, and for the negatively phrased items
 * complete agreement ('7'), which reverse-scores to 1. */
const FLOOR = Object.freeze({
  me_q01: '0',
  me_q02: '0',
  me_q03: '7',
  me_q04: '0',
  me_q05: '0',
  me_q06: '0',
  me_q07: '7',
});
/* Response set that scores 7 on every MT item. */
const CEILING = Object.freeze({
  me_q01: '10+',
  me_q02: '6+',
  me_q03: '1',
  me_q04: '5+',
  me_q05: '7+',
  me_q06: '10+',
  me_q07: '1',
});

beforeEach(() => {
  /* Some helpers that come along through hidden-nav register a window-level
   * shim; nothing in these tests needs jsPsych itself, but we keep the
   * window object stable so any incidental access doesn't throw. */
  Object.defineProperty(window, 'jsPsych', {
    value: { data: { get: () => ({ values: () => [] }) } },
    configurable: true,
    writable: true,
  });
});

describe('music-experience: item table', () => {
  it('contains exactly 8 items in the locked order me_q01..me_q08', () => {
    expect(MUSIC_EXPERIENCE_ITEMS.map((i) => i.id)).toEqual([
      'me_q01',
      'me_q02',
      'me_q03',
      'me_q04',
      'me_q05',
      'me_q06',
      'me_q07',
      'me_q08',
    ]);
  });

  it('items 1..7 are tagged as Gold-MSI MT01..MT07 in File S1 order; item 8 is null (outside composite)', () => {
    const tags = MUSIC_EXPERIENCE_ITEMS.map((i) => i.gold_msi);
    expect(tags).toEqual(['MT01', 'MT02', 'MT03', 'MT04', 'MT05', 'MT06', 'MT07', null]);
  });

  it('the seven Musical Training item texts equal the File S1 wording (hours item: documented reword)', () => {
    const mt = MUSIC_EXPERIENCE_ITEMS.slice(0, 7);
    for (const i of [0, 1, 2, 4, 5, 6]) {
      expect(norm(mt[i].text), `item ${i + 1}`).toBe(norm(S1_MT_ITEMS[i]));
    }
    /* Item 4 keeps S1's content but says 'per day', as the paper quotes it. */
    const t = norm(mt[3].text);
    expect(t).toContain('at the peak of my interest');
    expect(t).toContain('practiced');
    expect(t).toContain('primary instrument');
    expect(t).toContain('hours per day');
  });

  it('does not contain the items that are not part of the published subscale', () => {
    const all = MUSIC_EXPERIENCE_ITEMS.map((i) => norm(i.text)).join(' | ');
    expect(all).not.toContain('i would consider myself a musician');
    expect(all).not.toContain('play best');
    expect(all).not.toContain('level of a');
  });

  it('every item has ≥ 2 options, and every option has non-empty value + label', () => {
    for (const item of MUSIC_EXPERIENCE_ITEMS) {
      expect(item.options.length).toBeGreaterThanOrEqual(2);
      for (const opt of item.options) {
        expect(typeof opt.value).toBe('string');
        expect(opt.value.length).toBeGreaterThan(0);
        expect(typeof opt.label).toBe('string');
        expect(opt.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('each item id is unique and option values within an item are unique', () => {
    const seen = new Set();
    for (const item of MUSIC_EXPERIENCE_ITEMS) {
      expect(seen.has(item.id)).toBe(false);
      seen.add(item.id);
      const values = item.options.map((o) => o.value);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('all seven MT items carry integer scores covering exactly 1..7 across their options', () => {
    for (const item of MUSIC_EXPERIENCE_ITEMS.slice(0, 7)) {
      const scores = item.options.map((o) => o.score);
      expect(new Set(scores), item.id).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
      expect(scores.every(Number.isInteger)).toBe(true);
    }
  });

  it('exactly the two negatively phrased items are reverse-keyed, and their scores run 7..1 with the raw value 1..7', () => {
    const flagged = MUSIC_EXPERIENCE_ITEMS.filter((i) => i.reverse_keyed).map((i) => i.id);
    expect(flagged).toEqual(NEGATIVELY_PHRASED);
    for (const id of NEGATIVELY_PHRASED) {
      const item = MUSIC_EXPERIENCE_ITEMS.find((i) => i.id === id);
      expect(item.options.map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
      expect(item.options.map((o) => o.score)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    }
    /* every other MT item scores in the direction of its option order */
    for (const item of MUSIC_EXPERIENCE_ITEMS.slice(0, 7)) {
      if (item.reverse_keyed) continue;
      expect(item.options.map((o) => o.score)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
  });

  it('the absolute-pitch item (me_q08) carries score: null on every option (excluded from composite)', () => {
    const ap = MUSIC_EXPERIENCE_ITEMS.find((i) => i.id === 'me_q08');
    expect(ap).toBeDefined();
    for (const opt of ap.options) {
      expect(opt.score).toBe(null);
    }
    /* And it must offer a 'yes' option so the analyst can flag the AP case. */
    expect(ap.options.some((o) => o.value === 'yes')).toBe(true);
  });

  it('the two agreement items are 7-point scales anchored at "Completely disagree" and "Completely agree"', () => {
    for (const id of NEGATIVELY_PHRASED) {
      const item = MUSIC_EXPERIENCE_ITEMS.find((i) => i.id === id);
      expect(item.options).toHaveLength(7);
      expect(item.options[0].label.toLowerCase()).toContain('completely disagree');
      expect(item.options[6].label.toLowerCase()).toContain('completely agree');
      expect(item.options[3].label.toLowerCase()).toContain('neither');
    }
  });
});

describe('music-experience: form-node markup + on_finish', () => {
  it('the form node renders a labelled <select> with the right name= for every item', () => {
    const [, formNode] = musicExperienceTimeline();
    /* preamble + html together compose the visible markup; check html since
     * the `<select>` controls are mounted there. */
    const markup = `${formNode.preamble}\n${formNode.html}`;
    for (const item of MUSIC_EXPERIENCE_ITEMS) {
      expect(markup).toContain(`name="${item.id}"`);
    }
  });

  it('every <select> includes a blank-default option (forces an explicit choice)', () => {
    const [, formNode] = musicExperienceTimeline();
    /* `<option value="">—</option>` — the em-dash sentinel pattern. The form
     * has `required` on each select so the participant must choose. */
    expect(formNode.html).toContain('<option value="">–</option>');
    expect(formNode.html).toContain('required');
  });

  it('on_finish stamps phase="music_experience" and a per-item music_experience_responses map', () => {
    const [, formNode] = musicExperienceTimeline();
    const data = {
      response: { ...RESP },
    };
    formNode.on_finish(data);
    expect(data.phase).toBe('music_experience');
    expect(data.music_experience_responses).toEqual({ ...RESP });
  });

  it('on_finish coerces blank/missing responses to null per item', () => {
    const [, formNode] = musicExperienceTimeline();
    const data = {
      response: {
        me_q01: '0',
        me_q02: '',
        /* me_q03 missing */
        me_q04: null,
        me_q05: undefined,
        me_q06: '3-5',
        me_q07: '2',
        me_q08: 'no',
      },
    };
    formNode.on_finish(data);
    expect(data.music_experience_responses).toEqual({
      me_q01: '0',
      me_q02: null,
      me_q03: null,
      me_q04: null,
      me_q05: null,
      me_q06: '3-5',
      me_q07: '2',
      me_q08: 'no',
    });
  });

  it('intro node carries phase="music_experience_intro"', () => {
    const [introNode] = musicExperienceTimeline();
    const data = {};
    introNode.on_finish(data);
    expect(data.phase).toBe('music_experience_intro');
  });

  it('intro page warns participants away from comparing themselves to professional musicians', () => {
    /* Müllensiefen et al. (and the literature on self-rating bias more
     * generally — Dunning–Kruger / modesty effects) recommend explicit
     * framing so respondents anchor on their own behaviour rather than
     * external comparison. We pin the framing so a future copy edit
     * can't quietly drop it. */
    const [introNode] = musicExperienceTimeline();
    const text = introNode.preamble.toLowerCase();
    expect(text).toContain('what you have actually done');
    expect(text).toContain('professional');
  });
});

describe('goldMsiMtComposite (Gold-MSI MT subscale)', () => {
  it('returns the sum of the seven item scores (reversal applied), range 7..49', () => {
    expect(goldMsiMtComposite(FLOOR).gold_msi_mt_composite).toBe(7);
    expect(goldMsiMtComposite(CEILING).gold_msi_mt_composite).toBe(49);
  });

  it('reverse-keys the two negatively phrased items: agreeing LOWERS the score by 1 per step', () => {
    const base = { ...CEILING };
    const score = (over) => goldMsiMtComposite({ ...base, ...over }).gold_msi_mt_composite;
    for (const id of NEGATIVELY_PHRASED) {
      /* raw 1 (completely disagree) = 7 points; raw 7 (completely agree) = 1 point */
      expect(score({ [id]: '1' })).toBe(49);
      expect(score({ [id]: '2' })).toBe(48);
      expect(score({ [id]: '4' })).toBe(46);
      expect(score({ [id]: '7' })).toBe(43);
    }
    /* and a ranged item still scores upward with its bin */
    expect(score({ me_q01: '0' })).toBe(43);
    expect(score({ me_q01: '4-5' })).toBe(47);
  });

  it('a profile that is neutral on both agreement items and mid-range elsewhere scores the 4-point midpoint on each', () => {
    const mid = {
      me_q01: '3',
      me_q02: '3',
      me_q03: '4',
      me_q04: '1.5',
      me_q05: '2',
      me_q06: '2',
      me_q07: '4',
    };
    expect(goldMsiMtComposite(mid).gold_msi_mt_composite).toBe(28);
  });

  it('returns null composite + complete=false when any MT item is blank', () => {
    for (const id of Object.keys(CEILING)) {
      const partial = { ...CEILING, [id]: null };
      const out = goldMsiMtComposite(partial);
      expect(out.gold_msi_mt_composite, id).toBe(null);
      expect(out.gold_msi_mt_complete, id).toBe(false);
    }
  });

  it('an unknown option value counts as unanswered, not as zero', () => {
    const out = goldMsiMtComposite({ ...CEILING, me_q03: 'maybe' });
    expect(out.gold_msi_mt_composite).toBe(null);
    expect(out.gold_msi_mt_complete).toBe(false);
  });

  it('reports absolute_pitch from the AP item (me_q08), independent of MT completion and of the composite', () => {
    const withYes = goldMsiMtComposite({ ...RESP, me_q08: 'yes' });
    const withNo = goldMsiMtComposite({ ...RESP, me_q08: 'no' });
    expect(withYes.absolute_pitch).toBe('yes');
    expect(withNo.absolute_pitch).toBe('no');
    expect(withYes.gold_msi_mt_composite).toBe(withNo.gold_msi_mt_composite);
    expect(typeof withYes.gold_msi_mt_composite).toBe('number');
    expect(withYes.gold_msi_mt_complete).toBe(true);
    /* incomplete MT, AP still reported */
    expect(goldMsiMtComposite({ me_q08: 'unsure' }).absolute_pitch).toBe('unsure');
  });

  it('a modest expert (neutral on both agreement items) still scores well above the population mean (≈ 26.5)', () => {
    const modestExpert = { ...CEILING, me_q03: '4', me_q07: '4' };
    expect(goldMsiMtComposite(modestExpert).gold_msi_mt_composite).toBe(43);
  });

  it('a novice who strongly disagrees with the negative statements cannot inflate the composite far above the floor', () => {
    /* Lowest bin on every ranged item, but "never complimented" and "would
     * not consider myself a musician" both answered completely disagree
     * (raw 1 → 7 points each): 5 × 1 + 7 + 7 = 19, well below the mean. */
    const overclaimer = { ...FLOOR, me_q03: '1', me_q07: '1' };
    const out = goldMsiMtComposite(overclaimer);
    expect(out.gold_msi_mt_composite).toBe(19);
    expect(out.gold_msi_mt_composite).toBeLessThan(26.5);
  });
});

describe('scoreMusicExperience', () => {
  it('returns nulls for every item when no rows are passed', () => {
    const out = scoreMusicExperience([]);
    expect(out.total).toBe(8);
    expect(out.answered).toBe(0);
    expect(out.complete).toBe(false);
    expect(out.gold_msi_mt_composite).toBe(null);
    expect(out.gold_msi_mt_complete).toBe(false);
    expect(Object.values(out.itemResponses).every((v) => v === null)).toBe(true);
  });

  it('extracts a complete set when all 8 items answered on a single row', () => {
    const rows = [
      {
        phase: 'music_experience',
        music_experience_responses: { ...RESP, me_q08: 'unsure' },
      },
    ];
    const out = scoreMusicExperience(rows);
    expect(out.complete).toBe(true);
    expect(out.answered).toBe(8);
    expect(out.itemResponses.me_q01).toBe('4-5');
    expect(out.itemResponses.me_q07).toBe('2');
    expect(out.absolute_pitch).toBe('unsure');
    expect(typeof out.gold_msi_mt_composite).toBe('number');
    expect(out.gold_msi_mt_composite).toBeGreaterThanOrEqual(7);
    expect(out.gold_msi_mt_composite).toBeLessThanOrEqual(49);
  });

  it('ignores rows whose phase is not music_experience', () => {
    const rows = [
      { phase: 'strategy_memory_only', music_experience_responses: { me_q01: '10+' } },
      { phase: 'd_only_probe' },
    ];
    const out = scoreMusicExperience(rows);
    expect(out.itemResponses.me_q01).toBe(null);
    expect(out.complete).toBe(false);
    expect(out.gold_msi_mt_composite).toBe(null);
  });
});

describe('music-experience: wiring into the questionnaire chain', () => {
  it('assembleQuestionnaireChain ends with music_experience_intro then music_experience after every strategy-questionnaire section', () => {
    const chain = assembleQuestionnaireChain();
    /* Walk to the on_finish hooks to identify each node's phase. The
     * intro is an html-keyboard-response node with `data.phase`; the
     * strategy + music nodes use survey-html-form and stamp phase via
     * on_finish, so we run a synthetic on_finish to read it. */
    const phases = chain.map((node) => {
      if (node?.data?.phase) return node.data.phase;
      if (typeof node?.on_finish === 'function') {
        const probe = { response: {} };
        try {
          node.on_finish(probe);
        } catch {
          /* swallow — some hooks reach into runtime helpers we don't need */
        }
        return probe.phase;
      }
      return null;
    });
    /* The last two phases must be the music-experience pair, in order. */
    expect(phases[phases.length - 2]).toBe('music_experience_intro');
    expect(phases[phases.length - 1]).toBe('music_experience');
    /* All five strategy sections must precede the music block. */
    const meIntroIdx = phases.indexOf('music_experience_intro');
    for (const p of [
      'strategy_memory_only',
      'strategy_tone_only',
      'strategy_imagery_only',
      'strategy_i_d',
      'strategy_i_t',
    ]) {
      const idx = phases.indexOf(p);
      expect(idx, `phase ${p} missing from chain`).toBeGreaterThan(-1);
      expect(idx, `${p} must precede music_experience_intro`).toBeLessThan(meIntroIdx);
    }
  });
});
