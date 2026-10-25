// @vitest-environment jsdom
/**
 * V4-01: instruction-deck content sat ~40 px right of centre because the
 * 50 rem (800 px) text-slide wrapper was wider than the 720 px
 * `.jspsych-content` host and overflowed to the right.
 *
 * jsdom does no layout, so these tests pin the three ingredients of the fix
 * (verified in real Chrome at 1440 x 900/768, 1100, 860, 700 and 480 px
 * wide: wrapper centre == host centre, no overflow past the viewport):
 *   1. every text-slide wrapper carries the `slide-text` marker class,
 *   2. the wrapper caps at min(94vw, 100%) (fallback without :has()),
 *   3. index.html widens the host for such slides, capped at 94vw (a bare
 *      `max-width: none` pushes the wrapper off the right edge on windows
 *      narrower than ~850 px).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { slideTextPage, slideStimulusPage, SLIDE_TEXT_CLASS } from '../src/visuals/slide-layout.js';

const indexHtml = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');

function firstWrapper(html) {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild;
}

describe('text-slide wrapper centring (V4-01)', () => {
  it.each([
    ['slideTextPage', () => slideTextPage({ title: 'T', body: '<p>b</p>' })],
    ['slideStimulusPage', () => slideStimulusPage({ title: 'T', body: '<p>b</p>' })],
  ])('%s wrapper has the marker class and the 94vw/100%% cap', (_name, build) => {
    const w = firstWrapper(build());
    expect(w.classList.contains(SLIDE_TEXT_CLASS)).toBe(true);
    expect(w.getAttribute('style')).toContain('max-width: min(94vw, 100%)');
    expect(w.getAttribute('style')).toContain('width: 50rem');
    expect(w.getAttribute('style')).toContain('margin: 0 auto');
  });

  it('index.html widens the host for text slides, capped at the viewport', () => {
    const rule = indexHtml.match(/\.jspsych-content:has\(\.slide-text\)\s*\{([^}]*)\}/);
    expect(rule, 'missing .jspsych-content:has(.slide-text) rule').not.toBeNull();
    expect(rule[1]).toMatch(/max-width:\s*94vw/);
    expect(rule[1]).not.toMatch(/max-width:\s*none/);
  });

  it('the base 720 px cap still applies to everything else', () => {
    expect(indexHtml).toMatch(/\.jspsych-content\s*\{\s*max-width:\s*720px;\s*\}/);
  });

  it('the demo track is untouched (still lifted by .demo-frame, not .slide-text)', () => {
    const demo = indexHtml.match(/\.jspsych-content:has\(\.demo-frame\)\s*\{([^}]*)\}/);
    expect(demo).not.toBeNull();
    expect(demo[1]).toMatch(/max-width:\s*none/);
    const w = firstWrapper(slideTextPage({ title: 'T', body: '' }));
    expect(w.querySelector('.demo-frame')).toBeNull();
  });
});
