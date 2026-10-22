/**
 * Pre-flight launch-check tests.
 *
 * Exercises only the pure helpers — argv parsing, deployment-issue evaluation,
 * issue formatting. The gate-runner side (lint / format / test / build) is
 * exercised by actually running `npm run preflight` once the rest of the suite
 * is green; we don't re-run it from inside Vitest.
 */
import { describe, it, expect } from 'vitest';
import {
  parsePreflightArgs,
  evaluatePreflight,
  formatIssues,
  findPlaceholderTokens,
  PREVIOUSLY_USED_IDS,
} from '../scripts/preflight.js';

function fakeConfig(overrides = {}) {
  /* Mirrors the live `config.uploader` shape: the endpoint+provider+id triple
   * is what `evaluatePreflight` inspects. Tests that exercise specific
   * deployment-readiness checks pass a richer `uploader` override. The default
   * here keeps `endpoint: null`, which raises NO_UPLOADER_ENDPOINT. */
  return {
    schema_version: '1.1.3',
    build_id: 'v1',
    uploader: { endpoint: null, provider: 'datapipe', datapipe_experiment_id: 'PLACEHOLDER' },
    prolific: { completion_url: 'https://app.prolific.com/submissions/complete?cc=PLACEHOLDER' },
    ...overrides,
  };
}

function fakePreReg(overrides = {}) {
  return {
    pre_reg_lock_iso: '2000-01-01',
    pre_reg_lock_build_id: 'v1',
    pre_reg_lock_schema_version: '1.1.3',
    ...overrides,
  };
}

describe('parsePreflightArgs', () => {
  it('returns sensible defaults for an empty argv', () => {
    expect(parsePreflightArgs([])).toEqual({ strictDeployment: false, jsonOutput: false });
    expect(parsePreflightArgs(['node', 'preflight.js'])).toEqual({
      strictDeployment: false,
      jsonOutput: false,
    });
  });

  it('flips strictDeployment on --strict-deployment', () => {
    const out = parsePreflightArgs(['node', 'preflight.js', '--strict-deployment']);
    expect(out.strictDeployment).toBe(true);
  });

  it('flips jsonOutput on --json', () => {
    const out = parsePreflightArgs(['node', 'preflight.js', '--json']);
    expect(out.jsonOutput).toBe(true);
  });

  it('accepts both flags in either order', () => {
    expect(parsePreflightArgs(['node', 'preflight.js', '--json', '--strict-deployment'])).toEqual({
      strictDeployment: true,
      jsonOutput: true,
    });
    expect(parsePreflightArgs(['node', 'preflight.js', '--strict-deployment', '--json'])).toEqual({
      strictDeployment: true,
      jsonOutput: true,
    });
  });

  it('handles non-array argv defensively', () => {
    expect(parsePreflightArgs(undefined)).toEqual({
      strictDeployment: false,
      jsonOutput: false,
    });
  });
});

describe('evaluatePreflight — locked-id checks', () => {
  it('passes when build_id and schema_version match the pre-reg lock', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        uploader: {
          endpoint: 'https://api.test/upload',
          provider: 'datapipe',
          datapipe_experiment_id: 'real-id',
        },
        prolific: { completion_url: 'https://app.prolific.com/submissions/complete?cc=ABC123' },
      }),
      preReg: fakePreReg(),
      strictDeployment: true,
    });
    expect(issues).toEqual([]);
  });

  it('flags BUILD_ID_DRIFT when config.build_id ≠ pre-reg lock', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        build_id: 'step99-rogue',
        uploader: { endpoint: 'x' },
        prolific: { completion_url: 'x' },
      }),
      preReg: fakePreReg(),
      strictDeployment: true,
    });
    expect(issues.some((i) => i.code === 'BUILD_ID_DRIFT' && i.severity === 'error')).toBe(true);
  });

  it('flags SCHEMA_VERSION_DRIFT when versions diverge', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        schema_version: '2.0.0',
        uploader: { endpoint: 'x' },
        prolific: { completion_url: 'x' },
      }),
      preReg: fakePreReg(),
      strictDeployment: true,
    });
    expect(issues.some((i) => i.code === 'SCHEMA_VERSION_DRIFT' && i.severity === 'error')).toBe(
      true
    );
  });
});

