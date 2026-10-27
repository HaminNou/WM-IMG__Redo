// @vitest-environment jsdom
/**
 * Prolific's researcher terms (account hold, June 2026) forbid collecting
 * direct identifiers and forbid screening participants inside the study on
 * demographics such as age. These tests keep the program on the right side of
 * both rules:
 *
 *   1. The demographics form and the questionnaires ask for nothing that
 *      identifies a person (no name, email, date of birth, age, address,
 *      phone number), and the demographics form has no free-text box at all.
 *   2. No source file or schema field can bring back date of birth, a
 *      computed age or an age-disqualification flag.
 *   3. Nothing in the demographics form can end a session, and every
 *      in-study exit is a compatibility, quality or consent reason, never an
 *      age or other demographic one.
 *   4. All screening criteria are Prolific filters. The consent form does not
 *      restate them or ask people to judge themselves against them; the
 *      Prolific listing and the pre-registration list exactly the filters.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demographicsTrial } from '../src/calibration/demographics.js';
import { MUSIC_EXPERIENCE_ITEMS } from '../src/questionnaire/music-experience.js';
import { STRATEGY_ITEMS } from '../src/questionnaire/strategy.js';
import { consentBodyHtml } from '../src/calibration/consent-text.js';
import { PROLIFIC_PRESCREEN_SUMMARY } from '../src/config.js';

const ROOT = join(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|html|json)$/.test(name)) out.push(p);
  }
  return out;
}

const IDENTIFIER_NAME =
  /(^|[^a-z])(name|e-?mail|phone|tel|mobile|address|street|city|zip|postcode|postal|birth|birthday|dob|age|ssn|passport|license|licence)([^a-z]|$)/i;

describe('the demographics form collects nothing that identifies a person', () => {
  it('has no control whose name, id or label looks like an identifier', () => {
    document.body.innerHTML = demographicsTrial().html;
    const controls = Array.from(document.querySelectorAll('input, select, textarea'));
    expect(controls.length).toBeGreaterThan(0);
    for (const el of controls) {
      const label = el.id
        ? (document.querySelector(`label[for="${el.id}"]`)?.textContent ?? '')
        : '';
      for (const text of [el.getAttribute('name') ?? '', el.id, label]) {
        expect(IDENTIFIER_NAME.test(text), `${el.tagName} "${text}"`).toBe(false);
      }
    }
  });

  it('asks exactly handedness and education, both closed choices, with no free-text control', () => {
    document.body.innerHTML = demographicsTrial().html;
    const controls = Array.from(document.querySelectorAll('input, select, textarea'));
    expect(controls.map((el) => el.getAttribute('name'))).toEqual(['handedness', 'education']);
    for (const el of controls) expect(el.tagName, el.getAttribute('name')).toBe('SELECT');
    expect(document.querySelectorAll('textarea, input')).toHaveLength(0);
  });

  it('cannot end the session: no exit or abort code in the form', () => {
    const src = read('src/calibration/demographics.js');
    for (const word of [
      'abortExperiment',
      'finishScreenOut',
      'screenOut',
      'exit_reason',
      'endExperiment',
    ]) {
      expect(src, word).not.toContain(word);
    }
  });
});

describe('the questionnaires ask closed questions only', () => {
  const ASKS_FOR_IDENTITY =
    /\b(your name|e-?mail|phone number|home address|date of birth|birthday|zip ?code|postcode|social security)\b/i;

  it('has no music or strategy item that asks for an identifier', () => {
    for (const item of [...MUSIC_EXPERIENCE_ITEMS, ...STRATEGY_ITEMS]) {
      expect(IDENTIFIER_NAME.test(item.id), item.id).toBe(false);
      expect(ASKS_FOR_IDENTITY.test(item.text), item.id).toBe(false);
    }
  });

  it('gives every music item a fixed set of options (no typed answers)', () => {
    for (const item of MUSIC_EXPERIENCE_ITEMS) {
      expect(Array.isArray(item.options) && item.options.length > 1, item.id).toBe(true);
    }
  });
});

describe('nothing can bring back date of birth, computed age or an age screen', () => {
  it('has none of those field names in any source file or schema', () => {
    const banned = /date_of_birth|computed_age|age_disqualified|\bdob\b|birth_?date|birth_?year/i;
    const files = [
      ...walk(join(ROOT, 'src')),
      ...walk(join(ROOT, 'schemas')),
      join(ROOT, 'index.html'),
      join(ROOT, 'recover.html'),
    ];
    const hits = files.filter((f) => banned.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('has no in-study exit for age or any demographic answer', () => {
    const ALLOWED_EXITS = new Set([
      'consent_declined',
      'desktop_required',
      'display_guard_escape',
      'practice_criterion_not_met',
      'screen_calibration_failed',
      'timing_check_failed',
      'tones_not_audible',
    ]);
    const found = new Set();
    for (const f of walk(join(ROOT, 'src')).filter((p) => p.endsWith('.js'))) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/exit_?[Rr]eason:\s*'([a-z_]+)'/g)) found.add(m[1]);
    }
    expect(found.size).toBeGreaterThan(0);
    for (const reason of found) {
      expect(ALLOWED_EXITS.has(reason), `unexpected exit reason ${reason}`).toBe(true);
      expect(
        /age|demograph|eligib|birth|sex|gender|handed|educat|language|fluen|hearing|vision|cognit/i.test(
          reason
        )
      ).toBe(false);
    }
  });
});

describe('every screening criterion is a Prolific filter, never an in-study statement', () => {
  /* Imperative self-screening is what Prolific objected to: asking people to
   * judge themselves against requirements that no filter enforces. */
  const SELF_SCREENING = [
    /please take part only if[^.]*(vision|hearing|colou?r|cognitive|english)/i,
    /please do not take part if[^.]*(cognitive|colou?r|brain|vision|hearing)/i,
    /do not (continue|take part) if you have (a )?(cognitive|colou?r|traumatic)/i,
    /if any of the criteria above does not apply to you/i,
  ];
  const md = read('prolific-study-description.md');
  const pasted = md.slice(
    md.indexOf('<!-- PASTE-BLOCK-START -->'),
    md.indexOf('<!-- PASTE-BLOCK-END -->')
  );
  const consent = consentBodyHtml();

  it('has the seven filters in the config list', () => {
    expect(PROLIFIC_PRESCREEN_SUMMARY).toHaveLength(7);
  });

  it('does not restate the criteria or ask for self-screening in the consent', () => {
    for (const item of PROLIFIC_PRESCREEN_SUMMARY) expect(consent, item).not.toContain(item);
    for (const re of SELF_SCREENING) expect(consent, String(re)).not.toMatch(re);
    expect(consent).not.toMatch(/color blindness|colour blindness|traumatic brain injury/i);
    expect(consent).toMatch(/criteria are listed on the study(&rsquo;|')s Prolific page/);
  });

  it('lists exactly the filters in the pasted listing, with no self-screening sentence', () => {
    expect(pasted.length).toBeGreaterThan(500);
    for (const item of PROLIFIC_PRESCREEN_SUMMARY) expect(pasted, item).toContain(item);
    for (const re of SELF_SCREENING) expect(pasted, String(re)).not.toMatch(re);
    expect(pasted).toMatch(/determined only by these Prolific filters, which are applied/);
  });

  it('tells participants no identifying information is asked for, in consent and listing', () => {
    for (const text of [consent, pasted]) {
      expect(text).toMatch(/does not ask for your name, email address/i);
      expect(text).toMatch(/date of birth/i);
    }
  });
});
