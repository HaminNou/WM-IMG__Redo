/**
 * Voiced instruction slides — pre-rendered TTS audio (preferred) with
 * Web Speech API fallback + word-synced text reveal.
 *
 * Two-tier audio strategy:
 *
 *   1. **Pre-rendered TTS (preferred path).** A build-time render script
 *      (`scripts/render-voiceover-edge.js`) walks the inventory of narration
 *      strings, calls a text-to-speech service, and writes content-addressed MP3s into
 *      `public/voiceover/<sha256>.mp3` plus a `manifest.json` index. At
 *      narrate time the engine hashes the incoming text and, if the hash
 *      is in the manifest, plays the corresponding `<audio>` element. The
 *      participant hears a natural, consistent voice across every slide.
 *      This is the "good voice" path the participant should normally hear.
 *
 *   2. **Web Speech API (automatic fallback).** When no manifest is
 *      present (offline dev, manifest hasn't been generated yet, or a
 *      slide's text wasn't in the inventory), the engine falls back to
 *      `window.speechSynthesis` with the same word-synced reveal pacing
 *      driven by `boundary` events. The participant still hears the slide
 *      narrated; voice quality is OS-dependent. Used as a safety net so
 *      the experiment never goes silent on a missed manifest entry.
 *
 *   3. **Mute / typing-speed reveal (last resort).** If both paths are
 *      unavailable (mute or no `speechSynthesis`), words still reveal at
 *      typing speed so the visual pacing experience is preserved without
 *      audio.
 *
 * Why pre-rendered as the preferred path:
 *   - Voice quality is the critical participant-experience axis. Browser
 *     `speechSynthesis` voices are OS-dependent and several common ones
 *     (Samantha on macOS, Microsoft David / Mark on Windows) sound
 *     mechanical to a non-trivial fraction of participants. Studio-quality TTS is essentially
 *     indistinguishable from a human reader at this length.
 *   - Audio is identical for every participant, removing OS/voice-
 *     availability as a confound.
 *   - Each MP3 is content-addressed by SHA-256 of its source text — the
 *     render script is fully idempotent, only renders new strings, and
 *     can be re-run safely after any prose edit.
 *   - Hosting cost: ~14k characters of narration → ~30 minutes of audio
 *     → ~5 MB MP3. Trivial for any static-host (GitHub Pages, Netlify,
 *     Vite preview).
 *
 * Why we keep the Web Speech fallback:
 *   - The participant must never hit a silent slide. If the operator
 *     forgot to run `npm run render-voiceover`, or a copy edit landed
 *     after the last render, the missed string still narrates — just
 *     with a less polished voice for that one slide.
 *   - Dev iteration: copy edits don't require a re-render to test.
 *
 * Word-by-word reveal:
 *   - Web Speech fallback uses `boundary` events for word-by-word reveal.
 *   - Pre-rendered audio path doesn't have word boundaries (would require
 *     forced alignment on each MP3). Instead,
 *     the full text is revealed immediately at audio-start. The natural
 *     studio voice paces comprehension on its own — a visual fade
 *     is unnecessary (and arguably distracting) when the audio is natural.
 *
 * Reliability guards:
 *   - `boundary` fires inconsistently on Linux Chrome / older Edge. A
 *     watchdog timer (`BOUNDARY_WATCHDOG_MS`) detects this and switches to
 *     time-based reveal that paces words at ~175 WPM for the remainder of
 *     the utterance. Never blocks the participant.
 *   - The browser auto-pauses speech when the tab is hidden; we listen for
 *     `visibilitychange` and resume on tab-return. If the user navigates
 *     away mid-utterance, `cancel()` is called.
 *   - On feature-detect miss (no `speechSynthesis`) the module degrades to
 *     a typing-speed reveal with no audio. The participant can still read
 *     the slide.
 *
 * Accessibility:
 *   - Mute toggle persisted in `localStorage` (`voiceover_enabled`). When
 *     muted, words still reveal at typing speed so the visual pacing
 *     experience is preserved without audio.
 *   - `prefers-reduced-motion` (read by the CSS, not this module) collapses
 *     the per-word fade transition to 0 ms; words still reveal one at a
 *     time but without animation.
 *   - Skip control (`controller.skip()`): immediately reveals all words and
 *     cancels the utterance. Wired to the participant's first Space press
 *     by the slide-layer integration.
 *
 * The module is fully self-contained and side-effect-free at import time;
 * the singleton state lives behind getters so tests can stub `window`
 * without triggering accidental utterance starts.
 */

const WORD_REVEAL_MS_PER_WORD = 60_000 / 175; /* ≈343 ms – 175 WPM */
const BOUNDARY_WATCHDOG_MS = 600;

/* ---------- Audio watchdog ----------
 * A recording that never fires `ended` or `error` (no audio output device, a
 * stalled decode, a browser that accepts play() but never advances the clock)
 * used to leave the screen waiting forever: a demo only continues when its
 * caption finishes, so the participant had to switch Voice off to go on. The
 * guard below ends such an utterance exactly as an `error` does: it finishes
 * silently with the text revealed, and nothing is blocked.
 *
 *   - hard limit: expected duration + 3 s, never less than 5 s. The expected
 *     duration is read from the manifest entry (the end of the last word
 *     boundary, or the file size at the renderer's fixed 96 kbps, whichever is
 *     longer; characters x 90 ms when neither is present), divided by the
 *     playback rate;
 *   - `abort`: the browser gave up fetching the file, so it ends at once;
 *   - `stalled`: browsers also fire it during a short buffering pause, so it
 *     only starts a 4 s grace period; the utterance ends only if the playback
 *     position has not moved by then.
 * Normal playback is unaffected: the guard is disposed when the utterance
 * finishes for any reason. */
export const AUDIO_WATCHDOG_MARGIN_MS = 3000;
export const AUDIO_WATCHDOG_MIN_MS = 5000;
export const AUDIO_STALL_GRACE_MS = 4000;
const RENDER_BYTES_PER_MS = 12; /* 96 kbps mono MP3 = 12 000 bytes per second */
const FALLBACK_MS_PER_CHAR = 90;

/**
 * Expected playing time of a manifest entry at rate 1, in ms (0 if unknown).
 *
 * @param {{bytes?: number, chars?: number, word_boundaries?: {offset_ms: number, duration_ms?: number}[]}} entry
 */
