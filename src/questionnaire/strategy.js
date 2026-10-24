/**
 * Post-experiment strategy questionnaire.
 *
 * # What this instrument is
 *
 * A 19-item self-report of the cognitive strategies the participant used in
 * each of the five trial conditions: dot-only ("memory"), tone-only,
 * imagery-only, image+dot dual, and image+tone dual. Every item is a
 * statement rated on the same 5-point agreement Likert ("Strongly
 * disagree" .. "Strongly agree"). Items use the task vocabulary the
 * participant saw (pattern, star, bull's-eye circle, tone).
 *
 * # Items
 *
 *   - Memory-only (5): Geometric Pattern Formation, Pattern Recognition,
 *     Chunking, Relational Positioning, Sequential Pathways.
 *   - Tone-only (4): Pitch Labeling, Auditory Imagery / Sub-vocal
 *     Rehearsal, Contour Encoding, Tonal Chunking (anchored in the
 *     auditory short-term memory literature).
 *   - Imagery-only (3): Imagery Vividness, Continuous Pattern
 *     Maintenance, Imagery Lapse / Guessing. These probe whether the
 *     rotated pattern was held as a vivid, continuously maintained image
 *     or reconstructed on demand at each star.
 *   - Image+Dot dual (3): Continuous Visualization, Selective Attention
 *     Switching, Phase-Specific Focus.
 *   - Image+Tone dual (4): the same three constructs, plus Concurrent
 *     Auditory Rehearsal (concurrent loading of the visuospatial and
 *     phonological/auditory buffers).
 *
 * # Presentation
 *
 * 19 items in 5 themed pages. Each page receives its own `phase` tag
 * ('strategy_memory_only', 'strategy_tone_only', 'strategy_imagery_only',
 * 'strategy_i_d', 'strategy_i_t') and writes a `strategy_responses` object
 * on its data row, keyed by the item id ('strategy_q01' .. 'strategy_q19',
 * in fixed order regardless of section). The five rows together carry the
 * complete response set; `scoreStrategy` collapses them on the participant
 * level.
 */
import surveyHtmlForm from '@jspsych/plugin-survey-html-form';
import { registerHiddenNavStep, trackHiddenNavNode } from '../hidden-nav.js';

/**
 * The single 5-point agreement Likert used by every item. Scored 1..5,
 * `1 = Strongly disagree`, `5 = Strongly agree`. Higher = more endorsement.
 */
export const STRATEGY_SCALE = Object.freeze([
  Object.freeze({ value: '1', label: '1 – Strongly disagree', score: 1 }),
  Object.freeze({ value: '2', label: '2 – Disagree', score: 2 }),
  Object.freeze({ value: '3', label: '3 – Neither agree nor disagree', score: 3 }),
  Object.freeze({ value: '4', label: '4 – Agree', score: 4 }),
  Object.freeze({ value: '5', label: '5 – Strongly agree', score: 5 }),
]);

if (STRATEGY_SCALE.length !== 5) {
  throw new Error(`STRATEGY_SCALE must have 5 levels, got ${STRATEGY_SCALE.length}`);
}

/* Each item carries: a stable id (`strategy_q01`..`q19`), a section tag
 * matching its phase suffix, a `construct` machine code that names the
 * cognitive strategy the item operationalises (used by the analyst to
 * compute composites such as Structural Chunking), a free-text `text`
 * shown to the participant, and, where applicable, a `literature_anchor`
 * citing the work the construct draws on. Items are listed in their
 * presentation order. */
