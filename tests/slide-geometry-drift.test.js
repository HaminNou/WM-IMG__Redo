// @vitest-environment jsdom
/**
 * The instruction slides duplicate the frame geometry with literals
 * (slide-layout.js, deliberately: it must not import the runtime frame
 * builder). This guard fails if the literals drift from config / the live
 * frame, so the slides never show a different stimulus size or ring than
 * the task does.
 */
import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { slideStimulusPage } from '../src/visuals/slide-layout.js';
import { createGridFrame } from '../src/visuals/frame.js';
import { addDot } from '../src/visuals/dot.js';
import { addStar } from '../src/visuals/star.js';

function slideSvg(exemplar) {
  const host = document.createElement('div');
  host.innerHTML = slideStimulusPage({ title: 't', body: '<p>b</p>', exemplar });
  return host;
}

describe('slide geometry matches the live frame and config', () => {
  it('uses the same SVG viewBox and ring radius as createGridFrame', () => {
    const live = createGridFrame({ background_shade: 'white' });
    const liveVB = live.svg.getAttribute('viewBox').split(' ').map(Number);
    const liveRing = Number(live.svg.querySelector('.grid-bullseye-ring').getAttribute('r'));
    const host = slideSvg(['dot']);
    const svg = host.querySelector('svg');
    const vb = svg.getAttribute('viewBox').split(' ').map(Number);
    for (let i = 0; i < 4; i++) expect(vb[i]).toBeCloseTo(liveVB[i], 3);
    const rings = [...svg.querySelectorAll('circle')].map((c) => Number(c.getAttribute('r')));
    expect(rings.some((r) => Math.abs(r - liveRing) < 1e-3)).toBe(true);
  });

  it('draws the exemplar dot and star at config size', () => {
    const host = slideSvg(['dot', 'star']);
    const radii = [...host.querySelectorAll('circle')].map((c) => Number(c.getAttribute('r')));
    expect(radii.some((r) => Math.abs(r - config.memory.dot_diameter_mm / 2) < 1e-6)).toBe(true);
    const live = createGridFrame({ background_shade: 'white' });
    const liveStar = addStar(live, 6);
    const extent = (pts) => {
      const ys = pts.split(' ').map((p) => Number(p.split(',')[1]));
      return Math.max(...ys) - Math.min(...ys);
    };
    const slideStar = host.querySelector('polygon');
    expect(slideStar).not.toBeNull();
    expect(extent(slideStar.getAttribute('points'))).toBeCloseTo(
      extent(liveStar.getAttribute('points')),
      3
    );
    /* sanity: live dot radius is config */
    const liveDot = addDot(live, 8);
    expect(Number(liveDot.getAttribute('r'))).toBeCloseTo(config.memory.dot_diameter_mm / 2, 9);
  });
});
