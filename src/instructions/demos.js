/**
 * Per-trial-type demonstration slides.
 *
 * Between each instruction screen and its practice block, a slowed-down
 * looping mini-trial walks the participant through what to expect.
 *
 * Approach: re-use the live visual primitives (createGridFrame, addDot,
 * addStar, addOpenSquare, pattern overlay) at the same physical scale and
 * colours as the real task, but with slowed pacing (4× real-trial timing —
 * see the DEMO_* constants), an updating caption that names each phase,
 * a button-press demonstration in every recognition/judgement event so the
 * participant SEES the green/red feedback rule applied (rather than only
 * reading about it). The participant does not respond inside the
 * mini-trial itself: each event's expected verdict is narrated by the
 * caption AND visually performed by an animated hand pressing the correct
 * button (with one deliberate wrong-key press per round so the participant
 * also sees the red-feedback case).
 *
 * After every full round, the caption box asks the participant whether
 * they want to watch the demonstration again — they click the on-screen
 * "Repeat the demonstration" button to replay, or press <strong>Space</strong>
 * to advance into the practice. Replay is mouse-only: there is no
 * keyboard shortcut for it, and the on-screen prompt does not mention
 * a Yes key (no key on a demo screen is labelled Yes). They can request
 * up to DEMO_MAX_REPLAYS = 3 additional viewings (= 4 total).
 *
 * Key handling on a demo screen is owned end-to-end by the controller-
 * managed keydown listener mounted in `buildDemoNode` — jsPsych itself
 * runs with `choices: 'NO_KEYS'` and never advances on a keypress. The
 * listener enforces two rules:
 *
 *   1. First viewing must be watched in full. `ctl.state.spaceArmed`
 *      starts false; the listener swallows Space while it's false, and
 *      `loopify` flips it true only AFTER the first `runMiniTrial(...)`
 *      returns. From that point on (post-roll prompt and every replay
 *      body) a Space press ends the trial and advances to practice —
 *      so a repeat viewing CAN be cancelled, but the very first viewing
 *      cannot. This is the same "passive watch / wait" policy applied
 *      to the forced-rest screens.
 *
 *   2. ArrowLeft and ArrowRight are always absorbed. There is no
 *      left/right decision on a demo screen (the replay button is
 *      mouse-only), so a stray response-key press during or after the
 *      animation cannot advance the trial or trigger a replay.
 *
 * The hidden-nav U / R skip is unaffected: its document-level listener
 * is registered separately, and the demo listener never calls
 * `stopImmediatePropagation`, so both fire in capture phase and
 * hidden-nav's `jsPsych.finishTrial(...)` path works exactly as it
 * does on every other screen.
 *
 * Cancellation: each schedule maintains a `state.cancelled` flag and
 * bails out of its setTimeout chain when the trial ends (Space advance
 * from the post-roll / replay body, or a hidden-nav U / R skip).
 * jsPsych's plugin tear-down then unmounts the SVG, so the dangling
 * timeouts find nothing to manipulate.
 *
 * Caption / voiceover handoff: every body-level caption transition is
 * routed through `ctl.advanceCaption(text)` rather than `setCaption`
 * directly. `advanceCaption` (a) awaits the previous caption's
 * voiceover to finish, (b) sleeps `DEMO_INTER_CAPTION_GAP_MS` for a
 * brief between-line beat, and (c) only then paints the new text. This
 * keeps the visible caption box in lockstep with the audio track — no
 * caption ever appears while the previous sentence is still being
 * spoken, and the box never blanks mid-sentence either (empty captions
 * are also routed through `advanceCaption` and wait for the prior
 * narration). The first caption in any schedule is still a plain
 * synchronous `setCaption(...)` — there is no prior narration at the
 * top of a demo, so the await would just add a stray 400 ms of dead
 * air. `advanceCaption` returns `false` on cancellation so callers
 * unwind cleanly when the participant Skips (Space) or U/R-skips a
 * demo mid-flight.
 *
 * Layout (single source of truth — see `demoFrameTemplate`):
 *   row 1  · title (fixed height, single line, never wraps), pinned at the
 *           top of the wrapper
 *   row 2  · weighted flex-grow spacer (flex: 3 0 0) — absorbs ≈ 75 % of
 *           leftover vertical space so the circle sits well below the
 *           title rather than crowding it. Has a `min-height: 2rem` floor
 *           so the gap never collapses entirely on short screens.
 *   row 3  · circle, horizontally centred on the monitor
 *   row 4  · caption panel directly UNDER the circle (also centred)
 *   row 5  · PERSISTENT watch-and-listen banner row (#demo-watch-banner-row)
 *           — slim, dashed-bordered "JUST WATCH AND LISTEN, DON'T RESPOND
 *           YET" pill. Mounted ONCE at the top of each mini-trial and
 *           stays visible for every phase of the demo, INCLUDING the
 *           probe / star-judgement loops where the demo itself animates
 *           a fake press: the participant is still supposed to just
 *           watch then, not respond. Hidden only at askReplay (genuine
 *           interaction point) and after the last replay is consumed.
 *   row 6  · response-button row UNDER the banner — mounted ONCE per
 *           mini-trial demo and persistent from the first event to the
 *           last. Labels update in place ("No / Yes" vs.
 *           "Not on-pattern / On-pattern") as the demo crosses from a
 *           star judgement to a recognition probe; the hand glyph fades
 *           in only during an actual press animation.
 *   row 7  · weighted flex-grow spacer (flex: 1 0 0) — absorbs the
 *           remaining ≈ 25 % of leftover space so the hint sits at the
 *           bottom of the wrapper, separated from the buttons.
 *   row 8  · "Press Space when ready" hint — pinned to the BOTTOM of the
 *           wrapper. The 3 : 1 spacer split (above-circle : above-hint)
 *           biases the circle into the lower half of the page while still
 *           leaving a clear gap between the buttons and the bottom hint.
 *
 * Visual frame language (matches the instruction screens): the participant
 * only ever sees the bull's-eye circle. Captions therefore say "circle" /
 * "location" instead of "grid" / "square". The pattern (only shown during
 * imagery-bearing demos) is the one and only moment the gray cells are
 * visible — including the centre cell, which joins the pattern's
 * visual gestalt and disappears with it. No stimulus ever appears at the
 * centre cell (logical exclusion enforced by `grid.js`).
 *
 * Rotation arrow (imagery-bearing demos): rendered as a standalone 100 px
 * `<img>` centred at the bull's-eye, NOT inside the central cell —
 * matching the trial's `arrowCueNode` exactly. The prelude shows the
 * upright pattern, then HIDES it before the arrow appears (the pattern
 * never coexists with the arrow on screen — that mirrors the live trial
 * where only the arrow is shown), then hides the arrow and re-displays
 * the pattern at the rotated angle so the participant sees what their
 * mental image should look like, before hiding it again for the encoding
 * sequence.
 *
 * Each loop iteration of an imagery-bearing demo samples a fresh integer
 * rotation angle from a curated set spanning -90° to +90° (excluding 0°),
 * so participants see several different rotations across the demo's
 * repetitions. Live trials sample any integer in [-90, 90] per the design.
 *
 * The demo phases (`demo_*`) are listed in the schema enum but carry no
 * analytical weight — they're instruction-only rows like
 * `instructions_memory_d_only`.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';
import { config } from '../config.js';
import { createGridFrame, clearStimuli, setFixation, setRotation } from '../visuals/frame.js';
import { buildPatternOverlay, showPattern, hidePattern } from '../visuals/pattern.js';
import { addDot, removeElement } from '../visuals/dot.js';
import { addStar, recolourStar } from '../visuals/star.js';
import { addOpenSquare } from '../visuals/dummy.js';
import { onPatternCells, offPatternCells } from '../grid.js';
import { playToneByCell } from '../audio/tones.js';
import { FEEDBACK_COLOR_CORRECT, FEEDBACK_COLOR_WRONG, sleep } from '../conditions/shared.js';
import { registerInstructionFactory, trackInstructionNode } from '../hidden-nav.js';
import { getSessionPRNG } from '../prng.js';
import {
  SLIDE_STYLE_DEMO,
  SLIDE_TITLE_ROW_STYLE,
  SLIDE_TITLE_H2_STYLE,
} from '../visuals/slide-layout.js';
import { getVoiceover, htmlToNarrationText } from '../visuals/voiceover.js';
import { ensureToggleMounted as ensureVoiceoverToggleMounted } from '../visuals/voiceover-slide.js';
import { continueHintHtml } from '../visuals/continue-hint.js';

/* Demo timings are 4× the live trial so the participant has time to read the
 * caption before the next event lands. Live values come from `config.js` and
 * `conditions/shared.js`; the dot duration is 1000 ms live. Stars and open
 * squares stay visible for their whole onset in the live task, and
 * recognition probes run back-to-back separated only by the post-probe
 * offset. The demos mirror that structure. */
const DEMO_TIMING_FACTOR = 4;
const DEMO_DOT_VISIBLE_MS = 1000 * DEMO_TIMING_FACTOR;
const DEMO_INTER_LOOP_MS = 2000;
/* Brief beat between the end of one caption's narration and the moment the
 * next caption is painted into the box. Without this gap a caption swap
 * would land on the same animation frame as the spoken sentence's final
 * word — visually correct, but read as back-to-back overlap. ~400 ms lets
 * the participant register the sentence end before the next one appears,
 * matching the conversational hand-off that voice UIs use between turns.
 * Skipped when the next caption is empty (just clearing the box) since
 * there is no new message for the dwell to give breathing room around. */
const DEMO_INTER_CAPTION_GAP_MS = 400;

/* Strict-serialisation gaps between a caption's narration and the stimulus
 * event that follows it. Each demo event happens one at a time: caption
 * paints, voiceover speaks and ends, EVENT_LEAD silence, stimulus event
 * fires and ends, EVENT_TAIL silence, next caption. EVENT_LEAD is also the
 * post-voiceover dwell before a recognition-probe stimulus (dot / tone) and
 * before the press-judgement stars. */
const DEMO_EVENT_LEAD_MS = 500;
const DEMO_EVENT_TAIL_MS = 400;
/* Post-stimulus dwell on press-judgement events (dot/tone probes,
 * on-/not-on-pattern stars): how long the stimulus stays visible (or
 * the probe tone has finished) before the hand-emoji begins its travel
 * to the button. Together with the hand reveal + travel (≈1150 ms) the
 * participant has ≈2.5 s to study before the press lands. */
const DEMO_STUDY_HOLD_MS = 1200;

/* Button-press animation budget (per recognition / star event). Each
 * judgement event must give the participant enough time to (a) READ the
 * caption, (b) STUDY the stimulus inside the circle, (c) WATCH the hand
 * emoji slide to a key and press it, and (d) READ the outcome caption
 * while the green/red feedback colour holds. The demo intentionally
 * decouples those four phases with explicit dwell windows rather than
 * chaining them tight — the participant is reading three things (caption,
 * stimulus, hand) at once, which they can't do at live-trial speed. */
const DEMO_BTN_REVEAL_MS = 700;
const DEMO_BTN_TRAVEL_MS = 450;
const DEMO_BTN_PRESS_MS = 220;
/* Beat between applying the green/red feedback colour to the on-grid
 * stimulus and swapping the caption box from the prompt ("Test X of 3:
 * was a dot...") to the outcome message ("We chose Yes — that was the
 * correct answer..."). Without this pause the colour change
 * and the new caption land on the same animation frame, so the
 * participant can only register one of the two before the demo races on
 * — they end up reading the outcome text and missing the colour, or
 * staring at the colour and missing the explanation. The dwell lets
 * them see the colour change cleanly in the circle, then look down to
 * read why. Used at every press-judgement site (D-only / T-only / I+D /
 * I+T recognition probes AND I-only / I+D / I+T star judgements). */
