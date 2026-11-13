/**
 * Static audit of the recordings' word boundaries against the words the reveal engine builds, so
 * the text reveal keeps pace with the voice.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alignBoundariesToTokens } from '../src/visuals/voiceover.js';

const D = 'public/voiceover/';
const strings = JSON.parse(readFileSync(`${D}strings.json`, 'utf8'));
const manifest = JSON.parse(readFileSync(`${D}manifest.json`, 'utf8')).entries;
const L = /[\p{L}\p{N}]/u;
const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

describe('alignBoundariesToTokens', () => {
  it('skips tokens without a boundary and lets a boundary cover several tokens', () => {
    expect(alignBoundariesToTokens(['Block', 'includes'], ['Block', '1', 'includes'])).toEqual([
      0, 2,
    ]);
    expect(alignBoundariesToTokens(['3 seconds', 'Aim'], ['3', 'seconds', 'Aim'])).toEqual([1, 2]);
    expect(alignBoundariesToTokens(['x', 'y'], ['a', 'b'])).toEqual([0, 1]);
    expect(alignBoundariesToTokens(['a'], [])).toEqual([]);
  });
});

describe('every string has a recording whose boundaries line up with its words', () => {
  for (const s of strings) {
    const hash = createHash('sha256').update(s.text.replace(/–/g, '—'), 'utf8').digest('hex');
    it(`${s.source}: ${s.text.slice(0, 40)}`, () => {
      const e = manifest[hash];
      expect(e, 'manifest entry').toBeTruthy();
      const wb = e.word_boundaries;
      expect(wb.length).toBeGreaterThan(0);
      for (let i = 1; i < wb.length; i++)
        expect(wb[i].offset_ms).toBeGreaterThanOrEqual(wb[i - 1].offset_ms);
      const last = wb.at(-1);
      expect(last.offset_ms + last.duration_ms).toBeLessThanOrEqual(e.bytes / 12 + 300);
      const toks = s.text.split(/\s+/).filter((t) => L.test(t));
      const pos = alignBoundariesToTokens(
        wb.map((b) => b.text),
        toks
      );
      expect(pos).toHaveLength(wb.length);
      wb.forEach((b, j) => expect(norm(toks[pos[j]])).toBe(norm(b.text.split(' ').pop())));
    });
  }
});
