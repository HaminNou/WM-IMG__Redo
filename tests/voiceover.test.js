/**
 * Tests for src/visuals/voiceover.js — Web Speech API + word-sync engine.
 *
 * @vitest-environment jsdom
 *
 * The Web Speech API is mocked end-to-end so tests run deterministically
 * without depending on the host's TTS state. Boundary-event timing is
 * driven via fake timers; the watchdog fallback path is exercised by
 * starting an utterance whose mock never fires `boundary`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  isVoiceoverEnabled,
  setVoiceoverEnabled,
  isSpeechAvailable,
  pickPreferredVoice,
  htmlToNarrationText,
  tokeniseWords,
  tokenIndexAtChar,
  renderWordSpans,
  revealUpTo,
  wrapWordsInPlace,
  getVoiceover,
  __resetVoiceover,
  __setVoiceoverAudioDisabledForTests,
  CSS_WORD,
  CSS_WORD_REVEALED,
} from '../src/visuals/voiceover.js';

/* ---------- Mock Web Speech API ---------- */

class MockUtterance {
  constructor(text) {
    this.text = text;
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.lang = 'en-US';
    this.voice = null;
    this.onboundary = null;
    this.onend = null;
    this.onerror = null;
  }
}

class MockSpeechSynthesis {
  constructor() {
    this.spoken = [];
    this.cancelled = 0;
    this._voices = [
      { name: 'Microsoft David Desktop', lang: 'en-US' },
      { name: 'Google US English', lang: 'en-US' },
      { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' },
    ];
  }
  getVoices() {
    return this._voices;
  }
  speak(utterance) {
    this.spoken.push(utterance);
  }
  cancel() {
    this.cancelled += 1;
  }
  pause() {}
  resume() {}
}

let mockSynth;

beforeEach(() => {
  mockSynth = new MockSpeechSynthesis();
  /* Use defineProperty so the assignment survives `delete window.x` in
   * teardown without warnings. */
  Object.defineProperty(window, 'speechSynthesis', {
    value: mockSynth,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: MockUtterance,
    writable: true,
    configurable: true,
  });
  window.localStorage.clear();
  __resetVoiceover();
  /* The Web Speech engine is what these tests cover. Disable the
   * audio-manifest path so start() runs synchronously and the existing
   * `mockSynth.spoken` assertions don't need a microtask flush. The
   * audio path has its own dedicated specs further down that flip this
   * back on. */
  __setVoiceoverAudioDisabledForTests(true);
  vi.useFakeTimers();
});

afterEach(() => {
  __resetVoiceover();
  __setVoiceoverAudioDisabledForTests(false);
  vi.useRealTimers();
  delete window.speechSynthesis;
  delete window.SpeechSynthesisUtterance;
});

/* ---------- Pure helpers ---------- */

describe('htmlToNarrationText', () => {
  it('strips tags and collapses whitespace', () => {
    expect(htmlToNarrationText('<p>Hello <strong>world</strong>.</p>')).toBe('Hello world.');
  });
  it('handles entities via DOM decoding', () => {
    expect(htmlToNarrationText('Tom &amp; Jerry')).toBe('Tom & Jerry');
  });
  it('returns empty string for null/undefined', () => {
    expect(htmlToNarrationText(undefined)).toBe('');
    expect(htmlToNarrationText(null)).toBe('');
  });
});

describe('tokeniseWords', () => {
  it('splits into alternating word + space tokens with correct offsets', () => {
    const tokens = tokeniseWords('Hello  world');
    expect(tokens).toEqual([
      { kind: 'word', text: 'Hello', start: 0, end: 5 },
      { kind: 'space', text: '  ', start: 5, end: 7 },
      { kind: 'word', text: 'world', start: 7, end: 12 },
    ]);
  });
  it('keeps punctuation glued to its word', () => {
    const tokens = tokeniseWords('Press Space.');
    expect(tokens.map((t) => t.text)).toEqual(['Press', ' ', 'Space.']);
  });
  it('handles empty string', () => {
    expect(tokeniseWords('')).toEqual([]);
  });
});

describe('tokenIndexAtChar', () => {
  it('returns the index of the word containing charIndex', () => {
    const tokens = tokeniseWords('one two three');
    /* "one" 0..3, " " 3..4, "two" 4..7, " " 7..8, "three" 8..13 */
    expect(tokenIndexAtChar(tokens, 0)).toBe(0);
    expect(tokenIndexAtChar(tokens, 4)).toBe(2);
    expect(tokenIndexAtChar(tokens, 6)).toBe(2);
    expect(tokenIndexAtChar(tokens, 8)).toBe(4);
  });
  it('returns -1 for whitespace charIndex', () => {
    const tokens = tokeniseWords('one two');
    expect(tokenIndexAtChar(tokens, 3)).toBe(-1);
  });
  it('returns -1 for out-of-range charIndex', () => {
    const tokens = tokeniseWords('one');
    expect(tokenIndexAtChar(tokens, 999)).toBe(-1);
  });
});

describe('pickPreferredVoice', () => {
  it('prefers Microsoft Aria Natural over David', () => {
    const voices = [
      { name: 'Microsoft David Desktop', lang: 'en-US' },
      { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' },
    ];
    expect(pickPreferredVoice(voices).name).toMatch(/Aria/);
  });
  it('prefers Google US English when no Microsoft Natural voice is available', () => {
    const voices = [
      { name: 'Microsoft David Desktop', lang: 'en-US' },
      { name: 'Google US English', lang: 'en-US' },
    ];
    expect(pickPreferredVoice(voices).name).toMatch(/Google US English/);
  });
  it('falls back to any en-* voice', () => {
    const voices = [
      { name: 'SomeUnknownVoice', lang: 'fr-FR' },
      { name: 'Generic English', lang: 'en-GB' },
    ];
    expect(pickPreferredVoice(voices).name).toBe('Generic English');
  });
  it('returns null on empty list', () => {
    expect(pickPreferredVoice([])).toBeNull();
    expect(pickPreferredVoice(undefined)).toBeNull();
  });
});

describe('renderWordSpans + revealUpTo', () => {
  it('wraps each word in a vo-word span with data-vo-index', () => {
    const host = document.createElement('div');
    const tokens = tokeniseWords('one two three');
    renderWordSpans(host, tokens);
    const spans = host.querySelectorAll(`.${CSS_WORD}`);
    expect(spans).toHaveLength(3);
    expect(spans[0].textContent).toBe('one');
    expect(spans[2].textContent).toBe('three');
    expect(spans[1].getAttribute('data-vo-index')).toBe('2');
  });
  it('preserves whitespace between spans', () => {
    const host = document.createElement('div');
    renderWordSpans(host, tokeniseWords('one two'));
    expect(host.textContent).toBe('one two');
  });
  it('revealUpTo flips the revealed class progressively', () => {
    const host = document.createElement('div');
    renderWordSpans(host, tokeniseWords('a b c'));
    revealUpTo(host, 2); /* first word at idx 0, second at idx 2 */
    const spans = host.querySelectorAll(`.${CSS_WORD}`);
    expect(spans[0].classList.contains(CSS_WORD_REVEALED)).toBe(true);
    expect(spans[1].classList.contains(CSS_WORD_REVEALED)).toBe(true);
    expect(spans[2].classList.contains(CSS_WORD_REVEALED)).toBe(false);
  });
});

describe('wrapWordsInPlace', () => {
  it('wraps each word in a vo-word span while preserving paragraph + list structure', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<p>Sit comfortably.</p><ul><li>First <strong>rule</strong>.</li><li>Second item.</li></ul>';
    const tokens = wrapWordsInPlace(host);

    /* The structural elements are still there — bullets, paragraph
     * breaks, and bold all survive. */
    expect(host.querySelector('p')).not.toBeNull();
    expect(host.querySelectorAll('li')).toHaveLength(2);
    expect(host.querySelector('strong')).not.toBeNull();

    /* Every word is wrapped in a vo-word span. The visible text is
     * preserved (modulo word-internal whitespace handling — leading /
     * trailing whitespace inside text nodes is kept as text nodes). */
    const wordSpans = host.querySelectorAll(`.${CSS_WORD}`);
    const wordTexts = Array.from(wordSpans).map((s) => s.textContent);
    expect(wordTexts).toEqual(['Sit', 'comfortably.', 'First', 'rule', '.', 'Second', 'item.']);

    /* The bold span survives and now wraps the word "rule". */
    expect(host.querySelector('strong .vo-word')?.textContent).toBe('rule');

    /* Token list is parallel to spans — each word token's `data-vo-index`
     * matches its position in the tokens array. */
    expect(tokens.filter((t) => t.kind === 'word')).toHaveLength(7);
    for (const span of wordSpans) {
      const idx = Number(span.getAttribute('data-vo-index'));
      expect(tokens[idx].kind).toBe('word');
      expect(tokens[idx].text).toBe(span.textContent);
    }
  });

  it('builds a narration text whose offsets line up with token start fields', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>Hello <strong>world</strong>.</p>';
    const tokens = wrapWordsInPlace(host);
    const narrationText = tokens.map((t) => t.text).join('');

    /* Each token's [start, end) slice of the narration text must equal
     * the token's literal text — this is the invariant that lets
     * `tokenIndexAtChar(tokens, charIndex)` map boundary events back to
     * the correct vo-word span. */
    for (const tok of tokens) {
      expect(narrationText.slice(tok.start, tok.end)).toBe(tok.text);
    }
    /* Words from different DOM text nodes are joined by a single ASCII
     * space in the narration stream regardless of the original HTML
     * markup. */
    expect(narrationText).toBe('Hello world .');
  });

  it('preserves word-internal punctuation as a single token (no space split)', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>Press Space.</p>';
    wrapWordsInPlace(host);
    const wordSpans = host.querySelectorAll(`.${CSS_WORD}`);
    expect(Array.from(wordSpans).map((s) => s.textContent)).toEqual(['Press', 'Space.']);
  });