const DEMO_FEEDBACK_DWELL_MS = 1500;
/* Hidden-filler S-slot duration for the SINGLE-task demos (D-only, T-only,
 * I-only). The filler is an invisible open square that occupies the slot
 * a star/dummy would fill in the live trial, so the encoding sequence
 * still has the 6-slot rhythm the live task runs. In the demo the filler is
 * invisible and there is no caption to read during it, so the slot is
 * compressed to 1 s. The DUAL demos (I+D, I+T) do NOT
 * use fillers — their S-slots are real stars — so this constant only
 * applies to the three single-task schedules. */
const DEMO_HIDDEN_FILLER_SLOT_MS = 1000;

/* Curated set of integer rotation angles (multiples of 15° spanning
 * -90..+90, excluding 0°). Picked once per imagery-bearing demo loop via
 * the session PRNG, so participants see several distinct rotations across
 * a demo's repetitions instead of always the same angle.
 * The live task samples any integer in [-90, +90] per the design; these
 * 12 values are a representative subset that's quick to read and
 * unmistakably a rotation.  */
const DEMO_ROTATION_ANGLE_POOL = Object.freeze([
  -90, -75, -60, -45, -30, -15, 15, 30, 45, 60, 75, 90,
]);

function pickDemoRotationAngle() {
  return getSessionPRNG().pick(DEMO_ROTATION_ANGLE_POOL);
}

const ROTATION_ARROW_ASSET_URL = `${import.meta.env.BASE_URL}assets/rotation-arrow.png`;

/**
 * Demo HTML scaffold — see file-header layout description.
 *
 * Outer wrapper geometry comes from `slide-layout.js::SLIDE_STYLE_DEMO`
 * so the title's y-position and the bottom hint's y-position match the
 * calibration intros and the five Task 1–5 instruction decks. The title
 * row + H2 styles are also taken from the shared primitive.
 *
 * Vertical column inside the wrapper:
 *   title → spacer (flex 3) → circle → caption → watch-banner →
 *   buttons → spacer (flex 1) → hint.
 *
 * Every row has a fixed `min-height` so the column never reflows when a
 * caption gets longer/shorter or when buttons are mounted/unmounted.
 *
 * Width / height invariants:
 *   - Caption panel has `width: 30rem; min-height: 5rem` directly under
 *     the circle. Width is matched to the typical circle width so the two
 *     elements read as a single column.
 *   - Button row has `min-height: 6.5rem` so it reserves space whether or
 *     not the press animation is active.
 *
 * The shared wrapper's `align-items: center` ensures the circle, caption,
 * buttons, and hint are all horizontally centred regardless of the
 * wrapper's max-width on the current viewport.
 *
 * The wrapper width is needed because jsPsych's default
 * `.jspsych-content { max-width: 720px }` would otherwise force the
 * longest title onto two lines on smaller screens — see the
 * `.jspsych-content:has(.demo-frame)` override in index.html that lifts
 * the cap whenever a demo is on screen.
 */
function demoFrameTemplate(taskNumber, title) {
  return `
    <style>
      @keyframes demo-caption-bump {
        0%   { transform: scale(0.97); opacity: 0.55; }
        55%  { transform: scale(1.02); opacity: 1; }
        100% { transform: scale(1);    opacity: 1; }
      }
      .demo-caption-bump { animation: demo-caption-bump 0.42s ease-out; }
      @keyframes demo-btn-press {
        0%   { transform: translateY(0)    scale(1);    box-shadow: 0 4px 0 rgba(0,0,0,0.35); }
        50%  { transform: translateY(3px)  scale(0.97); box-shadow: 0 1px 0 rgba(0,0,0,0.35); }
        100% { transform: translateY(0)    scale(1);    box-shadow: 0 4px 0 rgba(0,0,0,0.35); }
      }
      .demo-btn-pressed { animation: demo-btn-press 0.22s ease-out; }
      /* Demo "key" buttons render as dark-ink pills on the gray card —
       * matching the caption and hint styling. The
       * box-shadow remains a thin black bar for the depressible-key
       * affordance that the press-animation keyframe targets. */
      .demo-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 9rem;
        padding: 0.7rem 1.4rem;
        border-radius: 0.65rem;
        background: rgba(0,0,0,0.04);
        border: 1px solid rgba(0,0,0,0.30);
        color: rgba(0,0,0,0.85);
        font-size: 1.05rem;
        font-weight: 500;
        box-shadow: 0 4px 0 rgba(0,0,0,0.35);
        user-select: none;
        cursor: default;
        /* Participant is NEVER meant to click a demo button — the animated
         * hand glyph performs every press. Disabling pointer-events kills
         * the browser's default hover/focus paint that otherwise made the
         * buttons look interactive (and could falsely cue a response during
         * passive watch/listen phases). The replay button at end-of-demo
         * is the only clickable affordance and overrides this rule with
         * an inline pointer-events:auto + cursor:pointer style. */
        pointer-events: none;
      }
      /* Watch/listen banner lives in its OWN persistent slot
       * (#demo-watch-banner-row), one row ABOVE the response buttons —
       * NOT in the buttons-row itself, so it stays on screen when the
       * (demo-driven, non-interactive) response buttons mount. The banner persists throughout the
       * entire mini-trial, including the probe / star-judgement loops,
       * and is hidden only at askReplay (genuine end-of-demo decision)
       * and after the last replay is consumed.
       *
       * To prevent screen crowding when banner + buttons coexist, the
       * banner is compact (1.15rem font, 0.4rem 1.1rem padding). The
       * uppercase + bold + dashed-border treatment keeps it salient
       * without dominating the column. Single line within the 38rem
       * max-width on a typical viewport. */
      .demo-watch-banner {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        max-width: 38rem;
        padding: 0.4rem 1.1rem;
        border: 2px dashed rgba(119, 33, 57, 0.6);
        border-radius: 0.5rem;
        background: rgba(119, 33, 57, 0.08);
        color: rgba(119, 33, 57, 1);
        font-size: 1.15rem;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        line-height: 1.2;
        user-select: none;
        pointer-events: none;
      }
      /* Two hand glyphs — one resting under each key cap (left ✋ on the
       * left arrow, right 🤚 on the right arrow). Both stay visible across
       * the entire response phase so the participant sees the realistic
       * two-hand keyboard posture they will adopt for the practice and
       * main task. Only the responding hand wiggles (up/down) to simulate
       * a press; the non-responding hand stays put. This models the
       * bimanual setup expected on the actual keyboard (left hand on ←,
       * right hand on →). */
      .demo-hand {
        font-size: 3.6rem;
        line-height: 1;
        opacity: 0;
        pointer-events: none;
        user-select: none;
        margin-top: 0.35rem;
        transition: opacity 250ms ease-out;
        transform: translateY(0);
        filter: grayscale(1) brightness(0.45) drop-shadow(0 2px 4px rgba(0,0,0,0.25));
      }
      .demo-hand.is-visible { opacity: 1; }
      @keyframes demo-hand-wiggle {
        0%   { transform: translateY(0) scale(1);
               filter: grayscale(1) brightness(0.45) drop-shadow(0 2px 4px rgba(0,0,0,0.25)); }
        30%  { transform: translateY(-1.3rem) scale(1.22);
               filter: grayscale(0) brightness(0.85) drop-shadow(0 6px 12px rgba(0,0,0,0.3)); }
        60%  { transform: translateY(0.4rem) scale(0.93);
               filter: grayscale(0) brightness(0.85) drop-shadow(0 1px 2px rgba(0,0,0,0.15)); }
        80%  { transform: translateY(-0.1rem) scale(1.02);
               filter: grayscale(0.7) brightness(0.55) drop-shadow(0 2px 4px rgba(0,0,0,0.2)); }
        100% { transform: translateY(0) scale(1);
               filter: grayscale(1) brightness(0.45) drop-shadow(0 2px 4px rgba(0,0,0,0.25)); }
      }
      .demo-hand.is-pressing {
        animation: demo-hand-wiggle 520ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      /* Per-button keyboard-key indicator. A small key-cap glyph rendered
       * directly below each demo button so the participant sees which
       * physical arrow key maps to which response, persistently — exactly
       * the same visual the deck pages use ("<kbd>&rarr;</kbd> RIGHT
       * arrow") but here it sits in the live demo's button row. The key
       * is decorative (aria-hidden); the button label already carries
       * the response meaning for assistive tech. */
      .demo-btn-stack {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        gap: 0.4rem;
      }
      .demo-btn-key {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 1.6rem;
        height: 1.6rem;
        padding: 0 0.35rem;
        border: 1px solid rgba(0, 0, 0, 0.35);
        border-bottom-width: 2px;
        border-radius: 0.3rem;
        background: rgba(255, 255, 255, 0.55);
        font-size: 1.05rem;
        line-height: 1;
        color: rgba(0, 0, 0, 0.8);
        user-select: none;
        pointer-events: none;
      }
    </style>
    <div class="demo-frame" style="${SLIDE_STYLE_DEMO}">
      <div style="${SLIDE_TITLE_ROW_STYLE}">
        <h2 style="${SLIDE_TITLE_H2_STYLE}">Demonstration of Task ${taskNumber} — ${title}</h2>
      </div>

      <div class="demo-spacer-above-circle" style="
        flex: 3 0 0;
        min-height: 9rem;
      "></div>

      <div id="demo-mount" style="
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-top: 1rem;
      "></div>

      <div style="
        flex: 0 0 auto;
        width: 30rem;
        max-width: 90vw;
        height: 6rem;
        margin-top: 1rem;
        padding: 0.85rem 1.15rem;
        border-radius: 0.75rem;
        background: rgba(0, 0, 0, 0.04);
        border: 1px solid rgba(0, 0, 0, 0.18);
        border-left: 3px solid #772139;
        box-shadow: 0 0 0 1px rgba(0,0,0,0.04) inset;
        display: flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
      ">
        <p id="demo-caption" style="
          margin: 0;
          text-align: center;
          color: rgba(0,0,0,0.85);
          font-size: 1.05rem;
          line-height: 1.45;
          font-weight: 400;
        "></p>
      </div>

      <!-- Persistent slot for the "Just watch and listen, don't respond yet"
           banner (see .demo-watch-banner CSS above). Lives on its own row
           ABOVE the response-buttons row so it can coexist with the
           (demo-driven, non-interactive) buttons during probe / star-
           judgement loops, rather than being replaced by them. Reserves a
           fixed min-height so the column doesn't reflow when the banner
           is hidden at askReplay. -->
      <div id="demo-watch-banner-row" style="
        flex: 0 0 auto;
        width: 100%;
        min-height: 2.4rem;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-top: 0.75rem;
      "></div>

      <div id="demo-buttons-row" style="
        flex: 0 0 auto;
        width: 100%;
        min-height: 6.5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-top: 0.4rem;
      "></div>

      <!-- Bottom-of-viewport reserve so the in-flow content above can never
           bleed under the pinned hint pill on shorter viewports. Matches the
           pinned hint's height (~3.5rem pill + ~1.5rem bottom offset). -->
      <div class="demo-spacer-above-hint" style="
        flex: 0 0 auto;
        height: 5rem;
      "></div>
    </div>

    <!-- Continue-hint pill PINNED to the viewport. Placed outside the
         demo-frame element so position:fixed is unambiguous and the pill's
         y is anchored to the viewport (not the slide), guaranteeing:
         (a) the participant never has to scroll to see "Press Space when
             you are ready", and
         (b) the pill sits at exactly the same y across all five demo
             slides regardless of the in-flow content above.
         z-index 5 keeps it above the slide background but below modal /
         tooltip layers (which sit at 1000+).

         Visibility. The pill is rendered fully
         transparent and aria-hidden so the participant cannot see (or
         have a screen reader read) the press-Space prompt while a
         demo mini-trial is playing. The controllers setSpaceArmed
         method flips opacity to 1 and aria-hidden to false the instant
         the demos events finish (post-roll prompt or last-demonstration
         handoff), and flips it back when a replay starts. Pill
         visibility is therefore the visible mirror of state.spaceArmed,
         which the keydown listener already consults to decide whether
         a Space press is honoured, so the message and the working key
         always agree. -->
    <div id="demo-hint" aria-hidden="true" style="
      position: fixed;
      left: 50%;
      bottom: 1.5rem;
      transform: translateX(-50%);
      z-index: 5;
      pointer-events: none;
      opacity: 0;
      transition: opacity 220ms ease-out;
    ">
      ${continueHintHtml(`Press <kbd>Space</kbd> when you are ready to start the practice for Task ${taskNumber}.`)}
    </div>
  `;
}