export function expectedAudioMs(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  const wb = Array.isArray(entry.word_boundaries) ? entry.word_boundaries : [];
  const last = wb[wb.length - 1];
  const fromWords = last
    ? (Number(last.offset_ms) || 0) + (Number.isFinite(last.duration_ms) ? last.duration_ms : 0)
    : 0;
  const fromBytes = Number.isFinite(entry.bytes) ? entry.bytes / RENDER_BYTES_PER_MS : 0;
  const fromChars = Number.isFinite(entry.chars) ? entry.chars * FALLBACK_MS_PER_CHAR : 0;
  return Math.max(fromWords, fromBytes) || fromChars;
}

/** Hard time limit for one recording, in ms. */
export function audioWatchdogLimitMs(entry, rate = 1) {
  const r = Number(rate) > 0 ? Number(rate) : 1;
  return Math.max(AUDIO_WATCHDOG_MIN_MS, expectedAudioMs(entry) / r + AUDIO_WATCHDOG_MARGIN_MS);
}

function armAudioGuard(audio, entry, state, finish, rate) {
  const hard = setTimeout(
    () => {
      if (!state.finished) finish('completed');
    },
    audioWatchdogLimitMs(entry, rate)
  );
  let stallTimer = null;
  const onAbort = () => {
    if (!state.finished) finish('completed');
  };
  const onStalled = () => {
    if (stallTimer || state.finished) return;
    const at = audio.currentTime;
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (!state.finished && audio.currentTime === at) finish('completed');
    }, AUDIO_STALL_GRACE_MS);
  };
  audio.addEventListener('abort', onAbort);
  audio.addEventListener('stalled', onStalled);
  state.audioGuardDispose = () => {
    clearTimeout(hard);
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    audio.removeEventListener?.('abort', onAbort);
    audio.removeEventListener?.('stalled', onStalled);
    state.audioGuardDispose = null;
  };
}
const STORAGE_KEY = 'voiceover_enabled';

/* Pre-rendered audio assets live under Vite's public root and are served
 * relative to the experiment's HTML. Using a relative URL keeps the engine
 * portable across deploy targets (GitHub Pages /<repo>/, Netlify root). */
const MANIFEST_URL = 'voiceover/manifest.json';
const AUDIO_DIR = 'voiceover/';

/* Harvest log: when the engine sees a narration text that is NOT in the
 * manifest, it appends `{ text, hash }` here so the operator can dump the
 * list and feed it to the render script. The list lives on `window` (not
 * inside the engine) so a quick `copy(window.__voiceoverHarvest)` from
 * DevTools picks up everything across the session. */
const HARVEST_GLOBAL = '__voiceoverHarvest';

/* CSS class names — must match the rules in index.html. Centralised here
 * so tests can assert without duplicating the strings. */
export const CSS_WORD = 'vo-word';
export const CSS_WORD_REVEALED = 'vo-revealed';

/* Voice-selection preference order. The Web Speech API's `voices` list is
 * OS-dependent; on Chrome we typically see "Google US English", on Edge
 * "Microsoft Aria Online (Natural) — English", on macOS Safari "Samantha".
 * The patterns below match natural / neural voices first, fall back to
 * any English voice, and finally to the system default. */
const VOICE_NAME_PATTERNS = [
  /Microsoft.*Aria.*Natural/i,
  /Microsoft.*Jenny.*Natural/i,
  /Microsoft.*Sonia.*Natural/i,
  /Microsoft.*Aria/i,
  /Google US English/i,
  /Google UK English Female/i,
  /Samantha/i,
  /Karen/i,
  /Daniel/i,
];

/**
 * Returns the participant's persisted voiceover preference. Defaults to
 * enabled on first session.
 */
export function isVoiceoverEnabled() {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

function setVoiceoverEnabled(enabled) {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* localStorage may be unavailable in incognito-restricted modes —
     * silently degrade; the in-memory engine state is still authoritative
     * for the current session via Voiceover#muted. */
  }
}

/**
 * Returns true iff the runtime supports Web Speech API speech synthesis.
 * False on older Safari (pre-7), some embedded browsers, and any context
 * where window is undefined (Node / jsdom without polyfill).
 */
function isSpeechAvailable() {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance === 'function'
  );
}

/**
 * Pick the most natural-sounding voice from `voices`. Returns the first
 * pattern match, then any English voice, then null (caller falls back to
 * the system default by leaving `utterance.voice` unset).
 */
function pickPreferredVoice(voices) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  for (const pattern of VOICE_NAME_PATTERNS) {
    const match = voices.find((v) => pattern.test(v.name));
    if (match) return match;
  }
  const english = voices.find((v) => /^en[-_]/i.test(v.lang));
  return english ?? null;
}

/**
 * Strip HTML tags from `html` and return the plain text used for
 * narration. Whitespace is collapsed; HTML entities are decoded by the
 * browser when assigned to `textContent`.
 */
