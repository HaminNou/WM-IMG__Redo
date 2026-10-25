/**
 * @vitest-environment jsdom
 *
 * Tests for the typed-instruction attention checks.
 *
 * Three layers:
 *   1. `normaliseAttentionAnswer` — pure string transform.
 *   2. `evaluateAttentionChecks` — pure aggregation across data rows.
 *   3. `typedAttentionCheckNode` and the three locked items — node shape
 *      verification (we don't run jsPsych in the test, just check the node
 *      object exposes what the runner expects).
 *
 * jsdom is required because the instruction modules import jsPsych plugins
 * (`@jspsych/plugin-html-keyboard-response`) which touch `window` at module
 * load.
 */
import { describe, it, expect } from 'vitest';
import {
  ATTENTION_CHECK_ITEMS,
  normaliseAttentionAnswer,
  typedAttentionCheckNode,
  evaluateAttentionChecks,
  attentionCheckSummaryNode,
} from '../src/instructions/attention-checks.js';
import { config } from '../src/config.js';

describe('ATTENTION_CHECK_ITEMS', () => {
  it('contains exactly the locked count from config', () => {
    expect(ATTENTION_CHECK_ITEMS).toHaveLength(config.attention_checks.instruction_typed_count);
  });

  it('every item has id, prompt, and expected_answer', () => {
    for (const item of ATTENTION_CHECK_ITEMS) {
      expect(item.id).toMatch(/^ac\d_/);
      expect(typeof item.prompt).toBe('string');
      expect(item.prompt.length).toBeGreaterThan(10);
      expect(typeof item.expected_answer).toBe('string');
      expect(item.expected_answer.length).toBeGreaterThan(0);
    }
  });

  it('item ids are unique', () => {
    const ids = ATTENTION_CHECK_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is frozen – items cannot be mutated post-load', () => {
    expect(Object.isFrozen(ATTENTION_CHECK_ITEMS)).toBe(true);
    expect(Object.isFrozen(ATTENTION_CHECK_ITEMS[0])).toBe(true);
  });
});

describe('normaliseAttentionAnswer', () => {
  it('lowercases and trims whitespace', () => {
    expect(normaliseAttentionAnswer('  Paper  ')).toBe('paper');
    expect(normaliseAttentionAnswer('THIRD')).toBe('third');
  });

  it('returns empty string for non-string inputs', () => {
    expect(normaliseAttentionAnswer(null)).toBe('');
    expect(normaliseAttentionAnswer(undefined)).toBe('');
    expect(normaliseAttentionAnswer(42)).toBe('');
  });

  it('does NOT strip punctuation – sloppy answers fail', () => {
    /* Per the design intent in attention-checks.js: punctuation indicates
     * low-effort responding and should fail. */
    expect(normaliseAttentionAnswer('paper.')).toBe('paper.');
    expect(normaliseAttentionAnswer('paper!')).toBe('paper!');
  });

  it('preserves internal whitespace (only trim)', () => {
    expect(normaliseAttentionAnswer('  some thing  ')).toBe('some thing');
  });
});

describe('typedAttentionCheckNode', () => {
  it('produces a survey-html-form node tagged phase=attention_check', () => {
    const node = typedAttentionCheckNode(ATTENTION_CHECK_ITEMS[0]);
    expect(node.type).toBeDefined();
    expect(node.data.phase).toBe('attention_check');
    expect(typeof node.on_finish).toBe('function');
  });

  it('throws on missing fields', () => {
    expect(() => typedAttentionCheckNode({})).toThrow(/expected_answer/);
    expect(() => typedAttentionCheckNode(null)).toThrow();
    expect(() => typedAttentionCheckNode({ id: 'x', prompt: 'y' })).toThrow();
  });

  it('on_finish stamps id, raw, and pass/fail flags using normalised match', () => {
    const item = ATTENTION_CHECK_ITEMS[0];
    const node = typedAttentionCheckNode(item);
    const data = { response: { response: '  PAPER  ' } };
    node.on_finish(data);
    expect(data.attention_check_id).toBe(item.id);
    expect(data.attention_check_raw).toBe('  PAPER  ');
    expect(data.attention_check_passed).toBe(true);
  });

  it('on_finish marks as failed when response does not match', () => {
    const item = ATTENTION_CHECK_ITEMS[0];
    const node = typedAttentionCheckNode(item);
    const data = { response: { response: 'wrong' } };
    node.on_finish(data);
    expect(data.attention_check_passed).toBe(false);
  });

  it('on_finish handles missing response object', () => {
    const item = ATTENTION_CHECK_ITEMS[0];
    const node = typedAttentionCheckNode(item);
    const data = {};
    node.on_finish(data);
    expect(data.attention_check_raw).toBe('');
    expect(data.attention_check_passed).toBe(false);
  });
});

