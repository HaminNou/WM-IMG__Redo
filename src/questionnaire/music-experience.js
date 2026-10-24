/**
 * Music-experience questionnaire (post-experiment covariate).
 *
 * The questionnaire mirrors the **Goldsmiths Musical Sophistication Index,
 * Musical Training (MT) subscale** verbatim (Müllensiefen, Gingras, Musil,
 * & Stewart, 2014, *PLOS ONE* 9(2): e89642) plus one absolute-pitch
 * self-report, because AP is a specific risk for the tone bank that
 * Gold-MSI does not address.
 *
 * Why Gold-MSI MT. Six of its seven items ask about concrete observable
 * behaviours (years, hours, number of instruments, level on best
 * instrument) and only one is a direct self-rating ("I would consider
 * myself a musician", 7-point Likert). The composite score (sum of the
 * seven 7-point items, range 7-49) therefore rests mostly on facts a
 * participant cannot easily over- or under-report. Reported reliability is
 * Cronbach alpha = .903 (Müllensiefen et al. 2014, Table 7).
 *
 * Why it matters here. The tone bank is a non-musical log-spaced ladder
 * (200-3900 Hz, neighbour ratio ~1.138) that blocks note-name re-encoding,
 * but a participant with substantial musical training, especially one with
 * absolute pitch, could still adopt an idiosyncratic auditory-WM strategy.
 * The Gold-MSI MT composite is the covariate column for that risk; the AP
 * item is a separate indicator for the extreme case.
 *
 * Item me_q04 (MT04, years of formal training) carries an explicit
 * "(school + private / conservatory combined)" parenthetical so that
 * in-school-only respondents do not under-count.
 *
 * Item map (Gold-MSI MT order is preserved; AP appended last):
 *   - me_q01 = MT01 — years of regular daily practice.
 *   - me_q02 = MT02 — peak hours/day on primary instrument.
 *   - me_q03 = MT03 — years of formal music-theory training.
 *   - me_q04 = MT04 — years of formal training on an instrument or voice (lifetime).
 *   - me_q05 = MT05 — number of instruments the participant plays.
 *   - me_q06 = MT06 — "I would consider myself a musician" 7-point Likert.
 *   - me_q07 = MT07 — level on best instrument (Beginner..Expert).
 *   - me_q08 = AP self-report.
 *
 * Bin labels follow Müllensiefen et al. 2014 verbatim where the original
 * scale supplies discrete labels, and follow the standard 7-point Likert
 * anchors elsewhere. Each bin maps to an integer 1..7 for composite
 * scoring (`goldMsiMtComposite`).
 *
 * Responses are stored on the data row as `music_experience_responses`,
 * an object keyed by item id (string codes preserved verbatim so the
 * raw response is auditable; the integer score is derived in scoring).
 */
import surveyHtmlForm from '@jspsych/plugin-survey-html-form';
import { registerHiddenNavStep, trackHiddenNavNode } from '../hidden-nav.js';

/* Each item carries its options as `{ value, label, score }` triples.
 * `score` is the integer 1..7 used by the Gold-MSI MT composite (Müllensiefen
 * et al. 2014, Methods §2.2 — items are scored on a 1–7 ordinal). The AP
 * item is OUTSIDE the composite (Gold-MSI does not include it) and carries
 * a `score: null` so the composite scorer skips it without special-casing. */
