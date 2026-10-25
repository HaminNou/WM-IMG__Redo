/**
 * @vitest-environment jsdom
 *
 * Participant-facing instruction text must be TRUE to what the program does.
 * Each test ties a sentence participants read to code or config, so the text
 * cannot drift (the original decks said the pattern "will not be shown during
 * the trials" although reminder screens appear, and rest screens said "will
 * resume automatically" although a key press follows).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

vi.mock('../src/audio/context.js', () => ({
  unlockAudio: vi.fn(() => Promise.resolve()),
  getAudioContext: () => ({ currentTime: 0, state: 'running' }),
  ensureRunning: async () => {},
}));

import { config } from '../src/config.js';
import { iDInstructionNode, iTInstructionNode } from '../src/instructions/dual.js';
import { iOnlyInstructionNode } from '../src/instructions/imagery.js';
import { dOnlyInstructionNode, tOnlyInstructionNode } from '../src/instructions/memory.js';
import { practiceReadinessNode, instructionsOverview } from '../src/instructions/index.js';
import { mainAIntroNode, mainBIntroNode } from '../src/runner-intros.js';
import { restNode, intraBlockRestNode, resumeAfterRestGateNode } from '../src/conditions/rest.js';
import { trialStartGateNode } from '../src/conditions/shared.js';
import {
  ARROW_MEANING_TEXT,
  ARROW_MEANING_HTML,
  PATTERN_REMINDER_SECONDS,
} from '../src/instructions/shared-copy.js';
import {
  FEEDBACK_GREEN,
  FEEDBACK_RED,
  FEEDBACK_WORD_CHIP,
} from '../src/instructions/feedback-words.js';
import { FEEDBACK_COLOR_CORRECT, FEEDBACK_COLOR_WRONG } from '../src/conditions/shared.js';
import { slideStimulusPage } from '../src/visuals/slide-layout.js';
import { BACKGROUND_FILLS } from '../src/visuals/colour-palette.js';

const plain = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&rarr;|&larr;/g, ' ')
    .replace(/\s+/g, ' ');
const deckText = (node) => node.pages.map(plain).join(' ');
const IMAGERY_DECKS = {
  i_only: () => iOnlyInstructionNode(),
  i_d: () => iDInstructionNode(),
  i_t: () => iTInstructionNode(),
};

/* WCAG relative luminance / contrast ratio from sRGB hex or rgba over a hex backdrop. */
function lum([r, g, b]) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (rgb, alpha, backdrop) => rgb.map((c, i) => c * alpha + backdrop[i] * (1 - alpha));

describe('the pattern reminder is described truthfully (finding F3)', () => {
  it('no instruction file says the pattern will not be shown during the trials', () => {
    for (const f of readdirSync('src/instructions').filter((n) => n.endsWith('.js'))) {
      const src = readFileSync(`src/instructions/${f}`, 'utf8');
      expect(src, f).not.toMatch(/not<\/strong> be shown during the\s+trials/i);
      expect(src, f).not.toMatch(/will not be shown during the trials/i);
    }
  });

  it('the imagery deck says when the reminder appears and how long it stays, from config', () => {
    expect(PATTERN_REMINDER_SECONDS).toBe(config.pattern.pattern_phase_duration_ms / 1000);
    const t = deckText(iOnlyInstructionNode());
    expect(t).toContain('sometimes appear again');
    expect(t).toContain(`${PATTERN_REMINDER_SECONDS} seconds`);
    expect(t).toContain('before the arrow');
    expect(t).toContain('never shown during the rest of the trial');
  });

  it('the program really does show the reminder before the arrow, on its own screen', () => {
    const block = readFileSync('src/scheduler/block.js', 'utf8');
    expect(block).toMatch(/sees the pattern reminder → sees the rotation arrow/);
    expect(config.pattern.pattern_phase_duration_ms).toBe(4000);
  });
});