export function htmlToNarrationText(html) {
  if (html === null || html === undefined) return '';
  if (typeof window === 'undefined') {
    /* Test fallback — strip tags via regex when no DOM is available. */
    return String(html)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const tmp = window.document.createElement('div');
  tmp.innerHTML = String(html);
  return (tmp.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Tokenise `text` into a sequence of `{ kind, text, start, end }` records
 * preserving word vs. whitespace structure. `start` / `end` are character
 * offsets into the original `text`. Used both to drive boundary→reveal
 * mapping (matches `charIndex` on the utterance) and to render per-word
 * spans into the host element.
 */
function tokeniseWords(text) {
  const out = [];
  /* `\S+` matches any run of non-whitespace as one "word" (including
   * punctuation glued to it, e.g. "dots." → one token). The Web Speech
   * boundary event reports `charIndex` at word starts, and that index
   * lands at the same offset our regex returns, so the two streams stay
   * aligned. */
  const re = /\S+|\s+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const isWord = !/^\s+$/.test(m[0]);
    out.push({
      kind: isWord ? 'word' : 'space',
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/**
 * Find the index of the word-token whose `[start, end)` range contains
 * `charIndex`. Returns -1 if `charIndex` falls in whitespace or beyond.
 *
 * Used to map a `boundary` event's `charIndex` to the right span to
 * reveal. Linear scan is fine — typical slide is < 200 words.
 */
function tokenIndexAtChar(tokens, charIndex) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word') continue;
    if (charIndex >= t.start && charIndex < t.end) return i;
  }
  return -1;
}

/**
 * Build the host's inner HTML by wrapping each word in a hidden span. Each
 * span carries `data-vo-index` (an offset into `tokens`) so the reveal
 * routine can locate it without a per-call DOM walk.
 *
 * Whitespace tokens are emitted as plain text nodes — they don't need a
 * fade animation and keeping them outside spans avoids quirks in browsers
 * that strip whitespace-only inline elements at line wrap.
 *
 * The host's existing children are replaced; tests should pass a
 * disposable element.
 */
function renderWordSpans(host, tokens) {
  /* Build a fresh fragment so the swap is atomic — no flicker between
   * empty host and partially-filled host. */
  const frag = host.ownerDocument.createDocumentFragment();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.kind === 'word') {
      const span = host.ownerDocument.createElement('span');
      span.className = CSS_WORD;
      span.setAttribute('data-vo-index', String(i));
      span.textContent = tok.text;
      frag.appendChild(span);
    } else {
      frag.appendChild(host.ownerDocument.createTextNode(tok.text));
    }
  }
  host.replaceChildren(frag);
}

/**
 * Reveal the word at `tokenIndex` (and any preceding word tokens that may
 * have been skipped — e.g. when boundary events arrive late). Idempotent.
 */
function revealUpTo(host, tokenIndex) {
  const spans = host.querySelectorAll(`.${CSS_WORD}`);
  for (const span of spans) {
    const idx = Number(span.getAttribute('data-vo-index'));
    if (idx <= tokenIndex) span.classList.add(CSS_WORD_REVEALED);
  }
}

function revealAll(host) {
  const spans = host.querySelectorAll(`.${CSS_WORD}`);
  for (const span of spans) span.classList.add(CSS_WORD_REVEALED);
}

/**
 * Walk `host`'s existing DOM and wrap each word substring of every
 * descendant text node in a `<span class="vo-word" data-vo-index="N">`,
 * leaving the surrounding element structure (`<p>`, `<ul>`, `<li>`,
 * `<strong>`, …) intact. Returns the parallel `tokens` array used for
 * boundary→reveal mapping.
 *
 * Why this exists alongside `renderWordSpans`:
 *   - `renderWordSpans` is the simple flat path: it replaces the host's
 *     inner content with a single inline run of word spans + whitespace
 *     text nodes. It is used by tests and by any caller that explicitly
 *     wants to produce flat output from a plain string.
 *   - For real instruction slides the body carries meaningful structure
 *     (paragraph breaks, bulleted lists, bold emphasis). Replacing
 *     innerHTML with a flat run flattens all of that into a wall of
 *     inline text — which destroys the reading experience the slide was
 *     designed for. `wrapWordsInPlace` preserves the structure: each
 *     `<li>` keeps its bullet, each `<p>` keeps its block break, each
 *     `<strong>` keeps its weight, and only the leaf text nodes are
 *     rewritten.
 *
 * Token contract — identical to `tokeniseWords`'s output, so the same
 * `_buildController` logic drives boundary→reveal mapping for both
 * paths:
 *   - `kind`: 'word' | 'space'
 *   - `text`: substring as it appears in the *narration text* (the
 *     string passed to `SpeechSynthesisUtterance`). Whitespace tokens
 *     hold the literal separator inserted between words from different
 *     DOM text nodes (always a single ASCII space — the TTS engine
 *     doesn't care about visual indentation, and using a single space
 *     keeps narration-text offsets compact and predictable).
 *   - `start` / `end`: character offsets into the narration text.
 *
 * Whitespace handling:
 *   - Whitespace runs WITHIN a single text node are preserved visually
 *     as text nodes (so original indentation / line breaks keep working
 *     for layout purposes) but are NOT copied into the narration text.
 *     Inserting them would inflate `charIndex` offsets and desync the
 *     boundary→reveal mapping on multi-line markup.
 *   - Whitespace BETWEEN words from different text nodes is added as a
 *     single ASCII space token in the narration stream so the spoken
 *     audio sounds natural (no run-together "Hello.world" across a
 *     `<p>` boundary). The inserted token lives in the narration text
 *     only — no corresponding visible text node is added, because the
 *     original DOM already has whatever separator the layout needs
 *     (block breaks, bold tag boundaries, …).
 *
 * Pre-collecting text nodes before mutating is mandatory: walking and
 * mutating the same tree confuses live NodeList ordering. We snapshot
 * every text node first, then rewrite each one independently.
 */
export function wrapWordsInPlace(host) {
  const tokens = [];
  if (!host || typeof host.ownerDocument === 'undefined') return tokens;
  const doc = host.ownerDocument;

  /* Recursive snapshot — `Array.from(host.querySelectorAll('*'))` would
   * miss text nodes (which are not Elements); a manual walk is the
   * smallest correct primitive. */
  const textNodes = [];
  const collect = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 /* TEXT_NODE */) {
        textNodes.push(child);
      } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
        collect(child);
      }
    }
  };
  collect(host);

  let narrationCursor = 0;
  for (const textNode of textNodes) {
    const parent = textNode.parentNode;
    if (!parent) continue;
    const text = textNode.nodeValue;
    if (!text) continue;

    const re = /\S+|\s+/g;
    let m;
    const replacements = [];
    while ((m = re.exec(text)) !== null) {
      const isWord = !/^\s+$/.test(m[0]);
      if (isWord) {
        /* Insert a narration-stream space separator if the previous
         * narration token was a word. This handles the case where two
         * word-bearing text nodes meet across an element boundary
         * (`<p>foo</p><p>bar</p>` → "foo bar" not "foobar"). The
         * separator is narration-only — it never becomes a visible
         * node, because the original DOM already provides whatever
         * inter-element spacing the layout needs. */
        if (tokens.length > 0 && tokens[tokens.length - 1].kind === 'word') {
          tokens.push({
            kind: 'space',
            text: ' ',
            start: narrationCursor,
            end: narrationCursor + 1,
          });
          narrationCursor += 1;
        }
        const start = narrationCursor;
        narrationCursor += m[0].length;
        const span = doc.createElement('span');
        span.className = CSS_WORD;
        span.setAttribute('data-vo-index', String(tokens.length));
        span.textContent = m[0];
        replacements.push(span);
        tokens.push({
          kind: 'word',
          text: m[0],
          start,
          end: narrationCursor,
        });
      } else {
        /* Visible whitespace — preserve as a text node so the original
         * inline / block layout still works (e.g. the space between
         * "Hello" and "<strong>world</strong>" stays a real space). */
        replacements.push(doc.createTextNode(m[0]));
      }
    }

    const frag = doc.createDocumentFragment();
    for (const part of replacements) frag.appendChild(part);
    parent.replaceChild(frag, textNode);
  }

  return tokens;
}