describe('evaluatePreflight — deployment readiness severity gates', () => {
  it('NO_UPLOADER_ENDPOINT is a warning in permissive mode (pilot-acceptable)', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        prolific: { completion_url: 'https://app.prolific.com/submissions/complete?cc=ABC' },
      }),
      preReg: fakePreReg(),
      strictDeployment: false,
    });
    const issue = issues.find((i) => i.code === 'NO_UPLOADER_ENDPOINT');
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('warning');
  });

  it('NO_UPLOADER_ENDPOINT is an error in strict-deployment mode (main-batch blocker)', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        prolific: { completion_url: 'https://app.prolific.com/submissions/complete?cc=ABC' },
      }),
      preReg: fakePreReg(),
      strictDeployment: true,
    });
    const issue = issues.find((i) => i.code === 'NO_UPLOADER_ENDPOINT');
    expect(issue.severity).toBe('error');
  });

  it('PLACEHOLDER_COMPLETION_URL is a warning in permissive mode', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({ uploader: { endpoint: 'https://api/x' } }),
      preReg: fakePreReg(),
      strictDeployment: false,
    });
    const issue = issues.find((i) => i.code === 'PLACEHOLDER_COMPLETION_URL');
    expect(issue.severity).toBe('warning');
  });

  it('PLACEHOLDER_COMPLETION_URL is an error in strict-deployment mode', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({ uploader: { endpoint: 'https://api/x' } }),
      preReg: fakePreReg(),
      strictDeployment: true,
    });
    const issue = issues.find((i) => i.code === 'PLACEHOLDER_COMPLETION_URL');
    expect(issue.severity).toBe('error');
  });

  it('clean strict-deployment config passes with no issues', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        uploader: {
          endpoint: 'https://api.test/upload',
          provider: 'datapipe',
          datapipe_experiment_id: 'real-id',
        },
        prolific: {
          completion_url: 'https://app.prolific.com/submissions/complete?cc=REAL_CODE_HERE',
        },
      }),
      preReg: fakePreReg(),
      strictDeployment: true,
    });
    expect(issues).toEqual([]);
  });

  it('PLACEHOLDER_DATAPIPE_ID is a warning in permissive mode', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        uploader: {
          endpoint: 'https://pipe.jspsych.org/api/data/',
          provider: 'datapipe',
          datapipe_experiment_id: 'PLACEHOLDER',
        },
        prolific: { completion_url: 'https://app.prolific.com/submissions/complete?cc=ABC' },
      }),
      preReg: fakePreReg(),
      strictDeployment: false,
    });
    const issue = issues.find((i) => i.code === 'PLACEHOLDER_DATAPIPE_ID');
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('warning');
  });

  it('PLACEHOLDER_DATAPIPE_ID is an error in strict-deployment mode', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        uploader: {
          endpoint: 'https://pipe.jspsych.org/api/data/',
          provider: 'datapipe',
          datapipe_experiment_id: 'PLACEHOLDER',
        },
        prolific: { completion_url: 'https://app.prolific.com/submissions/complete?cc=ABC' },
      }),
      preReg: fakePreReg(),
      strictDeployment: true,
    });
    const issue = issues.find((i) => i.code === 'PLACEHOLDER_DATAPIPE_ID');
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('error');
  });

  it('PLACEHOLDER_DATAPIPE_ID is not flagged when datapipe_experiment_id is a real ID', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        uploader: {
          endpoint: 'https://pipe.jspsych.org/api/data/',
          provider: 'datapipe',
          datapipe_experiment_id: 'aBcDeF12345X',
        },
        prolific: { completion_url: 'https://app.prolific.com/submissions/complete?cc=ABC' },
      }),
      preReg: fakePreReg(),
      strictDeployment: true,
    });
    expect(issues.find((i) => i.code === 'PLACEHOLDER_DATAPIPE_ID')).toBeUndefined();
  });

  it('PLACEHOLDER_DATAPIPE_ID is not flagged when provider is not datapipe', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        uploader: {
          endpoint: 'https://api.test/upload',
          provider: 'raw',
          datapipe_experiment_id: 'PLACEHOLDER' /* irrelevant when provider != datapipe */,
        },
        prolific: { completion_url: 'https://app.prolific.com/submissions/complete?cc=ABC' },
      }),
      preReg: fakePreReg(),
      strictDeployment: true,
    });
    expect(issues.find((i) => i.code === 'PLACEHOLDER_DATAPIPE_ID')).toBeUndefined();
  });
});

describe('screen-out code check', () => {
  it('flags a placeholder screen-out code (warning, then error in strict mode)', () => {
    const cfg = fakeConfig({
      prolific: {
        completion_url: 'https://app.prolific.com/submissions/complete?cc=ABC',
        screen_out_completion_code: 'SCREENOUT_CODE_PLACEHOLDER',
      },
    });
    const permissive = evaluatePreflight({ config: cfg, preReg: fakePreReg() });
    expect(permissive.find((i) => i.code === 'PLACEHOLDER_SCREEN_OUT_CODE')?.severity).toBe(
      'warning'
    );
    const strict = evaluatePreflight({
      config: cfg,
      preReg: fakePreReg(),
      strictDeployment: true,
    });
    expect(strict.find((i) => i.code === 'PLACEHOLDER_SCREEN_OUT_CODE')?.severity).toBe('error');
  });
});

describe('formatIssues', () => {
  it('counts errors and warnings separately', () => {
    const out = formatIssues([
      { severity: 'error', code: 'A', message: 'bad' },
      { severity: 'warning', code: 'B', message: 'meh' },
      { severity: 'warning', code: 'C', message: 'fyi' },
    ]);
    expect(out.errors).toBe(1);
    expect(out.warnings).toBe(2);
  });

  it('returns an empty rendering for no issues', () => {
    const out = formatIssues([]);
    expect(out.errors).toBe(0);
    expect(out.warnings).toBe(0);
    expect(out.rendered).toBe('');
  });

  it('includes both code and message in the rendered output', () => {
    const out = formatIssues([{ severity: 'error', code: 'X', message: 'something broke' }]);
    expect(out.rendered).toContain('[X]');
    expect(out.rendered).toContain('something broke');
  });
});