  it('returns empty tokens for an empty host', () => {
    const host = document.createElement('div');
    expect(wrapWordsInPlace(host)).toEqual([]);
    expect(host.querySelectorAll(`.${CSS_WORD}`)).toHaveLength(0);
  });

  it('walks deeply nested structure without losing tokens', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div><p>One</p><div><p>Two <em>three</em></p></div><p>Four</p></div>';
    const tokens = wrapWordsInPlace(host);
    const wordTokens = tokens.filter((t) => t.kind === 'word');
    expect(wordTokens.map((t) => t.text)).toEqual(['One', 'Two', 'three', 'Four']);
  });
});

/* ---------- Engine integration ---------- */

describe('VoiceoverEngine.narrate', () => {
  it('renders word spans synchronously and starts speaking', () => {
    const host = document.createElement('div');
    const vo = getVoiceover();
    vo.narrate(host, 'Hello world');
    expect(host.querySelectorAll(`.${CSS_WORD}`)).toHaveLength(2);
    expect(mockSynth.spoken).toHaveLength(1);
    expect(mockSynth.spoken[0].text).toBe('Hello world');
  });

  it('reveals words on boundary events with the correct charIndex mapping', () => {
    const host = document.createElement('div');
    const vo = getVoiceover();
    vo.narrate(host, 'one two three');
    const utt = mockSynth.spoken[0];
    /* Fire boundary at "two" start (charIndex 4). */
    utt.onboundary({ name: 'word', charIndex: 4 });
    const spans = host.querySelectorAll(`.${CSS_WORD}`);
    expect(spans[0].classList.contains(CSS_WORD_REVEALED)).toBe(true);
    expect(spans[1].classList.contains(CSS_WORD_REVEALED)).toBe(true);
    expect(spans[2].classList.contains(CSS_WORD_REVEALED)).toBe(false);
  });

  it('completes when onend fires and revealAll is applied', async () => {
    const host = document.createElement('div');
    const vo = getVoiceover();
    const ctrl = vo.narrate(host, 'one two');
    const utt = mockSynth.spoken[0];
    utt.onend();
    const reason = await ctrl.done;
    expect(reason).toBe('completed');
    const spans = host.querySelectorAll(`.${CSS_WORD}`);
    for (const s of spans) expect(s.classList.contains(CSS_WORD_REVEALED)).toBe(true);
  });

  it('skip() reveals all words and cancels the speech engine', async () => {
    const host = document.createElement('div');
    const vo = getVoiceover();
    const ctrl = vo.narrate(host, 'one two three');
    ctrl.skip();
    const reason = await ctrl.done;
    expect(reason).toBe('skipped');
    expect(mockSynth.cancelled).toBeGreaterThan(0);
    const spans = host.querySelectorAll(`.${CSS_WORD}`);
    for (const s of spans) expect(s.classList.contains(CSS_WORD_REVEALED)).toBe(true);
  });

  it('cancel() finishes with reason="cancelled"', async () => {
    const host = document.createElement('div');
    const vo = getVoiceover();
    const ctrl = vo.narrate(host, 'one two');
    ctrl.cancel();
    const reason = await ctrl.done;
    expect(reason).toBe('cancelled');
  });

  it('starting a new narrate cancels the previous one', async () => {
    const host = document.createElement('div');
    const vo = getVoiceover();
    const first = vo.narrate(host, 'first slide text');
    const firstReason = first.done;
    vo.narrate(host, 'second slide text');
    expect(await firstReason).toBe('cancelled');
    expect(mockSynth.spoken).toHaveLength(2);
  });

  it('falls back to timer-based reveal when no boundary events fire (watchdog)', async () => {
    const host = document.createElement('div');
    const vo = getVoiceover();
    const ctrl = vo.narrate(host, 'one two three');
    /* No boundary fired — advance past watchdog window. */
    vi.advanceTimersByTime(700); /* > BOUNDARY_WATCHDOG_MS = 600 */
    /* Watchdog now schedules the first fallback tick after one
     * WORD_REVEAL_MS_PER_WORD interval — advance enough to reveal
     * all three words. */
    vi.advanceTimersByTime(2000);
    /* After the fallback walks past the last word, finish() runs. */
    const reason = await ctrl.done;
    expect(reason).toBe('completed');
    const spans = host.querySelectorAll(`.${CSS_WORD}`);
    for (const s of spans) expect(s.classList.contains(CSS_WORD_REVEALED)).toBe(true);
  });

  it('narrateInPlace preserves DOM structure and reveals words by boundary charIndex', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>Hello <strong>world</strong>.</p>';
    const vo = getVoiceover();
    vo.narrateInPlace(host);

    /* Structural elements survive. */
    expect(host.querySelector('p')).not.toBeNull();
    expect(host.querySelector('strong')).not.toBeNull();

    /* The utterance was started with the reconstructed narration text,
     * which inserts an ASCII space between words from different text
     * nodes. */
    expect(mockSynth.spoken).toHaveLength(1);
    expect(mockSynth.spoken[0].text).toBe('Hello world .');

    /* Boundary at "world" (charIndex 6 in "Hello world .") reveals
     * "Hello" + "world" but not the trailing punctuation. */
    const utt = mockSynth.spoken[0];
    utt.onboundary({ name: 'word', charIndex: 6 });
    const spans = host.querySelectorAll(`.${CSS_WORD}`);
    expect(spans).toHaveLength(3);
    expect(spans[0].classList.contains(CSS_WORD_REVEALED)).toBe(true); /* Hello */
    expect(spans[1].classList.contains(CSS_WORD_REVEALED)).toBe(true); /* world */
    expect(spans[2].classList.contains(CSS_WORD_REVEALED)).toBe(false); /* . */
  });

  it('narrateInPlace speaks data-voiceover-script when present, leaving visible DOM intact', () => {
    const host = document.createElement('div');
    host.setAttribute('data-voiceover-target', '');
    host.setAttribute('data-voiceover-script', "Welcome. Hello world. That's everything.");
    host.innerHTML = '<p>Hello <strong>world</strong>.</p>';
    const vo = getVoiceover();
    vo.narrateInPlace(host);

    /* The visible structure is unchanged — the experimenter's framing
     * words are spoken-only. */
    expect(host.querySelector('p')).not.toBeNull();
    expect(host.querySelector('strong')).not.toBeNull();

    /* The Web Speech fallback (used here because the test stubs out the
     * audio path) gets the script text — not the on-screen prose. */
    expect(mockSynth.spoken).toHaveLength(1);
    expect(mockSynth.spoken[0].text).toBe("Welcome. Hello world. That's everything.");
  });

  it('narrateInPlace cancels a previous flat narration cleanly', async () => {
    const host = document.createElement('div');
    const vo = getVoiceover();
    const first = vo.narrate(host, 'one two');
    const firstReason = first.done;
    const host2 = document.createElement('div');
    host2.innerHTML = '<p>Three.</p>';
    vo.narrateInPlace(host2);
    expect(await firstReason).toBe('cancelled');
    expect(mockSynth.spoken).toHaveLength(2);
  });

  it('speak() utters the text with no DOM mutation and no per-word reveal', async () => {
    const vo = getVoiceover();
    const ctrl = vo.speak('Hello caption.');
    expect(mockSynth.spoken).toHaveLength(1);
    expect(mockSynth.spoken[0].text).toBe('Hello caption.');
    /* No spans were rendered into any host (none was passed). */
    expect(document.querySelectorAll(`.${CSS_WORD}`)).toHaveLength(0);
    /* Completing the utterance resolves done. */
    mockSynth.spoken[0].onend();
    const reason = await ctrl.done;
    expect(reason).toBe('completed');
  });

  it('speak() short-circuits to a resolved no-op when text is empty / whitespace', async () => {
    const vo = getVoiceover();
    const ctrl = vo.speak('   ');
    expect(mockSynth.spoken).toHaveLength(0);
    expect(await ctrl.done).toBe('completed');
  });

  it('speak() short-circuits in mute mode without speaking', async () => {
    const vo = getVoiceover();
    vo.setMuted(true);
    const ctrl = vo.speak('Hello');
    expect(mockSynth.spoken).toHaveLength(0);
    expect(await ctrl.done).toBe('completed');
  });

  it('speak() cancels the previous narration when a new caption arrives', async () => {
    const host = document.createElement('div');
    const vo = getVoiceover();
    const first = vo.narrate(host, 'first caption');
    const firstReason = first.done;
    vo.speak('second caption');
    expect(await firstReason).toBe('cancelled');
    expect(mockSynth.spoken).toHaveLength(2);
    expect(mockSynth.spoken[1].text).toBe('second caption');
  });

  it('two consecutive speak() calls cancel the first', async () => {
    const vo = getVoiceover();
    const a = vo.speak('one');
    const aReason = a.done;
    vo.speak('two');
    expect(await aReason).toBe('cancelled');
    expect(mockSynth.spoken).toHaveLength(2);
  });

  it('mute path reveals words via fallback timer with no audio', async () => {
    const host = document.createElement('div');
    const vo = getVoiceover();
    vo.setMuted(true);
    const ctrl = vo.narrate(host, 'one two');
    expect(mockSynth.spoken).toHaveLength(0); /* never spoke */
    vi.advanceTimersByTime(2000);
    const reason = await ctrl.done;
    expect(reason).toBe('completed');
    const spans = host.querySelectorAll(`.${CSS_WORD}`);
    for (const s of spans) expect(s.classList.contains(CSS_WORD_REVEALED)).toBe(true);
  });
});