function makeDemoController() {
  /* `spaceArmed` controls whether a Space press can end the demo trial.
   *
   * The participant must watch the FIRST mini-trial all the way through —
   * skipping the very first viewing would let them advance to practice
   * without ever seeing the rule the demo is teaching. So `spaceArmed`
   * starts false, the keydown listener mounted in `buildDemoNode` no-ops
   * on Space while it's false, and `loopify` flips it true once the
   * first `runMiniTrial(...)` call returns. From that point on Space ends
   * the trial whether the participant is sitting on the post-roll
   * "Repeat the demonstration / Press Space to start the practice" prompt
   * OR has clicked Repeat and is part-way through a replay — both are
   * "they've already seen the demo once" states.
   *
   * ArrowLeft and ArrowRight are never armed: there is no left/right
   * decision to take on a demo screen (the only action is the replay
   * button, which is mouse-only by design), so arrow presses are
   * silently absorbed by the listener to prevent stray responses from
   * leaking into the next trial. */
  const state = { cancelled: false, spaceArmed: false, currentNarration: null };
  return {
    state,
    /**
     * Set the Space-armed state and mirror it on the pinned "Press
     * Space when you are ready…" pill (`#demo-hint`). Single source of
     * truth for the gate: the visible message and the working key are
     * always in lockstep, because they flow through this one method.
     *
     * Why this matters. The participant must watch each mini-trial in
     * full — both the very first viewing and any participant-requested
     * replay. Showing a "press Space" hint during a demo body would
     * invite an early exit and contradict the persistent
     * watch-and-listen banner mounted at the top of the demo, so the
     * pill is rendered fully transparent + `aria-hidden="true"` at
     * mount time and only emerges at the two genuine end-of-events
     * states: the post-roll replay prompt (`askReplay`) and the "last
     * demonstration" final handoff in `loopify`. A replay re-disarms
     * (pill fades, Space re-locks) so each viewing has the same
     * watch-only contract regardless of which iteration it is.
     *
     * Idempotent — calling with the current value is a no-op. Safe to
     * call before the DOM is mounted (the pill is queried lazily; a
     * missing element just skips the visual update).
     */
    setSpaceArmed(armed) {
      const next = Boolean(armed);
      state.spaceArmed = next;
      const hint = typeof document !== 'undefined' ? document.getElementById('demo-hint') : null;
      if (!hint) return;
      hint.style.opacity = next ? '1' : '0';
      hint.setAttribute('aria-hidden', next ? 'false' : 'true');
    },
    /**
     * Replace the caption text and trigger a brief scale/opacity bump so
     * the participant's eye is drawn to the new text every time it
     * changes — addressing the "make sure they're reading it" requirement
     * without resorting to a constant attention-grabbing animation.
     */
    setCaption(text) {
      const el = document.getElementById('demo-caption');
      if (!el) return;
      /* `innerHTML` (rather than textContent) so press-outcome captions
       * can highlight the verdict words — "correct" in green, "incorrect"
       * in red — matching the on-grid feedback colour and giving the
       * participant a second visual cue to the response outcome. All
       * captions are author-generated literals from this module, so
       * there's no untrusted input to sanitise. */
      el.innerHTML = text;
      /* Reflow trick: remove + force reflow + re-add so the keyframe
       * restarts every time, even when the same class is re-applied. */
      el.classList.remove('demo-caption-bump');
      void el.offsetWidth;
      el.classList.add('demo-caption-bump');
      /* Voiceover — speak the caption alongside the visual update.
       *
       *   - `htmlToNarrationText` strips the inline `<span style="color:…">`
       *     verdict highlights from press-outcome captions so the spoken
       *     audio reads "Yes — correct" rather than literal style soup.
       *   - The engine's `speak()` is already re-entrant: a new caption
       *     arriving mid-utterance cancels the previous spoken caption,
       *     keeping the audio track aligned with whatever text is
       *     currently visible. Empty / cleared captions (`setCaption('')`)
       *     produce empty narration text and `speak()` short-circuits to
       *     a no-op, so the audio falls silent in lockstep with the
       *     visual.
       *   - The returned controller is stashed on `state.currentNarration`
       *     so callers that gate on a clean handoff (e.g. the replay
       *     prompt, which must not interrupt the previous press-outcome
       *     readout) can `await ctl.awaitNarration()` before pushing
       *     the next caption.
       *   - Mute and unavailable-speech paths also short-circuit inside
       *     `speak()`, so this call is safe on every host.
       *   - The toggle pill mounted by the slide-narration observer on
       *     the preceding instruction screen remains visible throughout
       *     the demo, so the participant can mute / unmute mid-demo
       *     without leaving the page. */
      const narration = htmlToNarrationText(text);
      if (narration) {
        /* Defence-in-depth: mount the toggle pill if it isn't already
         * onscreen. In the natural session flow the preceding
         * instruction screen mounts it via the slide-narration
         * observer, but a tester (or future skip-into-demo flow) may
         * land on a demo without the toggle present — in which case
         * the participant would have audio they couldn't mute. Idempotent. */
        ensureVoiceoverToggleMounted();
        state.currentNarration = getVoiceover().speak(narration);
      } else {
        state.currentNarration = null;
      }
    },
    async wait(ms) {
      await sleep(ms);
      return !state.cancelled;
    },
    /**
     * Wait for the most-recently-issued caption narration to finish
     * before continuing. Returns `false` if the demo was cancelled
     * (participant pressed Space) while waiting, so callers can bail
     * out without pushing a stale caption. Returns `true` if the
     * narration completed (or there was nothing to wait for).
     *
     * Used at the boundary between a mini-trial's final press-outcome
     * caption and the replay prompt: without this gate, the replay
     * prompt's `setCaption(...)` would cancel the prior outcome
     * narration mid-sentence, because the in-demo dwell timers
     * are tuned
     * to visual pacing and can be shorter than the press-outcome's
     * spoken duration (~6–7 s for the longest "incorrect" form at
     * the Edge-TTS -15% rate).
     */
    async awaitNarration() {
      const ctrl = state.currentNarration;
      if (!ctrl?.done) return !state.cancelled;
      /* Race the narration against a cancellation poll so a Space
       * press during the wait is honoured promptly rather than
       * blocking until the spoken sentence ends. The poll interval
       * mirrors askReplay's existing 100 ms cadence. */
      await new Promise((resolve) => {
        let done = false;
        const settle = () => {
          if (done) return;
          done = true;
          resolve();
        };
        ctrl.done.then(settle).catch(settle);
        const poll = setInterval(() => {
          if (state.cancelled) {
            clearInterval(poll);
            settle();
          }
        }, 100);
        ctrl.done.finally(() => clearInterval(poll));
      });
      return !state.cancelled;
    },
    /**
     * Show the next caption only AFTER the previous caption's narration
     * has finished. Composes `awaitNarration()` + a brief inter-caption
     * dwell + `setCaption()` into a single helper so every body-level
     * caption transition in the demo schedules can enforce the
     * "no caption appears while the previous voiceover is still
     * speaking" invariant with one line.
     *
     * Returns `true` on a successful caption swap, `false` if the demo
     * was cancelled at any point during the wait (caller should bail).
     *
     * `setCaption('')` clears the caption — there is no new message for
     * the participant to register, so the inter-caption dwell is skipped
     * and the box clears immediately after the prior narration ends.
     *
     * Note: the FIRST caption inside any schedule is intentionally NOT
     * routed through here — there is no prior narration to await, so
     * a synchronous `setCaption(...)` is correct and avoids a stray
     * 400 ms delay at the top of every demo.
     */
    async advanceCaption(text) {
      if (state.cancelled) return false;
      if (!(await this.awaitNarration())) return false;
      if (text !== '') {
        await sleep(DEMO_INTER_CAPTION_GAP_MS);
        if (state.cancelled) return false;
      }
      this.setCaption(text);
      return true;
    },
    /**
     * Paint a new caption, start its voiceover, AND wait for that
     * voiceover to finish before returning. Used at every site where
     * the next thing to happen must not overlap the spoken sentence —
     * which is every stimulus event (tone playback,
     * dot/star appearance, hand-press animation) and every press-
     * outcome handoff. Equivalent to `advanceCaption(text)` followed by
     * `awaitNarration()`; bundled so call sites read as one step.
     * Returns false on cancellation (Space press during narration), so
     * callers can bail out of the demo cleanly.
     */
    async narrate(text) {
      if (!(await this.advanceCaption(text))) return false;
      if (!(await this.awaitNarration())) return false;
      return true;
    },
  };
}

/**
 * Add a 100 px standalone rotation-cue arrow centred at the bull's-eye.
 * Mirrors `arrowCueNode` in `conditions/shared.js`: same asset URL, same
 * absolute positioning over `frame.wrapper`, same translate(-50%, -50%) +
 * rotate(angle) transform. The arrow is NOT a child of the SVG — it
 * floats above so its size is in CSS px, decoupled from the calibrated
 * `--mm` coordinate system.
 */
function addStandaloneArrow(frame, angleDeg) {
  const px = config.imagery.rotation_arrow_size_px;
  const img = document.createElement('img');
  img.src = ROTATION_ARROW_ASSET_URL;
  img.alt = 'rotation cue';
  img.className = 'rotation-arrow-cue demo-arrow';
  /* The rotation-arrow PNG is mid-gray. On the light demo card it would
   * disappear into the background, so apply the same `brightness(0)` tint
   * used on trial frames — the cue renders as a solid black chevron
   * exactly as in the live trial. */
  img.setAttribute(
    'style',
    [
      'position: absolute',
      'top: 50%',
      'left: 50%',
      `width: ${px}px`,
      `height: ${px}px`,
      `transform: translate(-50%, -50%) rotate(${angleDeg}deg)`,
      'pointer-events: none',
      'z-index: 10',
      'user-select: none',
      'filter: brightness(0) saturate(100%) drop-shadow(1px 0 0 #fff) drop-shadow(-1px 0 0 #fff) drop-shadow(0 1px 0 #fff) drop-shadow(0 -1px 0 #fff)',
    ].join('; ') + ';'
  );
  frame.wrapper.appendChild(img);
  return img;
}

function removeStandaloneArrow(arrow) {
  if (arrow && arrow.parentNode) arrow.parentNode.removeChild(arrow);
}

/**
 * Rotation-teaching prelude — used only by the three imagery-bearing demos
 * (I-only, I+D, I+T).
 *
 * Phases — each driven by a caption update so the participant always knows
 * what they're looking at:
 *   (1) Upright pattern alone — "Here is the pattern. Picture it in your
 *       mind." The arrow is NOT on screen yet (the two are strictly
 *       sequential so the participant first commits the pattern to
 *       memory, then learns the rotation).
 *   (2) Pattern hidden, arrow alone — "An arrow tells you which way to
 *       turn the pattern in your mind." The participant cannot see the
 *       pattern moving; this matches the live trial exactly (only the
 *       arrow is shown there).
 *   (3) Arrow hidden, rotor snapped to the chosen angle, pattern shown
 *       again at the rotated angle — "This is how your rotated mental
 *       image should look." The snap (no animated rotation) reinforces
 *       that the operation is mental, not visual.
 *   (4) Pattern hidden — "Now keep this turned image in your mind." The
 *       rotor stays at `angleDeg` so the encoding stars / dummies that
 *       follow land at rotated cell positions, mirroring the live trial.
 *
 * Side-effects on `frame` (the caller must reset between demo loop
 * iterations):
 *   - Builds and shows the pattern overlay; hides it on exit.
 *   - Rotates the rotor to `angleDeg` and leaves it there.
 *   - Adds and removes the standalone rotation arrow.
 *
 * Returns `true` if the prelude completed, `false` if the participant
 * cancelled mid-prelude (caller should bail without continuing).
 */
