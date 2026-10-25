// @vitest-environment jsdom
/**
 * V4-02: with the title and the intro paragraph, eight two-line items at 0.75 rem
 * row padding pushed the music questionnaire's Continue button below the fold at
 * 1440 x 900 (its bottom edge was at y = 926; measured in real Chrome with the
 * project's CSS). At 0.5 rem it ends at y = 862, inside the window. Only the
 * spacing changed: the items, their wording and their order are untouched
 * (tests/music-experience.test.js checks the texts against Gold-MSI File S1).
 */
import { describe, expect, it } from 'vitest';
import {
  musicExperienceTimeline,
  MUSIC_EXPERIENCE_ITEMS,
} from '../src/questionnaire/music-experience.js';

const nodes = musicExperienceTimeline();
const form = (Array.isArray(nodes) ? nodes : (nodes.timeline ?? [nodes])).find((n) =>
  String(n.html ?? '').includes('<table')
);

describe('music questionnaire layout (V4-02)', () => {
  const host = document.createElement('div');
  host.innerHTML = form.html;
  const rows = [...host.querySelectorAll('tr')];

  it('has one row per item, in order, each with a select named by the item id', () => {
    expect(rows).toHaveLength(MUSIC_EXPERIENCE_ITEMS.length);
    rows.forEach((tr, i) => {
      expect(tr.querySelector('select').getAttribute('name')).toBe(MUSIC_EXPERIENCE_ITEMS[i].id);
    });
  });

  it('every cell uses 0.5 rem vertical padding (no cell is taller than before)', () => {
    for (const td of host.querySelectorAll('td')) {
      const m = td.getAttribute('style').match(/padding:\s*([0-9.]+)rem/);
      expect(m, 'cell without rem padding').not.toBeNull();
      expect(Number(m[1])).toBeLessThanOrEqual(0.5);
    }
    expect(form.html).not.toContain('0.75rem 0.75rem 0.75rem 0');
  });

  it('keeps the preamble and the Continue label', () => {
    expect(form.preamble).toContain('Music background');
    expect(form.button_label).toBe('Continue');
  });
});
