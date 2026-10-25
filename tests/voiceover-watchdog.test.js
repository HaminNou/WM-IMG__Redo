// @vitest-environment jsdom
/**
 * V4-05: a recording that never fires `ended` or `error` (no audio output
 * device, stalled decode) used to hold a demo until the participant switched
 * Voice off. The engine now ends such an utterance like an `error` does:
 * silently, text revealed, nothing blocked.
 *
 *   hard limit = max(5 s, expected duration / rate + 3 s)
 *   `abort`    -> ends at once
 *   `stalled`  -> 4 s grace; ends only if the playback position has not moved
 *   normal end -> unchanged, and the guard is disposed (no timer left behind)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getVoiceover,
  __resetVoiceover,
  __setVoiceoverAudioDisabledForTests,
  __setVoiceoverManifestForTests,
  expectedAudioMs,
  audioWatchdogLimitMs,
  AUDIO_WATCHDOG_MARGIN_MS,
  AUDIO_WATCHDOG_MIN_MS,
  AUDIO_STALL_GRACE_MS,
} from '../src/visuals/voiceover.js';

describe('expected duration and the hard limit', () => {
  it('uses the end of the last word boundary or the file size, whichever is longer', () => {
    expect(
      expectedAudioMs({
        bytes: 12_000 /* 1 s at 96 kbps */,
        word_boundaries: [
          { offset_ms: 100, duration_ms: 200 },
          { offset_ms: 2500, duration_ms: 400 },
        ],
      })
    ).toBe(2900);
    expect(
      expectedAudioMs({ bytes: 120_000, word_boundaries: [{ offset_ms: 1, duration_ms: 1 }] })
    ).toBe(10_000);
  });
  it('falls back to 90 ms per character, then to 0', () => {
    expect(expectedAudioMs({ chars: 100 })).toBe(9000);
    expect(expectedAudioMs({})).toBe(0);
    expect(expectedAudioMs(null)).toBe(0);
  });
  it('limit: at least 5 s, otherwise expected + 3 s, scaled by the playback rate', () => {
    expect(audioWatchdogLimitMs({ bytes: 12_000 })).toBe(
      AUDIO_WATCHDOG_MIN_MS
    ); /* 1 s + 3 s < 5 s */
    expect(audioWatchdogLimitMs({ bytes: 600_000 })).toBe(50_000 + AUDIO_WATCHDOG_MARGIN_MS);
    expect(audioWatchdogLimitMs({ bytes: 600_000 }, 0.5)).toBe(100_000 + AUDIO_WATCHDOG_MARGIN_MS);
    expect(audioWatchdogLimitMs({ bytes: 600_000 }, 0)).toBe(50_000 + AUDIO_WATCHDOG_MARGIN_MS);
  });
});