async function runRotationTeachingPrelude(frame, ctl, angleDeg) {
  /* Voiceover-end-driven pacing: paint caption (which kicks off voiceover)
   * → await voiceover end → hold a short visual tail so the participant has
   * a beat to consolidate the just-spoken instruction → proceed. Pattern and
   * rotated-pattern tails are larger (visual study) than the arrow tail
   * (the arrow has been read by then). */
  const PATTERN_VISUAL_TAIL_MS = 1000;
  const ARROW_VISUAL_TAIL_MS = 600;
  const ROTATED_PATTERN_VISUAL_TAIL_MS = 1500;

  ctl.setCaption('Step 1 of 3 — Here is the pattern. Picture it in your mind.');
  buildPatternOverlay(frame);
  showPattern(frame);
  if (!(await ctl.awaitNarration())) return false;
  if (!(await ctl.wait(PATTERN_VISUAL_TAIL_MS))) return false;

  if (
    !(await ctl.advanceCaption(
      `Step 2 of 3 — An arrow tells you which way to turn the pattern in your mind (here, by ${angleDeg > 0 ? '+' : ''}${angleDeg}°).`
    ))
  ) {
    return false;
  }
  hidePattern(frame);
  const arrow = addStandaloneArrow(frame, angleDeg);
  if (!(await ctl.awaitNarration())) {
    removeStandaloneArrow(arrow);
    return false;
  }
  if (!(await ctl.wait(ARROW_VISUAL_TAIL_MS))) {
    removeStandaloneArrow(arrow);
    return false;
  }

  if (
    !(await ctl.advanceCaption(
      'Step 3 of 3 — This is how your rotated mental image should look. Hold this picture in your mind.'
    ))
  ) {
    removeStandaloneArrow(arrow);
    return false;
  }
  removeStandaloneArrow(arrow);
  /* Snap the rotor to the target angle while the pattern is hidden — the
   * rotation itself is invisible (no animation) and that is the point:
   * the live task has no visible rotation either. */
  setRotation(frame, angleDeg);
  showPattern(frame);
  if (!(await ctl.awaitNarration())) return false;
  if (!(await ctl.wait(ROTATED_PATTERN_VISUAL_TAIL_MS))) return false;

  hidePattern(frame);
  return true;
}

/* ─── Per-type demo schedules ────────────────────────────────────────── */

/**
 * Pick stable demo cells for each task — chosen by index from the
 * non-centre on/off-pattern pools so they never collide with the centre
 * cell and never duplicate each other within a slot.
 */
function pickDemoCells() {
  const onCells = onPatternCells();
  const offCells = offPatternCells();
  return {
    /* Memory items: 2 on-pattern + 1 off-pattern. The mix demonstrates that on/off labels vary per item. */
    memCells: [onCells[0], offCells[1], onCells[2]],
    /* M/S-slot fillers (open squares): different cells from above so the
     * demo's 6-slot sequence never repeats a cell. */
    fillerCells: [offCells[0], onCells[1], offCells[2]],
    /* Probes: 2 targets (T_on, T_off) + 1 foil (F_off). At set-size 3
     * trials must carry 1–2 targets; keeping 2 lets the demo show both
     * Yes-on and Yes-off correct-presses before the No-press. */
    probeCells: [
      { cell: onCells[0], isTarget: true, label: 'on' }, // T_on
      { cell: offCells[1], isTarget: true, label: 'off' }, // T_off
      { cell: offCells[4], isTarget: false, label: 'off' }, // F_off
    ],
    /* Star cells: 2 on-pattern (correct = On-pattern button) + 1 off-pattern. */
    starCells: [
      { cell: onCells[5], isOn: true },
      { cell: offCells[5], isOn: false },
      { cell: onCells[6], isOn: true },
    ],
  };
}

/* ─── Button + hand UI ──────────────────────────────────────────────── */

/**
 * Mount a left/right button pair plus a pair of resting hand glyphs in
 * the demo's reserved button row. The hands sit in the flow below each
 * arrow-key cap (left ✋ under ←, right 🤚 under →), persistently mirroring
 * the bimanual keyboard posture the participant will adopt for the
 * practice and main task. `animateButtonPress` reveals them and wiggles
 * only the responding hand.
 *
 * Persistent across the whole mini-trial: each demo (D-only / T-only /
 * I-only / I+D / I+T) calls this once at the top of its schedule. Labels
 * are baked into the mount call (Yes/No for recognition; On-pattern /
 * Not on-pattern for star judgements), so the demo remounts the row when
 * the scheme changes — same as before the two-hand refactor.
 *
 * Returns `{ container, leftBtn, rightBtn, leftKey, rightKey, leftHand,
 * rightHand }` or `null` if the button row is missing (defensive — should
 * never happen at runtime).
 */
function mountResponseButtons({ leftLabel, rightLabel }) {
  const row = document.getElementById('demo-buttons-row');
  if (!row) return null;
  /* Per-button column stacks: button on top, arrow-key cap, then a hand
   * glyph that sits under each cap. The two hands mirror the bimanual
   * keyboard posture the participant will use during practice and the
   * main task (left hand on ←, right hand on →); only the responding
   * hand wiggles during animateButtonPress while the other stays put. */
  row.innerHTML = `
    <div class="demo-buttons-container" style="
      position: relative;
      display: inline-flex;
      align-items: flex-start;
      gap: 1.25rem;
      padding: 0.5rem 0.5rem 0.75rem;
    ">
      <div class="demo-btn-stack">
        <button type="button" class="demo-btn" data-side="left">
          <span class="demo-btn-label">${leftLabel}</span>
        </button>
        <span class="demo-btn-key" data-side="left" aria-hidden="true">&larr;</span>
        <span class="demo-hand" data-side="left" aria-hidden="true">✋</span>
      </div>
      <div class="demo-btn-stack">
        <button type="button" class="demo-btn" data-side="right">
          <span class="demo-btn-label">${rightLabel}</span>
        </button>
        <span class="demo-btn-key" data-side="right" aria-hidden="true">&rarr;</span>
        <span class="demo-hand" data-side="right" aria-hidden="true">🤚</span>
      </div>
    </div>
  `;
  const container = row.querySelector('.demo-buttons-container');
  const leftBtn = row.querySelector('button[data-side="left"]');
  const rightBtn = row.querySelector('button[data-side="right"]');
  const leftKey = row.querySelector('.demo-btn-key[data-side="left"]');
  const rightKey = row.querySelector('.demo-btn-key[data-side="right"]');
  const leftHand = row.querySelector('.demo-hand[data-side="left"]');
  const rightHand = row.querySelector('.demo-hand[data-side="right"]');
  return { container, leftBtn, rightBtn, leftKey, rightKey, leftHand, rightHand };
}

function clearResponseButtons() {
  const row = document.getElementById('demo-buttons-row');
  if (row) row.innerHTML = '';
}

/**
 * Mount the large-print "JUST WATCH AND LISTEN, DON'T RESPOND YET"
 * banner in the dedicated #demo-watch-banner-row slot — one row ABOVE
 * the response-buttons row. Persistent across the entire
 * mini-trial: the banner stays visible during the rotation prelude,
 * the encoding sequence, retention, AND the recognition / star-
 * judgement loops where the demo's hand glyph animates a fake press.
 * The participant is never meant to respond during a demo — every
 * press they see is performed by the on-screen hand glyph — so the
 * "don't respond yet" reminder belongs on screen for the WHOLE
 * mini-trial, not just the passive windows.
 *
 * Idempotent: calling twice mounts the same markup, so this is safe
 * to call from every schedule's opening line without coordinating
 * with prior phases.
 *
 * Text is a single, consistent message — the user explicitly chose
 * this exact wording so the participant sees the same phrase every
 * time the banner is up. No per-modality variant: a single repeated
 * phrase is easier to recognise at a glance than three near-identical
 * variants.
 *
 * Returns `true` on success, `false` if the row is missing (defensive
 * — should never happen at runtime). `aria-live="polite"` so screen
 * readers announce the state change without interrupting the voiceover.
 */
function mountWatchListenBanner() {
  const row = document.getElementById('demo-watch-banner-row');
  if (!row) return false;
  row.innerHTML = `
    <div class="demo-watch-banner" role="status" aria-live="polite">
      Just watch and listen, don't respond yet
    </div>
  `;
  return true;
}

/**
 * Hide the persistent watch-and-listen banner. Used at the genuine
 * end-of-demo decision points where the participant IS expected to
 * interact: the askReplay prompt (mouse-click the replay button OR
 * press Space to advance) and the final "last demonstration" handoff.
 * Leaves the row reserved (min-height: 2.4rem in the template) so the
 * column doesn't reflow when the banner disappears.
 */
function hideWatchListenBanner() {
  const row = document.getElementById('demo-watch-banner-row');
  if (row) row.innerHTML = '';
}

/**
 * Reveal both resting hands (left ✋ on ←, right 🤚 on →). Idempotent —
 * safe to call before every press; the CSS opacity transition handles
 * the fade and re-applying `.is-visible` while already visible is a
 * no-op.
 */
function revealHands(controls) {
  if (!controls) return;
  controls.leftHand?.classList.add('is-visible');
  controls.rightHand?.classList.add('is-visible');
}

/**
 * Animate a simulated press: reveal both resting hands (if not already
 * shown), wiggle only the responding hand up and down to simulate
 * depressing the arrow key, then trigger the button's press animation.
 * The non-responding hand stays still — exactly mirroring the bimanual
 * keyboard posture the participant will use during the practice and
 * main task. Returns `false` if the demo was cancelled mid-animation so
 * the caller can bail.
 */
async function animateButtonPress(controls, side, ctl) {
  if (!controls) return true;
  revealHands(controls);
  if (!(await ctl.wait(DEMO_BTN_REVEAL_MS))) return false;

  const hand = side === 'right' ? controls.rightHand : controls.leftHand;
  if (hand) {
    hand.classList.remove('is-pressing');
    /* Force a reflow so re-applying the class restarts the keyframe
     * animation even when two presses on the same side fire back-to-back. */
    void hand.offsetWidth;
    hand.classList.add('is-pressing');
  }
  /* Let the wiggle reach roughly its "down" point before the button
   * paints the pressed state — the two animations should look like
   * one cause-and-effect rather than two independent events.
   * DEMO_BTN_TRAVEL_MS sets the wiggle-to-press overlap. */
  if (!(await ctl.wait(Math.min(DEMO_BTN_TRAVEL_MS, 220)))) return false;

  const btn = side === 'right' ? controls.rightBtn : controls.leftBtn;
  if (btn) {
    btn.classList.remove('demo-btn-pressed');
    void btn.offsetWidth;
    btn.classList.add('demo-btn-pressed');
  }
  if (!(await ctl.wait(DEMO_BTN_PRESS_MS))) return false;
  return true;
}

/**
 * Fade BOTH resting hands back out at the end of a press cycle. The
 * buttons stay mounted and visible across the whole mini-trial; only the
 * hands come and go so the "watch and listen, don't respond yet" windows
 * read as visually quiet (no hands hovering over keys) and the press
 * windows read as active.
 */
function hideHand(controls) {
  if (!controls) return;
  controls.leftHand?.classList.remove('is-visible', 'is-pressing');
  controls.rightHand?.classList.remove('is-visible', 'is-pressing');
}

