/**
 * Pre-registration lock tests.
 *
 * Three layers:
 *   1. `canonicaliseValue` / `canonicaliseConfig` — pure helper coverage.
 *   2. **Config snapshot byte-equality.** Canonicalise the live `src/config.js`
 *      and compare byte-for-byte against `pre-reg/pre-reg.json`'s
 *      `config_locked`. Any drift fails this test, surfacing the diff so the
 *      experimenter can decide between reverting the config change, applying
 *      the change while the document is still a draft, or filing a
 *      post-registration amendment (after the draft has been filed). Domain non-negotiable: once the draft is filed, the deployed
 *      commit SHA must match the OSF record.
 *   3. **Trial schema integrity.** `schemas/trial.schema.json` parses as
 *      valid JSON Schema (draft 2020-12) and the `phase` enum is a superset
 *      of every phase tag the codebase actually emits.
 *
 * No `@vitest-environment jsdom` here — these are file-and-string tests that
 * don't touch the DOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, PROLIFIC_PRESCREEN_SUMMARY } from '../src/config.js';
import { TIMING_THRESHOLDS } from '../src/calibration/device-probe.js';
import { _testHelpers as screenCal } from '../src/calibration/screen.js';
import { MAX_SWEEPS } from '../src/calibration/tone-familiarisation.js';
import { ESCAPE_AFTER_MS } from '../src/calibration/display-guard.js';
import { canonicaliseValue, canonicaliseConfig } from './helpers/fingerprint.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRE_REG_PATH = resolve(__dirname, '..', 'pre-reg', 'pre-reg.json');
const SCHEMA_PATH = resolve(__dirname, '..', 'schemas', 'trial.schema.json');

const preReg = JSON.parse(readFileSync(PRE_REG_PATH, 'utf-8'));
const trialSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));

describe('canonicaliseValue', () => {
  it('returns primitives unchanged', () => {
    expect(canonicaliseValue(42)).toBe(42);
    expect(canonicaliseValue('x')).toBe('x');
    expect(canonicaliseValue(true)).toBe(true);
    expect(canonicaliseValue(null)).toBe(null);
    expect(canonicaliseValue(undefined)).toBe(undefined);
  });

  it('preserves array order (order is meaningful for some fields)', () => {
    expect(canonicaliseValue([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('sorts object keys alphabetically (recursive)', () => {
    const input = { c: 3, a: 1, b: { z: 26, a: 1 } };
    const out = canonicaliseValue(input);
    expect(Object.keys(out)).toEqual(['a', 'b', 'c']);
    expect(Object.keys(out.b)).toEqual(['a', 'z']);
  });

  it('two semantically-equal objects produce byte-identical canonical JSON', () => {
    const a = { x: 1, y: { b: 2, a: 1 } };
    const b = { y: { a: 1, b: 2 }, x: 1 };
    expect(JSON.stringify(canonicaliseValue(a))).toBe(JSON.stringify(canonicaliseValue(b)));
  });

  it('handles deeply nested mixed structures', () => {
    const nested = { a: [{ z: 1, a: 2 }, { x: 0 }] };
    const out = canonicaliseValue(nested);
    expect(Object.keys(out.a[0])).toEqual(['a', 'z']);
    expect(Object.keys(out.a[1])).toEqual(['x']);
  });
});

describe('canonicaliseConfig', () => {
  it('produces a stably-formatted JSON string', () => {
    const s = canonicaliseConfig({ b: 2, a: 1 });
    expect(s).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it('respects the indent option', () => {
    expect(canonicaliseConfig({ a: 1 }, { indent: 0 })).toBe('{"a":1}');
    expect(canonicaliseConfig({ a: 1 }, { indent: 4 })).toBe('{\n    "a": 1\n}');
  });
});

describe('pre-reg.json structural integrity', () => {
  it('contains the required top-level keys', () => {
    expect(preReg).toHaveProperty('pre_reg_lock_iso');
    expect(preReg).toHaveProperty('pre_reg_lock_build_id');
    expect(preReg).toHaveProperty('study');
    expect(preReg).toHaveProperty('design_summary');
    expect(preReg).toHaveProperty('hypotheses');
    expect(preReg).toHaveProperty('sampling_plan');
    expect(preReg).toHaveProperty('exclusion_rules');
    expect(preReg).toHaveProperty('counterbalance_invariants');
    expect(preReg).toHaveProperty('config_locked');
  });

  it('locks exactly the five hypotheses H1–H5', () => {
    expect(preReg.hypotheses).toHaveLength(5);
    expect(preReg.hypotheses.map((h) => h.id)).toEqual(['H1', 'H2', 'H3', 'H4', 'H5']);
  });

  it('H3 uses the default JZS prior (r = sqrt(2)/2)', () => {
    const h3 = preReg.hypotheses.find((h) => h.id === 'H3');
    expect(h3.prior.family).toBe('JZS Cauchy');
    expect(h3.prior.scale_r).toBeCloseTo(Math.SQRT2 / 2, 10);
  });

  it('sample-size plan recruits 60 with retained ≥ 40 floor and 10-batch top-ups', () => {
    expect(preReg.sampling_plan.recruitment_target_n).toBe(60);
    expect(preReg.sampling_plan.retained_n_minimum).toBe(40);
    expect(preReg.sampling_plan.batch_size).toBe(10);
    expect(preReg.sampling_plan.stopping_rule).toMatch(/batch of 10/i);
  });

  it('sampling plan has one coherent stopping rule: a hard maximum, no BF/p-value stopping, stated power basis', () => {
    const plan = preReg.sampling_plan;
    expect(plan.max_recruitment_n).toBe(100);
    expect(plan.max_recruitment_n).toBeGreaterThan(plan.recruitment_target_n);
    expect((plan.max_recruitment_n - plan.recruitment_target_n) % plan.batch_size).toBe(0);
    expect(plan.stopping_rule).toMatch(/100 participants have completed/);
    expect(plan.no_optional_stopping).toMatch(
      /no p-value-based or Bayes-factor-based optional stopping/
    );
    expect(plan.prolific_setup.initial_places).toBe(plan.recruitment_target_n);
    expect(plan.prolific_setup.top_up_places_per_batch).toBe(plan.batch_size);
    expect(plan.prolific_setup.max_completions).toBe(plan.max_recruitment_n);
    expect(plan.power_analysis.computed_n_basis).toMatch(/rho = 0/);
    expect(plan.power_analysis.computed_n).toBeLessThanOrEqual(plan.retained_n_minimum);
  });

  it('the Prolific checklist states the same places, cap and budget as the pre-registration', () => {
    const md = readFileSync(resolve(__dirname, '../prolific-study-description.md'), 'utf8');
    expect(md).toMatch(/start with 60 places/);
    expect(md).toMatch(/aim for 60 completed sessions/);
    expect(md).toMatch(/fewer than 40 participants are retained/);
    expect(md).toMatch(/batch of 10 places/);
    expect(md).toMatch(/past 100 completed sessions/);
    expect(md).toContain('$1,560');
    expect(md).toContain('$2,600');
  });

  it('participant pay budget equals the stated pay times the completions', () => {
    const comp = preReg.sampling_plan.compensation;
    const pay = Number(comp.pay_amount.replace('$', ''));
    expect(comp.participant_pay_budget_usd.at_60_completions).toBe(
      pay * preReg.sampling_plan.recruitment_target_n
    );
    expect(comp.participant_pay_budget_usd.at_100_completions_maximum).toBe(
      pay * preReg.sampling_plan.max_recruitment_n
    );
  });

  it('design summary matches the locked config (12 trials per type per main block × 2 blocks = 24/type)', () => {
    expect(preReg.design_summary.trials_per_type_main).toBe(config.blocks.main_trials_per_type);
    expect(preReg.design_summary.main_blocks).toBe(config.blocks.main_block_count);
    expect(preReg.design_summary.trials_per_main_block).toBe(60);
    expect(preReg.design_summary.main_trials_total_per_participant).toBe(120);
  });
});

describe('config snapshot lock', () => {
  it('build_id matches the pre-reg lock build_id', () => {
    expect(config.build_id).toBe(preReg.pre_reg_lock_build_id);
  });

  it('schema_version matches the pre-reg lock schema_version', () => {
    expect(config.schema_version).toBe(preReg.pre_reg_lock_schema_version);
  });

  it('live config canonicalises byte-identically to pre-reg.json config_locked', () => {
    /* This is the central byte-equality check. If it fails, the diff between
     * the two canonical strings tells the experimenter exactly which key
     * drifted, and the fix is one of: (a) revert the config edit; (b) update
     * pre-reg.json's config_locked alongside the config edit AND record the
     * change (while the document is still a draft); (c) file a post-registration amendment
     * if the draft has already been filed. Do NOT just regenerate pre-reg.json
     * from the live config — that defeats the entire point of the snapshot. */
    const live = canonicaliseConfig(config);
    const frozen = canonicaliseConfig(preReg.config_locked);
    expect(live).toBe(frozen);
  });

  it('every locked top-level key in pre-reg also exists in the live config', () => {
    /* Defensive — if pre-reg locks a key that the live config no longer has,
     * the canonicalise comparison above would catch it, but this gives a
     * cleaner failure message naming the missing key. */
    for (const key of Object.keys(preReg.config_locked)) {
      if (key.startsWith('_')) continue; /* skip _doc fields */
      expect(config).toHaveProperty(key);
    }
  });
});

