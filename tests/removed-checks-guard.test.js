import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The headphone check and the pitch-discrimination check were removed so the
 * initial steps match the original Experiment 2. This guard fails if their
 * code, data fields or participant-facing wording come back in shipped files.
 * Tests are not scanned: the exporter and schema tests deliberately feed old
 * phase names to prove that old dumps still export.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REMOVED =
  /headphone[_ -]?(check|trial|pass)|pitch[_ -]?(check|discrimination|direction|trial)|audio[-_]check|playStereoSine|audio_check_failed|headphones_pass|n_chose_anti|AUDIO_CHECK|planPitchTrials/i;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('removed audio checks stay removed', () => {
  const files = ['src', 'scripts', 'schemas']
    .flatMap((d) => walk(join(ROOT, d)))
    .filter((f) => /\.(js|json|html|css)$/.test(f));

  it('scans a non-trivial set of files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no shipped source, script or schema mentions them', () => {
    const hits = files.filter((f) => REMOVED.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => f.replace(ROOT, ''))).toEqual([]);
  });

  it('the participant listing has no such item but keeps the speakers-acceptable wording', () => {
    const md = readFileSync(join(ROOT, 'prolific-study-description.md'), 'utf8');
    const block = md.split('<!-- PASTE-BLOCK-START -->')[1].split('<!-- PASTE-BLOCK-END -->')[0];
    expect(block).not.toMatch(/headphone check|pitch[- ]discrimination|pitch check/i);
    expect(block).toMatch(/headphones are recommended/i);
  });
});