/**
 * Format the press-result caption so the participant clearly links the
 * choice they "saw" pressed to the colour the stimulus turns. Phrasing
 * names the response by its meaning ("Yes" / "No" for recognition probes,
 * "On-pattern" / "Not on-pattern" for star judgements) rather than by
 * the underlying keyboard side — directional language ("right key" /
 * "left arrow") is not used, so participants see the response by its
 * label everywhere. The verdict word ("correct"
 * / "incorrect") is colour-matched to the on-stimulus feedback colour as
 * a second visual cue.
 */
/* Per-scheme side→label maps. The on-screen buttons (and therefore the
 * caption that names which one we "chose") are scheme-dependent: Yes/No
 * for recognition probes, On-pattern / Not on-pattern for star
 * judgements. The `pressedSide` / `correctSide` keys are still used
 * internally to drive the hand-emoji animation; only the participant-
 * visible label is scheme-aware. */
const PROBE_LABELS = Object.freeze({ left: 'No', right: 'Yes' });
const STAR_LABELS = Object.freeze({ left: 'Not on-pattern', right: 'On-pattern' });

function pressOutcomeCaption({ pressedLabel, correctLabel, isCorrect, stimulusName }) {
  const correctSpan = `<span style="color: ${FEEDBACK_COLOR_CORRECT}; font-weight: 600;">correct</span>`;
  const incorrectSpan = `<span style="color: ${FEEDBACK_COLOR_WRONG}; font-weight: 600;">incorrect</span>`;
  if (isCorrect) {
    return `We chose <strong>${pressedLabel}</strong> — that was the ${correctSpan} answer, so the ${stimulusName} turns green.`;
  }
  return `We chose <strong>${pressedLabel}</strong> — that was ${incorrectSpan}; the ${correctSpan} answer was <strong>${correctLabel}</strong>, so the ${stimulusName} turns red.`;
}

/* ─── Mini-trial schedules ──────────────────────────────────────────── */

/**
 * Run one D-only mini-trial: 6-slot encoding (3 dots + 3 invisible-square
 * fillers, interleaved) → retention → 3 dot probes with animated
 * button-press feedback (2 correct-presses + 1 deliberate wrong-press so
 * the participant sees both green and red outcomes inside the loop).
 */
async function runDOnlyMiniTrial(frame, ctl) {
  const { memCells, fillerCells, probeCells } = pickDemoCells();

  /* Mount the persistent WATCH-AND-LISTEN banner in its own row
   * (#demo-watch-banner-row). It stays visible for the entire mini-
   * trial — through encoding, retention, AND the probe loop where
   * the response buttons appear — and is hidden only at askReplay.
   * Buttons stay OUT of the DOM until the probe loop starts (see
   * `mountResponseButtons` call below the retention narration), so a
   * hovered cursor cannot give the false impression that a response
   * is needed yet. */
  mountWatchListenBanner();

  /* FIRST caption — a brief task-framing sentence so the participant
   * knows what the demo is about to show before any action begins.
   * One sentence is enough: the dots are an entirely visual encoding, and
   * the participant can see them appear, so there are no per-dot captions. */
  if (
    !(await ctl.narrate(
      'Memorize the locations of the dots that will appear inside the circle one at a time.'
    ))
  ) {
    return;
  }
  /* Caption box clears now and stays clear through the dot sequence so
   * the participant's attention is on the dots, not text. */
  if (!(await ctl.advanceCaption(''))) return;
  if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;

  for (let i = 0; i < 3; i++) {
    const dot = addDot(frame, memCells[i]);
    if (!(await ctl.wait(DEMO_DOT_VISIBLE_MS))) return;
    removeElement(dot);
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;

    /* Hidden-square slot: the filler that occupies the slot a star/dummy
     * fills in the live trial — invisible, silent. Compressed to
     * `DEMO_HIDDEN_FILLER_SLOT_MS`; no caption change needed since the
     * box is already empty. */
    const filler = addOpenSquare(frame, fillerCells[i], { visible: false });
    if (!(await ctl.wait(DEMO_HIDDEN_FILLER_SLOT_MS))) return;
    removeElement(filler);
  }

  /* Maintenance interval: narrate once, advance to recall as soon as
   * voiceover ends (+ tiny tail so the ? has a beat to register). */
  if (!(await ctl.narrate('Hold the dots in mind for a moment.'))) return;
  setFixation(frame, '?');
  if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;

  /* Probe loop begins — NOW the participant will see a response being
   * demonstrated, so the buttons replace the WATCH banner in the row
   * slot. They stay mounted across all three contiguous probes (no
   * banner flicker between probes); they will be cleared by `loopify`'s
   * end-of-loop teardown after the third probe completes. */
  const btns = mountResponseButtons({ leftLabel: 'No', rightLabel: 'Yes' });

  /* Press plan: probes 0..1 press correctly, probe 2 presses wrong. This
   * mixes Yes/No correct-presses with one wrong-press at the tail, so the
   * participant sees 2 green and 1 red feedback case per loop. */
  const wrongIndex = 2;
  for (let p = 0; p < probeCells.length; p++) {
    const probe = probeCells[p];
    const correctSide = probe.isTarget ? 'right' : 'left';
    const pressedSide =
      p === wrongIndex ? (correctSide === 'right' ? 'left' : 'right') : correctSide;

    if (!(await ctl.narrate(`Test ${p + 1} of 3: was a dot just shown in this location?`))) {
      return;
    }
    if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;
    const dot = addDot(frame, probe.cell);
    /* Post-stim study window: voiceover is already finished, so this is
     * pure looking-at-the-dot time before the hand begins moving. */
    if (!(await ctl.wait(DEMO_STUDY_HOLD_MS))) return;

    if (!(await animateButtonPress(btns, pressedSide, ctl))) return;

    const isCorrect = pressedSide === correctSide;
    dot.setAttribute('fill', isCorrect ? FEEDBACK_COLOR_CORRECT : FEEDBACK_COLOR_WRONG);
    if (!(await ctl.wait(DEMO_FEEDBACK_DWELL_MS))) return;
    if (
      !(await ctl.narrate(
        pressOutcomeCaption({
          pressedLabel: PROBE_LABELS[pressedSide],
          correctLabel: PROBE_LABELS[correctSide],
          isCorrect,
          stimulusName: 'dot',
        })
      ))
    ) {
      return;
    }

    hideHand(btns);
    removeElement(dot);
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;
  }

  setFixation(frame, '');
}

/**
 * Run one T-only mini-trial: 6-slot encoding (3 tones + 3 invisible-square
 * fillers, interleaved) → retention → 3 tone probes with animated
 * button-press feedback (2 correct + 1 wrong, same pattern as D-only).
 * Feedback colour is applied to the centre `?` glyph since the on-grid
 * stimulus is auditory.
 */
async function runTOnlyMiniTrial(frame, ctl) {
  const { memCells, fillerCells, probeCells } = pickDemoCells();

  /* Mount the persistent WATCH-AND-LISTEN banner — stays on screen
   * for the whole mini-trial (including the probe loop). Buttons are
   * not mounted until the probe loop begins (below), so a hovered
   * cursor cannot give the false impression that a response is
   * needed during encoding or retention. */
  mountWatchListenBanner();

  /* FIRST caption — brief task-framing sentence. The
   * participant then hears three tones in clean acoustic silence, with no
   * per-tone captions. */
  if (!(await ctl.narrate('Memorize each of the tones that will play one at a time.'))) {
    return;
  }
  if (!(await ctl.advanceCaption(''))) return;
  if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;

  for (let i = 0; i < 3; i++) {
    /* Tone played in clean acoustic silence (no per-tone voiceover any
     * more). The await on `playToneByCell` resolves when the Web Audio
     * node's `onended` fires (≈ tone duration + a small ramp-off tail). */
    await playToneByCell(memCells[i]).catch(() => {});
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;

    /* Hidden-square slot — see D-only for the rationale. */
    const filler = addOpenSquare(frame, fillerCells[i], { visible: false });
    if (!(await ctl.wait(DEMO_HIDDEN_FILLER_SLOT_MS))) return;
    removeElement(filler);
  }

  /* Maintenance interval — voiceover-end-driven (see D-only twin). */
  if (!(await ctl.narrate('Hold the tones in mind for a moment.'))) return;
  setFixation(frame, '?');
  if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;

  /* Probe loop begins — swap the LISTEN banner out for the response
   * buttons. They stay mounted across all three contiguous probes; the
   * loopify teardown will clear them after the third probe completes. */
  const btns = mountResponseButtons({ leftLabel: 'No', rightLabel: 'Yes' });

  const wrongIndex = 2;
  for (let p = 0; p < probeCells.length; p++) {
    const probe = probeCells[p];
    const correctSide = probe.isTarget ? 'right' : 'left';
    const pressedSide =
      p === wrongIndex ? (correctSide === 'right' ? 'left' : 'right') : correctSide;

    /* Probe tone first, then the spoken prompt asks about it. Same
     * tone-first rationale as the encoding loop above. */
    if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;
    await playToneByCell(probe.cell).catch(() => {});
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;

    if (!(await ctl.narrate(`Test ${p + 1} of 3: was that tone one of the ones you just heard?`))) {
      return;
    }
    if (!(await ctl.wait(DEMO_STUDY_HOLD_MS))) return;

    if (!(await animateButtonPress(btns, pressedSide, ctl))) return;

    const isCorrect = pressedSide === correctSide;
    setFixation(frame, '?', { color: isCorrect ? FEEDBACK_COLOR_CORRECT : FEEDBACK_COLOR_WRONG });
    if (!(await ctl.wait(DEMO_FEEDBACK_DWELL_MS))) return;
    if (
      !(await ctl.narrate(
        pressOutcomeCaption({
          pressedLabel: PROBE_LABELS[pressedSide],
          correctLabel: PROBE_LABELS[correctSide],
          isCorrect,
          stimulusName: 'question mark',
        })
      ))
    ) {
      return;
    }

    hideHand(btns);
    setFixation(frame, '?');
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;
  }

  setFixation(frame, '');
}

/**
 * Run one I-only mini-trial: rotation-teaching prelude → pattern hides →
 * 6 interleaved events (3 invisible placeholders + 3 stars in M/S order),
 * each star judged with the animated button-press demo (2 correct
 * presses + 1 wrong press across the three stars). The rotor stays at
 * `angle` throughout the events so stars/fillers land at rotated cell
 * positions, exactly as in the live encoding.
 */
async function runIOnlyMiniTrial(frame, ctl) {
  const angle = pickDemoRotationAngle();

  /* Mount the persistent WATCH-AND-LISTEN banner — stays on screen
   * for the whole mini-trial, including the rotation prelude and the
   * star-judgement loop. Buttons are not mounted until the star-
   * judgement loop begins (below). */
  mountWatchListenBanner();

  /* FIRST caption — brief task-framing sentence before the
   * rotation-teaching prelude starts. Lets the participant hear the
   * whole job in one breath before the step-by-step demonstration. */
  if (
    !(await ctl.narrate(
      'Picture the pattern, turn it in your mind, then judge whether each star falls on the rotated pattern.'
    ))
  ) {
    return;
  }

  if (!(await runRotationTeachingPrelude(frame, ctl, angle))) return;

  if (
    !(await ctl.narrate(
      'Now keep picturing the turned pattern. 3 stars will appear inside the circle. For each star, decide whether it falls <strong>on-pattern</strong> or <strong>not on-pattern</strong>.'
    ))
  ) {
    return;
  }
  if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;

  /* Clear the caption box once — per-star "Star X — judge it" prompts
   * are not used: the opener has already explained the rule, and the
   * participant can see the star inside the circle. */
  if (!(await ctl.advanceCaption(''))) return;

  /* Star-judgement loop starts now — every event is a press, so the
   * buttons replace the banner and stay mounted across all three stars
   * (invisible filler slots between them don't toggle the row). */
  const btns = mountResponseButtons({
    leftLabel: 'Not on-pattern',
    rightLabel: 'On-pattern',
  });

  const { fillerCells, starCells } = pickDemoCells();
  const wrongStarIndex = 2;
  for (let i = 0; i < 3; i++) {
    const filler = addOpenSquare(frame, fillerCells[i], { visible: false });
    if (!(await ctl.wait(DEMO_HIDDEN_FILLER_SLOT_MS))) return;
    removeElement(filler);

    const star = starCells[i];
    const correctSide = star.isOn ? 'right' : 'left';
    const pressedSide =
      i === wrongStarIndex ? (correctSide === 'right' ? 'left' : 'right') : correctSide;

    if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;
    const starEl = addStar(frame, star.cell);
    /* Post-stim study window: voiceover is already finished, so this
     * is pure look-at-the-star-against-the-turned-pattern time before
     * the hand begins moving. */
    if (!(await ctl.wait(DEMO_STUDY_HOLD_MS))) return;

    if (!(await animateButtonPress(btns, pressedSide, ctl))) return;

    const isCorrect = pressedSide === correctSide;
    recolourStar(starEl, isCorrect ? FEEDBACK_COLOR_CORRECT : FEEDBACK_COLOR_WRONG);
    if (!(await ctl.wait(DEMO_FEEDBACK_DWELL_MS))) return;
    if (
      !(await ctl.narrate(
        pressOutcomeCaption({
          pressedLabel: STAR_LABELS[pressedSide],
          correctLabel: STAR_LABELS[correctSide],
          isCorrect,
          stimulusName: 'star',
        })
      ))
    ) {
      return;
    }

    hideHand(btns);
    removeElement(starEl);
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;
  }
}

