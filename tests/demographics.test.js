// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demographicsTrial } from '../src/calibration/demographics.js';

function fields() {
  document.body.innerHTML = demographicsTrial().html;
  return Array.from(document.querySelectorAll('select, textarea')).map((el) =>
    el.getAttribute('name')
  );
}

describe('demographics form', () => {
  it('asks handedness and highest level of education only, as closed choices', () => {
    expect(fields()).toEqual(['handedness', 'education']);
    document.body.innerHTML = demographicsTrial().html;
    expect(document.querySelectorAll('textarea, input')).toHaveLength(0);
  });

  it('asks nothing that Prolific filters already decide or that is health-related', () => {
    const html = demographicsTrial().html.toLowerCase();
    for (const word of [
      'hearing',
      'impairment',
      'vision',
      'medication',
      'deficiency',
      'glasses',
      'contacts',
      'english',
      'fluency',
      'language',
      'dementia',
      'cognitive',
    ]) {
      expect(html, word).not.toContain(word);
    }
    for (const name of [
      'hearing',
      'hearing_note',
      'vision',
      'medication',
      'english_fluency',
      'glasses_contacts',
      'glasses_contacts_note',
    ]) {
      expect(fields()).not.toContain(name);
    }
  });

  it('keeps both fields required', () => {
    document.body.innerHTML = demographicsTrial().html;
    for (const name of ['handedness', 'education']) {
      expect(document.querySelector(`[name="${name}"]`).required).toBe(true);
    }
  });

  it('has no code left over from the removed free-text note', () => {
    const src = readFileSync(join(__dirname, '../src/calibration/demographics.js'), 'utf8');
    for (const word of [
      'textarea',
      'looksLikeIdentifier',
      'guardNoteAgainstIdentifiers',
      'setCustomValidity',
    ]) {
      expect(src, word).not.toContain(word);
    }
  });

  it('is tagged for the consent and demographics bucket', () => {
    expect(demographicsTrial().data.phase).toBe('demographics');
  });
});