export const STRATEGY_ITEMS = Object.freeze([
  /* ------------------------------------------------------------------
   * SECTION 1 — Memory-only (5 items).
   * ---------------------------------------------------------------- */
  Object.freeze({
    id: 'strategy_q01',
    section: 'memory_only',
    construct: 'geometric_pattern_formation',
    text: 'I tried to connect the remembered dots with imaginary lines to form a shape.',
  }),
  Object.freeze({
    id: 'strategy_q02',
    section: 'memory_only',
    construct: 'pattern_recognition',
    text: 'I noticed common shapes or symmetrical arrangements in the dot configurations and remembered them by that shape.',
  }),
  Object.freeze({
    id: 'strategy_q03',
    section: 'memory_only',
    construct: 'chunking',
    text: 'I grouped several dots together into clusters to make them easier to remember.',
  }),
  Object.freeze({
    id: 'strategy_q04',
    section: 'memory_only',
    construct: 'relational_positioning',
    text: 'I noted spatial relationships between the dots – which were adjacent, opposite, or close to each other.',
  }),
  Object.freeze({
    id: 'strategy_q05',
    section: 'memory_only',
    construct: 'sequential_pathways',
    text: 'I mentally retraced the dots in the order they appeared, as if drawing a line from one to the next.',
  }),
  /* ------------------------------------------------------------------
   * SECTION 2 — Tone-only (4 items).
   * Anchored in the auditory short-term memory literature.
   * ---------------------------------------------------------------- */
  Object.freeze({
    id: 'strategy_q06',
    section: 'tone_only',
    construct: 'pitch_labeling',
    text: 'I gave each tone a label (e.g., "high", "medium", "low", or a musical note name) and used the labels to remember the sequence.',
    literature_anchor: 'Williamson et al. 2010 – verbal/phonological coding of pitch',
  }),
  Object.freeze({
    id: 'strategy_q07',
    section: 'tone_only',
    construct: 'auditory_imagery_rehearsal',
    text: 'I silently sang or hummed the tones to myself between hearing them and the tone tests.',
    literature_anchor: 'Hubbard 2010 – auditory imagery / echoic rehearsal in auditory STM',
  }),
  Object.freeze({
    id: 'strategy_q08',
    section: 'tone_only',
    construct: 'contour_encoding',
    text: 'I remembered the tones by their up-and-down direction – e.g., "higher, then lower, then higher".',
    literature_anchor: 'Dowling 1978 – melodic contour encoding in tonal memory',
  }),
  Object.freeze({
    id: 'strategy_q09',
    section: 'tone_only',
    construct: 'tonal_chunking',
    text: 'I grouped adjacent tones into short melodic phrases or pairs to make them easier to remember.',
    literature_anchor: 'Tone-domain analogue of Chunking (strategy_q03)',
  }),
  /* ------------------------------------------------------------------
   * SECTION 3 — Imagery-only (3 items): (a) whether the rotated pattern
   * was held as a vivid percept-like image vs. a vague spatial sketch,
   * (b) whether it was maintained continuously across the trial vs.
   * reconstructed on demand at each star, and (c) whether the participant
   * lost the pattern and resorted to guessing.
   * ---------------------------------------------------------------- */
  Object.freeze({
    id: 'strategy_q10',
    section: 'imagery_only',
    construct: 'imagery_vividness',
    text: 'When the stars appeared, I could see the rotated pattern as a clear, vivid mental image – not just a vague sense of where it should be.',
    literature_anchor:
      'Pearson et al. 2015; Marks 1973 (VVIQ); Cui et al. 2007 – vividness as a percept-like vs. propositional distinction in visual imagery, central to imagery-maintenance accounts of dual-task cost',
  }),
  Object.freeze({
    id: 'strategy_q11',
    section: 'imagery_only',
    construct: 'continuous_pattern_maintenance',
    text: 'I held the rotated pattern in my mind as a continuous image throughout the trial, rather than recreating it from scratch each time a star appeared.',
    literature_anchor:
      'Cooper 1975; Kosslyn 1980; Logie 1995 – continuous maintenance of a visuospatial image vs. on-demand reconstruction; the within-subject mechanism the I-only condition is designed to isolate',
  }),
  Object.freeze({
    id: 'strategy_q12',
    section: 'imagery_only',
    construct: 'imagery_lapse_guessing',
    text: 'I often lost track of where the rotated pattern was and ended up just guessing on the stars.',
    literature_anchor:
      'Construct-validity check on the imagery-maintenance manipulation – endorsement signals the imagery channel failed to hold the rotated pattern long enough to support star judgements, mirroring "give-up" responding in Sperling-style decay paradigms',
  }),
  /* ------------------------------------------------------------------
   * SECTION 4 — Image + Dot dual (3 items).
   * ---------------------------------------------------------------- */
  Object.freeze({
    id: 'strategy_q13',
    section: 'i_d',
    construct: 'continuous_visualization',
    text: 'During the image+dot trials, I continued to hold the rotated pattern vividly in mind while responding to the dot tests.',
  }),
  Object.freeze({
    id: 'strategy_q14',
    section: 'i_d',
    construct: 'selective_attention_switching',
    text: 'During the image+dot trials, I switched my attention between visualizing the rotated pattern and tracking the dots, depending on what was on screen.',
  }),
  Object.freeze({
    id: 'strategy_q15',
    section: 'i_d',
    construct: 'phase_specific_focus',
    text: 'During the image+dot trials, even when it was not required, I kept a residual image of the rotated pattern in my mind while doing the dot tests.',
  }),
  /* ------------------------------------------------------------------
   * SECTION 5 — Image + Tone dual (3 items parallel to Section 4, plus 1
   * item operationalising the auditory analogue of Continuous
   * Visualization).
   * ---------------------------------------------------------------- */
  Object.freeze({
    id: 'strategy_q16',
    section: 'i_t',
    construct: 'continuous_visualization',
    text: 'During the image+tone trials, I continued to hold the rotated pattern vividly in mind while responding to the tone tests.',
  }),
  Object.freeze({
    id: 'strategy_q17',
    section: 'i_t',
    construct: 'selective_attention_switching',
    text: 'During the image+tone trials, I switched my attention between visualizing the rotated pattern and tracking the tones, depending on the stimulus.',
  }),
  Object.freeze({
    id: 'strategy_q18',
    section: 'i_t',
    construct: 'phase_specific_focus',
    text: 'During the image+tone trials, even when it was not required, I kept a residual image of the rotated pattern in my mind while doing the tone tests.',
  }),
  Object.freeze({
    id: 'strategy_q19',
    section: 'i_t',
    construct: 'concurrent_auditory_rehearsal',
    text: 'While visualizing the rotated pattern, I silently rehearsed (sang or hummed) the tones at the same time.',
    literature_anchor:
      'Auditory analogue of Continuous Visualization; tests concurrent loading of visuospatial and phonological buffers (Logie 1995; Baddeley 2000)',
  }),
]);

