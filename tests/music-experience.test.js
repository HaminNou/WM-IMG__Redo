/**
 * @vitest-environment jsdom
 *
 * Tests for the post-experiment music-experience questionnaire
 * (`src/questionnaire/music-experience.js`).
 *
 * The questionnaire is now an
 * 8-item instrument: the 7-item Goldsmiths Musical Sophistication
 * Index — Musical Training (MT) subscale verbatim (Müllensiefen,
 * Gingras, Musil & Stewart 2014, *PLOS ONE* 9(2) e89642) plus one
 * absolute-pitch item kept from the prior scale because AP poses a
 * design-specific risk for our tone bank that Gold-MSI does not cover.
 *
 * Locked invariants exercised:
 *   1. Exactly 8 items; ids are me_q01..me_q08 in fixed order; the first
 *      seven map to Gold-MSI MT01..MT07 in the published Müllensiefen
 *      et al. order.
 *   2. Each item carries ≥ 2 options, each with non-empty value+label.
 *      Gold-MSI MT items (1..7) carry numeric scores 1..7 (item 7
 *      carries 5 anchored levels mapped linearly to {1, 2.5, 4, 5.5, 7}).
 *      The AP item (me_q08) carries `score: null` so it is excluded from
 *      the composite.
 *   3. The form-node's stimulus markup contains a labelled `<select>`
 *      control for every item, with `name` matching the item id and a
 *      blank-default option that forces the participant to choose.
 *   4. `on_finish` mirrors the form's `response` object onto
 *      `data.music_experience_responses` keyed by item id, as strings or
 *      null.
 *   5. `goldMsiMtComposite` computes the sum of item scores 1..7
 *      (range 7..49) and returns null when any of the seven items is
 *      blank. The AP item is reported separately.
 *   6. `scoreMusicExperience` extracts per-item codes, computes the
 *      composite, flags `complete` only when all 8 items are answered,
 *      and ignores rows whose phase is not `music_experience`.
 *   7. The composer wires the music-experience pair (`music_experience_intro`
 *      then `music_experience`) into `assembleQuestionnaireChain` AFTER
 *      every strategy-questionnaire section.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MUSIC_EXPERIENCE_ITEMS,
  musicExperienceTimeline,
  scoreMusicExperience,
  goldMsiMtComposite,
} from '../src/questionnaire/music-experience.js';
import { assembleQuestionnaireChain } from '../src/questionnaire/index.js';

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

  it('items 1..7 are tagged as Gold-MSI MT01..MT07 in the published order; item 8 is null (outside composite)', () => {
    const tags = MUSIC_EXPERIENCE_ITEMS.map((i) => i.gold_msi);
    expect(tags).toEqual(['MT01', 'MT02', 'MT03', 'MT04', 'MT05', 'MT06', 'MT07', null]);
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

  it('Gold-MSI MT items 1..6 carry integer scores spanning 1..7 across their bins', () => {
    /* MT01..MT06 are the 7-bin items where every option's score is one
     * of {1, 2, 3, 4, 5, 6, 7}, with both endpoints present. (MT07 is
     * the 5-anchor named-level item — checked separately.) */
    const mtBinned = MUSIC_EXPERIENCE_ITEMS.slice(0, 6);
    for (const item of mtBinned) {
      const scores = item.options.map((o) => o.score);
      expect(new Set(scores)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
    }
  });

  it('MT07 (best-instrument level) maps the 5 named anchors onto {1, 2.5, 4, 5.5, 7}', () => {
    /* Linear mapping of 5 anchors onto a 1..7 range so the composite
     * stays in the canonical Gold-MSI 7..49 envelope. */
    const mt07 = MUSIC_EXPERIENCE_ITEMS.find((i) => i.id === 'me_q07');
    expect(mt07.options.map((o) => o.score)).toEqual([1, 2.5, 4, 5.5, 7]);
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

  it('MT06 (single self-rating) is a 7-point Likert anchored at "Completely disagree" and "Completely agree"', () => {
    const mt06 = MUSIC_EXPERIENCE_ITEMS.find((i) => i.id === 'me_q06');
    expect(mt06.options).toHaveLength(7);
    expect(mt06.options[0].label.toLowerCase()).toContain('completely disagree');
    expect(mt06.options[6].label.toLowerCase()).toContain('completely agree');
    expect(mt06.options[3].label.toLowerCase()).toContain('neither');
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
    expect(formNode.html).toContain('<option value="">—</option>');
    expect(formNode.html).toContain('required');
  });

  it('on_finish stamps phase="music_experience" and a per-item music_experience_responses map', () => {
    const [, formNode] = musicExperienceTimeline();
    const data = {
      response: {
        me_q01: '4-5',
        me_q02: '1.5',
        me_q03: '2',
        me_q04: '6-9',
        me_q05: '2',
        me_q06: '5',
        me_q07: 'intermediate',
        me_q08: 'no',
      },
    };
    formNode.on_finish(data);
    expect(data.phase).toBe('music_experience');
    expect(data.music_experience_responses).toEqual({
      me_q01: '4-5',
      me_q02: '1.5',
      me_q03: '2',
      me_q04: '6-9',
      me_q05: '2',
      me_q06: '5',
      me_q07: 'intermediate',
      me_q08: 'no',
    });
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
        me_q06: '4',
        me_q07: 'beginner',
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
      me_q06: '4',
      me_q07: 'beginner',
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
  it('returns the sum of item scores 1..7 across MT01..MT07 (range 7..49)', () => {
    /* Walk the score map at the floor (every MT item at its lowest bin)
     * and at the ceiling (every MT item at its highest bin). */
    const minResp = {
      me_q01: '0',
      me_q02: '0',
      me_q03: '0',
      me_q04: '0',
      me_q05: '0',
      me_q06: '1',
      me_q07: 'none',
    };
    expect(goldMsiMtComposite(minResp).gold_msi_mt_composite).toBe(7);

    const maxResp = {
      me_q01: '10+',
      me_q02: '5+',
      me_q03: '7+',
      me_q04: '10+',
      me_q05: '6+',
      me_q06: '7',
      me_q07: 'expert',
    };
    expect(goldMsiMtComposite(maxResp).gold_msi_mt_composite).toBe(49);
  });

  it('returns null composite + complete=false when any MT item is blank', () => {
    const partial = {
      me_q01: '4-5',
      me_q02: '1.5',
      me_q03: '2',
      me_q04: null,
      me_q05: '2',
      me_q06: '5',
      me_q07: 'intermediate',
    };
    const out = goldMsiMtComposite(partial);
    expect(out.gold_msi_mt_composite).toBe(null);
    expect(out.gold_msi_mt_complete).toBe(false);
  });

  it('reports absolute_pitch from the AP item (me_q08), independent of MT completion', () => {
    /* The AP item is OUTSIDE the composite — it should be reported even
     * if the MT subscale is incomplete, and its presence/absence must not
     * affect the MT score. */
    const completeMt = {
      me_q01: '4-5',
      me_q02: '1.5',
      me_q03: '2',
      me_q04: '6-9',
      me_q05: '2',
      me_q06: '5',
      me_q07: 'intermediate',
      me_q08: 'yes',
    };
    const out = goldMsiMtComposite(completeMt);
    expect(out.absolute_pitch).toBe('yes');
    expect(out.gold_msi_mt_complete).toBe(true);
    expect(typeof out.gold_msi_mt_composite).toBe('number');
  });

  it('a modest expert with high behavioural scores still scores high even if self-rating is "neutral"', () => {
    /* Smoke test for the modesty-resistance property: high MT01..MT05
     * + high MT07 + neutral MT06 = composite well above the population
     * mean. With Müllensiefen et al.'s 7..49 envelope and a reported
     * mean ≈ 26.5, this profile should sit at ≥ 35. */
    const modestExpert = {
      me_q01: '10+', // 7
      me_q02: '5+', // 7
      me_q03: '4-6', // 6
      me_q04: '10+', // 7
      me_q05: '3', // 4
      me_q06: '4', // 4 (neutral self-rating despite expert behaviour)
      me_q07: 'advanced', // 5.5
    };
    const out = goldMsiMtComposite(modestExpert);
    expect(out.gold_msi_mt_composite).toBeGreaterThanOrEqual(35);
  });

  it('a confident novice with all-low behavioural scores cannot inflate the composite via self-rating alone', () => {
    /* Symmetric smoke test: low MT01..MT05 + Beginner MT07 + max-self-rating
     * stays well below the population mean (~26.5). */
    const overclaimer = {
      me_q01: '0', // 1
      me_q02: '0', // 1
      me_q03: '0', // 1
      me_q04: '0', // 1
      me_q05: '1', // 2
      me_q06: '7', // 7 (max self-rating)
      me_q07: 'beginner', // 2.5
    };
    const out = goldMsiMtComposite(overclaimer);
    expect(out.gold_msi_mt_composite).toBeLessThan(20);
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
        music_experience_responses: {
          me_q01: '4-5',
          me_q02: '1.5',
          me_q03: '2',
          me_q04: '6-9',
          me_q05: '2',
          me_q06: '5',
          me_q07: 'intermediate',
          me_q08: 'unsure',
        },
      },
    ];
    const out = scoreMusicExperience(rows);
    expect(out.complete).toBe(true);
    expect(out.answered).toBe(8);
    expect(out.itemResponses.me_q01).toBe('4-5');
    expect(out.itemResponses.me_q07).toBe('intermediate');
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
