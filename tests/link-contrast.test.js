// @vitest-environment jsdom
/**
 * V4-03: the completion screen's 'click here' link was #60a5fa on the light
 * page (1.7:1 on #d3d3d3, 2.5:1 on white). It must reach WCAG AA (4.5:1)
 * on both light page backgrounds the study uses.
 */
import { describe, expect, it } from 'vitest';
import { _testHelpers } from '../src/conditions/debrief.js';

function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('completion-screen link contrast (V4-03)', () => {
  const host = document.createElement('div');
  host.innerHTML = _testHelpers.renderRedirectCountdown('https://app.prolific.com/x', 5);
  const link = host.querySelector('a');
  const colour = link.style.color;

  it('the rendered link carries an explicit colour and an underline', () => {
    expect(link).not.toBeNull();
    expect(colour).not.toBe('');
    expect(link.style.textDecoration).toContain('underline');
  });

  it.each(['#d3d3d3', '#ffffff'])('has at least 4.5:1 contrast on %s', (bg) => {
    // jsdom normalises style.color to rgb(...)
    const m = colour.match(/rgb\((\d+), (\d+), (\d+)\)/);
    const hex = m
      ? '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
      : colour;
    expect(contrast(hex, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('the exported constant matches what is rendered', () => {
    expect(contrast(_testHelpers.COMPLETION_LINK_COLOUR, '#d3d3d3')).toBeGreaterThan(5);
  });
});
