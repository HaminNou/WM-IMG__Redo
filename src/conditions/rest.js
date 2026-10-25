/**
 * Forced-rest screens used in the main task.
 *
 * Two flavours, one shared countdown primitive:
 *
 * (1) Inter-block rest. 30-second forced rest between Main A
 *     and Main B. Duration is locked (`config.blocks.rest_duration_s`) so
 *     the inter-block delay is uniform across participants — participants
 *     who took longer breaks could plausibly perform better on the next
 *     block for reasons unrelated to the manipulation.
 *
 * (2) Intra-block rest. A 30-second rest is spliced
 *     in after every 20 trials within each main block (so Main A gets two
 *     mid-block rests at trials 20→21 and 40→41, and Main B gets the same
 *     pattern at within-block trials 20→21 and 40→41 = overall 80→81 and
 *     100→101). 120 trials in a single sitting is enough to bake in
 *     fatigue effects that contaminate the design contrast; periodic
 *     forced rests bound that decay. After the timer hits zero the
 *     participant is shown a "press both arrow keys to start the next
 *     trial" gate (`resumeAfterRestGateNode`) — making them act before
 *     the next trial fires gives them a self-paced re-engagement step
 *     so a trial doesn't begin while they're still mid-stretch.
 *
 * Both flavours show a live countdown so the participant knows the rest
 * has a finite end. There is intentionally NO skip-early option: the
 * design guarantee is "at least 30 s of low-cognitive-load" and a skip
 * would let an eager participant collapse this to seconds.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';

import { config } from '../config.js';
import { stampTrialData, HINT_FLASH_AFTER_MS, HINT_FLASH_PERIOD_MS } from './shared.js';
import { uploadConsentAndPractice, uploadCheckpoint } from '../uploader.js';
import { getSessionObject } from '../storage.js';

const COUNTDOWN_ID = 'rest-countdown';
const TICK_MS = 1000;
/* The copy states what happens when the timer ends. After the inter-block rest
 * the Block 2 intro waits for Space (`mainBIntroNode`); after an intra-block
 * rest `resumeAfterRestGateNode` waits for both arrow keys. Neither advances by
 * itself, so neither message says "automatically". */
const DEFAULT_INTER_BLOCK_MESSAGE =
  'Take a short break. When the timer ends, you will press Space to start the next block.';
const DEFAULT_INTRA_BLOCK_MESSAGE = `Take a ${config.blocks.rest_duration_s}-second rest. When the timer ends, press both arrow keys to continue.`;

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
 * Build a forced-rest jsPsych node with a live countdown timer.
 *
 * @param {object} [opts]
 * @param {number} [opts.durationS]   override the rest duration in seconds (mainly for tests)
 * @param {string} [opts.blockLabel]  label for the data record (default 'inter_block')
 * @param {string} [opts.message]     short copy under the heading; defaults to the inter-block message
 * @param {string} [opts.heading]     heading text; defaults to 'Rest'
 * @returns {object}                  jsPsych trial object
 */
export function restNode({ durationS, blockLabel, message, heading, session } = {}) {
  const totalS = durationS ?? config.blocks.rest_duration_s;
  const totalMs = totalS * 1000;
  const copy = message ?? DEFAULT_INTER_BLOCK_MESSAGE;
  const title = heading ?? 'Rest';
  let uploadController = null;
  return {
    type: htmlKeyboardResponse,
    stimulus: `
      <div style="display: grid; place-items: center; gap: 1rem; height: 16rem;">
        <h2 style="margin: 0;">${title}</h2>
        <p data-voiceover-target style="opacity: 0.85; margin: 0;">${copy}</p>
        <div style="font-size: 4rem; line-height: 1;">
          <span id="${COUNTDOWN_ID}">${formatCountdown(totalS)}</span>
        </div>
      </div>
    `,
    choices: 'NO_KEYS',
    trial_duration: totalMs,
    on_load: () => {
      stampTrialData('rest_started_ts_ms', performance.now());

      /* Safety upload. The inter-block rest also sends the consent and
       * practice buckets; every rest sends a checkpoint file. It runs in the
       * background and is cancelled when the rest ends. */
      uploadController = new AbortController();
      void restUpload(session, uploadController.signal);

      const el = document.getElementById(COUNTDOWN_ID);
      if (!el) return;
      let remainingS = totalS;
      const tick = () => {
        remainingS -= 1;
        if (remainingS < 0) return;
        el.textContent = formatCountdown(remainingS);
      };
      const interval = setInterval(tick, TICK_MS);
      setTimeout(() => clearInterval(interval), totalMs + 100);
    },
    on_finish: (data) => {
      uploadController?.abort();
      uploadController = null;
      data.rest_ended_ts_ms = Math.round(performance.now());
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
      let leftPressed = false;
      let rightPressed = false;
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

      const onKeyDown = (e) => {
        if (e.key === 'ArrowLeft') {
          leftPressed = true;
          if (leftEl) leftEl.style.opacity = RESUME_DIM_OPACITY;
        } else if (e.key === 'ArrowRight') {
          rightPressed = true;
          if (rightEl) rightEl.style.opacity = RESUME_DIM_OPACITY;
        }
        if (leftPressed && rightPressed) {
          cleanup();
          /* End the trial. jsPsych v8: finishTrial advances the timeline. */
          window.jsPsych?.finishTrial?.({
            both_arrows_pressed: true,
            resume_latency_ms: Math.round(performance.now()),
          });
        }
      };
      document.addEventListener('keydown', onKeyDown);

      const cleanup = () => {
        stopFlashing();
        document.removeEventListener('keydown', onKeyDown);
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
 * @param {number[]} opts.restAfterWithinBlockTrials within-block trial numbers AFTER which to rest (e.g. [20, 40])
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
