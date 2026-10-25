/**
 * @vitest-environment jsdom
 *
 * The instruction decks, intros and attention checks state task facts in
 * prose ("5 seconds", "3 seconds", "60 trials", "after trials 20 and 40").
 * These tests tie those claims to config so the text cannot drift from
 * what the code does, and check that the I+D and I+T decks stay parallel.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../src/audio/context.js', () => ({
  unlockAudio: vi.fn(() => Promise.resolve()),
}));

import { config } from '../src/config.js';
import { iDInstructionNode, iTInstructionNode } from '../src/instructions/dual.js';
import { iOnlyInstructionNode } from '../src/instructions/imagery.js';
import { dOnlyInstructionNode, tOnlyInstructionNode } from '../src/instructions/memory.js';
import { ATTENTION_CHECK_ITEMS } from '../src/instructions/attention-checks.js';
import { mainAIntroNode, mainBIntroNode } from '../src/runner-intros.js';

const text = (node) =>
  node.pages
    .map((p) => p.replace(/<[^>]+>/g, ' '))
    .join(' ')
    .replace(/\s+/g, ' ');

describe('instruction prose matches config', () => {
  it('"5 seconds to imagine and turn" equals imagination + rotation + post-rotation delay', () => {
    const { imagination_duration_ms, rotation_animation_ms, post_rotation_delay_ms } =
      config.imagery;
    expect(imagination_duration_ms + rotation_animation_ms + post_rotation_delay_ms).toBe(5000);
    for (const node of [iOnlyInstructionNode(), iDInstructionNode(), iTInstructionNode()]) {
      expect(text(node)).toContain('5 seconds');
    }
  });

  it('"3 seconds" per star / test equals the star duration and the probe response window', () => {
    expect(config.imagery.star_duration_ms).toBe(3000);
    expect(config.probes.response_window_ms).toBe(3000);
    for (const node of [
      dOnlyInstructionNode(),
      tOnlyInstructionNode(),
      iOnlyInstructionNode(),
      iDInstructionNode(),
      iTInstructionNode(),
    ]) {
      expect(text(node)).toContain('3 seconds');
    }
  });

  it('main-task intro: two blocks of 60 trials, rests after trials 20 and 40, config rest length', () => {
    const trialsPerBlock =
      (5 * config.blocks.main_trials_per_type) / config.blocks.main_block_count;
    expect(trialsPerBlock).toBe(60);
    const a = mainAIntroNode()
      .stimulus.replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    const b = mainBIntroNode()
      .stimulus.replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    expect(a).toContain(`two blocks of ${trialsPerBlock} trials`);
    expect(a).toContain('after trials 20 and 40');
    expect(a).toContain(`${config.blocks.rest_duration_s}-second rest`);
    expect(b).toContain(`${trialsPerBlock} more trials`);
    expect(b).toContain('after trials 20 and 40');
    const scheduler = readFileSync('src/scheduler/main-blocks.js', 'utf8');
    expect(scheduler).toContain('REST_AFTER_WITHIN_BLOCK_TRIALS = Object.freeze([20, 40])');
  });
});

describe('I+D and I+T decks are parallel', () => {
  const idText = text(iDInstructionNode());
  const itText = text(iTInstructionNode());

  it('have the same number of pages', () => {
    expect(iDInstructionNode().pages.length).toBe(iTInstructionNode().pages.length);
  });

  it('state the same rules: arrow cue, 6 events, 3 stars, key mapping, hold-until-question-mark', () => {
    for (const t of [idText, itText]) {
      expect(t).toContain('arrow');
      expect(t).toContain('6 things');
      expect(t).toContain('3 stars');
      expect(t).toContain('On-pattern');
      expect(t).toContain('Not on-pattern');
      expect(t).toContain('RIGHT arrow');
      expect(t).toContain('LEFT arrow');
      expect(t).toContain('3 times');
      expect(t).toContain('VERY important');
      expect(t).toContain('question mark');
    }
  });

  it("differ only in the memory modality: each deck mentions its own, never the other's", () => {
    expect(idText).toMatch(/\bdots?\b/);
    expect(idText).not.toMatch(/\btones?\b/);
    expect(itText).toMatch(/\btones?\b/);
    expect(itText).not.toMatch(/\bdots?\b/);
  });
});

describe('attention checks', () => {
  it('the arrow-mapping check describes the real mapping (right = Yes / On-pattern)', () => {
    const ac3 = ATTENTION_CHECK_ITEMS.find((i) => i.id === 'ac3_arrow_mapping');
    expect(ac3.prompt).toContain('right-arrow key means');
    expect(ac3.prompt).toContain('Yes');
    expect(ac3.prompt).toContain('On-pattern');
    expect(ac3.prompt).not.toMatch(/points/i);
    expect(ac3.expected_answer).toBe('right');
  });
});