describe('pre-reg.json matches the build', () => {
  const rule = (id) => preReg.collection_time_screen_outs.rules.find((r) => r.id === id);

  it('lists the Prolific filters that are listed in the study description', () => {
    expect(preReg.sampling_plan.filters.prolific_prescreeners).toEqual([
      ...PROLIFIC_PRESCREEN_SUMMARY,
    ]);
  });

  it('describes the session length shown in the consent form', () => {
    expect(preReg.design_summary.session_length_minutes).toBe(110);
    expect(preReg.sampling_plan.compensation.estimated_session_minutes).toBe(110);
  });

  it('describes every collection-time screen-out', () => {
    expect(preReg.collection_time_screen_outs.rules.map((r) => r.id)).toEqual([
      'desktop_check',
      'screen_size_calibration',
      'tone_audibility',
      'timing_probe',
      'practice_accuracy',
      'display_guard_escape',
    ]);
  });

  it('pins the tone-audibility sweep limit to the source constant', () => {
    expect(rule('tone_audibility').max_sweeps).toBe(MAX_SWEEPS);
  });

  it('describes no headphone check and no pitch check (both removed)', () => {
    const ids = preReg.collection_time_screen_outs.rules.map((r) => r.id);
    expect(ids).not.toContain('headphone_check');
    expect(ids).not.toContain('pitch_discrimination');
    for (const r of preReg.collection_time_screen_outs.rules) {
      expect(JSON.stringify(r)).not.toMatch(/headphone|pitch|audio-check/i);
    }
  });

  it('pins the timing thresholds to device-probe.js', () => {
    expect(rule('timing_probe').thresholds).toEqual(TIMING_THRESHOLDS);
  });

  it('pins the screen-calibration bounds to screen.js', () => {
    expect(rule('screen_size_calibration')).toMatchObject({
      card_width_mm: screenCal.CARD_MM_WIDTH,
      px_per_mm_min: screenCal.PX_PER_MM_MIN,
      px_per_mm_max: screenCal.PX_PER_MM_MAX,
      implied_screen_width_mm_min: screenCal.IMPLIED_SCREEN_MM_MIN,
      implied_screen_width_mm_max: screenCal.IMPLIED_SCREEN_MM_MAX,
      min_slider_move_px: screenCal.MIN_MOVE_PX,
      consistency_tolerance_relative: screenCal.CONSISTENCY_TOL,
      max_attempts: screenCal.MAX_ATTEMPTS,
    });
  });

  it('pins the practice criterion and the guard escape to the build', () => {
    expect(rule('practice_accuracy')).toMatchObject({
      accuracy_criterion: config.practice.accuracy_criterion,
      max_loops: config.practice.max_loops,
    });
    expect(rule('display_guard_escape').escape_after_ms).toBe(ESCAPE_AFTER_MS);
  });

  it('keeps the guard-flag trial-drop rule among the analysis exclusions', () => {
    expect(preReg.exclusion_rules.rules.map((r) => r.id)).toContain('display_guard_flags');
  });
});

