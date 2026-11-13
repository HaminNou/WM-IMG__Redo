/**
 * Rest screens used in the main task.
 *
 * Two flavours, one shared countdown primitive:
 *
 * (1) Inter-block rest. Between Main A and Main B: `config.blocks.inter_block_rest_duration_s`
 *     (120 s, shown as m:ss). The participant MAY SKIP it: a visible hint says so, Space is ignored
 *     during the first `SKIP_GUARD_MS` (a key still held from the previous screen cannot skip it),
 *     and after that Space ends the rest early. So the real length varies by participant and is
 *     recorded on the rest row: `rest_planned_s`, `rest_actual_ms`, `rest_skipped`. Until
 *     2026-11-13 this rest was 30 s, forced, with no skip (a uniform inter-block delay); see
 *     pre-reg/AMENDMENT-inter-block-rest.md. When the timer ends or the rest is skipped the Block 2
 *     intro follows and waits for Space.
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
 * Only the inter-block rest can be skipped.
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
import { restLengthPhrase } from './rest-text.js';

const COUNTDOWN_ID = 'rest-countdown';
const SKIP_HINT_ID = 'rest-skip-hint';
const TICK_MS = 1000;
/* Space does nothing for this long after the inter-block rest appears. */
export const SKIP_GUARD_MS = 2000;
export const SKIP_HINT_TEXT = 'You can skip the rest by pressing Space when you are ready.';
/* The copy states what happens when the timer ends. After the inter-block rest
 * the Block 2 intro waits for Space (`mainBIntroNode`); after an intra-block
 * rest `resumeAfterRestGateNode` waits for both arrow keys. Neither advances by
 * itself, so neither message says "automatically". */
const DEFAULT_INTER_BLOCK_MESSAGE =
  'Take a short break. When the timer ends, you will press Space to start the next block.';
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
 * @param {boolean} [opts.skippable]  true (default): the inter-block rest, 120 s by default, Space
 *                                    ends it after the first SKIP_GUARD_MS. false: an intra-block
 *                                    rest, `config.blocks.rest_duration_s` by default, no skip.
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
    durationS ??
    (skippable ? config.blocks.inter_block_rest_duration_s : config.blocks.rest_duration_s);
  const totalMs = totalS * 1000;
  const copy = message ?? DEFAULT_INTER_BLOCK_MESSAGE;
  const title = heading ?? 'Rest';
  let uploadController = null;
  let interval = null;
  let keydownHandler = null;
  let startedAt = null;
  let skipped = false;
  const stopTimers = () => {
    if (interval) clearInterval(interval);
    interval = null;
    if (keydownHandler) document.removeEventListener('keydown', keydownHandler, true);
    keydownHandler = null;
  };
  const hint = skippable
    ? `<p id="${SKIP_HINT_ID}" style="opacity: 0.7; margin: 0; font-size: 0.95rem;">You can skip the rest by pressing <kbd>Space</kbd> when you are ready.</p>`
    : '';
  return {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="display: grid; place-items: center; gap: 1rem; height: ${skippable ? '19rem' : '16rem'};">
        <h2 style="margin: 0;">${title}</h2>
        <p data-voiceover-target style="opacity: 0.85; margin: 0;">${copy}</p>
        <div style="font-size: 4rem; line-height: 1;">
          <span id="${COUNTDOWN_ID}">${formatCountdown(totalS)}</span>
        </div>
        ${hint}
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

      /* Inter-block rest only: Space ends it early, but not during the first SKIP_GUARD_MS. The
       * handler is owned here (choices is NO_KEYS, so the plugin has no keyboard listener); it
       * is removed on every exit path (skip, timer end, external finishTrial via on_finish). */
      if (skippable) {
        keydownHandler = (e) => {
          if (e.key !== ' ' && e.code !== 'Space') return;
          e.preventDefault();
          if (e.repeat || skipped) return;
          if (performance.now() - startedAt < SKIP_GUARD_MS) return;
          skipped = true;
          const actual = Math.round(performance.now() - startedAt);
          stopTimers();
          window.jsPsych?.pluginAPI?.cancelAllKeyboardResponses?.();
          /* Deferred so the next screen (the Block 2 intro waits for Space) does not receive
           * this same keydown. */
          setTimeout(
            () => window.jsPsych?.finishTrial?.({ rest_skipped: true, rest_actual_ms: actual }),
            0
          );
        };
        document.addEventListener('keydown', keydownHandler, true);
      }

      const el = document.getElementById(COUNTDOWN_ID);
      if (!el) return;
      let remainingS = totalS;
      const tick = () => {
        remainingS -= 1;
        if (remainingS < 0) {
          clearInterval(interval);
          interval = null;
          return;
        }
        el.textContent = formatCountdown(remainingS);
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
    },
    data: {
      phase: 'rest',
      block_label: blockLabel ?? 'inter_block',
      duration_ms: totalMs,
    },
  };
}

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