if (STRATEGY_ITEMS.length !== 19) {
  throw new Error(`STRATEGY_ITEMS must contain exactly 19 items, got ${STRATEGY_ITEMS.length}`);
}

/* Five-section layout. Each section produces one form node. The header
 * is shown on its page so the participant knows which condition they
 * are rating; without this the cross-section item-text differences
 * (e.g., "image+dot trials" vs "image+tone trials") would be the only
 * anchor and that's too easy to overlook on a single-screen form. */
export const STRATEGY_SECTIONS = Object.freeze([
  Object.freeze({
    id: 'memory_only',
    phase: 'strategy_memory_only',
    header: 'Strategies – dot-memory trials',
    blurb:
      'Think about the trials where you only had to remember and judge the locations of <strong>dots</strong> (no pattern, no tones). For each statement, rate how much it describes the way you approached those trials.',
  }),
  Object.freeze({
    id: 'tone_only',
    phase: 'strategy_tone_only',
    header: 'Strategies – tone-memory trials',
    blurb:
      'Think about the trials where you only had to remember and judge a sequence of <strong>tones</strong> (no pattern, no dots). For each statement, rate how much it describes the way you approached those trials.',
  }),
  Object.freeze({
    id: 'imagery_only',
    phase: 'strategy_imagery_only',
    header: 'Strategies – pattern-imagery trials',
    blurb:
      'Think about the trials where you had to <strong>picture the rotated pattern</strong> and judge stars as on-pattern or not on-pattern (no dots, no tones). For each statement, rate how much it describes the way you approached those trials.',
  }),
  Object.freeze({
    id: 'i_d',
    phase: 'strategy_i_d',
    header: 'Strategies – pattern + dots (dual) trials',
    blurb:
      'Think about the trials where you had to <strong>both</strong> picture the rotated pattern <strong>and</strong> remember dot locations at the same time. For each statement, rate how much it describes the way you approached those dual trials.',
  }),
  Object.freeze({
    id: 'i_t',
    phase: 'strategy_i_t',
    header: 'Strategies – pattern + tones (dual) trials',
    blurb:
      'Think about the trials where you had to <strong>both</strong> picture the rotated pattern <strong>and</strong> remember a sequence of tones at the same time. For each statement, rate how much it describes the way you approached those dual trials.',
  }),
]);