export const MUSIC_EXPERIENCE_ITEMS = Object.freeze([
  Object.freeze({
    id: 'me_q01',
    gold_msi: 'MT01',
    text: 'I engaged in regular, daily practice of a musical instrument (including voice) for ___ years.',
    options: Object.freeze([
      Object.freeze({ value: '0', label: '0', score: 1 }),
      Object.freeze({ value: '1', label: '1', score: 2 }),
      Object.freeze({ value: '2', label: '2', score: 3 }),
      Object.freeze({ value: '3', label: '3', score: 4 }),
      Object.freeze({ value: '4-5', label: '4–5', score: 5 }),
      Object.freeze({ value: '6-9', label: '6–9', score: 6 }),
      Object.freeze({ value: '10+', label: '10 or more', score: 7 }),
    ]),
  }),
  Object.freeze({
    id: 'me_q02',
    gold_msi: 'MT02',
    text: 'At the peak of my interest, I practised my primary instrument for ___ hours per day.',
    options: Object.freeze([
      Object.freeze({ value: '0', label: '0', score: 1 }),
      Object.freeze({ value: '0.5', label: '0.5', score: 2 }),
      Object.freeze({ value: '1', label: '1', score: 3 }),
      Object.freeze({ value: '1.5', label: '1.5', score: 4 }),
      Object.freeze({ value: '2', label: '2', score: 5 }),
      Object.freeze({ value: '3-4', label: '3–4', score: 6 }),
      Object.freeze({ value: '5+', label: '5 or more', score: 7 }),
    ]),
  }),
  Object.freeze({
    id: 'me_q03',
    gold_msi: 'MT03',
    text: 'I have had formal training in music theory for ___ years.',
    options: Object.freeze([
      Object.freeze({ value: '0', label: '0', score: 1 }),
      Object.freeze({ value: '0.5', label: '0.5', score: 2 }),
      Object.freeze({ value: '1', label: '1', score: 3 }),
      Object.freeze({ value: '2', label: '2', score: 4 }),
      Object.freeze({ value: '3', label: '3', score: 5 }),
      Object.freeze({ value: '4-6', label: '4–6', score: 6 }),
      Object.freeze({ value: '7+', label: '7 or more', score: 7 }),
    ]),
  }),
  Object.freeze({
    id: 'me_q04',
    gold_msi: 'MT04',
    text: 'I have had ___ years of formal training on a musical instrument (including voice) during my lifetime – count school music classes <strong>and</strong> private lessons / conservatory together.',
    options: Object.freeze([
      Object.freeze({ value: '0', label: '0', score: 1 }),
      Object.freeze({ value: '0.5', label: '0.5', score: 2 }),
      Object.freeze({ value: '1', label: '1', score: 3 }),
      Object.freeze({ value: '2', label: '2', score: 4 }),
      Object.freeze({ value: '3-5', label: '3–5', score: 5 }),
      Object.freeze({ value: '6-9', label: '6–9', score: 6 }),
      Object.freeze({ value: '10+', label: '10 or more', score: 7 }),
    ]),
  }),
  Object.freeze({
    id: 'me_q05',
    gold_msi: 'MT05',
    text: 'I can play ___ musical instruments.',
    options: Object.freeze([
      Object.freeze({ value: '0', label: '0', score: 1 }),
      Object.freeze({ value: '1', label: '1', score: 2 }),
      Object.freeze({ value: '2', label: '2', score: 3 }),
      Object.freeze({ value: '3', label: '3', score: 4 }),
      Object.freeze({ value: '4', label: '4', score: 5 }),
      Object.freeze({ value: '5', label: '5', score: 6 }),
      Object.freeze({ value: '6+', label: '6 or more', score: 7 }),
    ]),
  }),
  Object.freeze({
    id: 'me_q06',
    gold_msi: 'MT06',
    /* The single self-rating in Gold-MSI MT. Anchored at both ends so the
     * scale is symmetric and the midpoint is explicitly neutral — this
     * symmetry is what protects the composite from modesty (an expert
     * answering "neutral" still scores 4/7, which is balanced by their
     * high MT01–05 / MT07 scores) and from over-claim (a novice
     * answering "completely agree" gets 7/7, but their low behavioural
     * items keep the composite low). */
    text: 'I would consider myself a musician.',
    options: Object.freeze([
      Object.freeze({ value: '1', label: '1 – Completely disagree', score: 1 }),
      Object.freeze({ value: '2', label: '2', score: 2 }),
      Object.freeze({ value: '3', label: '3', score: 3 }),
      Object.freeze({ value: '4', label: '4 – Neither agree nor disagree', score: 4 }),
      Object.freeze({ value: '5', label: '5', score: 5 }),
      Object.freeze({ value: '6', label: '6', score: 6 }),
      Object.freeze({ value: '7', label: '7 – Completely agree', score: 7 }),
    ]),
  }),
  Object.freeze({
    id: 'me_q07',
    gold_msi: 'MT07',
    /* Behavioural anchor for skill level on the participant's primary
     * instrument. Five named anchors rather than a numeric scale —
     * Müllensiefen et al. found this reduces midpoint bias compared to
     * a 1–7 numeric self-rating. The five anchors are scored
     * by mapping Beginner..Expert linearly to {1, 2.5, 4, 5.5, 7} so
     * the composite stays in the 7..49 range. */
    text: 'The musical instrument I play best (including voice), I play at the level of a:',
    options: Object.freeze([
      Object.freeze({ value: 'none', label: 'I do not play any instrument', score: 1 }),
      Object.freeze({ value: 'beginner', label: 'Beginner', score: 2.5 }),
      Object.freeze({ value: 'intermediate', label: 'Intermediate', score: 4 }),
      Object.freeze({ value: 'advanced', label: 'Advanced', score: 5.5 }),
      Object.freeze({ value: 'expert', label: 'Expert / professional', score: 7 }),
    ]),
  }),
  Object.freeze({
    id: 'me_q08',
    gold_msi: null /* outside the Gold-MSI composite */,
    text: 'Can you name a musical note (e.g., "C", "F♯") just from hearing it played, without comparing it to any reference note? (This is sometimes called "absolute pitch" or "perfect pitch".)',
    options: Object.freeze([
      Object.freeze({ value: 'no', label: 'No', score: null }),
      Object.freeze({ value: 'unsure', label: 'I am not sure / sometimes', score: null }),
      Object.freeze({ value: 'yes', label: 'Yes – reliably', score: null }),
    ]),
  }),
]);

