// @vitest-environment jsdom
/**
 * Short-window fit. jsdom cannot measure layout, so these tests pin the rules that make the
 * instruction decks, the demos and the other slides fit without scrolling in a 600-800 px high
 * window (measured in Chrome at 1280x600, 1280x650, 1366x657, 1440x700, 1536x730, 1920x940):
 * the CSS blocks, the class hooks they need, the custom property that caps the exemplar circle,
 * and the 14 px floor for text. If a rule is removed, the slides fall back below the fold.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { slideStimulusPage, slideTextPage } from '../src/visuals/slide-layout.js';
import {
  DEMO_SHORT_WINDOW_CSS,
  dOnlyDemoNode,
  DEMO_NO_PRESS_NOTE,
} from '../src/instructions/demos.js';
import { continueHintHtml } from '../src/visuals/continue-hint.js';
import { mainATagReminderNode } from '../src/runner-intros.js';

const indexHtml = readFileSync('index.html', 'utf8');
const host = (html) => {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
};
/* Every `font-size: Npx` / `N rem` declared in a CSS string, in px (1 rem = 16 px). */
const fontSizesPx = (css) =>
  [...css.matchAll(/font-size:\s*([\d.]+)(px|rem)/g)].map((m) =>
    m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1])
  );

describe('instruction decks (slideStimulusPage)', () => {
  const el = host(slideStimulusPage({ title: 'T', body: '<p>b</p>', exemplar: ['arrow', 'dot'] }));

  it('carries the class hooks the short-window rules use', () => {
    expect(el.querySelector('.slide-text.slide-deck')).not.toBeNull();
    expect(el.querySelector('.slide-deck > .slide-title-row')).not.toBeNull();
    expect(el.querySelector('.slide-deck .slide-body')).not.toBeNull();
    expect(el.querySelector('.slide-deck .slide-circle-row')).not.toBeNull();
    expect(el.querySelector('.slide-deck .slide-spacer')).not.toBeNull();
  });

  it('caps the exemplar circle with --slide-circle-max and keeps its full size otherwise', () => {
    const circle = el.querySelector('.slide-circle');
    const style = circle.getAttribute('style');
    expect(style).toContain('--slide-circle-full: calc(var(--mm) *');
    /* min(full size, cap) with no cap defined (tall windows) = full size. */
    expect(style).toContain('width: min(var(--slide-circle-full), var(--slide-circle-max, 100vh))');
    expect(style).toContain(
      'height: min(var(--slide-circle-full), var(--slide-circle-max, 100vh))'
    );
  });

  it('the arrow keeps 100 px at full size and shrinks with a capped circle', () => {
    const img = el.querySelector('img');
    expect(img.getAttribute('style')).toContain('width: min(100px, 36%)');
    expect(img.getAttribute('style')).toContain('height: min(100px, 36%)');
  });

  it('index.html tightens the decks under 820 px, and the body text under 760 px', () => {
    const tier1 = indexHtml.match(/@media \(max-height: 820px\) \{\s*\.slide-deck \{([^}]*)\}/);
    expect(tier1, 'deck rule under 820 px').not.toBeNull();
    expect(tier1[1]).toMatch(/--slide-circle-max:\s*36vh/);
    expect(indexHtml).toMatch(/\.slide-deck \.slide-body p \{\s*margin: 0\.5rem 0 !important/);
    expect(indexHtml).toMatch(/\.slide-deck \.slide-spacer \{\s*min-height: 0 !important/);
    const tier2 = indexHtml.match(
      /@media \(max-height: 760px\) \{\s*\.slide-deck \.slide-body \{([^}]*)\}/
    );
    expect(tier2, 'deck text rule under 760 px').not.toBeNull();
    expect(tier2[1]).toMatch(/font-size:\s*16px/);
    expect(indexHtml).toMatch(
      /@media \(max-height: 680px\) \{\s*\.slide-deck \{\s*--slide-circle-max:\s*32vh/
    );
    /* Body text never goes under 14 px. */
    const deck = indexHtml.slice(indexHtml.indexOf('.slide-deck {'));
    expect(Math.min(...fontSizesPx(deck.slice(0, 1800)))).toBeGreaterThanOrEqual(14);
  });

  it('the text-only page also gets the title-row hook', () => {
    expect(
      host(slideTextPage({ title: 'T', body: '' })).querySelector('.slide-title-row')
    ).not.toBeNull();
  });
});

describe('demo screen', () => {
  it('the short-window block shrinks the rows but never the circle, and keeps text >= 14 px', () => {
    expect(DEMO_SHORT_WINDOW_CSS).toContain('@media (max-height: 1040px)');
    expect(DEMO_SHORT_WINDOW_CSS).toContain('@media (max-height: 680px)');
    for (const sel of [
      '.demo-caption-box',
      '#demo-watch-banner-row',
      '#demo-buttons-row',
      '.demo-hand',
      '.demo-spacer-above-hint',
    ])
      expect(DEMO_SHORT_WINDOW_CSS).toContain(sel);
    /* The calibrated circle (#demo-mount and its frame) is not resized. */
    expect(DEMO_SHORT_WINDOW_CSS).not.toMatch(
      /#demo-mount[^}]*(width|height|transform|scale|zoom)/
    );
    expect(DEMO_SHORT_WINDOW_CSS).not.toMatch(/\.grid-frame|svg/);
    /* The hands are icons; every text size (banner, buttons) is at least 14 px. */
    const textSizes = DEMO_SHORT_WINDOW_CSS.split('\n')
      .filter((l) => !l.includes('.demo-hand'))
      .join('\n');
    expect(Math.min(...fontSizesPx(textSizes))).toBeGreaterThanOrEqual(14);
  });

  it('the button row reserves its real height, so mounting the buttons does not move the circle', () => {
    expect(DEMO_SHORT_WINDOW_CSS).toMatch(/#demo-buttons-row \{[^}]*min-height: 10rem !important/);
    expect(DEMO_SHORT_WINDOW_CSS).toMatch(
      /#demo-buttons-row \{[^}]*min-height: 9\.4rem !important/
    );
  });

  it('the template inserts the block and the class hooks', () => {
    const stim = dOnlyDemoNode().stimulus;
    expect(stim).toContain(DEMO_SHORT_WINDOW_CSS);
    const el = host(stim);
    expect(el.querySelector('.demo-frame > .slide-title-row')).not.toBeNull();
    expect(el.querySelector('.demo-caption-box #demo-caption')).not.toBeNull();
  });

  it('the "do not press" note is 14.4 px, not 13.6 px', () => {
    const stim = dOnlyDemoNode().stimulus;
    expect(stim).toMatch(/\.demo-no-press-note \{[^}]*font-size:\s*0\.9rem/);
    expect(DEMO_NO_PRESS_NOTE).toContain('Please do not press any keys.');
  });
});

describe('other slides', () => {
  it('the continue hint has class hooks (for the rules that tighten it)', () => {
    const el = host(continueHintHtml('x'));
    expect(el.querySelector('.continue-hint-row > .continue-hint')).not.toBeNull();
  });

  it('the tag-reminder slide is 56 rem wide and tightens under 680 px', () => {
    const el = host(mainATagReminderNode().stimulus);
    expect(el.querySelector('.slide-text.tag-reminder')).not.toBeNull();
    expect(el.querySelector('.tag-reminder-example')).not.toBeNull();
    expect(el.querySelector('.tag-reminder-circle')).not.toBeNull();
    expect(el.querySelectorAll('.tag-reminder-row')).toHaveLength(5);
    expect(indexHtml).toMatch(/@media \(max-height: 680px\) \{\s*\.tag-reminder h2/);
  });

  it('questionnaire forms are widened and tightened on a short window', () => {
    const block = indexHtml.slice(indexHtml.indexOf(':has(#jspsych-survey-html-form)') - 60);
    expect(block).toMatch(/max-width:\s*min\(94vw,\s*62rem\)/);
    expect(block).toMatch(/#jspsych-survey-html-form td \{[^}]*padding-top: 0\.25rem !important/);
    expect(block).toMatch(/#jspsych-survey-html-form select \{[^}]*padding-top: 0\.2rem/);
    expect(block).toMatch(/font-size:\s*16px/);
  });

  it('the sound-check page shrinks its tone boxes on a short window', () => {
    const src = readFileSync('src/calibration/tone-familiarisation.js', 'utf8');
    expect(src).toMatch(/@media \(max-height: 760px\) \{[^}]*\.tac-bank \{ max-width: 27rem/);
    expect(src).toMatch(/@media \(max-height: 680px\) \{[^}]*\.tac-bank \{ max-width: 24rem/);
  });

  it('the screen-calibration slider comes before the card rectangle, so it never drops below the fold', () => {
    const src = readFileSync('src/calibration/screen.js', 'utf8');
    expect(src.indexOf('id="cc-slider"')).toBeGreaterThan(-1);
    expect(src.indexOf('id="cc-slider"')).toBeLessThan(src.indexOf('id="cc-stage"'));
  });
});