if (STRATEGY_SECTIONS.length !== 5) {
  throw new Error(
    `STRATEGY_SECTIONS must contain exactly 5 sections, got ${STRATEGY_SECTIONS.length}`
  );
}

/* Compile-time guard: every item must belong to exactly one declared
 * section, and the section.phase must match the canonical form. */
const SECTION_IDS = new Set(STRATEGY_SECTIONS.map((s) => s.id));
for (const item of STRATEGY_ITEMS) {
  if (!SECTION_IDS.has(item.section)) {
    throw new Error(`STRATEGY_ITEMS: item ${item.id} has unknown section "${item.section}"`);
  }
}

/* Item-id → section lookup, built once. */
const ITEMS_BY_SECTION = (() => {
  const m = {};
  for (const s of STRATEGY_SECTIONS) m[s.id] = [];
  for (const it of STRATEGY_ITEMS) m[it.section].push(it);
  return Object.freeze(
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Object.freeze(v)]))
  );
})();

export function strategyItemsForSection(sectionId) {
  return ITEMS_BY_SECTION[sectionId] ?? [];
}

/* Item-id → score lookup, built once. Used by composite scorers. */
const SCORE_LOOKUP = (() => {
  const m = {};
  for (const opt of STRATEGY_SCALE) m[opt.value] = opt.score;
  return Object.freeze(m);
})();

function strategySectionFormNode(section) {
  const sectionItems = strategyItemsForSection(section.id);
  const scaleOptions = STRATEGY_SCALE.map(
    (s) => `<option value="${s.value}">${s.label}</option>`
  ).join('');
  const itemRows = sectionItems
    .map(
      (item) => `
      <tr>
        <td style="padding: 0.75rem 0.75rem 0.75rem 0; vertical-align: top; max-width: 32rem;">
          ${item.text}
        </td>
        <td style="padding: 0.75rem 0; vertical-align: top;">
          <select name="${item.id}" required>
            <option value="">–</option>
            ${scaleOptions}
          </select>
        </td>
      </tr>`
    )
    .join('');
  const stepId = section.phase;
  const node = {
    type: surveyHtmlForm,
    preamble: `
      <div style="max-width: 44rem; margin: 0 auto; text-align: left;">
        <h2 style="text-align: center;">${section.header}</h2>
        <p style="margin: 0.5rem 0 1rem 0;">${section.blurb}</p>
        <p style="margin: 0.5rem 0 1rem 0; font-size: 0.9rem; color: rgba(0,0,0,0.7);">
          There are no right or wrong answers. People use very different
          strategies on these tasks; we want to capture <em>your</em> approach.
          Use <strong>1 (Strongly disagree)</strong> if a statement is the
          opposite of what you did, <strong>5 (Strongly agree)</strong> if it
          captures your approach well, and the middle values for everything
          in between.
        </p>
      </div>
    `,
    html: `
      <div style="max-width: 46rem; margin: 0 auto;">
        <table style="width: 100%; border-collapse: collapse; text-align: left;">
          ${itemRows}
        </table>
      </div>
    `,
    button_label: 'Continue',
    on_finish: (data) => {
      data.phase = section.phase;
      data.strategy_section = section.id;
      data.strategy_responses = sectionItems.reduce((acc, item) => {
        const raw = data.response?.[item.id];
        acc[item.id] = raw === '' || raw === null || raw === undefined ? null : String(raw);
        return acc;
      }, {});
    },
  };
  registerHiddenNavStep(stepId, () => strategySectionFormNode(section));
  return trackHiddenNavNode(node, stepId);
}

