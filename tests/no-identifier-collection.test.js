// @vitest-environment jsdom
/**
 * Prolific's researcher terms (account hold, June 2026) forbid collecting
 * direct identifiers and forbid screening participants inside the study on
 * demographics such as age. These tests keep the program on the right side of
 * both rules:
 *
 *   1. The demographics form and the questionnaires ask for nothing that
 *      identifies a person (no name, email, date of birth, age, address,
 *      phone number), and the one free-text box refuses emails, phone
 *      numbers and links.
 *   2. No source file or schema field can bring back date of birth, a
 *      computed age or an age-disqualification flag.
 *   3. Nothing in the demographics form can end a session, and every
 *      in-study exit is a compatibility, quality or consent reason, never an
 *      age or other demographic one.
 *   4. The consent text and the Prolific listing give eligibility only
 *      through Prolific's filters and do not state extra self-screening
 *      requirements (colour vision, cognitive impairment, brain injury).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  demographicsTrial,
  guardNoteAgainstIdentifiers,
  looksLikeIdentifier,
} from '../src/calibration/demographics.js';
import { MUSIC_EXPERIENCE_ITEMS } from '../src/questionnaire/music-experience.js';
import { STRATEGY_ITEMS } from '../src/questionnaire/strategy.js';
import { consentBodyHtml } from '../src/calibration/consent-text.js';

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

  it('has exactly one free-text box, limited in length', () => {
    document.body.innerHTML = demographicsTrial().html;
    const free = document.querySelectorAll('textarea, input[type="text"], input:not([type])');
    expect(free).toHaveLength(1);
    expect(free[0].getAttribute('name')).toBe('glasses_contacts_note');
    expect(Number(free[0].getAttribute('maxlength'))).toBeLessThanOrEqual(200);
  });

  it('tells participants not to enter identifying information', () => {
    const html = demographicsTrial().html.toLowerCase();
    expect(html).toContain('do not include your name, email address');
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

describe('the optional note refuses direct identifiers', () => {
  it.each([
    ['call me 555 123 4567'],
    ['+1 (573) 882-1234'],
    ['mail me at a.b@c.com'],
    ['see www.example.org'],
    ['https://example.org/me'],
    ['5731234567'],
  ])('flags %s', (text) => {
    expect(looksLikeIdentifier(text)).toBe(true);
  });

  it.each([
    [''],
    ['I normally wear glasses'],
    ['I wear contacts at night'],
    ['since 2010'],
    ['prescription -2.5 and -3.25'],
    ['short-sighted, about -4'],
  ])('lets %s through', (text) => {
    expect(looksLikeIdentifier(text)).toBe(false);
  });

  it('blocks form submission while the note holds an identifier and releases it when removed', () => {
    document.body.innerHTML = demographicsTrial().html;
    const note = document.querySelector('[name="glasses_contacts_note"]');
    guardNoteAgainstIdentifiers(note);
    expect(note.checkValidity()).toBe(true);
    note.value = 'reach me on a.b@c.com';
    note.dispatchEvent(new Event('input'));
    expect(note.checkValidity()).toBe(false);
    expect(note.validationMessage).toMatch(/email|phone|link/i);
    note.value = 'I normally wear glasses';
    note.dispatchEvent(new Event('input'));
    expect(note.checkValidity()).toBe(true);
  });

  it('is wired into the trial so it runs when the form is shown', () => {
    document.body.innerHTML = demographicsTrial().html;
    const trial = demographicsTrial();
    expect(typeof trial.on_load).toBe('function');
    trial.on_load();
    const note = document.querySelector('[name="glasses_contacts_note"]');
    note.value = '573-882-1234';
    note.dispatchEvent(new Event('input'));
    expect(note.checkValidity()).toBe(false);
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
      'audio_check_failed',
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
        /age|demograph|eligib|birth|sex|gender|handed|educat|language|fluen/i.test(reason)
      ).toBe(false);
    }
  });
});

describe('eligibility is given only through Prolific filters', () => {
  const EXTRA_SELF_SCREENING = [
    /color blindness|colour blindness/i,
    /cognitive impairment/i,
    /traumatic brain injury/i,
    /normal color vision|normal colour vision/i,
    /please do not take part if you have a cognitive/i,
  ];
  const md = read('prolific-study-description.md');
  const pasted = md.slice(
    md.indexOf('<!-- PASTE-BLOCK-START -->'),
    md.indexOf('<!-- PASTE-BLOCK-END -->')
  );

  it('states no unenforced vision, cognitive or colour requirement in the consent', () => {
    const consent = consentBodyHtml();
    for (const re of EXTRA_SELF_SCREENING) expect(consent).not.toMatch(re);
  });

  it('states no unenforced vision, cognitive or colour requirement in the pasted listing', () => {
    expect(pasted.length).toBeGreaterThan(500);
    for (const re of EXTRA_SELF_SCREENING) expect(pasted).not.toMatch(re);
    expect(pasted).toMatch(/determined only by these Prolific filters/);
  });

  it('tells participants no identifying information is asked for, in consent and listing', () => {
    const consent = consentBodyHtml();
    for (const text of [consent, pasted]) {
      expect(text).toMatch(/does not ask for your name, email address/i);
      expect(text).toMatch(/date of birth/i);
    }
  });
});
