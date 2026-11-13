/**
 * Rest screens used in the main task.
 *
 * Two flavours, one shared countdown primitive:
 *
 * (1) Inter-block rest. Between Main A and Main B: up to `config.blocks.inter_block_rest_max_s`
 *     (600 s = 10 minutes, shown as m:ss). It is a MAXIMUM. The participant may end it early by
 *     pressing BOTH arrow keys (Left and Right, the same simultaneous-press rule as the resume gate:
 *     both down within BOTH_KEYS_WINDOW_MS, each cleared on keyup). Arrow presses are ignored during
 *     the first `SKIP_GUARD_MS` (a key still held from the previous screen cannot end it). Space does
 *     nothing. If the full time elapses without that key press, the participant is sent back to
 *     Prolific (`interBlockRestTimeoutExit`: the screen-out helper uploads the rows collected so far,
 *     writes `exit_reason: 'inter_block_rest_timeout'` and redirects with the screen-out
 *     completion code). The real length varies by participant and is recorded on the rest row:
 *     `rest_planned_s`, `rest_actual_ms`, `rest_skipped` (ended early), `rest_timed_out`. Until
 *     2026-11-13 this rest was 30 s and forced; see pre-reg/AMENDMENT-inter-block-rest.md. After an
 *     early end the Block 2 intro follows and waits for Space.
 *
 * (2) Intra-block rest. A 30-second rest (`config.blocks.rest_duration_s`) is spliced
 *     in within each main block (see `src/scheduler/main-blocks.js`): Main A
 *     gets two mid-block rests after within-block trials 20 and 40 (gates
 *     21 and 41), and Main B gets three, after within-block trials 15, 30
 *     and 45 (overall 75→76, 90→91 and 105→106). 120 trials in a single
 *     sitting is enough to bake in fatigue effects that contaminate the design contrast; periodic
 *     forced rests bound that decay. After the timer hits zero the
 *     participant is shown a "press both arrow keys to start the next
 *     trial" gate (`resumeAfterRestGateNode`) — making them act before
 *     the next trial fires gives them a self-paced re-engagement step
 *     so a trial doesn't begin while they're still mid-stretch.
 *
 * Both flavours show a live countdown so the participant knows the rest has a finite end. The
 * intra-block rests have intentionally NO skip option: the design guarantee there is "at least
 * 30 s of low-cognitive-load" and a skip would let an eager participant collapse it to seconds.
 * Only the inter-block rest can be ended early.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';

import { config } from '../config.js';
import {
  stampTrialData,
  HINT_FLASH_AFTER_MS,
  HINT_FLASH_PERIOD_MS,
  BOTH_KEYS_WINDOW_MS,
} from './shared.js';
import { uploadConsentAndPractice, uploadCheckpoint } from '../uploader.js';
import { getSessionObject } from '../storage.js';
import { traceMarker } from '../debug/trace-adapters.js';
import { restLengthPhrase, restDurationText } from './rest-text.js';
import { screenOutExit } from '../screen-out.js';

const COUNTDOWN_ID = 'rest-countdown';
const URGENT_ID = 'rest-urgent';
const TICK_MS = 1000;
/* Arrow presses do nothing for this long after the inter-block rest appears. */
export const SKIP_GUARD_MS = 2000;
/* The last stretch of the inter-block rest is shown as urgent. */
export const URGENT_LAST_S = 60;
export const URGENT_LINE_TEXT =
  'Press both arrow keys now to continue, or you will be sent back to Prolific.';
export const INTER_BLOCK_TIMEOUT_REASON = 'inter_block_rest_timeout';
/* After the inter-block rest the Block 2 intro waits for Space (`mainBIntroNode`); after an
 * intra-block rest `resumeAfterRestGateNode` waits for both arrow keys. Neither advances by
 * itself, so neither message says "automatically". */
export function interBlockRestMessage(maxS = config.blocks.inter_block_rest_max_s) {
  const t = restDurationText(maxS);
  return `Take a break of up to ${t}. When you are ready to continue, press the Left and Right arrow keys together. If you are not back within ${t}, you will be sent back to Prolific.`;
}
const DEFAULT_INTRA_BLOCK_MESSAGE = `Take a ${restLengthPhrase(config.blocks.rest_duration_s)} rest. When the timer ends, press both arrow keys to continue.`;

