/**
 * Objective audio checks (run after the volume / comfort step).
 *
 *   1. Headphone / stereo check (Woods et al., 2017, Atten Percept Psychophys
 *      79:2064; stimulus and scoring parameters as in that paper, see
 *      `AUDIO_CHECK`). Three 200 Hz tones: one in-phase at full level, one
 *      in-phase at -6 dB, one anti-phase (left = -right) at full level.
 *      Participants say which was quietest. On headphones the -6 dB tone is
 *      quietest; on loudspeakers the anti-phase tone cancels and is
 *      quietest. 6 trials. Recorded as `headphones_pass` (>= 5/6;
 *      chance of >= 5/6 is 0.018). Recorded, not an exclusion, because the
 *      consent allows speakers.
 *
 *   2. Pitch-direction check with the task's own tones. Two adjacent bank
 *      tones (about 14 % apart, the same spacing as the task); participants
 *      say whether the second tone was higher or lower. 8 trials at the
 *      participant's playback level, then 8 trials 12 dB lower. At the
 *      participant's level >= 7/8 is required (chance of >= 7/8 is 0.035);
 *      one retry after a prompt to raise the volume, then the session ends.
 *      The -12 dB block is recorded as a margin measure.
 *
 * If the audio system cannot be started within `AUDIO_START_TIMEOUT_MS`, or
 * playback throws, the trial is released with `playback_ok: false` so the
 * participant is never stuck; the answer is then scored like any other and a
 * pitch check that cannot be passed ends the session.
 *
 * Trial order and pitches use Math.random(), not the session PRNG, so the
 * counterbalancing stream is not changed. Plans are written to the data.
 */
import htmlButtonResponse from '@jspsych/plugin-html-button-response';
import callFunction from '@jspsych/plugin-call-function';
import { playStereoSine, getUserPlaybackGain, stopAllScheduledAudio } from '../audio/dsp.js';
import { playToneByIndex, getToneBank } from '../audio/tones.js';
import { getAudioContext, ensureRunning } from '../audio/context.js';
import { screenOutExit } from '../screen-out.js';
import { equalLoudnessGainDb70Phon } from '../audio/equal-loudness.js';
import { withTimeout } from '../async-util.js';

export const AUDIO_CHECK = Object.freeze({
  /* Parameters of Woods et al. (2017, Atten Percept Psychophys 79:2064): six
   * 3-AFC trials, 200 Hz tones of 1,000 ms with 100 ms on/off ramps, 500 ms
   * between tones, one tone 6 dB quieter, one tone phase-reversed across the
   * channels, pass at 5 of 6, no feedback. */
  headphone: {
    n_trials: 6,
    pass_min: 5,
    freq_hz: 200,
    dur_ms: 1000,
    ramp_ms: 100,
    gap_ms: 500,
    quiet_db: -6,
  },
  pitch: { n_trials: 8, pass_min: 7, margin_db: -12, max_attempts: 2 },
});

