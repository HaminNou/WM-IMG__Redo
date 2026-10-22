/**
 * Phase-enum coverage test.
 *
 * The trial-schema (`schemas/trial.schema.json`) declares the locked taxonomy
 * of `phase` discriminators that the runtime is allowed to emit. Analysis
 * scripts filter on these tags, so any drift between "what the runtime
 * actually writes" and "what the schema accepts" silently breaks downstream.
 *
 * This test scans every `phase: '...'` literal under `src/`
 * and verifies that each one appears in the schema enum, AND that every
 * schema enum entry is reachable from at least one source emitter.
 *
 * If you add a new phase tag in code, you MUST also add it to the schema —
 * this test will fail until you do. If you remove a tag from the runtime,
 * remove it from the schema too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC_DIR = resolve(HERE, '..', 'src');
const SCHEMA_PATH = resolve(HERE, '..', 'schemas', 'trial.schema.json');

function walkJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walkJsFiles(abs));
    else if (entry.endsWith('.js')) out.push(abs);
  }
  return out;
}

function extractPhasesFromSource(filePath) {
  const text = readFileSync(filePath, 'utf-8');
  const phases = new Set();
  /* `phase: 'foo'` literal in object initialisers (data: {phase: '…'}). */
  for (const m of text.matchAll(/\bphase:\s*['"]([a-z_][a-z0-9_]*)['"]/gi)) {
    phases.add(m[1]);
  }
  /* `data.phase = 'foo'` assignment (used in strategy.js where the phase is
   * set inside on_finish rather than the static data block). */
  for (const m of text.matchAll(
    /\b(?:data|datum|row|r)\.phase\s*=\s*['"]([a-z_][a-z0-9_]*)['"]/gi
  )) {
    phases.add(m[1]);
  }
  /* `function fooNode(label = 'phase_name')` default-parameter pattern, used
   * in d_only.js where the same node factory emits either the canonical phase
   * or a caller-overridden label (e.g. for practice rows). */
  for (const m of text.matchAll(/\blabel\s*=\s*['"]([a-z_][a-z0-9_]*)['"]/gi)) {
    phases.add(m[1]);
  }
  /* `phase: label ?? 'phase_name'` null-coalesce default, used in
   * debrief.js where the upload node accepts an optional label override but
   * falls back to the canonical phase tag. */
  for (const m of text.matchAll(/\bphase:\s*[^,}\n]*?\?\?\s*['"]([a-z_][a-z0-9_]*)['"]/gi)) {
    phases.add(m[1]);
  }
  return phases;
}

describe('phase-enum coverage', () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
  const enumSet = new Set(schema.properties.phase.enum);

  const allFiles = walkJsFiles(SRC_DIR);
  const emitted = new Set();
  for (const f of allFiles) {
    for (const p of extractPhasesFromSource(f)) emitted.add(p);
  }

  it('every phase emitted by src/ appears in the schema enum', () => {
    const missing = [...emitted].filter((p) => !enumSet.has(p)).sort();
    expect(missing, `Phases emitted by src/ but not in schema enum: ${missing.join(', ')}`).toEqual(
      []
    );
  });

  it('every phase in the schema enum is emitted by at least one src/ file', () => {
    const orphaned = [...enumSet].filter((p) => !emitted.has(p)).sort();
    expect(
      orphaned,
      `Phases in schema enum but no src/ file emits them: ${orphaned.join(', ')}`
    ).toEqual([]);
  });

  it('schema enum has no duplicate entries', () => {
    expect(schema.properties.phase.enum).toHaveLength(enumSet.size);
  });
});
