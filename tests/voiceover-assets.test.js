/**
 * @vitest-environment jsdom
 *
 * Every string the demos can speak must have a pre-rendered recording.
 *
 * `enumerateDemoNarrationStrings()` is the authoritative list of spoken text
 * (demos.js sets captions through `getVoiceover().speak(...)`; every other
 * screen runs silent). The engine looks a caption up by the SHA-256 of its
 * text (en dashes written as em dashes). A miss is not silent: the engine
 * falls back to the browser's own speech voice, so one slide would be read in
 * a different voice from the rest.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { enumerateDemoNarrationStrings } from '../src/instructions/demos.js';

const DIR = join(process.cwd(), 'public', 'voiceover');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const sha = (text) => createHash('sha256').update(text.replace(/–/g, '—'), 'utf8').digest('hex');

describe('narration assets', () => {
  const spoken = enumerateDemoNarrationStrings();

  it('lists a plausible number of spoken strings', () => {
    expect(spoken.length).toBeGreaterThan(30);
  });

  it('every spoken demo string has a manifest entry', () => {
    const missing = spoken.filter((s) => !manifest.entries[sha(s)]);
    expect(missing, `no recording for: ${JSON.stringify(missing, null, 1)}`).toEqual([]);
  });

  it('every spoken demo string has a non-empty MP3 file of the recorded size', () => {
    for (const s of spoken) {
      const e = manifest.entries[sha(s)];
      if (!e) continue;
      const file = join(DIR, e.file);
      expect(existsSync(file), `missing file ${e.file}`).toBe(true);
      const size = statSync(file).size;
      expect(size).toBeGreaterThan(1000);
      expect(size).toBe(e.bytes);
    }
  });

  it('every manifest entry is filed under its own hash and points at an MP3', () => {
    for (const [key, e] of Object.entries(manifest.entries)) {
      expect(e.file).toBe(`${key}.mp3`);
      const head = readFileSync(join(DIR, e.file)).subarray(0, 3);
      const id3 = head.toString('latin1') === 'ID3';
      const frameSync = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
      expect(id3 || frameSync, `${e.file} is not an MP3`).toBe(true);
    }
  });
});

describe('every harvested narration string is recorded and the recordings are sane', () => {
  const strings = JSON.parse(readFileSync(join(DIR, 'strings.json'), 'utf8'));
  const texts = strings.map((e) => (typeof e === 'string' ? e : e.text));

  it('every harvested string has a manifest entry whose file hash is the hash of that text', () => {
    const missing = texts.filter((t) => !manifest.entries[sha(t)]);
    expect(missing, `no recording for: ${JSON.stringify(missing, null, 1)}`).toEqual([]);
    for (const t of texts) {
      const e = manifest.entries[sha(t)];
      expect(e.file).toBe(`${sha(t)}.mp3`);
      expect(e.chars).toBe(t.length);
    }
  });

  it('the manifest is locked to one voice, model and rate', () => {
    expect(manifest.voice).toBe('en-US-AndrewMultilingualNeural');
    expect(manifest.model).toBe('edge-tts');
    expect(manifest.rate).toBe('-15%');
  });

  it('every recording carries word boundaries, in order, and a plausible speaking rate', () => {
    /* 96 kbps mono MP3 is 12,000 bytes/s, so bytes give the duration without decoding. */
    for (const e of Object.values(manifest.entries)) {
      const wb = e.word_boundaries;
      expect(Array.isArray(wb) && wb.length > 0, `no word boundaries: ${e.file}`).toBe(true);
      for (let i = 1; i < wb.length; i++) {
        expect(wb[i].offset_ms, e.file).toBeGreaterThanOrEqual(wb[i - 1].offset_ms);
      }
      const seconds = e.bytes / 12000;
      const charsPerSecond = e.chars / seconds;
      expect(
        charsPerSecond,
        `${e.file} speaks at ${charsPerSecond.toFixed(1)} chars/s`
      ).toBeGreaterThan(6);
      expect(
        charsPerSecond,
        `${e.file} speaks at ${charsPerSecond.toFixed(1)} chars/s`
      ).toBeLessThan(22);
      const lastEnd = (wb[wb.length - 1].offset_ms + wb[wb.length - 1].duration_ms) / 1000;
      expect(lastEnd, `${e.file}: audio ends before the last word`).toBeLessThanOrEqual(
        seconds + 0.5
      );
    }
  });
});
