// @vitest-environment jsdom
/**
 * The one-time slide before Block 1's first trial: look at the trial-type tag above the circle
 * before every trial. It uses the live tags (same labels, colours and look), says what comes
 * next in the vocabulary of the instruction slides, and is the last screen before the first gate.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mainAIntroNode, mainATagReminderNode, mainBIntroNode } from '../src/runner-intros.js';
import {
  TRIAL_TYPE_LABELS,
  TRIAL_TYPE_TAG_PILL_STYLE,
  trialTypeTagHtml,
} from '../src/conditions/shared.js';
import { TRIAL_TYPE_TAG_COLOURS } from '../src/conditions/trial-counter.js';
import { dOnlyInstructionNode, tOnlyInstructionNode } from '../src/instructions/memory.js';
import { iOnlyInstructionNode } from '../src/instructions/imagery.js';
import { trialStartGateNode } from '../src/conditions/shared.js';
import { getHiddenNavTrialStartHook, __resetHiddenNavForTests } from '../src/hidden-nav.js';

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('main_a_tag_reminder slide', () => {
  const node = mainATagReminderNode();
  const dom = () => {
    document.body.innerHTML = node.stimulus;
    return document.body;
  };

  it('is a Space-only screen with its own phase, registered as a hidden-nav checkpoint', () => {
    expect(node.choices).toEqual([' ']);
    expect(node.data.phase).toBe('main_a_tag_reminder');
    expect(node.data.hidden_nav_step).toBe('main_a_tag_reminder');
    expect(node._hidden_nav_checkpoint).toBe(true);
  });

  it('names all five tags, rendered from the shared label and colour tables', () => {
    const body = dom();
    const tags = [...body.querySelectorAll('.trial-type-label')];
    /* One example above the circle, then one per trial type. */
    const labels = tags.map((t) => t.textContent.trim());
    for (const label of Object.values(TRIAL_TYPE_LABELS)) expect(labels).toContain(label);
    expect(Object.keys(TRIAL_TYPE_LABELS)).toHaveLength(5);
    for (const [type, label] of Object.entries(TRIAL_TYPE_LABELS)) {
      const tag = tags.find((t) => t.textContent.trim() === label);
      expect(tag.innerHTML).toBe(
        new DOMParser()
          .parseFromString(trialTypeTagHtml(type), 'text/html')
          .querySelector('.trial-type-label').innerHTML
      );
      expect(tag.innerHTML).toContain(`background: ${TRIAL_TYPE_TAG_COLOURS[type]}`);
      for (const part of TRIAL_TYPE_TAG_PILL_STYLE)
        expect(tag.getAttribute('style')).toContain(part);
    }
  });

  it('the live tag in the trial-start gate uses the same pill style', () => {
    const gate = trialStartGateNode({ trial_index_in_block: 0, trialType: 'i_d' });
    document.body.innerHTML = gate.stimulus;
    gate.on_load();
    const live = document.querySelector('.trial-type-label');
    for (const part of TRIAL_TYPE_TAG_PILL_STYLE)
      expect(live.getAttribute('style')).toContain(part);
    expect(live.getAttribute('style')).toContain('position: fixed');
    gate.on_finish?.();
  });

  it('says what the tag is for and what comes next, in the words of the instruction slides', () => {
    const t = text(node.stimulus);
    expect(t).toContain(
      'Before every trial starts, look at the small tag at the top of the circle'
    );
    expect(t).toContain('which kind of task the upcoming trial is');
    expect(t).toContain('so you know what to expect');
    const deck = (n) => n().pages.join(' ').toLowerCase();
    expect(deck(dOnlyInstructionNode)).toContain('remember');
    expect(deck(tOnlyInstructionNode)).toContain('tones');
    expect(deck(iOnlyInstructionNode)).toContain('pattern');
    expect(t).toMatch(/Dots[^.]*remember the dots/);
    expect(t).toMatch(/Tones[^.]*remember the tones/);
    expect(t).toMatch(/Stars[^.]*picture the pattern[^.]*star/);
    expect(t).toMatch(/Stars \+ Dots[^.]*star[^.]*remember the dots/);
    expect(t).toMatch(/Stars \+ Tones[^.]*star[^.]*remember the tones/);
  });

  it('says the order of the trials is random, so the tag has to be checked before each trial', () => {
    const t = text(node.stimulus);
    expect(t).toContain('mixed in a random order');
    expect(t).toContain('you cannot know in advance which one comes next');
    expect(t).toContain('check the tag before you start each trial');
    /* No stronger claim than "random order" (the scheduler also limits runs of one type). */
    expect(t).not.toMatch(/never more than|at most twice|equally often/i);
  });

  it('keeps every tag description on one line, in an aligned column of pills', () => {
    const body = dom();
    const rows = [...body.querySelectorAll('.tag-reminder-row')];
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const meaning = row.querySelector('.tag-reminder-meaning');
      expect(meaning.getAttribute('style')).toContain('white-space: nowrap');
      /* The pill sits in a fixed-width, left-aligned cell, so all five start at one x. */
      const cell = row.firstElementChild;
      expect(cell.getAttribute('style')).toContain('flex: 0 0 10.5rem');
      expect(cell.getAttribute('style')).toContain('text-align: left');
    }
    /* Wide enough column (the one-line rows are measured in a real browser, see
     * tests/short-window-fit.test.js for what is pinned here). */
    const wrapper = body.querySelector('.tag-reminder');
    expect(wrapper.classList.contains('slide-text')).toBe(true);
    expect(wrapper.getAttribute('style')).toMatch(/max-width:\s*56rem/);
    /* Shortest wording that keeps them accurate: all five lines are short. */
    for (const row of rows)
      expect(row.querySelector('.tag-reminder-meaning').textContent.length).toBeLessThan(80);
  });

  it('ends with the standard continue hint', () => {
    dom();
    const hint = document.body.textContent;
    /* Not 'begin Block 1': the narrated screen before this one already says that. */
    expect(hint).toContain('Press Space to start the first trial.');
    expect(hint).not.toContain('begin Block 1');
  });

  it('is not narrated, so verify-voiceover has nothing to find for it', () => {
    expect(node.stimulus).not.toContain('data-voiceover-target');
  });

  it('the screens around it keep their narrated text (the previous screen is untouched)', () => {
    const intro = text(mainAIntroNode().stimulus);
    expect(intro).toContain('Press Space to begin Block 1.');
    expect(intro).toContain('look at the label shown above the circle');
    expect(mainBIntroNode().data.phase).toBe('main_b_intro');
  });

  it('is neutralised like any checkpoint-free trial: as a checkpoint it ends the skip instead', () => {
    __resetHiddenNavForTests();
    const hook = getHiddenNavTrialStartHook();
    const trial = { _hidden_nav_checkpoint: true, trial_duration: null, choices: [' '] };
    hook(trial);
    expect(trial.choices).toEqual([' ']);
  });
});

describe('position in the timeline', () => {
  const source = readFileSync('src/runner.js', 'utf-8');
  const at = (needle) => {
    const i = source.indexOf(needle, source.indexOf('const timeline = ['));
    expect(i, needle).toBeGreaterThan(-1);
    return i;
  };

  it('comes right after the practice-to-main intro and before the first Block 1 trial gate', () => {
    expect(at('mainAIntroNode()')).toBeLessThan(at('mainATagReminderNode()'));
    expect(at('mainATagReminderNode()')).toBeLessThan(at('...mainPair.mainA.nodes'));
    const between = source.slice(
      at('mainAIntroNode()') + 'mainAIntroNode()'.length,
      at('...mainPair.mainA.nodes')
    );
    expect(between.match(/Node\(/g)).toHaveLength(1);
  });

  it('is in the timeline once, and not before Block 2', () => {
    expect(source.match(/mainATagReminderNode\(\)/g)).toHaveLength(1);
    expect(at('mainATagReminderNode()')).toBeLessThan(at('mainBIntroNode()'));
  });
});
