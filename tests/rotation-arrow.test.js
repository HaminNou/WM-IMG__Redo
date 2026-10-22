/**
 * Tests for src/visuals/rotation-arrow.js — pure HTML-string generation.
 *
 * The module renders the `arrow.png` asset (`public/assets/rotation-arrow.png`)
 * and rotates it via CSS `transform`. Per the design, the **rotation
 * angle is not written into the cue copy** — the rotated arrow is the
 * only cue. These tests pin those two invariants (PNG asset + no angle
 * text) so a regression of either one fails loudly.
 */
import { describe, it, expect } from 'vitest';
import { rotationArrowImg, rotationCueStimulus } from '../src/visuals/rotation-arrow.js';
import { config } from '../src/config.js';

const ANGLES = [config.grid.rotation_min_deg, -37, 0, 42, config.grid.rotation_max_deg];
/* The source resolves the URL against Vite's `base` so the build works
 * under any subpath. Compute the test
 * expectation the same way so the pin survives changes to `base`. */
const ASSET_URL = `${import.meta.env.BASE_URL}assets/rotation-arrow.png`;

describe('rotationArrowImg: PNG asset + CSS rotation', () => {
  it('emits exactly one <img> tag for every configured angle', () => {
    for (const angle of ANGLES) {
      const out = rotationArrowImg(angle);
      const opens = out.match(/<img\b/g) ?? [];
      expect(opens).toHaveLength(1);
    }
  });

  it('points at the bundled reference arrow PNG', () => {
    const out = rotationArrowImg(45);
    expect(out).toContain(`src="${ASSET_URL}"`);
  });

  it('applies CSS rotate(angle) for every configured angle', () => {
    for (const angle of ANGLES) {
      const out = rotationArrowImg(angle);
      expect(out).toContain(`rotate(${angle}deg)`);
    }
  });

  it('uses the default size from config when no override is given', () => {
    const px = config.imagery.rotation_arrow_size_px;
    const out = rotationArrowImg(45);
    expect(out).toContain(`width="${px}"`);
    expect(out).toContain(`height="${px}"`);
  });

  it('respects an explicit size override', () => {
    const out = rotationArrowImg(45, { size: 200 });
    expect(out).toContain('width="200"');
    expect(out).toContain('height="200"');
  });

  it('carries an accessible alt text', () => {
    const out = rotationArrowImg(45);
    expect(out).toMatch(/alt="[^"]+"/);
  });
});

describe('rotationCueStimulus: no angle text in the copy', () => {
  it('embeds the rotated arrow image', () => {
    const out = rotationCueStimulus(45);
    expect(out).toContain('<img');
    expect(out).toContain(`src="${ASSET_URL}"`);
    expect(out).toContain('rotate(45deg)');
  });

  /* Design: the angle is never surfaced in text, even though the implementation now samples
   * any integer angle between -90 and +90. */
  it.each(ANGLES)('renders angle %i without writing the degree value as text', (angle) => {
    const out = rotationCueStimulus(angle);
    /* No "Rotate ..." caption. The CSS transform string `rotate(Ndeg)` is
     * allowed (it sits inside style="..."), but a free-floating "N°" or
     * "N degrees" is not. */
    expect(out).not.toMatch(/Rotate\s/);
    expect(out).not.toMatch(/\d+\s*°/);
    /* `Math.abs(angle)\s*degrees?` would catch "45 degrees" copy too. */
    if (angle !== 0) {
      const re = new RegExp(`${Math.abs(angle)}\\s*degrees?`, 'i');
      expect(out).not.toMatch(re);
    }
  });
});