describe('every imagery deck explains the arrow, including 0 degrees', () => {
  for (const [name, make] of Object.entries(IMAGERY_DECKS)) {
    it(`${name}: straight up = no turn, right = clockwise, left = counterclockwise, quarter turn at most`, () => {
      const t = deckText(make());
      expect(t).toContain("if it points straight up, don't turn the pattern at all");
      expect(t).toContain('clockwise');
      expect(t).toContain('counterclockwise');
      expect(t).toContain('quarter turn');
      expect(t).toContain('to the right');
      expect(t).toContain('to the left');
    });
  }

  it('the narration says the same thing as the on-screen words', () => {
    expect(plain(ARROW_MEANING_HTML).replace(/\s+([;,.:])/g, '$1')).toBe(ARROW_MEANING_TEXT);
  });

  it('matches the program: angles span -90..+90 (a quarter turn each way) and 0 is allowed', () => {
    expect(config.grid.rotation_min_deg).toBe(-90);
    expect(config.grid.rotation_max_deg).toBe(90);
    const rb = readFileSync('src/scheduler/rotation-balance.js', 'utf8');
    expect(rb).toMatch(/0\.\.30|\[0, 30\]|0, 30/);
  });
});

describe('the two-key trial start is explained', () => {
  const GATE_WINDOW = /BOTH_KEYS_WINDOW_MS = 300/;

  it('the on-screen hint says both keys at the same time', () => {
    const node = trialStartGateNode({ trial_index_in_block: 0, phase: 'd_only_trial_start' });
    document.body.innerHTML = node.stimulus;
    node.on_load();
    const hint = document.querySelector('.trial-start-hint');
    expect(hint?.textContent).toBe(
      'Press the Left and Right arrow keys at the same time to start the next trial.'
    );
    node.on_finish?.();
  });

  it('the practice-readiness page and the main intro both say at the same time', () => {
    expect(plain(practiceReadinessNode().stimulus)).toContain(
      'press the Left and Right arrow keys at the same time'
    );
    expect(plain(mainAIntroNode().stimulus)).toContain(
      'press the Left and Right arrow keys at the same time'
    );
  });

  it('the gate really requires both keys together within 300 ms (the claim the text relies on)', () => {
    expect(readFileSync('src/conditions/shared.js', 'utf8')).toMatch(GATE_WINDOW);
  });
});

describe('rest screens say what actually happens next', () => {
  it('nothing in the rest copy says "automatically"', () => {
    const inter = restNode().stimulus;
    const intra = intraBlockRestNode().stimulus;
    expect(plain(inter)).not.toMatch(/automatically/i);
    expect(plain(intra)).not.toMatch(/automatically/i);
  });

  it('inter-block: the timer ends, then the Block 2 intro waits for Space', () => {
    expect(plain(restNode().stimulus)).toContain('you will press Space to start the next block');
    expect(mainBIntroNode().choices).toEqual([' ']);
    expect(restNode().choices).toBe('NO_KEYS');
    expect(restNode().trial_duration).toBe(config.blocks.rest_duration_s * 1000);
  });

  it('intra-block: the length comes from config and a two-key resume gate follows', () => {
    const n = intraBlockRestNode();
    const t = plain(n.stimulus);
    expect(t).toContain(`${config.blocks.rest_duration_s}-second rest`);
    expect(t).toContain('press both arrow keys to continue');
    expect(n.trial_duration).toBe(config.blocks.rest_duration_s * 1000);
    expect(plain(resumeAfterRestGateNode().stimulus)).toMatch(
      /Press both Left.*and Right.*arrow keys/
    );
  });
});

describe('numbers in the text equal config-derived values', () => {
  it('practice criterion %, practice length, imagination 5 seconds, 3 seconds, rest and trial counts', () => {
    const crit = Math.round(config.practice.accuracy_criterion * 100);
    expect(crit).toBe(70);
    const ready = plain(practiceReadinessNode().stimulus);
    expect(ready).toContain(`${crit}%`);
    const overview = plain(instructionsOverview().stimulus);
    expect(overview).toContain(`${crit}%`);
    expect(overview).toContain(`${config.blocks.practice_trials_per_type * 5} trials in total`);
    const { imagination_duration_ms, rotation_animation_ms, post_rotation_delay_ms } =
      config.imagery;
    expect(imagination_duration_ms + rotation_animation_ms + post_rotation_delay_ms).toBe(5000);
    for (const make of Object.values(IMAGERY_DECKS))
      expect(deckText(make())).toContain('5 seconds');
    expect(config.imagery.star_duration_ms).toBe(3000);
    const a = plain(mainAIntroNode().stimulus);
    expect(a).toContain('two blocks of 60 trials');
    expect(a).toContain(`${config.blocks.rest_duration_s}-second rest`);
    expect((5 * config.blocks.main_trials_per_type) / config.blocks.main_block_count).toBe(60);
    expect(5 * config.blocks.main_trials_per_type).toBe(120);
  });

  it('the imagination period text does not fold the arrow into the 5 seconds', () => {
    for (const make of Object.values(IMAGERY_DECKS)) {
      expect(deckText(make())).toMatch(
        /After the arrow goes away you'll have\s+(about\s+)?5 seconds/
      );
    }
  });
});

