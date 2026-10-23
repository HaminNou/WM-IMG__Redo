/**
 * Slide-layer integration for the voiceover engine.
 *
 * Two responsibilities, kept separate from `voiceover.js` so the engine
 * stays pure (no DOM observers, no jsPsych assumptions) and easy to test:
 *
 *   1. **Auto-narrate every instruction page.** A MutationObserver watches
 *      the jsPsych display element for new `[data-voiceover-target]` nodes
 *      appearing — the marker the slide-layout primitive `slideTextPage()`
 *      stamps on each rendered page. When one shows up, we extract its
 *      narration text and hand it to the engine. This works regardless of
 *      which jsPsych plugin rendered the page (instructions, html-button-
 *      response, html-keyboard-response) and survives plugin internals
 *      (page-forward, page-backward, re-renders).
 *
 *   2. **Mount the persistent voiceover toggle pill.** A single top-right
 *      control reflects the engine's mute state and toggles it on click.
 *      Mounted on first narrated slide and unmounted by the trial-start
 *      gate (so it doesn't bleed into the experiment's trial body).
 *
 * The rationale for the MutationObserver approach over a per-page hook:
 *   - jsPsych's `instructions` plugin renders pages in place by mutating the
 *     same display element. There is no per-page lifecycle hook.
 *   - Replacing every instruction node with a hand-rolled
 *     html-keyboard-response sequence would require rebuilding back/forward
 *     navigation, accumulator state, and the existing accuracy-loop
 *     wrapper. Touching that much code purely to add a per-page hook is a
 *     bigger surface area than the observer approach.
 *   - Observation is read-only: we don't mutate the page, only watch for
 *     new `[data-voiceover-target]` appearances and hand them to the
 *     engine. If a page has no target marker (calibration UI, surveys),
 *     nothing happens.
 */

import { getVoiceover, isVoiceoverEnabled } from './voiceover.js';

const TOGGLE_ID = 'vo-toggle';
const TARGET_ATTR = 'data-voiceover-target';
const STARTED_FLAG = 'data-voiceover-started';

let observerInstalled = false;
let observer = null;

/**
 * Install the global slide-narration observer. Idempotent — calling twice
 * is a no-op. Mount this once at runner-start before the first instruction
 * slide is shown.
 */
export function installVoiceoverSlideObserver() {
  if (observerInstalled) return;
  if (typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;
  observerInstalled = true;

  /* Scan the whole body — jsPsych re-mounts the display element across
   * trials, and any contained `[data-voiceover-target]` should be picked
   * up regardless of where it lands in the DOM tree. */
  observer = new MutationObserver((_mutations) => {
    /* On any DOM mutation, find live targets that haven't been narrated
     * yet. We don't try to be precise about which node was added — a
     * simple second pass is cheap and catches edge cases (e.g. when the
     * instructions plugin replaces the entire stimulus container). */
    handleTargets();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  /* Initial pass in case the first slide is already in the DOM by the
   * time we install. */
  handleTargets();
}

function handleTargets() {
  const targets = document.querySelectorAll(`[${TARGET_ATTR}]:not([${STARTED_FLAG}])`);
  for (const target of targets) {
    /* Mark before extracting so a re-entrant mutation (e.g. our own
     * `replaceChildren` inside renderWordSpans) doesn't trigger a second
     * narration pass. */
    target.setAttribute(STARTED_FLAG, '1');
    narrateTarget(target);
  }
}

/**
 * Imperatively narrate any [data-voiceover-target] currently mounted in the
 * document (or its first match if `selector` provided). Use this from a
 * node's `on_load` when the global slide-narration observer is intentionally
 * NOT installed (see `runner.js` Voiceover scope comment) but the
 * experimenter wants this one screen spoken — e.g. the "main trials begin"
 * announcement after practice, or the "thank you" message at the end of the
 * main task. Idempotent: nodes already flagged as narrated are skipped, so
 * a re-fire of `on_load` won't double-speak.
 */
export function narrateNowIfPresent() {
  handleTargets();
}

function narrateTarget(target) {
  /* Skip empty / whitespace-only targets. `textContent` is cheap and
   * captures the visible prose regardless of HTML structure. Footer
   * hints (e.g. "Press Space to continue") sit OUTSIDE the target, so
   * they don't contribute — by design. */
  if (!target.textContent || !target.textContent.trim()) return;

  /* Hand off to the engine's structure-preserving walker. The body's
   * `<p>`, `<ul>`, `<li>`, `<strong>` (and any other inline / block
   * structure the slide author used) are kept intact — only the leaf
   * text-node words are wrapped in `vo-word` spans. This preserves the
   * reading layout the slide was designed around (bulleted lists, bold
   * emphasis, paragraph breaks) while still giving the engine a flat
   * narration stream + per-word reveal targets. */
  getVoiceover().narrateInPlace(target);

  /* Mount the toggle pill the first time we narrate. */
  ensureToggleMounted();
}

/**
 * Mount the voiceover toggle button at top-right. Idempotent.
 *
 * The button's icon and label reflect the current mute state. Click
 * toggles muted-ness in the engine and re-renders.
 */
export function ensureToggleMounted() {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(TOGGLE_ID);
  if (el) {
    renderToggleContent(el);
    return;
  }
  el = document.createElement('button');
  el.id = TOGGLE_ID;
  el.type = 'button';
  el.className = 'vo-toggle';
  el.setAttribute('aria-label', 'Toggle voice narration');
  el.addEventListener('click', () => {
    const vo = getVoiceover();
    vo.setMuted(!vo.muted);
    renderToggleContent(el);
  });
  document.body.appendChild(el);
  renderToggleContent(el);
}

export function unmountToggle() {
  const el = document.getElementById(TOGGLE_ID);
  if (el?.parentNode) el.parentNode.removeChild(el);
}

function renderToggleContent(el) {
  const enabled = !getVoiceover().muted && isVoiceoverEnabled();
  el.innerHTML = enabled
    ? '<span class="vo-toggle__icon" aria-hidden="true">🔊</span><span>Voice on</span>'
    : '<span class="vo-toggle__icon" aria-hidden="true">🔇</span><span>Voice off</span>';
}