/* Uploads started at a rest are cancelled when the rest ends, so no request
 * is in flight while a trial runs. Anything not sent is included in the next
 * checkpoint or in the end-of-session upload. */
async function restUpload(session, signal) {
  try {
    const active = session ?? (await getSessionObject());
    if (!active || signal.aborted) return;
    if (session) await uploadConsentAndPractice({ session, signal });
    if (signal.aborted) return;
    await uploadCheckpoint({ session: active, signal });
  } catch (err) {
    console.error('[rest] upload failed', err);
  }
}

/**
 * Build a rest jsPsych node with a live countdown timer.
 *
 * @param {object} [opts]
 * @param {number} [opts.durationS]   override the rest duration in seconds (mainly for tests)
 * @param {boolean} [opts.skippable]  true (default): the inter-block rest, up to 600 s by default;
 *                                    both arrow keys end it after the first SKIP_GUARD_MS and a
 *                                    natural end is a timeout (`rest_timed_out`). false: an
 *                                    intra-block rest, `config.blocks.rest_duration_s` by default,
 *                                    no early end.
 * @param {string} [opts.blockLabel]  label for the data record (default 'inter_block')
 * @param {string} [opts.message]     short copy under the heading; defaults to the inter-block message
 * @param {string} [opts.heading]     heading text; defaults to 'Rest'
 * @returns {object}                  jsPsych trial object
 */
