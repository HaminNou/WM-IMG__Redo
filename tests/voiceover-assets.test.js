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