describe('evaluatePreflight — previously used identifiers', () => {
  const codes = (issues) => issues.map((i) => i.code);
  const previouslyUsedIds = ['USEDCODE1', 'USEDPIPE1'];

  it('errors when the completion URL carries a previously used completion code', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        prolific: { completion_url: 'https://app.prolific.com/submissions/complete?cc=USEDCODE1' },
      }),
      preReg: fakePreReg(),
      strictDeployment: false,
      previouslyUsedIds,
    });
    expect(issues.find((i) => i.code === 'REUSED_COMPLETION_CODE')?.severity).toBe('error');
  });

  it('errors when the screen-out code was used before', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        prolific: {
          completion_url: 'https://app.prolific.com/submissions/complete?cc=ABCD1234',
          screen_out_completion_code: 'USEDCODE1',
        },
      }),
      preReg: fakePreReg(),
      strictDeployment: false,
      previouslyUsedIds,
    });
    expect(codes(issues)).toContain('REUSED_SCREEN_OUT_CODE');
  });

  it('errors when the DataPipe experiment id was used before', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        uploader: {
          endpoint: 'https://pipe.jspsych.org/api/data/',
          provider: 'datapipe',
          datapipe_experiment_id: 'USEDPIPE1',
        },
      }),
      preReg: fakePreReg(),
      strictDeployment: false,
      previouslyUsedIds,
    });
    expect(issues.find((i) => i.code === 'REUSED_DATAPIPE_ID')?.severity).toBe('error');
  });

  it('reports only placeholders, not reuse, for the placeholder ids in the live config shape', () => {
    const issues = evaluatePreflight({
      config: fakeConfig({
        uploader: {
          endpoint: 'https://pipe.jspsych.org/api/data/',
          provider: 'datapipe',
          datapipe_experiment_id: 'PLACEHOLDER_TODO_NEW_DATAPIPE_ID',
        },
        prolific: {
          completion_url:
            'https://app.prolific.com/submissions/complete?cc=PLACEHOLDER_TODO_NEW_STUDY_CODE',
        },
      }),
      preReg: fakePreReg(),
      strictDeployment: true,
      previouslyUsedIds,
    });
    expect(codes(issues)).toContain('PLACEHOLDER_DATAPIPE_ID');
    expect(codes(issues)).toContain('PLACEHOLDER_COMPLETION_URL');
    expect(codes(issues)).not.toContain('REUSED_COMPLETION_CODE');
    expect(codes(issues)).not.toContain('REUSED_DATAPIPE_ID');
  });

  it('ships with an empty list of previously used ids', () => {
    expect(PREVIOUSLY_USED_IDS).toEqual([]);
  });
});

describe('evaluatePreflight — placeholders in participant-facing text', () => {
  const text = [
    { source: 'consent form', text: '<p>Payment: [PAYMENT_POLICY] and [PAY_AMOUNT].</p>' },
  ];
  const run = (strictDeployment, participantText = text) =>
    evaluatePreflight({
      config: fakeConfig(),
      preReg: fakePreReg(),
      strictDeployment,
      participantText,
    }).filter((i) => i.code === 'PLACEHOLDER_IN_PARTICIPANT_TEXT');

  it('is a warning in permissive mode and names the tokens', () => {
    const [issue] = run(false);
    expect(issue.severity).toBe('warning');
    expect(issue.message).toContain('consent form');
    expect(issue.message).toContain('[PAYMENT_POLICY]');
    expect(issue.message).toContain('[PAY_AMOUNT]');
  });

  it('is an error under --strict-deployment', () => {
    expect(run(true)[0].severity).toBe('error');
  });

  it('is not raised for text without placeholders', () => {
    expect(
      run(true, [{ source: 'consent form', text: '<p>Paid pro rata [see below].</p>' }])
    ).toEqual([]);
  });

  it('findPlaceholderTokens finds each upper-case bracketed token once', () => {
    expect(findPlaceholderTokens('[A_B] x [A_B] [C1] [lower] [Mixed]')).toEqual(['[A_B]', '[C1]']);
  });

  it('flags the live config payment text and the live study description until they are filled in', async () => {
    const { readFileSync } = await import('node:fs');
    const { config } = await import('../src/config.js');
    const { consentBodyHtml } = await import('../src/calibration/consent-text.js');
    const description = readFileSync(
      new URL('../prolific-study-description.md', import.meta.url),
      'utf-8'
    );
    expect(findPlaceholderTokens(consentBodyHtml(config.prolific.payment_policy_text))).toEqual([
      '[PAYMENT_POLICY]',
    ]);
    expect(findPlaceholderTokens(consentBodyHtml('Pro rata.'))).toEqual([]);
    expect(findPlaceholderTokens(description)).toContain('[PAYMENT_POLICY]');
  });
});