export function restNode({
  durationS,
  skippable = true,
  blockLabel,
  message,
  heading,
  session,
} = {}) {
  const totalS =
    durationS ?? (skippable ? config.blocks.inter_block_rest_max_s : config.blocks.rest_duration_s);
  const totalMs = totalS * 1000;
  const copy = message ?? (skippable ? interBlockRestMessage(totalS) : DEFAULT_INTRA_BLOCK_MESSAGE);
  const title = heading ?? 'Rest';
  let uploadController = null;
  let interval = null;
  let keydownHandler = null;
  let keyupHandler = null;
  let startedAt = null;
  let skipped = false;
  const stopTimers = () => {
    if (interval) clearInterval(interval);
    interval = null;
    if (keydownHandler) document.removeEventListener('keydown', keydownHandler, true);
    if (keyupHandler) document.removeEventListener('keyup', keyupHandler, true);
    keydownHandler = null;
    keyupHandler = null;
  };
  const urgentLine = skippable
    ? `<p id="${URGENT_ID}" style="visibility: hidden; margin: 0; font-weight: 700; color: #b00020;">${URGENT_LINE_TEXT}</p>`
    : '';
  const setUrgent = (remainingS) => {
    if (!skippable) return;
    const urgent = remainingS <= URGENT_LAST_S;
    const count = document.getElementById(COUNTDOWN_ID);
    const line = document.getElementById(URGENT_ID);
    if (count) {
      count.style.color = urgent ? '#b00020' : '';
      count.style.fontWeight = urgent ? '700' : '';
    }
    if (line) line.style.visibility = urgent ? 'visible' : 'hidden';
  };
  return {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="display: grid; place-items: center; gap: 1rem; height: ${skippable ? '22rem' : '16rem'}; max-width: 38rem; margin: 0 auto; text-align: center;">
        <h2 style="margin: 0;">${title}</h2>
        <p ${skippable ? '' : 'data-voiceover-target '}style="opacity: 0.85; margin: 0;">${copy}</p>
        <div style="font-size: 4rem; line-height: 1;">
          <span id="${COUNTDOWN_ID}">${formatCountdown(totalS)}</span>
        </div>
        ${urgentLine}
      </div>
    `,
    choices: 'NO_KEYS',
    trial_duration: totalMs,
    on_load: () => {
      startedAt = performance.now();
      skipped = false;
      stampTrialData('rest_started_ts_ms', startedAt);
      traceMarker(`REST ${totalS} s (${blockLabel ?? 'inter_block'})`);

      /* Safety upload. The inter-block rest also sends the consent and
       * practice buckets; every rest sends a checkpoint file. It runs in the
       * background and is cancelled when the rest ends. */
      uploadController = new AbortController();
      void restUpload(session, uploadController.signal);

      /* Inter-block rest only: both arrow keys end it early (same rule as the resume gate), but
       * not during the first SKIP_GUARD_MS. The listeners are owned here (choices is NO_KEYS, so
       * the plugin has no keyboard listener); they are removed on every exit path (early end,
       * timer end, external finishTrial via on_finish). */
      if (skippable) {
        let leftDownTs = null;
        let rightDownTs = null;
        keydownHandler = (e) => {
          const k = String(e.key).toLowerCase();
          if (k !== 'arrowleft' && k !== 'arrowright') return;
          e.preventDefault();
          if (e.repeat || skipped) return;
          const now = performance.now();
          if (now - startedAt < SKIP_GUARD_MS) return;
          if (k === 'arrowleft') leftDownTs = now;
          else rightDownTs = now;
          if (
            leftDownTs === null ||
            rightDownTs === null ||
            Math.abs(leftDownTs - rightDownTs) > BOTH_KEYS_WINDOW_MS
          )
            return;
          skipped = true;
          const actual = Math.round(now - startedAt);
          stopTimers();
          window.jsPsych?.pluginAPI?.cancelAllKeyboardResponses?.();
          /* Deferred so the next screen (the Block 2 intro waits for Space) is not handed
           * this same keydown. */
          setTimeout(
            () => window.jsPsych?.finishTrial?.({ rest_skipped: true, rest_actual_ms: actual }),
            0
          );
        };
        keyupHandler = (e) => {
          const k = String(e.key).toLowerCase();
          if (k === 'arrowleft') leftDownTs = null;
          else if (k === 'arrowright') rightDownTs = null;
        };
        document.addEventListener('keydown', keydownHandler, true);
        document.addEventListener('keyup', keyupHandler, true);
      }

      const el = document.getElementById(COUNTDOWN_ID);
      if (!el) return;
      let remainingS = totalS;
      setUrgent(remainingS);
      const tick = () => {
        remainingS -= 1;
        if (remainingS < 0) {
          clearInterval(interval);
          interval = null;
          return;
        }
        el.textContent = formatCountdown(remainingS);
        setUrgent(remainingS);
      };
      interval = setInterval(tick, TICK_MS);
    },
    on_finish: (data) => {
      stopTimers();
      uploadController?.abort();
      uploadController = null;
      data.rest_ended_ts_ms = Math.round(performance.now());
      data.rest_planned_s = totalS;
      data.rest_skipped = skipped;
      if (data.rest_actual_ms === undefined && startedAt !== null) {
        data.rest_actual_ms = Math.round(performance.now() - startedAt);
      }
      /* Timed out = the inter-block rest ran its full length with no early end. An external
       * finish (debug skip, hidden nav) before the full length is neither. */
      data.rest_timed_out =
        skippable && !skipped && data.rest_actual_ms >= totalMs - TIMEOUT_TOLERANCE_MS;
    },
    data: {
      phase: 'rest',
      block_label: blockLabel ?? 'inter_block',
      duration_ms: totalMs,
    },
  };
}

/* jsPsych's trial_duration timer cannot fire early; this only absorbs rounding. */
const TIMEOUT_TOLERANCE_MS = 50;

/**
 * Exit after the inter-block rest ran out. Placed right after `restNode()`: when the last
 * inter-block rest row says `rest_timed_out`, the participant sees the explanation and is sent
 * back to Prolific with the screen-out completion code (rows collected so far are uploaded
 * first, `exit_reason: 'inter_block_rest_timeout'`). The Block 2 intro and everything after it
 * are then never reached. The redirect starts by itself after a short read time; the button
 * does it at once.
 */
export function interBlockRestTimeoutExit() {
  return screenOutExit({
    phase: INTER_BLOCK_TIMEOUT_REASON,
    exitReason: INTER_BLOCK_TIMEOUT_REASON,
    flush: true,
    autoSubmitAfterMs: AUTO_REDIRECT_MS,
    reasonHtml: () => `
      <h2>The session has ended</h2>
      <p>You did not return to the experiment within ${restDurationText(config.blocks.inter_block_rest_max_s)}, so the session has ended. You will now be sent back to Prolific.</p>
    `,
    condition: () => {
      const last = window.jsPsych?.data
        ?.get()
        .filter({ phase: 'rest', block_label: 'inter_block' })
        .last(1)
        .values()[0];
      return last?.rest_timed_out === true;
    },
  });
}
const AUTO_REDIRECT_MS = 4000;

/**
 * Build the intra-block rest node (30-second countdown spliced in mid-block).
 * Wrapper around `restNode` with intra-block copy and a distinct block label
 * so the rest rows for the two flavours are separable in the export.
 */
export function intraBlockRestNode({ durationS, blockLabel } = {}) {
  return restNode({
    durationS,
    skippable: false,
    blockLabel: blockLabel ?? 'intra_block',
    message: DEFAULT_INTRA_BLOCK_MESSAGE,
    heading: 'Rest',
  });
}

const RESUME_LEFT_KBD_ID = 'resume-left-kbd';
const RESUME_RIGHT_KBD_ID = 'resume-right-kbd';
const RESUME_DIM_OPACITY = '0.45';

/**
 * Re-engagement gate after an intra-block rest.
 *
 * The participant must press BOTH arrow keys (Left and Right, in either
 * order) before the next trial begins. Requiring an explicit two-key
 * press (rather than any-key or auto-advance) achieves three things:
 *   - It gives the participant a deliberate "I'm ready" act after the
 *     forced rest, so the next trial doesn't fire while they are still
 *     mid-sip / mid-stretch.
 *   - It rehearses the same Left / Right arrows used as the response keys
 *     for the upcoming trial, so the hands are physically on the keys.
 *   - It avoids accidental advance — pressing any single key by reflex
 *     during the rest doesn't gate the next trial.
 *
 * Implementation note. `htmlKeyboardResponse` ends on the FIRST matching
 * key, which would advance after one arrow. We therefore use it with
 * `choices: 'NO_KEYS'` and attach our own keydown listener that calls
 * `jsPsych.finishTrial()` only once both arrows have been seen.
 */
export function resumeAfterRestGateNode({ blockLabel } = {}) {
  const PROMPT_ID = 'resume-prompt-text';
  return {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="display: grid; place-items: center; gap: 1.25rem; height: 14rem;">
        <h2 style="margin: 0;">Ready to continue?</h2>
        <p id="${PROMPT_ID}" data-voiceover-target style="opacity: 0.85; margin: 0; font-size: 1.05rem; transition: opacity 200ms linear;">
          Press both Left
          <kbd id="${RESUME_LEFT_KBD_ID}" style="padding: 0.15rem 0.5rem; border: 1px solid rgba(0,0,0,0.35); border-radius: 4px; margin: 0 0.15rem;">←</kbd>
          and Right
          <kbd id="${RESUME_RIGHT_KBD_ID}" style="padding: 0.15rem 0.5rem; border: 1px solid rgba(0,0,0,0.35); border-radius: 4px; margin: 0 0.15rem;">→</kbd>
          arrow keys to start the next trial.
        </p>
      </div>
    `,
    choices: 'NO_KEYS',
    on_load: () => {
      traceMarker('REST over: waiting for both arrow keys');
      const leftEl = document.getElementById(RESUME_LEFT_KBD_ID);
      const rightEl = document.getElementById(RESUME_RIGHT_KBD_ID);
      const promptEl = document.getElementById(PROMPT_ID);

      /* Flash the prompt copy after HINT_FLASH_AFTER_MS so an inattentive
       * participant gets a visible "press the keys" reminder. Mirrors the
       * trial-start gate flash semantics — never auto-passes. */
      let flashTimeout = null;
      let flashInterval = null;
      let flashDim = false;
      const stopFlashing = () => {
        if (flashTimeout) {
          clearTimeout(flashTimeout);
          flashTimeout = null;
        }
        if (flashInterval) {
          clearInterval(flashInterval);
          flashInterval = null;
        }
        if (promptEl) promptEl.style.opacity = '0.85';
      };
      flashTimeout = setTimeout(() => {
        flashTimeout = null;
        flashInterval = setInterval(() => {
          if (!promptEl) return;
          flashDim = !flashDim;
          promptEl.style.opacity = flashDim ? '0.2' : '0.85';
        }, HINT_FLASH_PERIOD_MS);
      }, HINT_FLASH_AFTER_MS);

      /* Same rule as trialStartGateNode: both arrows must be DOWN together
       * (keydowns within BOTH_KEYS_WINDOW_MS, each cleared on keyup), so a
       * Left now and a Right seconds later do not pass. */
      let leftDownTs = null;
      let rightDownTs = null;
      let passed = false;
      const onKeyDown = (e) => {
        if (e.repeat || passed) return;
        const k = String(e.key).toLowerCase();
        if (k !== 'arrowleft' && k !== 'arrowright') return;
        e.preventDefault();
        const now = performance.now();
        if (k === 'arrowleft') {
          leftDownTs = now;
          if (leftEl) leftEl.style.opacity = RESUME_DIM_OPACITY;
        } else {
          rightDownTs = now;
          if (rightEl) rightEl.style.opacity = RESUME_DIM_OPACITY;
        }
        if (
          leftDownTs !== null &&
          rightDownTs !== null &&
          Math.abs(leftDownTs - rightDownTs) <= BOTH_KEYS_WINDOW_MS
        ) {
          passed = true;
          cleanup();
          /* End the trial. jsPsych v8: finishTrial advances the timeline. */
          window.jsPsych?.finishTrial?.({
            both_arrows_pressed: true,
            resume_latency_ms: Math.round(performance.now()),
          });
        }
      };
      const onKeyUp = (e) => {
        const k = String(e.key).toLowerCase();
        if (k === 'arrowleft') {
          leftDownTs = null;
          if (leftEl) leftEl.style.opacity = '';
        } else if (k === 'arrowright') {
          rightDownTs = null;
          if (rightEl) rightEl.style.opacity = '';
        }
      };
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('keyup', onKeyUp);

      const cleanup = () => {
        stopFlashing();
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup', onKeyUp);
      };
      const trial = window.jsPsych?.getCurrentTrial?.();
      if (trial && typeof trial === 'object') {
        trial._resume_gate_cleanup = cleanup;
      }
    },
    on_finish: () => {
      const trial = window.jsPsych?.getCurrentTrial?.();
      if (trial && typeof trial === 'object') {
        try {
          trial._resume_gate_cleanup?.();
        } catch {
          /* no-op */
        }
        trial._resume_gate_cleanup = null;
      }
    },
    data: {
      phase: 'rest_resume_gate',
      block_label: blockLabel ?? 'intra_block',
    },
  };
}

