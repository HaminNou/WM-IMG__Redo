/**
 * The tone-bank step ratio is quoted in comments and in the pre-registration prose. It must be
 * the true value (3900/200)^(1/23) = 1.1379, i.e. 1.138 (13.8 %), and three ranks = 1.4732,
 * i.e. 1.47x. Earlier text said 1.139 (~13.9 %) and 1.48x. The locked config VALUES are not
 * touched; this guards only the prose.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { config } from '../src/config.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const { low_freq_hz: lo, high_freq_hz: hi, count } = config.tones;
const ratio = (hi / lo) ** (1 / (count - 1));

describe('tone-bank step ratio prose', () => {
  it('the true values round to 1.138, 13.8 % and 1.47x', () => {
    expect(ratio.toFixed(3)).toBe('1.138');
    expect(((ratio - 1) * 100).toFixed(1)).toBe('13.8');
    expect((ratio ** 3).toFixed(2)).toBe('1.47');
  });

  it('no source comment or pre-registration claim quotes the old, wrong roundings', () => {
    for (const rel of [
      '../src/config.js',
      '../src/audio/tones.js',
      '../src/audio/dsp.js',
      '../tests/tones.test.js',
      '../pre-reg/pre-reg.json',
    ]) {
      let text = read(rel);
      if (rel.endsWith('pre-reg.json')) {
        /* the dated history in _doc may quote the old figures it corrects */
        const { _doc, ...rest } = JSON.parse(text);
        void _doc;
        text = JSON.stringify(rest);
      }
      expect(text, `${rel}: 1.139`).not.toMatch(/\b1\.139\b/);
      expect(text, `${rel}: 13.9 %`).not.toMatch(/13\.9 ?%/);
      expect(text, `${rel}: 1.48x`).not.toMatch(/3 ranks ≈ 1\.48/);
    }
  });

  it('the pre-registration states the correct ratio and the three-rank factor', () => {
    const text = read('../pre-reg/pre-reg.json');
    expect(text).toContain('neighbour ratio ≈ 1.138, so 3 ranks ≈ 1.47×');
  });
});
