/**
 * @vitest-environment jsdom
 *
 * Instruction slides that describe a DOT memory test must show the probe the
 * participant will see: the centre '?' AND a black dot inside the circle, the
 * same size as the live probe dot. Slides about a TONE test show no dot (the
 * probe is a sound), and the other slides are unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/audio/context.js', () => ({
  unlockAudio: vi.fn(() => Promise.resolve()),
  getAudioContext: () => ({ currentTime: 0, state: 'running' }),
  ensureRunning: async () => {},
}));

import { config } from '../src/config.js';
import { iDInstructionNode, iTInstructionNode } from '../src/instructions/dual.js';
import { dOnlyInstructionNode, tOnlyInstructionNode } from '../src/instructions/memory.js';

const doc = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
const plain = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&rarr;|&larr;/g, ' ')
    .replace(/\s+/g, ' ');

/* What a slide's circle contains, read from the rendered SVG. */
function circleContents(html) {
  const svg = doc(html).querySelector('svg');
  const circles = [...svg.querySelectorAll('circle')].map((c) => ({
    cx: Number(c.getAttribute('cx')),
    cy: Number(c.getAttribute('cy')),
    r: Number(c.getAttribute('r')),
    fill: c.getAttribute('fill'),
    stroke: c.getAttribute('stroke'),
  }));
  const ring = circles.find((c) => c.fill === 'none');
  const centreDot = circles.find((c) => c.r === 0.65);
  const probeDots = circles.filter(
    (c) => c.fill === '#000' && c.r === config.memory.dot_diameter_mm / 2
  );
  return { ring, centreDot, probeDots, qmark: svg.querySelectorAll('path').length };
}

const page = (node, includes) => {
  const hit = node.pages.filter((p) => plain(p).includes(includes));
  expect(hit, `exactly one page containing "${includes}"`).toHaveLength(1);
  return hit[0];
};

describe('dot-test slides show the probe dot together with the question mark', () => {
  const d = dOnlyInstructionNode();
  const slides = {
    'Task 1, the test slide': page(d, 'we test your memory'),
    'Task 1, the feedback slide': page(d, 'You have 3 seconds for each test'),
    'dots + imagery, the dot-test slide': page(iDInstructionNode(), 'we test your dot memory'),
  };

  for (const [name, html] of Object.entries(slides)) {
    describe(name, () => {
      const c = circleContents(html);

      it('shows exactly one black probe dot, the size of the live probe dot', () => {
        expect(c.probeDots).toHaveLength(1);
        expect(c.probeDots[0].r * 2).toBe(config.memory.dot_diameter_mm);
      });

      it("keeps the centre question mark and the bull's-eye dot", () => {
        expect(c.qmark).toBe(1);
        expect(c.centreDot).toBeTruthy();
        expect(c.ring).toBeTruthy();
      });

      it('puts the probe dot inside the circle, in a non-centre cell, clear of the question mark', () => {
        const mid = c.ring.cx;
        const dot = c.probeDots[0];
        const dist = Math.hypot(dot.cx - mid, dot.cy - mid);
        const cell = Math.floor(dot.cy / 10) * 5 + Math.floor(dot.cx / 10);
        expect(cell).not.toBe(config.grid.centre_cell_index);
        expect(dot.cx).toBeGreaterThan(0);
        expect(dot.cx).toBeLessThan(50);
        expect(dot.cy).toBeGreaterThan(0);
        expect(dot.cy).toBeLessThan(50);
        expect(dist + dot.r).toBeLessThan(c.ring.r);
        /* nearest stimulus edge stays >= 7.5 mm from the centre, as in a live trial */
        expect(dist - dot.r).toBeGreaterThanOrEqual(7.5);
      });
    });
  }
});

describe('slides about a tone test show no probe dot', () => {
  const toneSlides = {
    'Task 2, the tone-test slide': page(tOnlyInstructionNode(), 'Then we play'),
    'tones + imagery, the tone-test slide': page(iTInstructionNode(), 'we test your tone memory'),
  };
  for (const [name, html] of Object.entries(toneSlides)) {
    it(`${name}: question mark only`, () => {
      const c = circleContents(html);
      expect(c.qmark).toBe(1);
      expect(c.probeDots).toHaveLength(0);
    });
  }
});

describe('the other Task 1 slides are unchanged', () => {
  it('has three pages; the first shows a dot and no question mark', () => {
    const d = dOnlyInstructionNode();
    expect(d.pages).toHaveLength(3);
    const first = circleContents(d.pages[0]);
    expect(first.probeDots).toHaveLength(1);
    expect(first.qmark).toBe(0);
  });
});
