/**
 * Music-experience questionnaire (post-experiment covariate).
 *
 * The seven Musical Training items are the **Goldsmiths Musical
 * Sophistication Index (Gold-MSI) v1.0 Musical Training subscale**
 * (Müllensiefen, Gingras, Musil, & Stewart, 2014, *PLOS ONE* 9(2): e89642),
 * in the item set and order of the paper's File S1 ("Musical Training,
 * 7 items, alpha = .903"), plus one absolute-pitch self-report appended last
 * (AP is a specific risk for the tone bank that Gold-MSI does not address).
 *
 * What was checked against the primary sources (read 2026-10-25: the paper,
 * its File S1, and the Gold-MSI v1.0 documentation, gms_documentation_en.pdf):
 *   - the subscale has exactly these seven items (S1): years of regular daily
 *     practice; number of instruments played; "I have never been complimented
 *     for my talents as a musical performer"; hours practised at the peak of
 *     interest; years of formal music-theory training; years of formal
 *     training on an instrument; "I would not consider myself a musician";
 *   - all items are scored on one 7-point scale with equal weights, the
 *     subscale is the sum (Table 2: minimum 7, maximum 49);
 *   - the negatively phrased items are reverse-scored before summing
 *     (documentation, section 2.3: a response of 1 scores 7, 4 scores 4,
 *     2 scores 6, and so on). The two negatively phrased Musical Training
 *     items are the "never been complimented" and "would not consider myself
 *     a musician" statements;
 *   - for the items answered as a range ("___ years", "___ hours"), the
 *     documentation says to enter the number 1-7 that corresponds to the
 *     range's order of presentation.
 * NOT verified from a primary source that could be read: the printed labels of
 * the response ranges (0, 1, 2, 3, 4-5, 6-9, 10+ and so on). They are kept as
 * they were; compare them with the Gold-MSI questionnaire PDF before the data
 * are reported as "the Gold-MSI Musical Training subscale".
 *
 * Deviations from the published form, all deliberate and minor: US spelling
 * ("practiced" for "practised"); the hours item says "per day" (the paper
 * quotes the item that way in its Factor 3 description); the two agreement
 * items use anchored 1-7 labels ("Completely disagree" ... "Completely
 * agree"); one item per row in a single form rather than interleaved with the
 * other 31 Gold-MSI items, so published percentile norms for the full
 * inventory do not apply to the order effects of this short form.
 *
 * Why Gold-MSI MT. Five of its seven items ask about concrete observable
 * behaviours (years, hours, number of instruments), so the composite rests
 * mostly on facts a participant cannot easily over- or under-report.
 *
 * Why it matters here. The tone bank is a non-musical log-spaced ladder
 * (200-3900 Hz, neighbour ratio ~1.138) that blocks note-name re-encoding,
 * but a participant with substantial musical training, especially one with
 * absolute pitch, could still adopt an idiosyncratic auditory-WM strategy.
 * The Gold-MSI MT composite is the covariate column for that risk; the AP
 * item is a separate indicator for the extreme case.
 *
 * Item map (File S1 order; AP appended last):
 *   - me_q01 = MT01 - years of regular daily practice.
 *   - me_q02 = MT02 - number of instruments played (including voice).
 *   - me_q03 = MT03 - "I have never been complimented for my talents as a
 *                     musical performer" (agreement; REVERSE-scored).
 *   - me_q04 = MT04 - hours per day practiced at the peak of interest.
 *   - me_q05 = MT05 - years of formal music-theory training.
 *   - me_q06 = MT06 - years of formal training on an instrument or voice.
 *   - me_q07 = MT07 - "I would not consider myself a musician"
 *                     (agreement; REVERSE-scored).
 *   - me_q08 = AP self-report (outside the composite).
 *
 * Responses are stored on the data row as `music_experience_responses`, an
 * object keyed by item id. The stored value is the raw option the participant
 * chose (so the raw response is auditable); the 1-7 item score, with the
 * reversal applied to the two negatively phrased items, is derived in scoring
 * from each option's `score`.
 */
