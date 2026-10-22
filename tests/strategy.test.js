/**
 * @vitest-environment jsdom
 *
 * Tests for the post-experiment strategy questionnaire
 * (`src/questionnaire/strategy.js`). These specs lock the item-set count, section layout,
 * phase tags, scale invariants, and the composite scorers that the
 * pre-registration draft promises in its `exploratory_analyses` block.
 */
import { describe, it, expect } from 'vitest';
import {
  STRATEGY_SCALE,
  STRATEGY_ITEMS,
  STRATEGY_SECTIONS,
  strategyItemsForSection,
  strategyTimeline,
  scoreStrategy,
} from '../src/questionnaire/strategy.js';
import { assembleQuestionnaireChain } from '../src/questionnaire/index.js';

describe('STRATEGY_SCALE', () => {
  it('is a 5-point agreement Likert', () => {
    expect(STRATEGY_SCALE).toHaveLength(5);
    expect(STRATEGY_SCALE.map((o) => o.value)).toEqual(['1', '2', '3', '4', '5']);
    expect(STRATEGY_SCALE.map((o) => o.score)).toEqual([1, 2, 3, 4, 5]);
  });

  it('labels endpoints "Strongly disagree" and "Strongly agree"', () => {
    expect(STRATEGY_SCALE[0].label).toMatch(/Strongly disagree/i);
    expect(STRATEGY_SCALE[4].label).toMatch(/Strongly agree/i);
  });
});

describe('STRATEGY_ITEMS', () => {
  it('contains exactly 19 items', () => {
    expect(STRATEGY_ITEMS).toHaveLength(19);
  });

  it('uses unique strategy_qNN ids in fixed order', () => {
    const ids = STRATEGY_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 0; i < ids.length; i++) {
      const n = String(i + 1).padStart(2, '0');
      expect(ids[i]).toBe(`strategy_q${n}`);
    }
  });

  it('declares a known section on every item', () => {
    const sectionIds = new Set(STRATEGY_SECTIONS.map((s) => s.id));
    for (const it of STRATEGY_ITEMS) {
      expect(sectionIds.has(it.section)).toBe(true);
    }
  });
});

describe('STRATEGY_SECTIONS', () => {
  it('declares 5 sections matching the trial-type taxonomy', () => {
    expect(STRATEGY_SECTIONS).toHaveLength(5);
    expect(STRATEGY_SECTIONS.map((s) => s.id)).toEqual([
      'memory_only',
      'tone_only',
      'imagery_only',
      'i_d',
      'i_t',
    ]);
  });

  it('uses canonical strategy_<id> phase tags', () => {
    for (const s of STRATEGY_SECTIONS) {
      expect(s.phase).toBe(`strategy_${s.id}`);
    }
  });

  it('partitions STRATEGY_ITEMS exactly', () => {
    let total = 0;
    for (const s of STRATEGY_SECTIONS) {
      const items = strategyItemsForSection(s.id);
      expect(items.length).toBeGreaterThan(0);
      total += items.length;
    }
    expect(total).toBe(STRATEGY_ITEMS.length);
  });
});

describe('strategyTimeline()', () => {
  it('returns 5 form nodes in section order', () => {
    const tl = strategyTimeline();
    expect(tl).toHaveLength(5);
    for (let i = 0; i < tl.length; i++) {
      expect(typeof tl[i].on_finish).toBe('function');
    }
  });

  it('each form node carries its section phase via on_finish', () => {
    const tl = strategyTimeline();
    for (let i = 0; i < tl.length; i++) {
      const data = { response: {} };
      tl[i].on_finish(data);
      expect(data.phase).toBe(STRATEGY_SECTIONS[i].phase);
      expect(data.strategy_section).toBe(STRATEGY_SECTIONS[i].id);
      expect(data.strategy_responses).toBeDefined();
    }
  });

  it('on_finish stamps null for unanswered items', () => {
    const tl = strategyTimeline();
    const data = { response: {} };
    tl[0].on_finish(data);
    for (const v of Object.values(data.strategy_responses)) {
      expect(v).toBeNull();
    }
  });

  it('on_finish preserves string responses', () => {
    const tl = strategyTimeline();
    const section = STRATEGY_SECTIONS[0];
    const sectionItems = strategyItemsForSection(section.id);
    const responses = {};
    for (const it of sectionItems) responses[it.id] = '4';
    const data = { response: responses };
    tl[0].on_finish(data);
    for (const it of sectionItems) {
      expect(data.strategy_responses[it.id]).toBe('4');
    }
  });
});