/**
 * Returns the strategy-questionnaire timeline (five form nodes in fixed
 * order: memory-only, tone-only, imagery-only, image+dot, image+tone).
 * Splice into the runner after `endOfTaskIntroNode` and before the
 * music-experience pair.
 */
export function strategyTimeline() {
  return STRATEGY_SECTIONS.map((s) => strategySectionFormNode(s));
}

/**
 * Convert the per-section strategy_responses objects on a participant's
 * data rows into (1) a flat item-response map keyed by item id, and (2)
 * a handful of theoretically-motivated composites. The Structural
 * Chunking composite is the sum of
 * Geometric Pattern Formation + Pattern Recognition + Chunking, range
 * 3-15. The Imagery-Maintenance composites split by dual condition
 * (I+D, I+T) and sum Continuous Visualization + Phase-Specific Focus,
 * range 2-10. All composites are `null` when any constituent item is
 * unanswered (no imputation).
 *
 * @param {object[]} rows  jsPsych data rows (any phase)
 * @returns {{
 *   itemResponses: Record<string, string|null>,
 *   itemScores: Record<string, number|null>,
 *   answered: number,
 *   total: number,
 *   complete: boolean,
 *   structural_chunking_composite: number|null,
 *   imagery_maintenance_id: number|null,
 *   imagery_maintenance_it: number|null,
 * }}
 */
export function scoreStrategy(rows) {
  const strategyPhases = new Set(STRATEGY_SECTIONS.map((s) => s.phase));
  const itemResponses = {};
  for (const it of STRATEGY_ITEMS) itemResponses[it.id] = null;
  for (const row of rows ?? []) {
    if (!strategyPhases.has(row?.phase)) continue;
    const responses = row.strategy_responses ?? {};
    for (const [k, v] of Object.entries(responses)) {
      if (k in itemResponses && typeof v === 'string' && v.length > 0) {
        itemResponses[k] = v;
      }
    }
  }
  const itemScores = {};
  for (const [id, code] of Object.entries(itemResponses)) {
    itemScores[id] = code !== null ? (SCORE_LOOKUP[code] ?? null) : null;
  }
  const answered = Object.values(itemResponses).filter((v) => v !== null).length;
  const total = STRATEGY_ITEMS.length;

  /* Composites — strict (any null in the set → composite is null). */
  const sumIfComplete = (ids) => {
    let total_ = 0;
    for (const id of ids) {
      const s = itemScores[id];
      if (typeof s !== 'number') return null;
      total_ += s;
    }
    return total_;
  };
  const structural_chunking_composite = sumIfComplete([
    'strategy_q01' /* Geometric Pattern Formation */,
    'strategy_q02' /* Pattern Recognition */,
    'strategy_q03' /* Chunking */,
  ]);
  const imagery_maintenance_id = sumIfComplete([
    'strategy_q13' /* Continuous Visualization (I+D) */,
    'strategy_q15' /* Phase-Specific Focus (I+D) */,
  ]);
  const imagery_maintenance_it = sumIfComplete([
    'strategy_q16' /* Continuous Visualization (I+T) */,
    'strategy_q18' /* Phase-Specific Focus (I+T) */,
  ]);

  return {
    itemResponses,
    itemScores,
    answered,
    total,
    complete: answered === total,
    structural_chunking_composite,
    imagery_maintenance_id,
    imagery_maintenance_it,
  };
}