function shuffle(a) {
  const x = a.slice();
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

const PERMS = [
  ['ref', 'quiet', 'anti'],
  ['ref', 'anti', 'quiet'],
  ['quiet', 'ref', 'anti'],
  ['quiet', 'anti', 'ref'],
  ['anti', 'ref', 'quiet'],
  ['anti', 'quiet', 'ref'],
];

/** One trial per permutation, shuffled: each position holds the target twice. */
export function planHeadphoneTrials() {
  return shuffle(PERMS).map((order) => ({ order, correct: order.indexOf('quiet') }));
}

/** Adjacent-tone pairs spread over the bank, random direction. */
export function planPitchTrials(n = AUDIO_CHECK.pitch.n_trials, bankSize = 24) {
  const step = (bankSize - 1) / n;
  const los = Array.from({ length: n }, (_, k) =>
    Math.min(bankSize - 2, Math.floor(k * step + Math.random() * step))
  );
  return shuffle(los).map((lo) => {
    const up = Math.random() < 0.5;
    return { first: up ? lo : lo + 1, second: up ? lo + 1 : lo, correct: up ? 1 : 0 };
  });
}

export function scoreBlock(rows, passMin) {
  const n_correct = rows.filter((r) => r.correct === true).length;
  return { n_trials: rows.length, n_correct, passed: n_correct >= passMin };
}

/** Longest wait for the audio context to resume before a trial is released. */
export const AUDIO_START_TIMEOUT_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resume the audio context within a time limit; false if it could not be started. */
async function startAudio() {
  try {
    await withTimeout(ensureRunning(), AUDIO_START_TIMEOUT_MS, 'audio start');
    return true;
  } catch (err) {
    console.error('[audio-check] audio start failed', err);
    return false;
  }
}

function disableButtons(disabled) {
  document.querySelectorAll('button.jspsych-btn').forEach((b) => {
    b.disabled = disabled;
  });
}

async function playHeadphoneTrial(order) {
  const h = AUDIO_CHECK.headphone;
  if (!(await startAudio())) return false;
  const ctx = getAudioContext();
  const comp = equalLoudnessGainDb70Phon(h.freq_hz);
  let scheduleFailed = false;
  let t = ctx.currentTime + 0.15;
  for (let k = 0; k < 3; k++) {
    const kind = order[k];
    /* playStereoSine(freqHz, opts): frequency first, then ONE options object.
     * Resolves when the sound ends, so it is not awaited here (the three
     * sounds are scheduled up front on the audio clock); a rejection is
     * caught so it cannot go unhandled, and releases the trial as failed. */
    Promise.resolve(
      playStereoSine(h.freq_hz, {
        durationMs: h.dur_ms,
        rampMs: h.ramp_ms,
        gainDb: comp + (kind === 'quiet' ? h.quiet_db : 0),
        antiphase: kind === 'anti',
        when: t,
      })
    ).catch((err) => {
      scheduleFailed = true;
      console.error('[audio-check] headphone sound failed', err);
    });
    const el = document.getElementById(`hp-${k}`);
    setTimeout(() => el?.classList.add('on'), (t - ctx.currentTime) * 1000);
    setTimeout(() => el?.classList.remove('on'), (t - ctx.currentTime) * 1000 + h.dur_ms);
    t += (h.dur_ms + h.gap_ms) / 1000;
  }
  await sleep((t - ctx.currentTime) * 1000);
  return !scheduleFailed;
}

/** Run `play` with the answer buttons disabled; always re-enable them. */
async function playWithButtonsDisabled(play) {
  disableButtons(true);
  try {
    return await play();
  } catch (err) {
    console.error('[audio-check] playback failed', err);
    return false;
  } finally {
    disableButtons(false);
  }
}

function headphoneTrial(getPlan, i) {
  let t0 = 0;
  let playbackOk = false;
  return {
    type: htmlButtonResponse,
    stimulus: `
      <style>.hp-box{display:inline-block;margin:0 .5rem;padding:.6rem 1rem;border:1px solid #555;border-radius:4px;opacity:.5}
      .hp-box.on{opacity:1;background:#60a5fa}</style>
      <h2>Headphone check (${i + 1} of ${AUDIO_CHECK.headphone.n_trials})</h2>
      <p>You will hear three sounds. Which one was the <strong>quietest</strong>?</p>
      <div style="margin:1rem 0"><span id="hp-0" class="hp-box">1</span><span id="hp-1" class="hp-box">2</span><span id="hp-2" class="hp-box">3</span></div>`,
    choices: ['Sound 1', 'Sound 2', 'Sound 3'],
    on_load: async () => {
      playbackOk = await playWithButtonsDisabled(() => playHeadphoneTrial(getPlan()[i].order));
      t0 = performance.now();
    },
    on_finish: (data) => {
      const p = getPlan()[i];
      stopAllScheduledAudio();
      Object.assign(data, {
        check: 'headphone',
        trial_i: i,
        order: p.order,
        correct_pos: p.correct,
        chosen: data.response,
        chosen_kind: p.order[data.response] ?? null,
        correct: data.response === p.correct,
        playback_ok: playbackOk,
        rt_after_playback_ms: Math.round(performance.now() - t0),
        user_gain: getUserPlaybackGain(),
      });
    },
    data: { phase: 'headphone_check_trial' },
  };
}

export function headphoneCheckBlock() {
  let plan = [];
  const n = AUDIO_CHECK.headphone.n_trials;
  const intro = {
    type: htmlButtonResponse,
    stimulus: `<h2>Headphone check</h2>
      <p style="max-width:38rem;margin:0 auto 1rem">Next, a short listening check (about one minute).
      Keep your volume where you set it. If you are using headphones, please
      put them on now. If any sound is uncomfortable, lower the volume or stop at any time.</p>`,
    choices: ['Start'],
    data: { phase: 'headphone_check_intro' },
  };
  return {
    timeline: [
      intro,
      {
        type: callFunction,
        async: false,
        func: () => {
          plan = planHeadphoneTrials();
          return { plan };
        },
        data: { phase: 'headphone_check_plan' },
      },
      ...Array.from({ length: n }, (_, i) => headphoneTrial(() => plan, i)),
      {
        type: callFunction,
        async: false,
        func: () => {
          const rows = window.jsPsych.data
            .get()
            .filter({ phase: 'headphone_check_trial' })
            .last(n)
            .values();
          const s = scoreBlock(rows, AUDIO_CHECK.headphone.pass_min);
          /* `n_chose_anti`: how often the anti-phase sound was called quietest, the
           * signature of listening over loudspeakers (it cancels in the room);
           * distinguishes speaker listening from guessing. Recorded only. */
          const n_chose_anti = rows.filter((r) => r.chosen_kind === 'anti').length;
          return {
            ...s,
            headphones_pass: s.passed,
            pass_min: AUDIO_CHECK.headphone.pass_min,
            n_chose_anti,
          };
        },
        data: { phase: 'headphone_check_summary' },
      },
    ],
  };
}

function pitchTrial(getPlan, i, levelDb, label) {
  let t0 = 0;
  let playbackOk = false;
  return {
    type: htmlButtonResponse,
    stimulus: `<h2>Pitch-discrimination check (${i + 1} of ${AUDIO_CHECK.pitch.n_trials})</h2><p>Two tones will play. Was the <strong>second</strong> tone lower or higher than the first?</p>
      <p style="opacity:.6" id="pc-wait">Listen...</p>`,
    choices: ['Lower', 'Higher'],
    on_load: async () => {
      playbackOk = await playWithButtonsDisabled(async () => {
        const p = getPlan()[i];
        if (!(await startAudio())) return false;
        const ctx = getAudioContext();
        const peak = 0.25 * Math.pow(10, levelDb / 20);
        const t = ctx.currentTime + 0.2;
        playToneByIndex(p.first, { when: t, peak });
        playToneByIndex(p.second, { when: t + 0.75, peak });
        await sleep(1300);
        return true;
      });
      document.getElementById('pc-wait')?.remove();
      t0 = performance.now();
    },
    on_finish: (data) => {
      const p = getPlan()[i];
      const bank = getToneBank();
      stopAllScheduledAudio();
      Object.assign(data, {
        check: label,
        trial_i: i,
        level_db_rel_user: levelDb,
        first_idx: p.first,
        second_idx: p.second,
        first_hz: bank[p.first].freq_hz,
        second_hz: bank[p.second].freq_hz,
        correct_resp: p.correct,
        chosen: data.response,
        correct: data.response === p.correct,
        playback_ok: playbackOk,
        rt_after_playback_ms: Math.round(performance.now() - t0),
        user_gain: getUserPlaybackGain(),
      });
    },
    data: { phase: 'pitch_check_trial' },
  };
}

function pitchBlock(levelDb, label, onSummary = () => {}) {
  let plan = [];
  const n = AUDIO_CHECK.pitch.n_trials;
  return [
    {
      type: callFunction,
      async: false,
      func: () => {
        plan = planPitchTrials();
        return { plan, label };
      },
      data: { phase: 'pitch_check_plan' },
    },
    ...Array.from({ length: n }, (_, i) => pitchTrial(() => plan, i, levelDb, label)),
    {
      type: callFunction,
      async: false,
      func: () => {
        const rows = window.jsPsych.data
          .get()
          .filter({ phase: 'pitch_check_trial', check: label })
          .last(n)
          .values();
        const out = {
          label,
          level_db_rel_user: levelDb,
          ...scoreBlock(rows, AUDIO_CHECK.pitch.pass_min),
        };
        onSummary(out);
        return out;
      },
      data: { phase: 'pitch_check_summary' },
    },
  ];
}

/**
 * Pitch check at the participant's level (required, one retry) followed by
 * the -12 dB margin block (recorded only).
 */
export function pitchCheckChain() {
  let attempts = 0;
  let lastPass = false;
  const main = {
    timeline: [
      {
        timeline: [
          {
            type: htmlButtonResponse,
            stimulus: `<h2>Please raise the volume</h2><p style="max-width:38rem;margin:0 auto 1rem">
              Some tones were hard to tell apart. Raise your computer volume a little, then try again.
              If any sound is uncomfortable, lower the volume or stop at any time.</p>`,
            choices: ['Try again'],
            data: { phase: 'pitch_check_retry_hint' },
          },
        ],
        conditional_function: () => attempts >= 1,
      },
      ...pitchBlock(0, 'pitch_user_level', (s) => {
        lastPass = s.passed;
      }),
      {
        type: callFunction,
        async: false,
        func: () => {
          attempts += 1;
          return { attempt: attempts, passed: lastPass };
        },
        data: { phase: 'pitch_check_gate' },
      },
    ],
    loop_function: () => !lastPass && attempts < AUDIO_CHECK.pitch.max_attempts,
  };
  const exit = screenOutExit({
    phase: 'audio_check_fail',
    exitReason: 'audio_check_failed',
    reasonHtml: `<h2>Sorry, we cannot continue</h2>
      <p>The task needs every tone to be clearly audible and distinguishable.</p>`,
    condition: () => !lastPass,
    flush: true,
  });
  return {
    timeline: [main, exit, ...pitchBlock(AUDIO_CHECK.pitch.margin_db, 'pitch_margin_minus12')],
  };
}