/**
 * Run one I+D mini-trial: rotation-teaching prelude → pattern hides →
 * 6 events (3 dots + 3 stars interleaved, each star with the animated
 * button-press demo) → retention → 3 dot probes with the same
 * button-press demo (2 correct + 1 wrong per phase).
 */
async function runIDMiniTrial(frame, ctl) {
  const angle = pickDemoRotationAngle();

  /* Mount the persistent WATCH-AND-LISTEN banner — stays on screen
   * for the entire mini-trial (rotation prelude → dot encoding →
   * star judgements → retention → dot probes). The banner sits in
   * its own row above the response-buttons row, so it remains
   * visible even when buttons are mounted for star judgements and
   * dot probes — the demo's hand glyph performs every press; the
   * participant is never meant to respond inside a demo. Each phase
   * still mounts/refreshes buttons only at the moment a press is
   * about to be DEMONSTRATED:
   *   - dot encoding: no buttons (banner only) — purely visual
   *   - star judgement: buttons (Not on-pattern / On-pattern)
   *   - retention: no buttons (banner only) — pure dwell
   *   - dot probes: buttons (No / Yes), mounted once, stay across all 3
   */
  mountWatchListenBanner();

  /* FIRST caption — brief task-framing sentence before the
   * rotation-teaching prelude starts. */
  if (
    !(await ctl.narrate(
      'Picture the rotated pattern, memorize the dot locations, and judge whether each star falls on the rotated pattern.'
    ))
  ) {
    return;
  }

  if (!(await runRotationTeachingPrelude(frame, ctl, angle))) return;

  if (
    !(await ctl.narrate(
      'Now keep picturing the turned pattern. 6 things appear inside the circle, mixed together: 3 dots to remember, 3 stars to judge as <strong>on-pattern</strong> or <strong>not on-pattern</strong>.'
    ))
  ) {
    return;
  }
  if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;

  /* Clear the caption box once — there are no per-event captions: the
   * opener already covered both rules and the participant can see the
   * kind of stimulus inside the circle. */
  if (!(await ctl.advanceCaption(''))) return;

  const { memCells, starCells, probeCells } = pickDemoCells();
  const wrongStarIndex = 2;
  for (let i = 0; i < 3; i++) {
    /* Dot encoding window — visual only, no response required. The
     * persistent watch-and-listen banner mounted at the top of this
     * mini-trial is still on screen (its own row, separate from the
     * buttons). Clear the buttons row so the prior iteration's star-
     * judgement buttons don't loiter on screen during encoding —
     * pedagogically the buttons should appear only for the phase
     * they actually apply to. The first iteration has no prior
     * buttons; clearing is a no-op there. */
    clearResponseButtons();
    if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;
    const dot = addDot(frame, memCells[i]);
    if (!(await ctl.wait(DEMO_DOT_VISIBLE_MS))) return;
    removeElement(dot);
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;

    const star = starCells[i];
    const correctSide = star.isOn ? 'right' : 'left';
    const pressedSide =
      i === wrongStarIndex ? (correctSide === 'right' ? 'left' : 'right') : correctSide;

    /* Star judgement: mount the response buttons (Not on-pattern /
     * On-pattern). The watch-and-listen banner stays visible above,
     * since the participant is still meant to just watch the demo's
     * hand glyph perform the press — not respond themselves. */
    const btns = mountResponseButtons({
      leftLabel: 'Not on-pattern',
      rightLabel: 'On-pattern',
    });

    if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;
    const starEl = addStar(frame, star.cell);
    /* Post-stim study window: voiceover is already finished, so this
     * is pure look-at-the-star-against-the-turned-pattern time before
     * the hand begins moving. */
    if (!(await ctl.wait(DEMO_STUDY_HOLD_MS))) return;

    if (!(await animateButtonPress(btns, pressedSide, ctl))) return;

    const isCorrect = pressedSide === correctSide;
    recolourStar(starEl, isCorrect ? FEEDBACK_COLOR_CORRECT : FEEDBACK_COLOR_WRONG);
    if (!(await ctl.wait(DEMO_FEEDBACK_DWELL_MS))) return;
    if (
      !(await ctl.narrate(
        pressOutcomeCaption({
          pressedLabel: STAR_LABELS[pressedSide],
          correctLabel: STAR_LABELS[correctSide],
          isCorrect,
          stimulusName: 'star',
        })
      ))
    ) {
      return;
    }

    hideHand(btns);
    removeElement(starEl);
    if (!(await ctl.advanceCaption(''))) return;
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;
  }

  /* Retention bridge — narrated, no response. The persistent banner
   * is still on screen from the top of the mini-trial; no need to
   * re-mount it. Clear the now-stale star-judgement buttons so they
   * don't linger during the retention narration. */
  clearResponseButtons();
  if (
    !(await ctl.narrate(
      'The question mark means the dot tests begin. You may let the picture go and focus on the dots.'
    ))
  ) {
    return;
  }
  if (!(await ctl.advanceCaption(''))) return;
  /* Probe phase begins — swap the previous (Not on-pattern / On-
   * pattern) labels out for the dot-probe (No / Yes) labels. The
   * watch-and-listen banner stays visible above through every probe;
   * the demo's hand glyph performs every press. */
  const btns = mountResponseButtons({ leftLabel: 'No', rightLabel: 'Yes' });
  setFixation(frame, '?');
  if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;

  const wrongProbeIndex = 2;
  for (let p = 0; p < probeCells.length; p++) {
    const probe = probeCells[p];
    const correctSide = probe.isTarget ? 'right' : 'left';
    const pressedSide =
      p === wrongProbeIndex ? (correctSide === 'right' ? 'left' : 'right') : correctSide;

    if (!(await ctl.narrate(`Dot test ${p + 1} of 3: was a dot shown in this location?`))) {
      return;
    }
    if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;
    const dot = addDot(frame, probe.cell);
    /* Post-stim study window: voiceover is already finished, so this
     * is pure looking-at-the-probe-dot time before the hand begins moving. */
    if (!(await ctl.wait(DEMO_STUDY_HOLD_MS))) return;

    if (!(await animateButtonPress(btns, pressedSide, ctl))) return;

    const isCorrect = pressedSide === correctSide;
    dot.setAttribute('fill', isCorrect ? FEEDBACK_COLOR_CORRECT : FEEDBACK_COLOR_WRONG);
    if (!(await ctl.wait(DEMO_FEEDBACK_DWELL_MS))) return;
    if (
      !(await ctl.narrate(
        pressOutcomeCaption({
          pressedLabel: PROBE_LABELS[pressedSide],
          correctLabel: PROBE_LABELS[correctSide],
          isCorrect,
          stimulusName: 'dot',
        })
      ))
    ) {
      return;
    }

    hideHand(btns);
    removeElement(dot);
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;
  }

  setFixation(frame, '');
}

/**
 * Run one I+T mini-trial: rotation-teaching prelude → pattern hides →
 * 6 events (3 tones + 3 stars interleaved, each star with the animated
 * button-press demo) → retention → 3 tone probes with the same
 * button-press demo. Star feedback colour is applied to the star;
 * tone-probe feedback colour is applied to the centre `?` glyph.
 */
async function runITMiniTrial(frame, ctl) {
  const angle = pickDemoRotationAngle();

  /* Mount the persistent WATCH-AND-LISTEN banner — stays on screen
   * for the entire mini-trial (rotation prelude → tone encoding →
   * star judgements → retention → tone probes). Same architecture
   * as I+D: banner sits in its own row above the response-buttons
   * row, so it remains visible even when buttons are mounted for
   * star judgements and tone probes — the demo's hand glyph
   * performs every press; the participant doesn't respond inside a
   * demo. Buttons appear only for star judgements and tone probes. */
  mountWatchListenBanner();

  /* FIRST caption — brief task-framing sentence before the
   * rotation-teaching prelude starts. */
  if (
    !(await ctl.narrate(
      'Picture the rotated pattern, memorize each tone, and judge whether each star falls on the rotated pattern.'
    ))
  ) {
    return;
  }

  if (!(await runRotationTeachingPrelude(frame, ctl, angle))) return;

  if (
    !(await ctl.narrate(
      'Now keep picturing the turned pattern. 6 things happen, mixed together: 3 tones to remember, 3 stars (inside the circle) to judge as <strong>on-pattern</strong> or <strong>not on-pattern</strong>.'
    ))
  ) {
    return;
  }
  if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;

  /* Clear the caption box once — there are no per-event captions: the
   * opener already covered both rules. */
  if (!(await ctl.advanceCaption(''))) return;

  const { memCells, starCells, probeCells } = pickDemoCells();
  const wrongStarIndex = 2;
  for (let i = 0; i < 3; i++) {
    /* Tone encoding — purely auditory, no response. The persistent
     * watch-and-listen banner mounted at the top of this mini-trial
     * is still on screen above the buttons row. Clear the buttons
     * row so the prior iteration's star-judgement buttons don't
     * loiter during encoding (no-op on iteration 1). */
    clearResponseButtons();
    if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;
    await playToneByCell(memCells[i]).catch(() => {});
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;

    const star = starCells[i];
    const correctSide = star.isOn ? 'right' : 'left';
    const pressedSide =
      i === wrongStarIndex ? (correctSide === 'right' ? 'left' : 'right') : correctSide;

    /* Star judgement: mount the response buttons (Not on-pattern /
     * On-pattern). The watch-and-listen banner stays visible above —
     * the hand glyph performs every press, the participant doesn't. */
    const btns = mountResponseButtons({
      leftLabel: 'Not on-pattern',
      rightLabel: 'On-pattern',
    });

    if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;
    const starEl = addStar(frame, star.cell);
    /* Post-stim study window: voiceover is already finished, so this
     * is pure look-at-the-star-against-the-turned-pattern time before
     * the hand begins moving. */
    if (!(await ctl.wait(DEMO_STUDY_HOLD_MS))) return;

    if (!(await animateButtonPress(btns, pressedSide, ctl))) return;

    const isCorrect = pressedSide === correctSide;
    recolourStar(starEl, isCorrect ? FEEDBACK_COLOR_CORRECT : FEEDBACK_COLOR_WRONG);
    if (!(await ctl.wait(DEMO_FEEDBACK_DWELL_MS))) return;
    if (
      !(await ctl.narrate(
        pressOutcomeCaption({
          pressedLabel: STAR_LABELS[pressedSide],
          correctLabel: STAR_LABELS[correctSide],
          isCorrect,
          stimulusName: 'star',
        })
      ))
    ) {
      return;
    }

    hideHand(btns);
    removeElement(starEl);
    if (!(await ctl.advanceCaption(''))) return;
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;
  }

  /* Retention bridge — narrated, no response. The persistent banner
   * is still on screen from the top of the mini-trial; no re-mount.
   * Clear the now-stale star-judgement buttons. */
  clearResponseButtons();
  if (
    !(await ctl.narrate(
      'The question mark means the tone tests begin. You may let the picture go and focus on the tones.'
    ))
  ) {
    return;
  }
  if (!(await ctl.advanceCaption(''))) return;
  /* Probe phase begins — swap the previous (Not on-pattern / On-
   * pattern) labels for (No / Yes). Banner stays above. */
  const btns = mountResponseButtons({ leftLabel: 'No', rightLabel: 'Yes' });
  setFixation(frame, '?');
  if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;

  const wrongProbeIndex = 2;
  for (let p = 0; p < probeCells.length; p++) {
    const probe = probeCells[p];
    const correctSide = probe.isTarget ? 'right' : 'left';
    const pressedSide =
      p === wrongProbeIndex ? (correctSide === 'right' ? 'left' : 'right') : correctSide;

    /* Probe tone first, then the prompt narration asks about it. */
    if (!(await ctl.wait(DEMO_EVENT_LEAD_MS))) return;
    await playToneByCell(probe.cell).catch(() => {});
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;

    if (
      !(await ctl.narrate(`Tone test ${p + 1} of 3: was that tone one of the ones you just heard?`))
    ) {
      return;
    }
    if (!(await ctl.wait(DEMO_STUDY_HOLD_MS))) return;

    if (!(await animateButtonPress(btns, pressedSide, ctl))) return;

    const isCorrect = pressedSide === correctSide;
    setFixation(frame, '?', { color: isCorrect ? FEEDBACK_COLOR_CORRECT : FEEDBACK_COLOR_WRONG });
    if (!(await ctl.wait(DEMO_FEEDBACK_DWELL_MS))) return;
    if (
      !(await ctl.narrate(
        pressOutcomeCaption({
          pressedLabel: PROBE_LABELS[pressedSide],
          correctLabel: PROBE_LABELS[correctSide],
          isCorrect,
          stimulusName: 'question mark',
        })
      ))
    ) {
      return;
    }

    hideHand(btns);
    setFixation(frame, '?');
    if (!(await ctl.wait(DEMO_EVENT_TAIL_MS))) return;
  }

  setFixation(frame, '');
}