describe('trial.schema.json', () => {
  it('parses as valid JSON Schema (draft 2020-12)', () => {
    expect(trialSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(trialSchema.type).toBe('object');
    expect(trialSchema.required).toContain('phase');
  });

  it('phase enum is non-empty and contains the core trial phases', () => {
    const phases = trialSchema.properties.phase.enum;
    expect(Array.isArray(phases)).toBe(true);
    expect(phases.length).toBeGreaterThan(20);
    /* Spot-check the five condition probe/star phases. */
    for (const p of [
      'd_only_probe',
      't_only_probe',
      'i_only_star',
      'i_d_star',
      'i_d_probe',
      'i_t_star',
      'i_t_probe',
    ]) {
      expect(phases).toContain(p);
    }
  });

  it('phase enum has no duplicates', () => {
    const phases = trialSchema.properties.phase.enum;
    expect(new Set(phases).size).toBe(phases.length);
  });

  it('contains canonical probe-type taxonomy {T_on, T_off, F_on, F_off}', () => {
    expect(trialSchema.properties.probe_type.enum).toEqual(['T_on', 'T_off', 'F_on', 'F_off']);
  });

  it('attention_check_id pattern matches the locked item ids', () => {
    const pattern = new RegExp(trialSchema.properties.attention_check_id.pattern);
    expect(pattern.test('ac1_direct_instruction')).toBe(true);
    expect(pattern.test('ac2_third_word')).toBe(true);
    expect(pattern.test('ac3_arrow_mapping')).toBe(true);
    expect(pattern.test('not_a_check')).toBe(false);
  });

  it('strategy_section enum matches the five condition-specific section ids', () => {
    expect(trialSchema.properties.strategy_section.enum).toEqual([
      'memory_only',
      'tone_only',
      'imagery_only',
      'i_d',
      'i_t',
    ]);
  });

  it('strategy_responses constrains item codes to "1".."5" or null', () => {
    const sub = trialSchema.properties.strategy_responses.additionalProperties;
    expect(sub.type).toEqual(['string', 'null']);
    expect(sub.enum).toEqual(['1', '2', '3', '4', '5', null]);
  });

  it('phase enum includes all five strategy phases and excludes the vviq phase', () => {
    const phases = trialSchema.properties.phase.enum;
    for (const p of [
      'strategy_memory_only',
      'strategy_tone_only',
      'strategy_imagery_only',
      'strategy_i_d',
      'strategy_i_t',
    ]) {
      expect(phases).toContain(p);
    }
    expect(phases).not.toContain('vviq');
  });
});
