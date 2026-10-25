/**
 * Every source, script and test file the pre-registration names must exist,
 * so a rename or a removed test cannot leave the document pointing at nothing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(resolve(ROOT, 'pre-reg', 'pre-reg.json'), 'utf8');

describe('pre-reg.json file references', () => {
  const refs = [
    ...new Set(
      raw.match(
        /(?<![A-Za-z./])(?:tests|scripts|src|schemas|pre-reg)\/[A-Za-z0-9_./-]*[A-Za-z0-9_]\.(?:js|py|json)\b/g
      ) ?? []
    ),
  ];

  it('names at least the files the plan relies on', () => {
    expect(refs.length).toBeGreaterThan(10);
  });

  it('every named file exists', () => {
    const missing = refs.filter((f) => !existsSync(resolve(ROOT, f)));
    expect(missing, `dangling references: ${missing.join(', ')}`).toEqual([]);
  });
});