describe('voiceover preference persistence', () => {
  it('defaults to enabled when no localStorage entry exists', () => {
    expect(isVoiceoverEnabled()).toBe(true);
  });
  it('round-trips through setVoiceoverEnabled', () => {
    setVoiceoverEnabled(false);
    expect(isVoiceoverEnabled()).toBe(false);
    setVoiceoverEnabled(true);
    expect(isVoiceoverEnabled()).toBe(true);
  });
});

describe('isSpeechAvailable', () => {
  it('returns true when the API is mounted on window', () => {
    expect(isSpeechAvailable()).toBe(true);
  });
  it('returns false when the API is unavailable', () => {
    delete window.speechSynthesis;
    expect(isSpeechAvailable()).toBe(false);
  });
});

/* ---------- Audio-manifest path ---------- */

describe('audio-manifest playback', () => {
  /* The audio path is async (manifest fetch + SHA-256 hash + Audio
   * playback). These tests re-enable the audio path that the rest of
   * the suite disables, stub the manifest, stub the Audio constructor,
   * and flush microtasks before assertions. */

  let createdAudios;
  let originalAudio;
  let __setVoiceoverManifestForTests;

  beforeEach(async () => {
    /* Pull the test hooks lazily so the import doesn't pollute earlier
     * specs that don't need them. */
    const mod = await import('../src/visuals/voiceover.js');
    __setVoiceoverManifestForTests = mod.__setVoiceoverManifestForTests;

    __setVoiceoverAudioDisabledForTests(false);
    /* Real timers — we need the microtask queue to drain naturally for
     * the awaited fetch / hash. Fake timers freeze that queue too. */
    vi.useRealTimers();

    createdAudios = [];
    originalAudio = window.Audio;
    class MockAudio {
      constructor(src) {
        this.src = src;
        this.volume = 1;
        this.playbackRate = 1;
        this.preload = 'none';
        this.played = false;
        this._listeners = {};
        createdAudios.push(this);
      }
      addEventListener(event, fn) {
        this._listeners[event] = fn;
      }
      play() {
        this.played = true;
        return Promise.resolve();
      }
      pause() {}
      _fireEnded() {
        this._listeners.ended?.();
      }
      _fireError() {
        this._listeners.error?.();
      }
    }
    window.Audio = MockAudio;
  });

  afterEach(() => {
    if (originalAudio) window.Audio = originalAudio;
    else delete window.Audio;
    __setVoiceoverManifestForTests(null);
    __setVoiceoverAudioDisabledForTests(true); /* restore default for other suites */
    vi.useFakeTimers();
  });

  /* Helper: SHA-256 hex of `text`. Runs the same algorithm the engine
   * uses; jsdom + Node ≥20 expose `crypto.subtle`. */
  async function hashOf(text) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const bytes = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  it('plays an Audio element for a manifest hit and skips Web Speech', async () => {
    const text = 'Hello world';
    const hash = await hashOf(text);
    __setVoiceoverManifestForTests({
      version: 1,
      voice: 'nova',
      model: 'tts-1-hd',
      entries: { [hash]: { file: `${hash}.mp3` } },
    });

    const host = document.createElement('div');
    const vo = getVoiceover();
    const ctrl = vo.narrate(host, text);

    /* Drain the manifest + hash + audio-create microtasks. Two ticks
     * suffice (loadManifest → sha256Hex → Audio()). A few extra
     * `Promise.resolve()` waits add no risk and absorb any future
     * timing jitter. */
    await ctrl._started;

    expect(createdAudios).toHaveLength(1);
    expect(createdAudios[0].src).toContain(`${hash}.mp3`);
    expect(createdAudios[0].played).toBe(true);
    /* Web Speech was NOT used. */
    expect(mockSynth.spoken).toHaveLength(0);
    /* Word spans reveal progressively in lockstep with audio playback
     * (driven by `timeupdate`), so before any time has elapsed no spans
     * are revealed yet — the mock audio has not fired a timeupdate. */
    const spansBefore = host.querySelectorAll(`.${CSS_WORD}`);
    for (const s of spansBefore) expect(s.classList.contains(CSS_WORD_REVEALED)).toBe(false);

    /* Simulate the audio finishing — controller resolves with completed
     * and `finish` calls `revealAll`, so every word span ends up
     * revealed regardless of how many `timeupdate` ticks fired. */
    createdAudios[0]._fireEnded();
    const reason = await ctrl.done;
    expect(reason).toBe('completed');
    const spansAfter = host.querySelectorAll(`.${CSS_WORD}`);
    for (const s of spansAfter) expect(s.classList.contains(CSS_WORD_REVEALED)).toBe(true);
  });

  it('reveals words progressively as `timeupdate` events fire (audio-clock-driven gray→white pacing)', async () => {
    const text = 'one two three four five';
    const hash = await hashOf(text);
    __setVoiceoverManifestForTests({
      version: 1,
      voice: 'nova',
      model: 'tts-1-hd',
      entries: { [hash]: { file: `${hash}.mp3` } },
    });

    const host = document.createElement('div');
    const vo = getVoiceover();
    const ctrl = vo.narrate(host, text);
    await ctrl._started;

    const audio = createdAudios[0];
    /* Stretch the mock with mutable currentTime / duration and a helper
     * to fire `timeupdate`. The engine reveals words as
     * `floor(currentTime / duration * totalWords)` advances. */
    audio.duration = 5;
    audio.currentTime = 0;
    audio._fireTimeUpdate = function () {
      this._listeners.timeupdate?.();
    };

    const wordsRevealed = () => host.querySelectorAll(`.${CSS_WORD}.${CSS_WORD_REVEALED}`).length;

    /* Initially nothing revealed. */
    expect(wordsRevealed()).toBe(0);

    /* 40 % through the audio → first 2 of 5 words revealed. */
    audio.currentTime = 2;
    audio._fireTimeUpdate();
    expect(wordsRevealed()).toBe(2);

    /* 80 % through → 4 of 5 words revealed. */
    audio.currentTime = 4;
    audio._fireTimeUpdate();
    expect(wordsRevealed()).toBe(4);

    /* Audio ends → revealAll fills in the final word. */
    audio._fireEnded();
    await ctrl.done;
    expect(wordsRevealed()).toBe(5);
  });

  it('reveals words on `word_boundaries` timestamps when the manifest entry has them (lock-step with spoken pace, end-of-word trigger)', async () => {
    /* When the manifest entry carries Edge-TTS-derived word boundaries,
     * the engine drives the reveal off those offsets rather than the
     * linear `currentTime / duration` approximation. Each visible word
     * lights at the END of its spoken time (`offset_ms + duration_ms`),
     * so the visual trails the voice rather than racing ahead of it. */
    const text = 'one two three four five';
    const hash = await hashOf(text);
    __setVoiceoverManifestForTests({
      version: 1,
      voice: 'en-US-AndrewMultilingualNeural',
      model: 'edge-tts',
      entries: {
        [hash]: {
          file: `${hash}.mp3`,
          /* End-of-word triggers (offset + duration): "one"@150ms,
           * "two"@350ms, "three"@1700ms, "four"@1750ms, "five"@1850ms. */
          word_boundaries: [
            { text: 'one', offset_ms: 0, duration_ms: 150 },
            { text: 'two', offset_ms: 200, duration_ms: 150 },
            { text: 'three', offset_ms: 1500, duration_ms: 200 },
            { text: 'four', offset_ms: 1600, duration_ms: 150 },
            { text: 'five', offset_ms: 1700, duration_ms: 150 },
          ],
        },
      },
    });

    const host = document.createElement('div');
    const vo = getVoiceover();
    const ctrl = vo.narrate(host, text);
    await ctrl._started;

    const audio = createdAudios[0];
    audio.duration = 2; /* seconds */
    audio.currentTime = 0;
    audio._fireTimeUpdate = function () {
      this._listeners.timeupdate?.();
    };

    const wordsRevealed = () => host.querySelectorAll(`.${CSS_WORD}.${CSS_WORD_REVEALED}`).length;

    expect(wordsRevealed()).toBe(0);

    /* currentTime = 0.05 s → no word has finished yet (earliest end is
     * 150 ms). Visual stays gray, voice is mid-"one". */
    audio.currentTime = 0.05;
    audio._fireTimeUpdate();
    expect(wordsRevealed()).toBe(0);

    /* currentTime = 0.2 s → "one" has finished (ended at 150 ms);
     * "two" has not (ends at 350 ms). → 1 word revealed. */
    audio.currentTime = 0.2;
    audio._fireTimeUpdate();
    expect(wordsRevealed()).toBe(1);

    /* currentTime = 0.4 s → "two" has finished → 2 words. */
    audio.currentTime = 0.4;
    audio._fireTimeUpdate();
    expect(wordsRevealed()).toBe(2);

    /* currentTime = 1.0 s → still 2 words; "three" hasn't ended (1700 ms). */
    audio.currentTime = 1.0;
    audio._fireTimeUpdate();
    expect(wordsRevealed()).toBe(2);

    /* currentTime = 1.71 s → "three" has finished → 3 words. */
    audio.currentTime = 1.71;
    audio._fireTimeUpdate();
    expect(wordsRevealed()).toBe(3);

    /* currentTime = 1.86 s → "four" (1750) + "five" (1850) finished → 5. */
    audio.currentTime = 1.86;
    audio._fireTimeUpdate();
    expect(wordsRevealed()).toBe(5);

    audio._fireEnded();
    await ctrl.done;
    expect(wordsRevealed()).toBe(5);
  });

  it('skips punctuation-only visible tokens (em-dashes) when mapping boundaries → visible spans', async () => {
    /* Edge-TTS emits a boundary per SPOKEN word, but the visible text
     * tokenisation treats `\S+` (e.g. "—") as a word token even though
     * the engine never speaks it. The reveal cursor must skip these
     * non-spoken tokens so the visible word lights up in sync with the
     * audio, not one token behind. */
    const text = 'Dot 1 — remember its location.';
    const hash = await hashOf(text);
    __setVoiceoverManifestForTests({
      version: 1,
      voice: 'en-US-AndrewMultilingualNeural',
      model: 'edge-tts',
      entries: {
        [hash]: {
          file: `${hash}.mp3`,
          /* 5 boundaries for 6 visible word tokens — the em-dash has
           * no spoken boundary. Real numbers from a sample render. */
          word_boundaries: [
            { text: 'Dot', offset_ms: 118, duration_ms: 235 },
            { text: '1', offset_ms: 353, duration_ms: 441 },
            { text: 'remember', offset_ms: 1412, duration_ms: 309 },
            { text: 'its', offset_ms: 1721, duration_ms: 118 },
            { text: 'location', offset_ms: 1838, duration_ms: 706 },
          ],
        },
      },
    });

    const host = document.createElement('div');
    const vo = getVoiceover();
    const ctrl = vo.narrate(host, text);
    await ctrl._started;

    const audio = createdAudios[0];
    audio.duration = 3;
    audio.currentTime = 0;
    audio._fireTimeUpdate = function () {
      this._listeners.timeupdate?.();
    };

    /* All six visible word spans, in order, with their text content
     * for clarity. Index 2 is the em-dash. */
    const spans = host.querySelectorAll(`.${CSS_WORD}`);
    expect(spans).toHaveLength(6);
    expect(spans[2].textContent).toBe('—');

    /* End-of-word triggers (offset + duration):
     *   Dot:      ends @ 353 ms
     *   1:        ends @ 794 ms
     *   remember: ends @ 1721 ms
     *   its:      ends @ 1839 ms
     *   location: ends @ 2544 ms
     *
     * currentTime = 0.4 s → only "Dot" has ended (353 ms). "1" still
     * being spoken, so its span stays gray. The em-dash and everything
     * after stays gray. */
    audio.currentTime = 0.4;
    audio._fireTimeUpdate();
    expect(spans[0].classList.contains(CSS_WORD_REVEALED)).toBe(true);
    expect(spans[1].classList.contains(CSS_WORD_REVEALED)).toBe(false);
    expect(spans[2].classList.contains(CSS_WORD_REVEALED)).toBe(false);

    /* currentTime = 1.8 s → "Dot", "1", and "remember" have all ended.
     * `revealUpTo` flips every span with data-vo-index ≤ "remember"'s
     * token index, which includes the em-dash (span 2) as a side
     * effect — so spans 0, 1, 2, 3 are revealed; span 4 ("its", ends
     * at 1839 ms) is NOT yet. The reveal trails the voice, not leads
     * it. */
    audio.currentTime = 1.8;
    audio._fireTimeUpdate();
    expect(spans[3].textContent).toBe('remember');
    expect(spans[3].classList.contains(CSS_WORD_REVEALED)).toBe(true);
    expect(spans[2].classList.contains(CSS_WORD_REVEALED)).toBe(true);
    expect(spans[4].classList.contains(CSS_WORD_REVEALED)).toBe(false);

    audio._fireEnded();
    await ctrl.done;
    for (const s of spans) expect(s.classList.contains(CSS_WORD_REVEALED)).toBe(true);
  });

  it('falls back to linear reveal when `word_boundaries` is absent (back-compat with older manifests)', async () => {
    /* Manifest entries rendered before the word-boundary feature was
     * added carry no `word_boundaries` array. The engine should still
     * progressively reveal words using the linear fallback so older
     * manifests don't regress. */
    const text = 'alpha beta gamma delta';
    const hash = await hashOf(text);
    __setVoiceoverManifestForTests({
      version: 1,
      voice: 'en-US-AndrewMultilingualNeural',
      model: 'edge-tts',
      entries: { [hash]: { file: `${hash}.mp3` /* no word_boundaries */ } },
    });

    const host = document.createElement('div');
    const vo = getVoiceover();
    const ctrl = vo.narrate(host, text);
    await ctrl._started;

    const audio = createdAudios[0];
    audio.duration = 4;
    audio.currentTime = 0;
    audio._fireTimeUpdate = function () {
      this._listeners.timeupdate?.();
    };

    const wordsRevealed = () => host.querySelectorAll(`.${CSS_WORD}.${CSS_WORD_REVEALED}`).length;

    /* 50 % through → 2 of 4 words revealed (linear). */
    audio.currentTime = 2;
    audio._fireTimeUpdate();
    expect(wordsRevealed()).toBe(2);

    audio._fireEnded();
    await ctrl.done;
    expect(wordsRevealed()).toBe(4);
  });

  it('does NOT fall back to Web Speech when the manifest is missing (policy: silent over wrong-voice)', async () => {
    __setVoiceoverManifestForTests(null);

    const host = document.createElement('div');
    const vo = getVoiceover();
    const ctrl = vo.narrate(host, 'Hello world');

    await ctrl._started;

    expect(createdAudios).toHaveLength(0);
    /* Web Speech intentionally disabled — narration finishes silently. */
    expect(mockSynth.spoken).toHaveLength(0);
  });

  it('does NOT fall back to Web Speech when the hash is not in the manifest; records harvest miss', async () => {
    __setVoiceoverManifestForTests({
      version: 1,
      voice: 'nova',
      model: 'tts-1-hd',
      entries: { abc123_unknown: { file: 'abc123.mp3' } },
    });

    const host = document.createElement('div');
    const vo = getVoiceover();
    const ctrl = vo.narrate(host, 'Hello world');

    await ctrl._started;

    expect(createdAudios).toHaveLength(0);
    /* Web Speech intentionally disabled. */
    expect(mockSynth.spoken).toHaveLength(0);
    /* Harvest log captured the unmatched text for re-rendering. */
    expect(window.__voiceoverHarvest).toBeDefined();
    expect(window.__voiceoverHarvest.some((e) => e.text === 'Hello world')).toBe(true);
    /* Clean up so other tests don't inherit. */
    delete window.__voiceoverHarvest;
  });

  it('speak() also uses the audio path on manifest hit', async () => {
    const text = 'Short caption.';
    const hash = await hashOf(text);
    __setVoiceoverManifestForTests({
      version: 1,
      voice: 'nova',
      model: 'tts-1-hd',
      entries: { [hash]: { file: `${hash}.mp3` } },
    });

    const vo = getVoiceover();
    const ctrl = vo.speak(text);

    await ctrl._started;

    expect(createdAudios).toHaveLength(1);
    expect(mockSynth.spoken).toHaveLength(0);
  });
});