/* Maximum number of replays the participant can request after the first
 * (mandatory) viewing. Three additional
 * viewings (= 4 total) is generous without becoming a stalling tactic. */
const DEMO_MAX_REPLAYS = 3;

/**
 * After a mini-trial finishes, offer the participant a single
 * "Repeat the demonstration" affordance inside the caption box. Resolves
 * with `true` if they request a replay (button click or right-arrow key)
 * and `false` if they decline by pressing Space (which jsPsych's
 * `htmlKeyboardResponse` owns as the trial-advance shortcut, flipping
 * `ctl.state.cancelled` via on_finish — the polling timer below catches
 * that and resolves false).
 *
 * There is intentionally NO "No, continue" button: the wrapper's bottom
 * hint already tells the participant to press Space when they are ready,
 * so a "No" button would just duplicate that single source of truth and
 * give them two ways to do the same thing. The left-arrow / No key is
 * therefore unbound here — pressing it has no effect, which is the
 * correct affordance for "there is no No option on this screen."
 *
 * The prompt copy and narration do NOT tell the participant to press
 * "Yes": no key here is labelled "Yes" (the No / Yes labels only appear
 * during the demonstration's own button row, which has been replaced by
 * this single replay button by the time `askReplay` runs), so the prompt
 * sticks to the visible affordance — the button — to avoid asking the
 * participant to press something that isn't on the screen.
 */
async function askReplay(ctl, replaysRemaining) {
  if (ctl.state.cancelled) return false;
  /* Hide the persistent watch-and-listen banner — askReplay is the
   * first moment in the demo where the participant is GENUINELY
   * expected to interact (click "Repeat the demonstration" or press
   * Space to start the practice). Leaving "don't respond yet" on
   * screen here would contradict the replay button's affordance and
   * confuse the handoff to the practice phase. */
  hideWatchListenBanner();
  /* The replay button gets a fresh mouse-clickable handler since the
   * press is a real participant decision (not a demo'd press). The row
   * wrapper around it stays centred via the parent flex container. */
  const row = document.getElementById('demo-buttons-row');
  if (!row) return false;
  row.innerHTML = `
    <div class="demo-buttons-container" style="
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 1.25rem;
      padding: 0.5rem 0.5rem 1rem;
    ">
      <button type="button" class="demo-btn demo-replay-btn" data-side="right" style="cursor: pointer; pointer-events: auto;">
        <span class="demo-btn-label">Repeat the demonstration</span>
      </button>
    </div>
  `;

  const remainingHint =
    replaysRemaining === 1
      ? ' (this is the last replay you can request)'
      : ` (you can watch up to ${replaysRemaining} more time${replaysRemaining === 1 ? '' : 's'})`;
  /* Wait for the press-outcome narration (which can run ~6–7s for the
   * longest "incorrect" form) to finish before overlaying the replay
   * prompt. The demo's visual dwells were tuned to visual pacing, not
   * audio length, so without this await the new setCaption would cancel
   * the prior voiceover mid-sentence. `advanceCaption` chains the wait
   * with the inter-caption dwell + setCaption — same invariant as every
   * other caption transition in the demos. */
  if (
    !(await ctl.advanceCaption(
      `Would you like to watch the demonstration again?${remainingHint} ` +
        'Click the button below to watch it again.'
    ))
  ) {
    return false;
  }

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (answer) => {
      if (resolved) return;
      resolved = true;
      const btns = row.querySelectorAll('.demo-replay-btn');
      btns.forEach((b) => b.removeEventListener('click', onClick));
      resolve(answer);
    };
    /* Replay is mouse-only. Arrow keys are absorbed by the demo node's
     * controller-owned keydown listener (see `buildDemoNode`), so there
     * is no keyboard shortcut to request a replay — only the on-screen
     * "Repeat the demonstration" button does that. Space is also handled
     * by that same listener: once the first viewing is complete (which
     * is necessarily true by the time we reach `askReplay`, because
     * `loopify` arms Space immediately before calling us), a Space press
     * ends the trial and flips `ctl.state.cancelled` via on_finish; the
     * polling timer below catches that and resolves false so the loop
     * unwinds cleanly into the practice. */
    const onClick = (e) => {
      const side = e.currentTarget.getAttribute('data-side');
      finish(side === 'right');
    };
    row.querySelectorAll('.demo-replay-btn').forEach((b) => b.addEventListener('click', onClick));

    const pollId = setInterval(() => {
      if (ctl.state.cancelled) {
        clearInterval(pollId);
        finish(false);
      }
      if (resolved) clearInterval(pollId);
    }, 100);
  });
}

/**
 * Wrap one mini-trial with the post-roll replay prompt. The demo runs
 * once; afterwards a single "Repeat the demonstration" affordance is
 * offered (capped at DEMO_MAX_REPLAYS additional views). The participant
 * either accepts the replay (button click only — there is no Yes key on
 * this screen) or proceeds to the practice by pressing Space.
 *
 * Space gating: the controller-owned keydown listener wired in
 * `buildDemoNode` only acts on Space when `ctl.state.spaceArmed === true`.
 * `spaceArmed` is flipped to true HERE, immediately after the first
 * `runMiniTrial(...)` returns — so during the first viewing's body the
 * participant cannot end the demo early, but from the post-roll prompt
 * onward (including the body of any replay) a Space press ends the trial
 * and advances to the practice. `askReplay`'s polling loop watches
 * `ctl.state.cancelled`, which the listener flips before calling
 * `jsPsych.finishTrial(...)`, so a mid-prompt Space press unwinds the
 * loop cleanly.
 */
function loopify(runMiniTrial) {
  return async function looped(frame, ctl) {
    let replaysUsed = 0;
    while (!ctl.state.cancelled) {
      try {
        await runMiniTrial(frame, ctl);
      } catch (err) {
        console.error('[demo] mini-trial error', err);
        return;
      }
      if (ctl.state.cancelled) return;

      /* Mini-trial events are finished — arm Space so the participant
       * can advance to practice (post-roll prompt) or skip the replay
       * decision and proceed. `setSpaceArmed(true)` also fades the
       * pinned "Press Space when you are ready…" pill in so the
       * visible message and the working key flip together. Re-disarmed
       * before each replay (see below) so the pill / key gate matches
       * every viewing — not just the first. */
      ctl.setSpaceArmed(true);

      const replaysRemaining = DEMO_MAX_REPLAYS - replaysUsed;
      if (replaysRemaining <= 0) {
        /* No more replays — the participant must Space into the
         * practice. Hide the watch-and-listen banner: the demo is
         * over, so the "don't respond yet" reminder does not
         * apply (and would visually contradict the "press Space
         * when ready" hint that this branch points to). */
        hideWatchListenBanner();
        /* `advanceCaption` waits for the press-outcome narration to
         * finish first, so the "last demonstration" caption doesn't
         * truncate it. */
        if (
          !(await ctl.advanceCaption(
            'That was the last demonstration. Press Space when you are ready to start the practice.'
          ))
        ) {
          return;
        }
        clearResponseButtons();
        return;
      }

      const wantsReplay = await askReplay(ctl, replaysRemaining);
      if (!wantsReplay) {
        /* Trial is cancelled (Space) by this point — `advanceCaption`
         * returns false immediately and the box is left as-is for the
         * imminent tear-down. (askReplay already hid the banner.) */
        await ctl.advanceCaption('Press Space when you are ready to start the practice.');
        clearResponseButtons();
        return;
      }
      replaysUsed += 1;

      /* Re-disarm Space for the replay viewing. The participant must
       * watch each viewing — including replays — to completion, so the
       * pinned "press Space" pill fades back out and a stray Space
       * press during the replay body is silently absorbed by the
       * keydown listener. `setSpaceArmed(true)` runs again at the top
       * of the next loop iteration once the replay mini-trial returns,
       * re-flipping both the pill and the gate. The
       * watch-and-listen banner is re-mounted by the individual demo
       * routines (`mountWatchListenBanner()` is called at the start of
       * each `run*Demo`) so its lifecycle matches the pill's. */
      ctl.setSpaceArmed(false);

      /* Tear down any lingering stimuli + buttons AND reset rotor +
       * pattern between loops so each iteration starts from a clean
       * upright circle with the next iteration's freshly-sampled
       * rotation angle (the imagery prelude calls `setRotation(angle)`
       * each time). */
      try {
        clearStimuli(frame);
        clearResponseButtons();
        setFixation(frame, '');
        frame.rotor.style.transition = '';
        setRotation(frame, 0);
        hidePattern(frame);
      } catch {
        /* frame may be in flux during tear-down; ignore. */
      }
      /* The participant just clicked the replay button — wait for the
       * replay-prompt narration to finish before showing the
       * "Replaying the demonstration…" handoff caption, so the two
       * lines don't talk over each other. */
      if (!(await ctl.advanceCaption('Replaying the demonstration…'))) return;
      if (!(await ctl.wait(DEMO_INTER_LOOP_MS))) return;
    }
  };
}

const runDOnlyDemo = loopify(runDOnlyMiniTrial);
const runTOnlyDemo = loopify(runTOnlyMiniTrial);
const runIOnlyDemo = loopify(runIOnlyMiniTrial);
const runIDDemo = loopify(runIDMiniTrial);
const runITDemo = loopify(runITMiniTrial);