import surveyHtmlForm from '@jspsych/plugin-survey-html-form';
import { registerHiddenNavStep, trackHiddenNavNode } from '../hidden-nav.js';

/* Each item carries its options as `{ value, label, score }` triples.
 * `score` is the 1..7 value used by the Gold-MSI MT composite. For the two
 * negatively phrased items (`reverse_keyed: true`) the score is already the
 * REVERSED value (response 1 scores 7, 4 scores 4, 7 scores 1), so the
 * composite is a plain sum. The AP item is OUTSIDE the composite and carries
 * `score: null` so the composite scorer skips it without special-casing. */

/* The 7-point agreement scale, 1 = completely disagree ... 7 = completely
 * agree. `reverse` turns the score around (the stored `value` stays raw). */
function agreementOptions(reverse) {
  const labels = [
    '1 – Completely disagree',
    '2',
    '3',
    '4 – Neither agree nor disagree',
    '5',
    '6',
    '7 – Completely agree',
  ];
  return Object.freeze(
    labels.map((label, i) =>
      Object.freeze({ value: String(i + 1), label, score: reverse ? 7 - i : i + 1 })
    )
  );
}

export const MUSIC_EXPERIENCE_ITEMS = Object.freeze([
  Object.freeze({
    id: 'me_q01',
    gold_msi: 'MT01',
    reverse_keyed: false,
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
    reverse_keyed: false,
    text: 'I can play the following number of musical instruments (including voice): ___',
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
    id: 'me_q03',
    gold_msi: 'MT03',
    reverse_keyed: true /* negatively phrased: agreement means LESS training */,
    text: 'I have never been complimented for my talents as a musical performer.',
    options: agreementOptions(true),
  }),
  Object.freeze({
    id: 'me_q04',
    gold_msi: 'MT04',
    reverse_keyed: false,
    text: 'At the peak of my interest, I practiced my primary instrument (including voice) for ___ hours per day.',
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
    id: 'me_q05',
    gold_msi: 'MT05',
    reverse_keyed: false,
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
    id: 'me_q06',
    gold_msi: 'MT06',
    reverse_keyed: false,
    text: 'During my life time I have had formal training on a musical instrument (including voice) for ___ years.',
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
    id: 'me_q07',
    gold_msi: 'MT07',
    reverse_keyed: true /* negatively phrased: agreement means LESS training */,
    text: 'I would not consider myself a musician.',
    options: agreementOptions(true),
  }),
  Object.freeze({
    id: 'me_q08',
    gold_msi: null /* outside the Gold-MSI composite */,
    reverse_keyed: false,
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
 * their per-item scores (reversal already applied to the two negatively
 * phrased items); range 7..49 (Müllensiefen et al. 2014, Table 2: scale
 * minimum 7, maximum 49). */
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

/* Row padding is 0.5 rem (it was 0.75 rem): with the title and the intro
 * paragraph, eight two-line items at 0.75 rem pushed the Continue button below
 * the fold at 1440 x 900 (its bottom edge was at y = 926). At 0.5 rem it ends at
 * y = 862. The items and their wording are unchanged. */
function musicExperienceFormNode() {
  const itemRows = MUSIC_EXPERIENCE_ITEMS.map((item) => {
    const optionsHtml = item.options
      .map((o) => `<option value="${o.value}">${o.label}</option>`)
      .join('');
    return `
      <tr>
        <td style="padding: 0.5rem 0.75rem 0.5rem 0; vertical-align: top; max-width: 28rem;">
          ${item.text}
        </td>
        <td style="padding: 0.5rem 0; vertical-align: top;">
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
 * Gold-MSI MT composite score (sum of items 1..7 with the two negatively
 * phrased items reverse-scored, range 7..49) and the raw item codes. Returns `null` for the composite if any of the seven
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
