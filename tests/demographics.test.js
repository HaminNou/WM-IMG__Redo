// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { demographicsTrial } from '../src/calibration/demographics.js';

function fields() {
  document.body.innerHTML = demographicsTrial().html;
  return Array.from(document.querySelectorAll('select, textarea')).map((el) =>
    el.getAttribute('name')
  );
}

describe('demographics form', () => {
  it('asks handedness, education, English fluency and glasses or contacts, with one note', () => {
    expect(fields()).toEqual([
      'handedness',
      'education',
      'english_fluency',
      'glasses_contacts',
      'glasses_contacts_note',
    ]);
  });

  it('asks nothing about hearing, vision status, colour vision or medication', () => {
    const html = demographicsTrial().html.toLowerCase();
    for (const word of ['hearing', 'impairment', 'vision', 'medication', 'deficiency']) {
      expect(html, word).not.toContain(word);
    }
    for (const name of ['hearing', 'hearing_note', 'vision', 'medication']) {
      expect(fields()).not.toContain(name);
    }
  });

  it('keeps the required fields required and the note optional', () => {
    document.body.innerHTML = demographicsTrial().html;
    for (const name of ['handedness', 'education', 'english_fluency', 'glasses_contacts']) {
      expect(document.querySelector(`[name="${name}"]`).required).toBe(true);
    }
    expect(document.querySelector('[name="glasses_contacts_note"]').required).toBe(false);
  });

  it('is tagged for the consent and demographics bucket', () => {
    expect(demographicsTrial().data.phase).toBe('demographics');
  });
});