/**
 * SHA-256 hash of `text` as a 64-char lowercase hex string. Async because
 * `crypto.subtle.digest` is async; the tiny extra Promise overhead is
 * irrelevant against utterance render time.
 *
 * The same hash function runs on the Node side in `scripts/render-voiceover-edge.js`
 * so a string hashed in the browser maps to the same `<hash>.mp3` file
 * that was rendered offline. SHA-256 chosen for stable hex length and
 * negligible collision risk over a few hundred narration strings.
 *
 * Returns `null` on platforms without `crypto.subtle` (very old Safari,
 * non-secure contexts on http://) — caller treats `null` as "no manifest
 * match possible" and falls through to Web Speech.
 */
/* Audio is keyed on the text with en dashes written as em dashes, so the
 * dash style shown on screen does not change which recording is played. */
async function sha256Hex(text) {
  text = text.replace(/\u2013/g, '\u2014');
  if (typeof crypto === 'undefined' || !crypto.subtle?.digest) return null;
  if (typeof TextEncoder === 'undefined') return null;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const bytes = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  } catch {
    return null;
  }
}

/* Module-cached manifest promise. Singleton: every engine instance shares
 * the same fetch result so we don't issue duplicate network requests on a
 * test reset. The promise resolves to `{ entries: { hash: { file, ... } } }`
 * on success, or `null` on any failure (no manifest at deploy target,
 * 404, JSON parse error). Null means "fall through to Web Speech for
 * everything" — a safe degraded mode. */
let _manifestPromise = null;

/* When true, the engine bypasses the async audio-manifest path entirely
 * and goes synchronously to Web Speech. Used by the unit-test suite,
 * which mocks `window.speechSynthesis` and asserts on synchronous behavior
 * — the async fetch + SHA-256 chain would force every test to add an
 * explicit microtask flush. Production code never sets this. */
let _audioPathDisabled = false;

function loadManifest() {
  if (_manifestPromise) return _manifestPromise;
  if (typeof fetch === 'undefined') {
    _manifestPromise = Promise.resolve(null);
    return _manifestPromise;
  }
  /* `cache: 'no-cache'` revalidates with the server but still uses the
   * disk cache when the ETag matches — safer than `force-cache` which
   * can serve a stale empty response from a prior failed request and
   * poison the session. */
  const attempt = () =>
    fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || typeof j !== 'object' || !j.entries || typeof j.entries !== 'object') {
          return null;
        }
        return j;
      })
      .catch(() => null);

  /* Auto-retry if the first attempt returns null — a single transient
   * network blip (or HMR-induced module reload) should not silence the
   * whole session. The retry resets the cached promise so future
   * narrations re-fetch fresh. */
  _manifestPromise = attempt().then((m) => {
    if (m) return m;
    _manifestPromise = null;
    return attempt();
  });
  return _manifestPromise;
}

/**
 * Append `{ text, hash }` to the harvest global so the operator can dump
 * every unmatched narration string after walking the experiment in dev.
 * Dedup by hash so re-narrating the same slide doesn't bloat the list.
 */
function recordHarvest(text, hash) {
  if (typeof window === 'undefined') return;
  if (!window[HARVEST_GLOBAL]) window[HARVEST_GLOBAL] = [];
  const list = window[HARVEST_GLOBAL];
  if (!list.find((e) => e.hash === hash)) {
    list.push({ text, hash });
    /* Surface the miss in the console so the operator sees in real time
     * which strings still need to be added to strings.json + re-rendered.
     * Without this, misses only show up in `window.__voiceoverHarvest`,
     * which the operator has to remember to inspect. */
    try {
      console.warn(`[voiceover] manifest miss: "${text}" (sha256=${hash})`);
    } catch {
      /* no-op */
    }
  }
}

/**
 * Test-only manifest stub. Pass `null` to clear. Used by unit tests that
 * want to exercise the audio path without an actual fetch.
 */
export function __setVoiceoverManifestForTests(manifest) {
  _manifestPromise = Promise.resolve(manifest);
}

/**
 * Test-only flag — when true, the engine skips the async audio-manifest
 * lookup entirely and runs the Web Speech path synchronously. The unit
 * tests set this before each case so existing synchronous assertions
 * (`vo.narrate(...); expect(mockSynth.spoken).toHaveLength(1)`) keep
 * working without forcing every spec to flush microtasks.
 */
export function __setVoiceoverAudioDisabledForTests(disabled) {
  _audioPathDisabled = !!disabled;
}

/**
 * Singleton manager: only one utterance speaks at a time. A new `narrate`
 * call cancels the previous one — mirrors the demo-caption flow where the
 * controller advances captions on a fixed schedule and a stale narration
 * would talk over the next.
 */
class VoiceoverEngine {
  constructor() {
    this.current = null;
    this.muted = !isVoiceoverEnabled();
    this._installVisibilityHandler();
  }

  setMuted(muted) {
    this.muted = muted;
    setVoiceoverEnabled(!muted);
    /* Cancel current narration on mute so the participant doesn't hear a
     * trailing word after toggling off. The visual reveal is left at
     * whatever progress it had reached; the next narrate() call starts
     * fresh. */
    if (muted && this.current) {
      this.current.skip();
    }
  }