if (MUSIC_EXPERIENCE_ITEMS.length !== 8) {
  throw new Error(
    `MUSIC_EXPERIENCE_ITEMS must contain exactly 8 items, got ${MUSIC_EXPERIENCE_ITEMS.length}`
  );
}

/* Item-id → score lookup, built once at module load. Used by
 * `goldMsiMtComposite` to convert raw response codes to integers. */
const SCORE_LOOKUP = (() => {
  const m = {};
  for (const item of MUSIC_EXPERIENCE_ITEMS) {
    m[item.id] = {};
    for (const opt of item.options) m[item.id][opt.value] = opt.score;
  }
  return Object.freeze(m);
})();

/* The seven Gold-MSI MT item ids, in order. The composite is the sum of
 * their per-item scores; range 7..49 (matching Müllensiefen et al. 2014
 * Table 7's reported MT subscale range). */
const GOLD_MSI_MT_ITEM_IDS = Object.freeze(
  MUSIC_EXPERIENCE_ITEMS.filter((i) => i.gold_msi !== null).map((i) => i.id)
);

function musicExperienceIntro() {
  const stepId = 'music_experience_intro';
  const node = {
    type: surveyHtmlForm,
    preamble: `
      <div style="max-width: 40rem; margin: 0 auto; text-align: left;">
        <h2 style="text-align: center;">Music background – 8 quick questions</h2>
        <p>Some of the trials in this experiment involved listening to
        short tones. Different people listen to tones in different ways
        depending on their music background. The next page asks eight
        short questions about music training and instrument practice.</p>
        <p>Please answer based on <strong>what you have actually done</strong>
        (years, hours, instruments) rather than how you compare to professional
        musicians – there are no right or wrong answers, and the scale is
        designed for everyone from people who have never played an instrument
        to people who play professionally.</p>
      </div>
    `,
    html: `<div style="text-align: center; padding: 1rem 0;"><em>Click Continue to begin.</em></div>`,
    button_label: 'Continue',
    on_finish: (data) => {
      data.phase = 'music_experience_intro';
    },
  };
  registerHiddenNavStep(stepId, musicExperienceIntro);
  return trackHiddenNavNode(node, stepId);
}