describe('evaluateAttentionChecks', () => {
  it('counts passed and failed across attention_check rows only', () => {
    const rows = [
      { phase: 'attention_check', attention_check_id: 'a', attention_check_passed: true },
      { phase: 'attention_check', attention_check_id: 'b', attention_check_passed: false },
      { phase: 'attention_check', attention_check_id: 'c', attention_check_passed: true },
      { phase: 'instructions_overview' } /* should be ignored */,
    ];
    const r = evaluateAttentionChecks(rows);
    expect(r.total).toBe(3);
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(1);
  });

  it('flags exceededThreshold when failures > config max', () => {
    /* config.attention_checks.instruction_max_failures = 1 */
    const rows = [
      { phase: 'attention_check', attention_check_passed: false },
      { phase: 'attention_check', attention_check_passed: false },
    ];
    const r = evaluateAttentionChecks(rows);
    expect(r.failed).toBe(2);
    expect(r.threshold).toBe(config.attention_checks.instruction_max_failures);
    expect(r.exceededThreshold).toBe(true);
  });

  it('does NOT flag when failures equal threshold (boundary test)', () => {
    const rows = [{ phase: 'attention_check', attention_check_passed: false }];
    /* threshold = 1, failed = 1 → exceeded only when failed > threshold */
    const r = evaluateAttentionChecks(rows);
    expect(r.failed).toBe(1);
    expect(r.exceededThreshold).toBe(false);
  });

  it('threshold override works', () => {
    const rows = [
      { phase: 'attention_check', attention_check_passed: false },
      { phase: 'attention_check', attention_check_passed: false },
    ];
    expect(evaluateAttentionChecks(rows, 5).exceededThreshold).toBe(false);
    expect(evaluateAttentionChecks(rows, 0).exceededThreshold).toBe(true);
  });

  it('returns zeros for empty input', () => {
    const r = evaluateAttentionChecks([]);
    expect(r.total).toBe(0);
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.exceededThreshold).toBe(false);
  });

  it('handles null input gracefully', () => {
    expect(evaluateAttentionChecks(null).total).toBe(0);
    expect(evaluateAttentionChecks(undefined).total).toBe(0);
  });

  /* The practice loop repeats all three checks whenever practice accuracy is below
   * criterion. A check counts once, as failed if it was failed the first time shown. */
  describe('practice re-loop (a check administered more than once)', () => {
    const row = (id, passed) => ({
      phase: 'attention_check',
      attention_check_id: id,
      attention_check_passed: passed,
    });

    it('counts a check once: the same check missed in both passes is ONE failure', () => {
      const rows = [
        row('ac1', true),
        row('ac2', false),
        row('ac3', true),
        row('ac1', true),
        row('ac2', false),
        row('ac3', true),
      ];
      const r = evaluateAttentionChecks(rows);
      expect(r.total).toBe(3);
      expect(r.failed).toBe(1);
      expect(r.failedFinal).toBe(1);
      expect(r.administrations).toBe(6);
      expect(r.exceededThreshold).toBe(false);
    });

    it('judges a check on its FIRST administration; the final verdict is reported beside it', () => {
      const rows = [
        row('ac1', false),
        row('ac2', false),
        row('ac3', true),
        row('ac1', true),
        row('ac2', true),
        row('ac3', true),
      ];
      const r = evaluateAttentionChecks(rows);
      expect(r.failed).toBe(2);
      expect(r.failedFinal).toBe(0);
      expect(r.exceededThreshold).toBe(true);
    });

    it('a pass the first time followed by a miss the second time does not fail the check', () => {
      const rows = [row('ac1', true), row('ac1', false)];
      const r = evaluateAttentionChecks(rows);
      expect(r.failed).toBe(0);
      expect(r.failedFinal).toBe(1);
    });

    it('the summary node stamps the distinct counts and both verdicts', () => {
      const rows = [
        row('ac1', true),
        row('ac2', false),
        row('ac3', true),
        row('ac1', true),
        row('ac2', false),
        row('ac3', true),
      ];
      Object.defineProperty(window, 'jsPsych', {
        value: { data: { get: () => ({ values: () => rows }) } },
        configurable: true,
        writable: true,
      });
      const data = {};
      attentionCheckSummaryNode().on_finish(data);
      expect(data.attention_total).toBe(3);
      expect(data.attention_failed).toBe(1);
      expect(data.attention_failed_final).toBe(1);
      expect(data.attention_administrations).toBe(6);
      expect(data.attention_excluded).toBe(false);
    });
  });

  it('exposes the ids in administration order', () => {
    const rows = [
      { phase: 'attention_check', attention_check_id: 'first', attention_check_passed: true },
      { phase: 'attention_check', attention_check_id: 'second', attention_check_passed: true },
    ];
    expect(evaluateAttentionChecks(rows).ids).toEqual(['first', 'second']);
  });
});

describe('attentionCheckSummaryNode', () => {
  it('points the participant to the main task rather than back to practice', () => {
    const node = attentionCheckSummaryNode();
    expect(node.html).toContain('proceed to the main task');
    expect(node.html).not.toContain('practice trials');
  });

  it('returns a node whose on_finish stamps a summary onto the data row', () => {
    const node = attentionCheckSummaryNode();
    expect(typeof node.on_finish).toBe('function');
    /* Stub window.jsPsych to mimic what the runner installs at session start. */
    const checkRows = [
      { phase: 'attention_check', attention_check_passed: true },
      { phase: 'attention_check', attention_check_passed: false },
      { phase: 'attention_check', attention_check_passed: true },
    ];
    Object.defineProperty(window, 'jsPsych', {
      value: { data: { get: () => ({ values: () => checkRows }) } },
      configurable: true,
      writable: true,
    });
    const data = {};
    node.on_finish(data);
    expect(data.phase).toBe('attention_check_summary');
    expect(data.attention_total).toBe(3);
    expect(data.attention_passed).toBe(2);
    expect(data.attention_failed).toBe(1);
    expect(data.attention_excluded).toBe(false); /* 1 ≤ threshold 1 */
    expect(data.attention_threshold).toBe(config.attention_checks.instruction_max_failures);
  });
});