  /**
   * Start narrating `text` into `host`. Returns a controller with
   * `skip()`, `cancel()`, and a `done` Promise that resolves when the
   * utterance ends (naturally, by skip, or by cancel).
   *
   * Re-entrant: a new narrate() during an active one cancels the old.
   */
  narrate(host, text, opts = {}) {
    if (this.current) this.current.cancel();
    const tokens = tokeniseWords(text);
    renderWordSpans(host, tokens);

    const controller = this._buildController(host, tokens, text, opts);
    this.current = controller;
    /* Capture the start promise on the controller so tests can `await
     * controller._started` to deterministically know when the audio /
     * speech path has been resolved. Production callers don't touch
     * this — they just await `done`. */
    controller._started = controller.start();
    return controller;
  }

  /**
   * Speak `text` aloud with no DOM mutation and no per-word reveal.
   *
   * Use this for short, ephemeral UI strings whose visual is already
   * onscreen (and animated by their own host) — primarily the demo
   * captions in `src/instructions/demos.js`. The visual caption is
   * unchanged; only an audio track is added.
   *
   * Why this is separate from `narrate` / `narrateInPlace`:
   *   - Demo captions update on a fixed animation schedule (every
   *     1.5–3 s) and are typically a single short sentence. Wrapping
   *     each caption in vo-word spans + driving boundary→reveal would
   *     fight the existing `demo-caption-bump` animation and burn DOM
   *     work the participant never sees.
   *   - The caption host element belongs to `demos.js`'s scheduler — it
   *     gets its `innerHTML` overwritten on every new caption — and
   *     mutating it from the engine would race with the scheduler's
   *     own writes.
   *   - The engine still needs to be re-entrant: a new caption arriving
   *     mid-utterance must cancel the previous spoken caption so the
   *     audio track stays aligned with the visual. The same
   *     `this.current.cancel()` invariant used by narrate / narrateInPlace
   *     handles this.
   *
   * Returns a controller compatible with the narrate / narrateInPlace
   * controllers: `start()`, `skip()`, `cancel()`, and a `done` Promise.
   * `start()` is auto-invoked before return — callers don't need to
   * touch it.
   *
   * Empty / whitespace-only `text`, mute, and unavailable speech all
   * return a pre-finished no-op controller whose `done` is already
   * resolved with `'completed'` — callers can `await ctrl.done` without
   * branching on degraded modes.
   */
  speak(text, opts = {}) {
    if (this.current) this.current.cancel();
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed || this.muted || !isSpeechAvailable()) {
      /* No-op controller — already finished. Keeps the call site
       * uniform regardless of degraded modes. */
      return {
        start: () => {},
        skip: () => {},
        cancel: () => {},
        done: Promise.resolve('completed'),
        _state: { finished: true },
      };
    }

    let resolveDone;
    const done = new Promise((res) => {
      resolveDone = res;
    });
    const state = { finished: false, utterance: null, audioEl: null };

    const stopAudio = () => {
      if (!state.audioEl) return;
      try {
        state.audioEl.pause();
        state.audioEl.src = '';
      } catch {
        /* no-op */
      }
      state.audioEl = null;
    };

    const finish = (reason) => {
      if (state.finished) return;
      state.finished = true;
      state.audioGuardDispose?.();
      stopAudio();
      if (this.current === controller) this.current = null;
      resolveDone(reason);
    };

    const cancel = () => {
      try {
        if (typeof window !== 'undefined' && window.speechSynthesis) {
          window.speechSynthesis.cancel();
        }
      } catch {
        /* no-op */
      }
      stopAudio();
      finish('cancelled');
    };

    /* `skip` and `cancel` differ semantically (skipped vs cancelled
     * `done` reason) so callers that wire their own keyboard handlers
     * — e.g. spacebar-to-skip — can still distinguish, even though the
     * audible effect is identical. */
    const skip = () => {
      try {
        if (typeof window !== 'undefined' && window.speechSynthesis) {
          window.speechSynthesis.cancel();
        }
      } catch {
        /* no-op */
      }
      stopAudio();
      finish('skipped');
    };

    const startWebSpeech = () => {
      const utterance = new window.SpeechSynthesisUtterance(trimmed);
      utterance.rate = opts.rate ?? 1.0;
      utterance.pitch = opts.pitch ?? 1.0;
      utterance.volume = opts.volume ?? 1.0;
      const voices = window.speechSynthesis.getVoices?.() ?? [];
      const voice = pickPreferredVoice(voices);
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? 'en-US';

      utterance.onend = () => finish('completed');
      /* Speech-engine errors degrade silently — there is no visible
       * fallback to drive (no spans to reveal), so the cleanest UX is
       * to mark the speak() finished and let the next caption arrive
       * on schedule. */
      utterance.onerror = () => finish('completed');

      state.utterance = utterance;

      try {
        window.speechSynthesis.cancel(); /* clear any leftover state */
        window.speechSynthesis.speak(utterance);
      } catch {
        finish('completed');
      }
    };