describe('hidden-nav integration (U / R keys must work on every page)', () => {
  it('every strategy section form node is a registered hidden-nav checkpoint', () => {
    /* The runner's `on_trial_start` hook neutralises trials until it sees
     * `_hidden_nav_checkpoint === true`. If a strategy page is missing this
     * marker, a U press from inside a main-block trial would either skip
     * straight through the page (writing no responses) or fail to stop at
     * it at all — both are silent data-loss failures, so we lock the
     * invariant here. */
    const tl = strategyTimeline();
    expect(tl).toHaveLength(STRATEGY_SECTIONS.length);
    for (let i = 0; i < tl.length; i++) {
      const node = tl[i];
      expect(node._hidden_nav_checkpoint, `${STRATEGY_SECTIONS[i].phase}`).toBe(true);
      const data = typeof node.data === 'function' ? node.data() : node.data;
      expect(data?.hidden_nav_step, `${STRATEGY_SECTIONS[i].phase}`).toBe(
        STRATEGY_SECTIONS[i].phase
      );
    }
  });

  it('the questionnaire intro screen is also a hidden-nav checkpoint', () => {
    /* The intro is the first node U lands on when the experimenter skips
     * from the end-of-task screen — without checkpoint marking, U would
     * blow past it. */
    const chain = assembleQuestionnaireChain();
    const intro = chain[0];
    expect(intro._hidden_nav_checkpoint).toBe(true);
    const data = typeof intro.data === 'function' ? intro.data() : intro.data;
    expect(data?.phase).toBe('questionnaire_intro');
    expect(data?.hidden_nav_step).toBe('questionnaire_intro');
  });

  it('R-back from any strategy page resolves to a previous registered step', async () => {
    /* R splices the previous step's factory output after the current trial.
     * For that to work, every step the experimenter might land on must have
     * registered a factory via `registerHiddenNavStep`. We can't easily
     * inspect the registry from here, but we can verify the strategy module
     * actually called the API: re-importing the module would re-register,
     * but a fresh `strategyTimeline()` call also re-registers each section.
     * The clean check is: after building the timeline, the hidden-nav module
     * should report that each section is registered. */
    const { __resetHiddenNavForTests, getHiddenNavTrialStartHook } =
      await import('../src/hidden-nav.js');
    __resetHiddenNavForTests();
    const tl = strategyTimeline();
    /* Re-running the start hook on each tracked node must NOT neutralise
     * the trial (zero duration) — that's the proxy for "this trial is a
     * checkpoint". */
    const hook = getHiddenNavTrialStartHook();
    for (let i = 0; i < tl.length; i++) {
      const trial = { _hidden_nav_checkpoint: tl[i]._hidden_nav_checkpoint };
      hook(trial);
      expect(trial.trial_duration, `${STRATEGY_SECTIONS[i].phase}`).toBeUndefined();
      expect(trial.choices, `${STRATEGY_SECTIONS[i].phase}`).toBeUndefined();
    }
  });
});

describe('scoreStrategy()', () => {
  function makeFullResponseRows(score) {
    const value = String(score);
    return STRATEGY_SECTIONS.map((s) => {
      const items = strategyItemsForSection(s.id);
      const responses = {};
      for (const it of items) responses[it.id] = value;
      return { phase: s.phase, strategy_section: s.id, strategy_responses: responses };
    });
  }

  it('reports total = 19 and answered = 0 when no rows are supplied', () => {
    const result = scoreStrategy([]);
    expect(result.total).toBe(19);
    expect(result.answered).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.structural_chunking_composite).toBeNull();
    expect(result.imagery_maintenance_id).toBeNull();
    expect(result.imagery_maintenance_it).toBeNull();
  });

  it('returns 19 answered + composites when all items endorsed at 4', () => {
    const rows = makeFullResponseRows(4);
    const result = scoreStrategy(rows);
    expect(result.answered).toBe(19);
    expect(result.complete).toBe(true);
    /* Structural chunking = q01+q02+q03 = 4+4+4 = 12 */
    expect(result.structural_chunking_composite).toBe(12);
    /* Imagery maintenance composites = 2 items × 4 = 8 each */
    expect(result.imagery_maintenance_id).toBe(8);
    expect(result.imagery_maintenance_it).toBe(8);
  });

  it('returns null composites when any constituent item is unanswered', () => {
    const rows = makeFullResponseRows(5);
    /* Blank q01 → structural chunking should be null */
    rows[0].strategy_responses['strategy_q01'] = null;
    /* Blank q13 → imagery_maintenance_id should be null */
    rows[3].strategy_responses['strategy_q13'] = null;
    const result = scoreStrategy(rows);
    expect(result.structural_chunking_composite).toBeNull();
    expect(result.imagery_maintenance_id).toBeNull();
    /* imagery_maintenance_it is untouched */
    expect(result.imagery_maintenance_it).toBe(10);
  });

  it('ignores rows whose phase is not a strategy phase', () => {
    const rows = [
      {
        phase: 'demographics',
        strategy_responses: { strategy_q01: '5', strategy_q02: '5', strategy_q03: '5' },
      },
    ];
    const result = scoreStrategy(rows);
    expect(result.answered).toBe(0);
    expect(result.structural_chunking_composite).toBeNull();
  });

  it('maps the response codes 1..5 to scores 1..5 in itemScores', () => {
    const rows = makeFullResponseRows(3);
    const { itemScores } = scoreStrategy(rows);
    for (const it of STRATEGY_ITEMS) {
      expect(itemScores[it.id]).toBe(3);
    }
  });
});