/**
 * Splice intra-block rest + resume-gate node pairs into an already-
 * gate-stamped main-block nodes array. Inserts a (rest, resume-gate) pair
 * BEFORE every gate whose within-block trial number sits in
 * `restAfterWithinBlockTrials` + 1 — i.e., a rest after trial 20 means
 * the pair is inserted just before the gate of trial 21.
 *
 * @param {object[]} nodes
 * @param {object} opts
 * @param {number} opts.blockStartOverall            overall trial number of this block's first trial (1 for Main A, 61 for Main B)
 * @param {number[]} opts.restAfterWithinBlockTrials within-block trial numbers AFTER which to rest (e.g. [20, 40] for Main A, [15, 30, 45] for Main B)
 * @param {string} opts.blockLabel                   passed through to the rest + gate data records
 * @param {number} [opts.durationS]                  rest duration override
 * @returns {object[]}                               new nodes array
 */
export function injectIntraBlockRests(nodes, opts) {
  const { blockStartOverall, restAfterWithinBlockTrials, blockLabel, durationS } = opts;
  const breakpoints = new Set(restAfterWithinBlockTrials.map((t) => t + 1));
  const result = [];
  for (const node of nodes) {
    const phase = node?.data?.phase;
    const isGate = phase && /_trial_start$/.test(phase);
    if (isGate && Number.isFinite(node.data.main_trial_number_overall)) {
      const withinBlock = node.data.main_trial_number_overall - blockStartOverall + 1;
      if (breakpoints.has(withinBlock)) {
        result.push(intraBlockRestNode({ durationS, blockLabel }));
        result.push(resumeAfterRestGateNode({ blockLabel }));
      }
    }
    result.push(node);
  }
  return result;
}

function formatCountdown(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