describe('feedback colour words are legible (finding F13)', () => {
  it('"green" and "red" use the live feedback hex on a near-black chip, at least 4.5:1', () => {
    expect(FEEDBACK_GREEN).toContain(FEEDBACK_COLOR_CORRECT);
    expect(FEEDBACK_RED).toContain(FEEDBACK_COLOR_WRONG);
    expect(ratio(hex(FEEDBACK_COLOR_CORRECT), hex(FEEDBACK_WORD_CHIP))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(FEEDBACK_COLOR_WRONG), hex(FEEDBACK_WORD_CHIP))).toBeGreaterThanOrEqual(4.5);
  });

  it('every deck that talks about feedback uses the shared chip words and says what each colour means', () => {
    for (const node of [
      dOnlyInstructionNode(),
      tOnlyInstructionNode(),
      iOnlyInstructionNode(),
      iDInstructionNode(),
      iTInstructionNode(),
    ]) {
      const html = node.pages.join(' ');
      expect(html).toContain(FEEDBACK_GREEN);
      expect(html).toContain(FEEDBACK_RED);
      expect(plain(html)).toMatch(
        /green for correct or\s+red for incorrect|green for correct or red for incorrect/
      );
    }
  });
});

describe('the deck pattern exemplar can be seen (finding F13)', () => {
  const host = () => {
    const el = document.createElement('div');
    el.innerHTML = slideStimulusPage({ title: 't', body: '<p>b</p>', exemplar: ['pattern'] });
    return el;
  };

  it('uses the live gray-trial look (solid white, opacity 1) plus a dark silhouette outline', () => {
    const fills = [...host().querySelectorAll('rect.slide-pattern-fill')];
    expect(fills).toHaveLength(config.pattern.gray_pattern_cells.length);
    for (const r of fills) {
      expect(r.getAttribute('fill')).toBe('#FFFFFF');
      expect(Number(r.getAttribute('opacity'))).toBe(1);
    }
    expect(host().querySelectorAll('rect.slide-pattern-outline')).toHaveLength(fills.length);
  });

  it('the outline against the gray card is at least 3:1, and was ~1.1:1 before (0.33 white)', () => {
    const card = hex(BACKGROUND_FILLS.gray);
    const outline = host().querySelector('rect.slide-pattern-outline');
    const m = outline.getAttribute('stroke').match(/rgba\(0, 0, 0, ([0-9.]+)\)/);
    const rendered = over([0, 0, 0], Number(m[1]), card);
    expect(ratio(rendered, card)).toBeGreaterThanOrEqual(3);
    const oldLook = over([255, 255, 255], 0.33, card);
    expect(ratio(oldLook, card)).toBeLessThan(1.2);
  });

  it("the bull's-eye dot stays visible on top of the pattern (drawn after it)", () => {
    const svg = host().querySelector('svg');
    const all = [...svg.querySelectorAll('*')];
    const dot = svg.querySelector('circle[r="0.65"]');
    expect(dot).not.toBeNull();
    const lastFill = [...svg.querySelectorAll('rect.slide-pattern-fill')].pop();
    expect(all.indexOf(dot)).toBeGreaterThan(all.indexOf(lastFill));
  });

  it('the exemplar arrow has the same centre hole as the live arrow', () => {
    const html = slideStimulusPage({ title: 't', body: '<p>b</p>', exemplar: ['arrow'] });
    expect(html).toContain('mask-image');
  });
});