function buildDemoNode({ phase, taskNumber, title, run, factory }) {
  const node = {
    type: htmlKeyboardResponse,
    stimulus: demoFrameTemplate(taskNumber, title),
    /* `choices: 'NO_KEYS'` (not `[' ']`) so jsPsych's plugin registers no
     * keyboard listener of its own. All key handling on a demo screen is
     * owned by the controller-managed listener wired below — that listener
     * implements the "first-viewing must be watched to the end" rule by
     * gating Space on `ctl.state.spaceArmed`, and absorbs ArrowLeft /
     * ArrowRight so accidental response-key presses cannot leak into the
     * next trial. The hidden-nav U / R skip remains functional: hidden-nav
     * registers its own document-level listener and ends the trial via
     * `jsPsych.finishTrial(...)`, independent of `choices`. */
    choices: 'NO_KEYS',
    response_ends_trial: false,
    on_load: () => {
      const mount = document.getElementById('demo-mount');
      if (!mount) return;
      /* Demo runs on the light card: pass
       * `background_shade: 'gray'` so `createGridFrame` plumbs the trial
       * palette (BULLSEYE_COLOUR_DARK, FIXATION_MARK_COLOUR_DARK,
       * STIMULUS_BLACK, PATTERN_FILLS_BY_BG.gray) onto the frame, and the
       * downstream live primitives (addDot, addStar, addOpenSquare,
       * buildPatternOverlay, setFixation) inherit it automatically via
       * `frame.stimulus_colour` / `frame.pattern_colour`. */
      const frame = createGridFrame({ rotation_deg: 0, fixation: '', background_shade: 'gray' });
      mount.appendChild(frame.wrapper);

      const ctl = makeDemoController();
      /* Stash on the live trial so on_finish can flip the cancel flag
       * regardless of whether the schedule has progressed. */
      const trial = window.jsPsych?.getCurrentTrial?.();
      if (trial && typeof trial === 'object') trial._demo_state = ctl.state;

      /* Document-level keydown listener owns Space + Arrow behaviour for
       * the entire demo lifetime:
       *   - Space: if `spaceArmed` is false (first viewing in progress),
       *     it's swallowed entirely. Once `loopify` flips `spaceArmed` to
       *     true after the first mini-trial completes, a Space press ends
       *     the demo trial (advances to the practice).
       *   - ArrowLeft / ArrowRight: always swallowed so the response-key
       *     fingers cannot drive trial advancement off a demo screen.
       *   - Anything else (notably U / R): not touched here, so hidden-nav
       *     can still claim it. Capture phase keeps our preventDefault
       *     ahead of any bubble-phase listener; we never call
       *     `stopImmediatePropagation`, so hidden-nav's own capture-phase
       *     listener (registered earlier at boot) still runs and gets a
       *     clean shot at U / R. */
      let listenerActive = true;
      const onKey = (e) => {
        if (!listenerActive) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.key === ' ' || e.code === 'Space') {
          e.preventDefault();
          e.stopPropagation();
          if (!ctl.state.spaceArmed) return;
          listenerActive = false;
          document.removeEventListener('keydown', onKey, true);
          ctl.state.cancelled = true;
          window.jsPsych?.finishTrial?.({ demo_advanced_via_space: true });
        }
      };
      document.addEventListener('keydown', onKey, true);
      if (trial && typeof trial === 'object') trial._demo_keydown_handler = onKey;

      void run(frame, ctl).catch((err) => {
        console.error(`[demo:${phase}] schedule error`, err);
      });
    },
    on_finish: () => {
      const trial = window.jsPsych?.getCurrentTrial?.();
      if (trial?._demo_state) trial._demo_state.cancelled = true;
      if (trial?._demo_keydown_handler) {
        document.removeEventListener('keydown', trial._demo_keydown_handler, true);
        trial._demo_keydown_handler = null;
      }
      try {
        getVoiceover().cancel();
      } catch {
        /* no-op */
      }
    },
    data: { phase },
  };
  registerInstructionFactory(phase, factory);
  return trackInstructionNode(node);
}

export function dOnlyDemoNode() {
  return buildDemoNode({
    phase: 'demo_d_only',
    taskNumber: 1,
    title: 'Remember the dots',
    run: runDOnlyDemo,
    factory: dOnlyDemoNode,
  });
}
export function tOnlyDemoNode() {
  return buildDemoNode({
    phase: 'demo_t_only',
    taskNumber: 2,
    title: 'Remember the tones',
    run: runTOnlyDemo,
    factory: tOnlyDemoNode,
  });
}
export function iOnlyDemoNode() {
  return buildDemoNode({
    phase: 'demo_i_only',
    taskNumber: 3,
    title: 'Picture the pattern',
    run: runIOnlyDemo,
    factory: iOnlyDemoNode,
  });
}
export function iDDemoNode() {
  return buildDemoNode({
    phase: 'demo_i_d',
    taskNumber: 4,
    title: 'Dots and pattern together',
    run: runIDDemo,
    factory: iDDemoNode,
  });
}
export function iTDemoNode() {
  return buildDemoNode({
    phase: 'demo_i_t',
    taskNumber: 5,
    title: 'Tones and pattern together',
    run: runITDemo,
    factory: iTDemoNode,
  });
}

/**
 * Enumerate every narration string the demos can ever speak — the literal
 * captions plus a full enumeration of every templated caption across the
 * small variable spaces (slot index i ∈ {0,1,2}, probe index p ∈ {0,1,2},
 * rotation angle ∈ DEMO_ROTATION_ANGLE_POOL, response labels, stimulus
 * names). The voiceover harvester (`scripts/harvest-voiceover.js`) imports
 * this and writes one strings.json entry per emitted caption so the Edge-
 * TTS renderer pre-builds an MP3 for every spoken line. Without this list,
 * setCaption() narration falls through to the browser's Web Speech
 * fallback because no manifest hash matches the runtime-composed text.
 *
 * Each returned string is the NARRATION text after `htmlToNarrationText`
 * has stripped inline `<span style=…>` colour highlights — i.e. the
 * canonical SPOKEN form, which is what the engine hashes against the
 * manifest at runtime.
 *
 * Kept in lockstep with the setCaption(…) call sites in this file:
 *   - prelude (runRotationTeachingPrelude) — 3 captions per imagery loop
 *   - per-task mini-trial schedules (runDOnly/TOnly/IOnly/ID/IT)
 *   - replay prompt (askReplay) — 3 plurality variants
 *   - end-of-demo prompts (loopify) — 2 fixed strings
 *   - pressOutcomeCaption — 12 stimulus×label combinations
 */
export function enumerateDemoNarrationStrings() {
  const out = new Set();

  /* Per-task one-shot prelude / setup captions. */
  out.add('Step 1 of 3 — Here is the pattern. Picture it in your mind.');
  for (const angle of DEMO_ROTATION_ANGLE_POOL) {
    const sign = angle > 0 ? '+' : '';
    out.add(
      `Step 2 of 3 — An arrow tells you which way to turn the pattern in your mind (here, by ${sign}${angle}°).`
    );
  }
  out.add(
    'Step 3 of 3 — This is how your rotated mental image should look. Hold this picture in your mind.'
  );

  /* D-only mini-trial. */
  out.add('Memorize the locations of the dots that will appear inside the circle one at a time.');
  out.add('Watch as dots appear one at a time. Try to remember the location of each dot.');
  out.add('Dot 1 — remember its location.');
  out.add('Last dot — remember its location.');
  for (let i = 0; i < 3; i++) {
    out.add(
      `Dot ${i + 1} — keep tracking each location.`
    ); /* i=1 used at runtime; cover all 3 defensively */
    out.add(`Dot ${i + 1} — remember its location.`);
  }
  out.add('Hold the dots in mind for a moment.');
  for (let p = 0; p < 3; p++) {
    out.add(`Test ${p + 1} of 3: was a dot just shown in this location?`);
  }

  /* T-only mini-trial. */
  out.add('Memorize each of the tones that will play one at a time.');
  out.add('Listen as tones play one at a time.');
  out.add('Tone 1 — listen and try to remember it.');
  out.add('Last tone — keep remembering each one.');
  for (let i = 0; i < 3; i++) {
    out.add(`Tone ${i + 1} — keep listening for each tone.`);
    out.add(`Tone ${i + 1} — listen and remember it.`);
  }
  out.add('Hold the tones in mind for a moment.');
  for (let p = 0; p < 3; p++) {
    out.add(`Test ${p + 1} of 3: was that tone one of the ones you just heard?`);
  }

  /* I-only mini-trial. */
  out.add(
    'Picture the pattern, turn it in your mind, then judge whether each star falls on the rotated pattern.'
  );
  out.add(
    'Now keep picturing the turned pattern. 3 stars will appear inside the circle. For each star, decide whether it falls on-pattern or not on-pattern.'
  );
  for (let i = 0; i < 3; i++) {
    out.add(`Star ${i + 1} of 3 — judge it against your turned pattern.`);
    out.add(`Star ${i + 1} — judge it against your turned pattern.`);
  }

  /* I+D mini-trial. */
  out.add(
    'Picture the rotated pattern, memorize the dot locations, and judge whether each star falls on the rotated pattern.'
  );
  out.add(
    'Now keep picturing the turned pattern. 6 things appear inside the circle, mixed together: 3 dots to remember, 3 stars to judge as on-pattern or not on-pattern.'
  );
  out.add(
    'The question mark means the dot tests begin. You may let the picture go and focus on the dots.'
  );
  for (let p = 0; p < 3; p++) {
    out.add(`Dot test ${p + 1} of 3: was a dot shown in this location?`);
  }

  /* I+T mini-trial. */
  out.add(
    'Picture the rotated pattern, memorize each tone, and judge whether each star falls on the rotated pattern.'
  );
  out.add(
    'Now keep picturing the turned pattern. 6 things happen, mixed together: 3 tones to remember, 3 stars (inside the circle) to judge as on-pattern or not on-pattern.'
  );
  out.add(
    'The question mark means the tone tests begin. You may let the picture go and focus on the tones.'
  );
  for (let p = 0; p < 3; p++) {
    out.add(`Tone test ${p + 1} of 3: was that tone one of the ones you just heard?`);
  }

  /* Replay prompt + end-of-demo. The remainingHint branch produces three
   * forms by replaysRemaining ∈ {1, 2, 3} (DEMO_MAX_REPLAYS = 3): "last
   * replay you can request" when 1; "you can watch up to N more time(s)"
   * for 2 and 3. */
  const replayLastForm = ' (this is the last replay you can request)';
  const replayMore = (n) => ` (you can watch up to ${n} more time${n === 1 ? '' : 's'})`;
  const replayBody = (hint) =>
    `Would you like to watch the demonstration again?${hint} ` +
    'Click the button below to watch it again.';
  out.add(replayBody(replayLastForm));
  out.add(replayBody(replayMore(2)));
  out.add(replayBody(replayMore(3)));
  out.add('That was the last demonstration. Press Space when you are ready to start the practice.');
  out.add('Press Space when you are ready to start the practice.');
  out.add('Replaying the demonstration…');

  /* pressOutcomeCaption variants. The narration text is the rendered HTML
   * with the inline `<strong>` and `<span style="color:…">` tags stripped
   * by htmlToNarrationText. The stripped form retains the inner text
   * verbatim (just collapsing tags), so the spoken sentence is the same
   * sentence with the markup removed. */
  const PROBE_LBLS = ['No', 'Yes'];
  const STAR_LBLS = ['Not on-pattern', 'On-pattern'];
  const cases = [
    { stim: 'dot', labels: PROBE_LBLS },
    { stim: 'question mark', labels: PROBE_LBLS },
    { stim: 'star', labels: STAR_LBLS },
  ];
  for (const { stim, labels } of cases) {
    for (const pressed of labels) {
      /* Correct branch. */
      out.add(`We chose ${pressed} — that was the correct answer, so the ${stim} turns green.`);
      /* Incorrect branch — paired with the other label as the correct one. */
      const correct = labels.find((l) => l !== pressed);
      out.add(
        `We chose ${pressed} — that was incorrect; the correct answer was ${correct}, so the ${stim} turns red.`
      );
    }
  }

  return Array.from(out);
}