describe('the watchdog on a real narration', () => {
  let audios;
  let originalAudio;

  class StubAudio {
    constructor(src) {
      this.src = src;
      this.volume = 1;
      this.playbackRate = 1;
      this.preload = 'none';
      this.currentTime = 0;
      this.duration = NaN;
      this._l = {};
      audios.push(this);
    }
    addEventListener(e, fn) {
      (this._l[e] ??= new Set()).add(fn);
    }
    removeEventListener(e, fn) {
      this._l[e]?.delete(fn);
    }
    play() {
      return Promise.resolve(); /* accepted, but the clock never moves and nothing ends */
    }
    pause() {}
    fire(e) {
      for (const fn of [...(this._l[e] ?? [])]) fn();
    }
  }

  async function hashOf(text) {
    text = text.replace(/–/g, '—');
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  beforeEach(() => {
    __resetVoiceover();
    __setVoiceoverAudioDisabledForTests(false);
    window.localStorage.clear();
    audios = [];
    originalAudio = window.Audio;
    window.Audio = StubAudio;
    /* Only the timers: the manifest lookup and the SHA-256 hash must keep running. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    __resetVoiceover();
    vi.useRealTimers();
    if (originalAudio) window.Audio = originalAudio;
    else delete window.Audio;
    __setVoiceoverManifestForTests(null);
    __setVoiceoverAudioDisabledForTests(true);
  });

  async function start(text, entryExtra = {}, via = 'narrate') {
    const hash = await hashOf(text);
    __setVoiceoverManifestForTests({
      version: 1,
      entries: { [hash]: { file: `${hash}.mp3`, ...entryExtra } },
    });
    const host = document.createElement('div');
    let ctrl;
    if (via === 'narrate') {
      ctrl = getVoiceover().narrate(host, text);
    } else {
      host.setAttribute('data-voiceover-target', '');
      host.setAttribute('data-voiceover-script', text);
      host.innerHTML = '<p>visible words</p>';
      ctrl = getVoiceover().narrateInPlace(host);
    }
    await ctrl._started;
    return { ctrl, host };
  }
  const settled = (p) => {
    let v = null;
    p.then((r) => (v = r));
    return () => v;
  };

  describe.each([['narrate'], ['narrateInPlace']])('%s path', (via) => {
    it('a recording that never ends is released at the hard limit, not before', async () => {
      const { ctrl } = await start(`Never ends ${via}`, { bytes: 12_000 }, via);
      const state = settled(ctrl.done);
      expect(audios).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(AUDIO_WATCHDOG_MIN_MS - 100);
      expect(state()).toBeNull(); /* still waiting inside the limit */
      await vi.advanceTimersByTimeAsync(200);
      expect(state()).toBe('completed');
    });

    it('a long recording gets expected + 3 s, so slow but healthy playback is not cut off', async () => {
      const { ctrl } = await start(`Long one ${via}`, { bytes: 600_000 /* 50 s */ }, via);
      const state = settled(ctrl.done);
      await vi.advanceTimersByTimeAsync(50_000 + AUDIO_WATCHDOG_MARGIN_MS - 200);
      expect(state()).toBeNull();
      await vi.advanceTimersByTimeAsync(400);
      expect(state()).toBe('completed');
    });

    it('a normal end before the limit is unchanged and leaves no timer behind', async () => {
      const { ctrl } = await start(`Normal end ${via}`, { bytes: 12_000 }, via);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      audios[0].fire('ended');
      expect(await ctrl.done).toBe('completed');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('an error is unchanged and also clears the guard', async () => {
      const { ctrl } = await start(`Error ${via}`, { bytes: 12_000 }, via);
      audios[0].fire('error');
      expect(await ctrl.done).toBe('completed');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('abort ends it at once', async () => {
      const { ctrl } = await start(`Abort ${via}`, { bytes: 12_000 }, via);
      const state = settled(ctrl.done);
      audios[0].fire('abort');
      await Promise.resolve();
      expect(state()).toBe('completed');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stalled with no progress ends after the grace period', async () => {
      const { ctrl } = await start(`Stalled ${via}`, { bytes: 600_000 }, via);
      const state = settled(ctrl.done);
      audios[0].fire('stalled');
      await vi.advanceTimersByTimeAsync(AUDIO_STALL_GRACE_MS - 100);
      expect(state()).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(state()).toBe('completed');
    });

    it('stalled that recovers (the position moved) does not end it', async () => {
      const { ctrl } = await start(`Recovers ${via}`, { bytes: 600_000 }, via);
      const state = settled(ctrl.done);
      audios[0].fire('stalled');
      audios[0].currentTime = 1.5; /* buffering finished and playback resumed */
      await vi.advanceTimersByTimeAsync(AUDIO_STALL_GRACE_MS + 500);
      expect(state()).toBeNull();
    });

    it('revealed text: the in-place host shows all its words once released', async () => {
      if (via !== 'narrateInPlace') return;
      const { ctrl, host } = await start(`Reveal ${via}`, { bytes: 12_000 }, via);
      await vi.advanceTimersByTimeAsync(AUDIO_WATCHDOG_MIN_MS + 100);
      expect(await ctrl.done).toBe('completed');
      const words = host.querySelectorAll('.vo-word');
      expect(words.length).toBeGreaterThan(0);
      for (const w of words) expect(w.className).toMatch(/revealed/);
    });
  });
});