function musicExperienceFormNode() {
  const itemRows = MUSIC_EXPERIENCE_ITEMS.map((item) => {
    const optionsHtml = item.options
      .map((o) => `<option value="${o.value}">${o.label}</option>`)
      .join('');
    return `
      <tr>
        <td style="padding: 0.75rem 0.75rem 0.75rem 0; vertical-align: top; max-width: 28rem;">
          ${item.text}
        </td>
        <td style="padding: 0.75rem 0; vertical-align: top;">
          <select name="${item.id}" required>
            <option value="">–</option>
            ${optionsHtml}
          </select>
        </td>
      </tr>`;
  }).join('');
  const stepId = 'music_experience';
  const node = {
    type: surveyHtmlForm,
    preamble: `
      <h2>Music background</h2>
      <p style="max-width: 40rem; margin: 0.5rem auto; text-align: left;">
        Please answer each of the eight questions below based on what you
        have actually done – count years, hours, and instruments as
        accurately as you can. There are no right or wrong answers.
      </p>
    `,
    html: `
      <div style="max-width: 44rem; margin: 0 auto;">
        <table style="width: 100%; border-collapse: collapse; text-align: left;">
          ${itemRows}
        </table>
      </div>
    `,
    button_label: 'Continue',
    on_finish: (data) => {
      data.phase = 'music_experience';
      data.music_experience_responses = MUSIC_EXPERIENCE_ITEMS.reduce((acc, item) => {
        const raw = data.response?.[item.id];
        acc[item.id] = raw === '' || raw === null || raw === undefined ? null : String(raw);
        return acc;
      }, {});
    },
  };
  registerHiddenNavStep(stepId, musicExperienceFormNode);
  return trackHiddenNavNode(node, stepId);
}

/**
 * Returns the music-experience timeline. Splice into the runner after the
 * strategy questionnaire and before the upload node.
 */
export function musicExperienceTimeline() {
  return [musicExperienceIntro(), musicExperienceFormNode()];
}

/**
 * Convert a single response-code map ({ me_q01: '4-5', ... }) to the
 * Gold-MSI MT composite score (sum of items 1..7, range 7..49) and the
 * raw item codes. Returns `null` for the composite if any of the seven
 * MT items is unanswered (Müllensiefen et al. require all items present
 * for a valid subscale score). The AP item (me_q08) is reported as a
 * separate field and never counted in the composite.
 *
 * @param {Record<string, string|null>} itemResponses
 * @returns {{
 *   gold_msi_mt_composite: number|null,
 *   gold_msi_mt_complete: boolean,
 *   absolute_pitch: string|null,
 * }}
 */
export function goldMsiMtComposite(itemResponses) {
  let total = 0;
  let allAnswered = true;
  for (const id of GOLD_MSI_MT_ITEM_IDS) {
    const code = itemResponses?.[id];
    const score = code !== null && code !== undefined ? SCORE_LOOKUP[id]?.[code] : undefined;
    if (typeof score !== 'number') {
      allAnswered = false;
      break;
    }
    total += score;
  }
  return {
    gold_msi_mt_composite: allAnswered ? total : null,
    gold_msi_mt_complete: allAnswered,
    absolute_pitch: itemResponses?.me_q08 ?? null,
  };
}

/**
 * Score a set of music-experience rows. Returns the raw responses by item
 * id, the Gold-MSI MT composite, an AP flag, and a `complete` boolean
 * (true iff all 8 items are answered). Used by the analyst as a covariate
 * column.
 *
 * @param {object[]} rows                jsPsych data rows (any phase)
 * @returns {{
 *   itemResponses: Record<string, string|null>,
 *   answered: number,
 *   total: number,
 *   complete: boolean,
 *   gold_msi_mt_composite: number|null,
 *   gold_msi_mt_complete: boolean,
 *   absolute_pitch: string|null,
 * }}
 */
export function scoreMusicExperience(rows) {
  const meRows = (rows ?? []).filter((r) => r?.phase === 'music_experience');
  const itemResponses = {};
  for (const item of MUSIC_EXPERIENCE_ITEMS) itemResponses[item.id] = null;
  for (const row of meRows) {
    const responses = row.music_experience_responses ?? {};
    for (const [k, v] of Object.entries(responses)) {
      if (k in itemResponses && typeof v === 'string' && v.length > 0) {
        itemResponses[k] = v;
      }
    }
  }
  const answered = Object.values(itemResponses).filter((v) => v !== null).length;
  const total = MUSIC_EXPERIENCE_ITEMS.length;
  const composite = goldMsiMtComposite(itemResponses);
  return {
    itemResponses,
    answered,
    total,
    complete: answered === total,
    ...composite,
  };
}
