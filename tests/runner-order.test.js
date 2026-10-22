import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* runner.js starts a session when imported, so its timeline order is checked
 * from the source. */
const source = readFileSync(new URL('../src/runner.js', import.meta.url), 'utf-8');
const at = (needle) => {
  const i = source.indexOf(needle, source.indexOf('const timeline = ['));
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

describe('runner timeline', () => {
  it('switches the display guard off after the last trial and before every end-of-session node', () => {
    const stop = at('stopDisplayGuardNode()');
    expect(stop).toBeGreaterThan(at('...mainPair.mainB.nodes'));
    expect(stop).toBeLessThan(at('endOfTaskIntroNode()'));
    expect(stop).toBeLessThan(at('...assembleQuestionnaireChain()'));
    expect(stop).toBeLessThan(at('uploadProgressNode('));
    expect(stop).toBeLessThan(at('completionRedirectNode()'));
  });
});