    /* Public start() — async because manifest fetch + SHA-256 hashing
     * are async. The audio path is tried first; on any miss / error we
     * fall through to Web Speech so the participant still hears the
     * caption. */
    const start = async () => {
      /* Test-only synchronous bypass. Production never hits this. */
      if (_audioPathDisabled) {
        startWebSpeech();
        return;
      }
      const manifest = await loadManifest();
      if (state.finished) return;
      const hash = await sha256Hex(trimmed);
      if (state.finished) return;
      if (!manifest || !hash) {
        if (hash) recordHarvest(trimmed, hash);
        /* No manifest or no hash — finish silently rather than fall through
         * to Web Speech (the system voice is jarringly different from the
         * pre-rendered Andrew MP3). Operator can see the miss in the
         * console via `recordHarvest` and re-harvest. */
        finish('completed');
        return;
      }
      const entry = manifest.entries[hash];
      if (!entry || !entry.file) {
        recordHarvest(trimmed, hash);
        finish('completed');
        return;
      }
      let audio;
      try {
        audio = new Audio(`${AUDIO_DIR}${entry.file}`);
      } catch {
        finish('completed');
        return;
      }
      audio.volume = opts.volume ?? 1.0;
      audio.playbackRate = opts.rate ?? 1.0;
      audio.preload = 'auto';
      state.audioEl = audio;
      armAudioGuard(audio, entry, state, finish, audio.playbackRate);
      audio.addEventListener('ended', () => {
        if (state.finished) return;
        finish('completed');
      });
      audio.addEventListener('error', () => {
        if (state.finished) return;
        state.audioEl = null;
        finish('completed');
      });
      try {
        const p = audio.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            if (state.finished) return;
            finish('completed');
          });
        }
      } catch {
        finish('completed');
      }
    };

    const controller = { start, skip, cancel, done, _state: state };
    this.current = controller;
    controller._started = controller.start();
    return controller;
  }

  /**
   * Narrate `host`'s existing content, preserving its DOM structure
   * (paragraphs, lists, emphasis, …) and wrapping each word substring
   * in a vo-word span in place. The narration text is derived from the
   * walker's tokens so boundary events stay byte-aligned with the
   * spoken utterance.
   *
   * Use this for any caller whose host element carries meaningful HTML
   * structure — instruction slides, lists, multi-paragraph copy. Use
   * `narrate(host, text)` (above) when the input is a plain string and
   * the host has no pre-existing structure to preserve (tests, demo
   * captions where the visible text is one short sentence).
   *
   * Re-entrant: a new narrate call (either method) during an active
   * one cancels the old.
   */
  narrateInPlace(host, opts = {}) {
    if (this.current) this.current.cancel();
    const tokens = wrapWordsInPlace(host);
    /* Visible-text narration is reconstructed from the tokens' literal
     * fields (not from `host.textContent`, which would include the
     * preserved visible whitespace that we deliberately left out of the
     * narration stream). This keeps `charIndex` offsets reported by
     * `boundary` events byte-aligned with the `tokens[].start` field. */
    const visibleText = tokens.map((t) => t.text).join('');
    /* `data-voiceover-script` lets a slide specify experimenter framing
     * that the participant hears but does not see (e.g. "Let's begin
     * with the practice block." prepended to the visible body). When
     * present, audio path hashes the SCRIPT — so the rendered MP3
     * matches the spoken narration — while the host's on-screen text
     * is unchanged. Web Speech fallback also speaks the script; the
     * per-word reveal can't stay aligned with mismatched text, so the
     * boundary-watchdog will fall through to timer-paced reveal. */
    const scriptOverride = host?.getAttribute?.('data-voiceover-script');
    const text = scriptOverride && scriptOverride.trim() ? scriptOverride.trim() : visibleText;
    const controller = this._buildController(host, tokens, text, opts);
    this.current = controller;
    controller._started = controller.start();
    return controller;
  }

  _buildController(host, tokens, text, opts) {
    const wordCount = tokens.filter((t) => t.kind === 'word').length;
    let resolveDone;
    const done = new Promise((res) => {
      resolveDone = res;
    });
    const state = {
      host,
      tokens,
      wordCount,
      text,
      revealedUpTo: -1,
      finished: false,
      utterance: null,
      audioEl: null,
      watchdogTimer: null,
      fallbackTimer: null,
      fallbackActive: false,
      visibilityWasHidden: false,
    };

    const stopAudio = () => {
      if (!state.audioEl) return;
      try {
        state.audioEl.pause();
        state.audioEl.src = '';
      } catch {
        /* no-op */
      }
      state.audioEl = null;
    };

    const finish = (reason) => {
      if (state.finished) return;
      state.finished = true;
      this._stopAllTimers(state);
      stopAudio();
      revealAll(host);
      if (reason !== 'cancelled' && opts.onEnd) opts.onEnd();
      if (this.current === controller) this.current = null;
      resolveDone(reason);
    };

    const skip = () => {
      try {
        if (typeof window !== 'undefined' && window.speechSynthesis) {
          window.speechSynthesis.cancel();
        }
      } catch {
        /* no-op */
      }
      stopAudio();
      finish('skipped');
    };

    const cancel = () => {
      try {
        if (typeof window !== 'undefined' && window.speechSynthesis) {
          window.speechSynthesis.cancel();
        }
      } catch {
        /* no-op */
      }
      stopAudio();
      finish('cancelled');
    };

    const startFallbackReveal = (fromTokenIndex) => {
      if (state.fallbackActive) return;
      state.fallbackActive = true;
      let idx = fromTokenIndex;
      const tick = () => {
        if (state.finished) return;
        /* Walk forward to next word token. */
        idx += 1;
        while (idx < tokens.length && tokens[idx].kind !== 'word') idx += 1;
        if (idx >= tokens.length) {
          finish('completed');
          return;
        }
        state.revealedUpTo = idx;
        revealUpTo(host, idx);
        state.fallbackTimer = setTimeout(tick, WORD_REVEAL_MS_PER_WORD);
      };
      state.fallbackTimer = setTimeout(tick, WORD_REVEAL_MS_PER_WORD);
    };

    /* Web Speech path, factored out so the async audio-first start() can
     * delegate to it cleanly on manifest miss. */
    const startWebSpeech = () => {
      const utterance = new window.SpeechSynthesisUtterance(text);
      utterance.rate = opts.rate ?? 1.0;
      utterance.pitch = opts.pitch ?? 1.0;
      utterance.volume = opts.volume ?? 1.0;
      const voices = window.speechSynthesis.getVoices?.() ?? [];
      const voice = pickPreferredVoice(voices);
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? 'en-US';

      utterance.onboundary = (ev) => {
        if (state.finished) return;
        if (ev.name && ev.name !== 'word') return;
        const idx = tokenIndexAtChar(tokens, ev.charIndex ?? 0);
        if (idx < 0) return;
        if (idx <= state.revealedUpTo) return;
        state.revealedUpTo = idx;
        revealUpTo(host, idx);
        /* Reset watchdog — boundary events are flowing. */
        this._armWatchdog(state, () => {
          /* No further boundary events; pace remaining words by timer. */
          startFallbackReveal(state.revealedUpTo);
        });
      };

      utterance.onend = () => {
        if (state.finished) return;
        finish('completed');
      };

      utterance.onerror = () => {
        if (state.finished) return;
        /* Speech engine errored — degrade to fallback reveal so the
         * participant can still finish reading. */
        startFallbackReveal(state.revealedUpTo);
      };

      state.utterance = utterance;

      /* Arm initial watchdog: if no boundary event arrives within
       * BOUNDARY_WATCHDOG_MS, switch to fallback timer-based reveal. */
      this._armWatchdog(state, () => {
        startFallbackReveal(-1);
      });

      try {
        window.speechSynthesis.cancel(); /* clear any leftover state */
        window.speechSynthesis.speak(utterance);
      } catch {
        startFallbackReveal(-1);
      }
    };

    /* Public start() — async because we have to await the manifest fetch
     * + SHA-256 hash before deciding which engine path to take. The
     * caller (`narrate` / `narrateInPlace`) doesn't await this; the
     * controller is returned synchronously and start() runs to
     * completion in the background. */
    const start = async () => {
      /* Mute / empty path — typing-speed reveal with no audio. Same as
       * before; this short-circuits BEFORE we attempt any audio fetch
       * so a muted participant never triggers a network request. */
      if (this.muted || wordCount === 0) {
        startFallbackReveal(-1);
        return;
      }

      /* Test-only synchronous bypass. Production never hits this. */
      if (_audioPathDisabled) {
        if (!isSpeechAvailable()) {
          startFallbackReveal(-1);
          return;
        }
        startWebSpeech();
        return;
      }

      /* Audio-first path: try to play a pre-rendered MP3 from the
       * manifest. Falls through to Web Speech on manifest miss, hash
       * failure, or audio playback error. */
      const playedAudio = await this._tryAudioPath({
        text,
        host,
        opts,
        state,
        finish,
      });
      if (playedAudio) return;

      /* No matching audio — degrade to silent typing-speed reveal so
       * words still appear in sequence for reading, but never fall
       * through to Web Speech (system voice is wrong-sounding compared
       * to the pre-rendered Andrew MP3s; user policy is silent over
       * wrong-voice). */
      startFallbackReveal(-1);
    };

    const controller = { start, skip, cancel, done, _state: state };
    return controller;
  }

  /**
   * Attempt to play a pre-rendered MP3 for `text` from the manifest.
   * Returns `true` if playback was started (caller should not invoke
   * Web Speech), `false` otherwise.
   *
   * Behaviour on hit:
   *   - Word spans reveal progressively in lock-step with audio
   *     playback position, driven by the `<audio>` element's
   *     `timeupdate` events. Two paths share the same `timeupdate`
   *     handler:
   *       (a) **Timestamp-driven (preferred).** If the manifest entry
   *           carries a `word_boundaries: [{ offset_ms, ... }]` array
   *           (produced by `scripts/render-voiceover-edge.js` with
   *           Edge-TTS WordBoundary metadata enabled), each tick
   *           advances the cursor to the latest word whose `offset_ms`
   *           is ≤ the current playback time. This matches the spoken
   *           pace of every word — short words fly past, long words
   *           dwell — exactly as the TTS engine produced them.
   *       (b) **Linear (fallback).** If `word_boundaries` is missing
   *           (older manifest, partial render), each tick maps
   *           `currentTime / duration ⇒ fraction of total words
   *           revealed`. Words flanking commas/periods may lead or
   *           trail the spoken word by a beat, but the visual still
   *           progresses smoothly with audio.
   *     `finish('completed')` calls `revealAll` on `ended` so any words
   *     not yet reached by `timeupdate` are still revealed before
   *     hand-off.
   *   - An off-screen `<audio>` element is created, src set to
   *     `voiceover/<hash>.mp3`, played. `ended` calls `finish('completed')`;
   *     `error` finishes silently with the text already revealed (the
   *     element is not appended to the DOM — it's enough to instantiate
   *     it and call `play()`).
   *
   * Behaviour on miss:
   *   - Hash is logged via `recordHarvest(text, hash)` so the operator
   *     can dump unmatched strings and feed them to the render script.
   *   - Returns false; caller falls through to Web Speech.
   */
  async _tryAudioPath({ text, host, opts, state, finish }) {
    const manifest = await loadManifest();
    if (state.finished) return true; /* already cancelled – don't start */
    const hash = await sha256Hex(text);
    if (state.finished) return true;
    if (!manifest || !hash) {
      if (hash) recordHarvest(text, hash);
      return false;
    }
    const entry = manifest.entries[hash];
    if (!entry || !entry.file) {
      recordHarvest(text, hash);
      return false;
    }

    /* Match — play the MP3. The on-screen text is revealed progressively
     * (gray → white) by an audio-clock-driven word cursor below, so the
     * participant reads along with the spoken narration rather than
     * having the whole block flip to white at audio-start. */
    let audio;
    try {
      audio = new Audio(`${AUDIO_DIR}${entry.file}`);
    } catch {
      return false;
    }
    audio.volume = opts.volume ?? 1.0;
    /* `playbackRate` defaults to 1.0; the studio voice paces fine on its
     * own. Exposed via opts in case a future caller wants slow-mode. */
    audio.playbackRate = opts.rate ?? 1.0;
    audio.preload = 'auto';
    state.audioEl = audio;
    armAudioGuard(audio, entry, state, finish, audio.playbackRate);

    /* Precompute the token indices of every word token so the time-based
     * cursor can jump straight to the right span without walking tokens
     * on every `timeupdate` tick. */
    const wordTokenIndices = [];
    for (let i = 0; i < state.tokens.length; i++) {
      if (state.tokens[i].kind === 'word') wordTokenIndices.push(i);
    }
    const totalWords = wordTokenIndices.length;

    /* Preferred path: lock the reveal to the TTS engine's per-word
     * timestamps when they are present in the manifest. The offsets are
     * milliseconds from the start of the audio for the START of each
     * spoken word; the timestamps were captured at render time from
     * Edge-TTS WordBoundary metadata and stored in the manifest.
     *
     * Alignment subtlety: Edge-TTS emits boundaries for SPOKEN words
     * only. Visible punctuation-only tokens — most commonly the em-dash
     * "—" we use throughout the prose — have no spoken boundary. The
     * `tokeniseWords` regex treats `\S+` as one token, so "—" is a
     * visible word token but has no matching boundary. If we mapped
     * boundary[k] → wordTokenIndices[k] naively, the k-th spoken word
     * would reveal the k-th visible token, which can be the em-dash —
     * the reveal then trails the audio by one word forever.
     *
     * Fix: build `spokenWordTokenIndices` as the subset of word tokens
     * that actually carry pronounceable content (any letter/digit).
     * The boundary list has length = N spoken words; this filtered list
     * also has length = N (with rare exceptions like all-symbol words),
     * so boundary[k] maps cleanly to the k-th letter-bearing visible
     * token. Any visible token between the previous and current spoken
     * token (e.g. "—" between "1" and "remember") gets revealed as a
     * side-effect of `revealUpTo` flipping every span with
     * `data-vo-index <= tokenIdx`. */
    const boundariesRaw = Array.isArray(entry.word_boundaries) ? entry.word_boundaries : null;
    const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
    const spokenWordTokenIndices = wordTokenIndices.filter((idx) =>
      HAS_LETTER_OR_DIGIT.test(state.tokens[idx].text)
    );
    const useBoundaries = boundariesRaw && boundariesRaw.length > 0 && totalWords > 0;
    /* Truncate to the shorter of the two so we never index out of
     * bounds. The remaining words are caught by `revealAll` in
     * `finish('completed')`. */
    const boundaryLimit = useBoundaries
      ? Math.min(boundariesRaw.length, spokenWordTokenIndices.length)
      : 0;
    /* Pre-compute the trigger time for each spoken word: revealing at
     * the END of the word (`offset_ms + duration_ms`) instead of the
     * start. Rationale: lighting a word the instant the voice begins
     * pronouncing it visually leads the audio by the full spoken
     * duration of that word — the participant perceives the visual as
     * "running ahead of the voice." Triggering at end-of-word makes
     * each span flip to white the moment the voice has just finished
     * saying it, giving the natural "reading along behind the voice"
     * feel of karaoke / audiobook word-highlight tracks. The
     * `duration_ms` field comes straight from Edge-TTS's WordBoundary
     * metadata, so this respects the actual spoken length of every
     * word — short words still flip quickly, long words dwell. */
    const triggerMs = useBoundaries
      ? boundariesRaw
          .slice(0, boundaryLimit)
          .map((b) => b.offset_ms + (Number.isFinite(b.duration_ms) ? b.duration_ms : 0))
      : [];
    let nextBoundaryIdx = 0;

    const revealForTime = () => {
      if (state.finished) return;
      if (totalWords === 0) return;
      if (useBoundaries) {
        const currentMs = audio.currentTime * 1000;
        /* Advance the cursor past every word whose END time has
         * already passed. Monotonic — no need to rescan from zero. */
        let advancedTo = -1;
        while (nextBoundaryIdx < boundaryLimit && triggerMs[nextBoundaryIdx] <= currentMs) {
          advancedTo = nextBoundaryIdx;
          nextBoundaryIdx += 1;
        }
        if (advancedTo < 0) return;
        const tokenIdx = spokenWordTokenIndices[advancedTo];
        if (tokenIdx <= state.revealedUpTo) return;
        state.revealedUpTo = tokenIdx;
        revealUpTo(host, tokenIdx);
        return;
      }
      /* Linear fallback for older manifest entries without per-word
       * timestamps. Same semantics as before. */
      const dur = audio.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      const fraction = Math.max(0, Math.min(1, audio.currentTime / dur));
      const targetWords = Math.floor(fraction * totalWords);
      if (targetWords <= 0) return;
      const tokenIdx = wordTokenIndices[Math.min(targetWords - 1, totalWords - 1)];
      if (tokenIdx <= state.revealedUpTo) return;
      state.revealedUpTo = tokenIdx;
      revealUpTo(host, tokenIdx);
    };
    /* `timeupdate` fires roughly every 250 ms during playback — enough
     * to feel responsive without flooding the layout engine. The
     * `loadedmetadata` hook covers the corner case where the audio
     * starts before the first `timeupdate` so the very first word can
     * appear as soon as duration is known. */
    audio.addEventListener('timeupdate', revealForTime);
    audio.addEventListener('loadedmetadata', revealForTime);

    audio.addEventListener('ended', () => {
      if (state.finished) return;
      finish('completed');
    });
    audio.addEventListener('error', () => {
      if (state.finished) return;
      /* Audio failed to load (network glitch, missing file, decode
       * error). Fall back to Web Speech for THIS narration so the
       * participant still hears it. */
      state.audioEl = null;
      if (isSpeechAvailable()) {
        /* startWebSpeech is in the closure, but only `_buildController`
         * has access to it. We can't get back there from here. Cleanest:
         * just finish silently — the text is already revealed, and the
         * participant can read it. A second narrate call can be issued
         * by the operator if needed. */
        finish('completed');
      } else {
        finish('completed');
      }
    });

    try {
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          if (state.finished) return;
          /* Autoplay may be blocked on the very first slide if the user
           * hasn't interacted yet. The slide-layer integration mounts
           * narration AFTER the participant clicks past the welcome /
           * volume calibration, so this should never fire in practice;
           * if it does, finish silently with text revealed. */
          finish('completed');
        });
      }
    } catch {
      finish('completed');
    }
    return true;
  }

  _armWatchdog(state, onTimeout) {
    if (state.watchdogTimer) clearTimeout(state.watchdogTimer);
    state.watchdogTimer = setTimeout(() => {
      state.watchdogTimer = null;
      if (state.finished) return;
      onTimeout();
    }, BOUNDARY_WATCHDOG_MS);
  }

  _stopAllTimers(state) {
    state.audioGuardDispose?.();
    if (state.watchdogTimer) {
      clearTimeout(state.watchdogTimer);
      state.watchdogTimer = null;
    }
    if (state.fallbackTimer) {
      clearTimeout(state.fallbackTimer);
      state.fallbackTimer = null;
    }
  }

  _installVisibilityHandler() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (!isSpeechAvailable()) return;
      try {
        if (document.hidden) {
          window.speechSynthesis.pause?.();
        } else {
          window.speechSynthesis.resume?.();
        }
      } catch {
        /* no-op */
      }
    });
  }

  /**
   * Cancel any current narration without starting a new one. Used by slide
   * teardown hooks so we don't carry voice across screens.
   */
  cancel() {
    if (this.current) this.current.cancel();
  }
}

let _engine = null;

/**
 * Lazily-instantiated singleton — exposed via getter so import-time
 * side-effects (visibility listener, localStorage probe) only fire when a
 * call site actually needs voiceover. Tests can call `__resetVoiceover()`
 * between cases.
 */
export function getVoiceover() {
  if (!_engine) _engine = new VoiceoverEngine();
  return _engine;
}

export function __resetVoiceover() {
  if (_engine) _engine.cancel();
  _engine = null;
}
