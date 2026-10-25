#!/usr/bin/env node
/**
 * Pre-flight launch check.
 *
 * Single command (`npm run preflight` or `node scripts/preflight.js`) that
 * verifies the build is in a launch-ready state. Wraps the four standard gates
 * (lint, format, test, build) and adds launch assertions that the four-gate
 * suite alone doesn't cover:
 *
 *   - `config.build_id === pre-reg.json#pre_reg_lock_build_id` — the snapshot
 *     byte-equality test catches drift in `config_locked`, but a fresh maintainer
 *     might bump build_id in BOTH places. That is legitimate only while the
 *     document is still a draft; once it is filed, the same bump requires a
 *     post-registration amendment. The snapshot id is surfaced explicitly so a
 *     launch can't happen without acknowledging it.
 *   - `config.uploader.endpoint` is non-null in `--strict-deployment` mode.
 *     For the main batch (n=60) we don't want a JSON-download-fallback launch
 *     since coordinating data collection from 60 download blobs by email is
 *     an operational nightmare. The pilot (n=10) can run with the fallback;
 *     the main batch should not.
 *   - `config.prolific.completion_url` doesn't contain `PLACEHOLDER` in
 *     `--strict-deployment` mode. A live study with a placeholder completion
 *     URL leaves participants stranded.
 *   - When `config.uploader.provider === 'datapipe'`,
 *     `config.uploader.datapipe_experiment_id` is set to a non-placeholder
 *     value in `--strict-deployment` mode. Without it the uploader falls
 *     through to the JSON download fallback — same operational pain as a
 *     null endpoint.
 *   - No bracketed placeholder such as `[PAYMENT_POLICY]` remains in the
 *     participant-facing text (consent form, prescreener list, Prolific study
 *     description) in `--strict-deployment` mode.
 *   - The completion codes and DataPipe id are not in `PREVIOUSLY_USED_IDS`.
 *
 * Default mode (no flags): runs all four gates + warns about deployment gaps
 * without failing. Suitable for the n=10 pilot.
 *
 * `--strict-deployment` mode: turns the deployment-gap warnings into errors.
 * Required gate before the main batch.
 *
 * Exit code is 0 on all-green, 1 on any failure. Output is plain ANSI-colored
 * text — no JSON, no machine-readable wrapping. The script is for the human
 * launching the study.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PRE_REG_PATH = resolve(ROOT, 'pre-reg', 'pre-reg.json');

const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const CYAN = (s) => `\x1b[36m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

/* ---------- Pure helpers (unit-tested in tests/preflight.test.js) ---------- */

/**
 * Parse argv into a structured options bag. Recognises `--strict-deployment`
 * and `--json` (the latter for CI consumption — emits a machine-readable
 * single-line summary instead of human-readable per-step output).
 */
export function parsePreflightArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  return {
    strictDeployment: args.includes('--strict-deployment'),
    jsonOutput: args.includes('--json'),
  };
}

/* Completion codes and DataPipe experiment ids that must not be used again.
 * Empty by default; add the ids of any earlier study here. */
export const PREVIOUSLY_USED_IDS = Object.freeze([]);

const PLACEHOLDER_TOKEN_RE = /\[[A-Z][A-Z0-9_]*\]/g;

/** Bracketed placeholder tokens such as `[PAYMENT_POLICY]` found in `text`. */
export function findPlaceholderTokens(text) {
  return Array.from(new Set(String(text).match(PLACEHOLDER_TOKEN_RE) ?? []));
}

/**
 * Inspect the live config + pre-reg lock and produce a list of deployment
 * issues. Each issue has `severity: 'error'|'warning'`, `code`, and `message`.
 *
 * @param {object} opts
 * @param {object} opts.config             live config
 * @param {object} opts.preReg             parsed pre-reg.json
 * @param {boolean} opts.strictDeployment  if true, deployment gaps are errors; else warnings
 * @param {Array<{source: string, text: string}>} [opts.participantText]  participant-facing texts to scan for placeholders
 * @param {readonly string[]} [opts.previouslyUsedIds]  ids that must not be reused
 * @param {readonly string[]} [opts.uncommittedPaths]  paths with uncommitted changes among the files that ship
 * @returns {Array<{severity: 'error'|'warning', code: string, message: string}>}
 */
export function evaluatePreflight({
  config,
  preReg,
  strictDeployment,
  participantText = [],
  previouslyUsedIds = PREVIOUSLY_USED_IDS,
  uncommittedPaths = [],
}) {
  const issues = [];
  if (uncommittedPaths.length > 0) {
    const shown = uncommittedPaths.slice(0, 5).join(', ');
    const more = uncommittedPaths.length > 5 ? ` (+${uncommittedPaths.length - 5} more)` : '';
    issues.push({
      severity: strictDeployment ? 'error' : 'warning',
      code: 'UNCOMMITTED_CHANGES',
      message: `Uncommitted changes in files that ship: ${shown}${more}. The build is stamped "-dirty" and its commit does not contain this code; commit first so build_commit identifies what participants ran.`,
    });
  }
  if (config.build_id !== preReg.pre_reg_lock_build_id) {
    issues.push({
      severity: 'error',
      code: 'BUILD_ID_DRIFT',
      message: `config.build_id (${config.build_id}) ≠ pre-reg.pre_reg_lock_build_id (${preReg.pre_reg_lock_build_id}) — sync both sides if this is an in-draft revision; file a post-registration amendment if the draft has already been filed.`,
    });
  }
  if (config.schema_version !== preReg.pre_reg_lock_schema_version) {
    issues.push({
      severity: 'error',
      code: 'SCHEMA_VERSION_DRIFT',
      message: `config.schema_version (${config.schema_version}) ≠ pre-reg.pre_reg_lock_schema_version (${preReg.pre_reg_lock_schema_version}) — sync both sides if this is an in-draft revision; file a post-registration amendment if the draft has already been filed.`,
    });
  }
  if (!config.uploader.endpoint) {
    issues.push({
      severity: strictDeployment ? 'error' : 'warning',
      code: 'NO_UPLOADER_ENDPOINT',
      message: `config.uploader.endpoint is null — sessions will fall back to JSON download. Acceptable for n≤10 pilot; not acceptable for the main batch.`,
    });
  }
  /* DataPipe is the locked egress provider (see config.js#uploader). The
   * endpoint is the public DataPipe URL, but uploads only land in OUR project
   * once `datapipe_experiment_id` is replaced with the real ID minted on the
   * DataPipe dashboard — until then the uploader detects the PLACEHOLDER and
   * falls through to the JSON download fallback. Same severity gate as the
   * Prolific completion URL: warning in pilot mode, error before main batch. */
  if (
    config.uploader.provider === 'datapipe' &&
    (typeof config.uploader.datapipe_experiment_id !== 'string' ||
      config.uploader.datapipe_experiment_id.length === 0 ||
      config.uploader.datapipe_experiment_id.includes('PLACEHOLDER'))
  ) {
    issues.push({
      severity: strictDeployment ? 'error' : 'warning',
      code: 'PLACEHOLDER_DATAPIPE_ID',
      message: `config.uploader.datapipe_experiment_id is missing or still the PLACEHOLDER token — the uploader will fall back to JSON download instead of POSTing to DataPipe. Replace with the experiment ID minted at https://pipe.jspsych.org for this study.`,
    });
  }
  if (
    typeof config.prolific.completion_url === 'string' &&
    config.prolific.completion_url.includes('PLACEHOLDER')
  ) {
    issues.push({
      severity: strictDeployment ? 'error' : 'warning',
      code: 'PLACEHOLDER_COMPLETION_URL',
      message: `config.prolific.completion_url still contains 'PLACEHOLDER' — debrief node will skip the redirect and show a test-build notice. The participant won't return to Prolific automatically.`,
    });
  }
  /* Identifiers that belong to an earlier study must not be reused. */
  const completionUrl = config.prolific.completion_url ?? '';
  if (previouslyUsedIds.some((id) => completionUrl.includes(id))) {
    issues.push({
      severity: 'error',
      code: 'REUSED_COMPLETION_CODE',
      message: `config.prolific.completion_url holds a previously used completion code. Create a new completion code for this study on Prolific.`,
    });
  }
  const screenOutCode = config.prolific.screen_out_completion_code ?? '';
  if (previouslyUsedIds.some((id) => screenOutCode.includes(id))) {
    issues.push({
      severity: 'error',
      code: 'REUSED_SCREEN_OUT_CODE',
      message: `config.prolific.screen_out_completion_code holds a previously used completion code.`,
    });
  }
  if (previouslyUsedIds.includes(config.uploader.datapipe_experiment_id)) {
    issues.push({
      severity: 'error',
      code: 'REUSED_DATAPIPE_ID',
      message: `config.uploader.datapipe_experiment_id is a previously used DataPipe experiment. Create a new DataPipe experiment for this study.`,
    });
  }
  if (
    typeof config.prolific.screen_out_completion_code === 'string' &&
    config.prolific.screen_out_completion_code.includes('PLACEHOLDER')
  ) {
    issues.push({
      severity: strictDeployment ? 'error' : 'warning',
      code: 'PLACEHOLDER_SCREEN_OUT_CODE',
      message: `config.prolific.screen_out_completion_code still contains 'PLACEHOLDER' — screened-out participants will not be sent back to Prolific. Create a screen-out completion code on the Prolific study page and set it here.`,
    });
  }
  for (const { source, text } of participantText) {
    const tokens = findPlaceholderTokens(text);
    if (tokens.length === 0) continue;
    issues.push({
      severity: strictDeployment ? 'error' : 'warning',
      code: 'PLACEHOLDER_IN_PARTICIPANT_TEXT',
      message: `${source} still contains placeholder text: ${tokens.join(', ')}. Replace it before launch.`,
    });
  }
  return issues;
}

/**
 * Format a list of issues for human consumption. Returns the rendered string
 * and a summary `{ errors, warnings }` count.
 */
export function formatIssues(issues) {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const lines = [];
  for (const e of errors) lines.push(`  ${RED('✗')} [${e.code}] ${e.message}`);
  for (const w of warnings) lines.push(`  ${YELLOW('!')} [${w.code}] ${w.message}`);
  return {
    rendered: lines.join('\n'),
    errors: errors.length,
    warnings: warnings.length,
  };
}

/* ---------- Gate runners ---------- */

function runGate(label, command) {
  process.stdout.write(`  ${CYAN('•')} ${label}… `);
  const t0 = Date.now();
  try {
    execSync(command, { cwd: ROOT, stdio: 'pipe' });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`${GREEN('ok')} (${dt}s)\n`);
    return { ok: true };
  } catch (err) {
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`${RED('FAIL')} (${dt}s)\n`);
    /* Surface stderr for debugging — the participant of this script is the
     * experimenter, not jsPsych, so noise is fine. */
    if (err.stdout) process.stdout.write(String(err.stdout));
    if (err.stderr) process.stderr.write(String(err.stderr));
    return { ok: false, message: err.message };
  }
}

async function loadConfig() {
  const configPath = resolve(ROOT, 'src', 'config.js');
  const mod = await import(pathToFileURL(configPath).href);
  return mod.config;
}

/** Participant-facing texts: consent form, prescreener list, study description. */
async function loadParticipantText(config) {
  const textPath = resolve(ROOT, 'src', 'calibration', 'consent-text.js');
  const { consentBodyHtml } = await import(pathToFileURL(textPath).href);
  const texts = [
    { source: 'consent form', text: consentBodyHtml(config.prolific.payment_policy_text) },
  ];
  const descriptionPath = resolve(ROOT, 'prolific-study-description.md');
  if (existsSync(descriptionPath)) {
    texts.push({
      source: 'prolific-study-description.md',
      text: readFileSync(descriptionPath, 'utf-8'),
    });
  }
  return texts;
}

/* Files that ship; keep in sync with `gitCommit()` in vite.config.js. */
const SHIPPED_PATHS = [
  'src',
  'public',
  'index.html',
  'recover.html',
  'package.json',
  'package-lock.json',
  'vite.config.js',
];

/** Paths with uncommitted changes among the shipped files; [] when git is unavailable. */
export function uncommittedShippedPaths() {
  try {
    const out = execSync(`git status --porcelain -- ${SHIPPED_PATHS.join(' ')}`, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return out
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function loadPreReg() {
  return JSON.parse(readFileSync(PRE_REG_PATH, 'utf-8'));
}

/* ---------- Main entry ---------- */

async function main(argv) {
  const opts = parsePreflightArgs(argv);
  if (!opts.jsonOutput) {
    console.log(BOLD('\nPre-flight launch check'));
    console.log(`  mode: ${opts.strictDeployment ? BOLD('strict-deployment') : 'permissive'}\n`);
  }

  const gates = [
    { label: 'Lint        (eslint src)', command: 'npm run --silent lint' },
    {
      label: 'Format      (prettier --check .)',
      command: 'npx --no-install prettier --check .',
    },
    { label: 'Test suite  (vitest run)', command: 'npm test --silent' },
    { label: 'Build       (vite build)', command: 'npm run --silent build' },
  ];

  if (!opts.jsonOutput) console.log(BOLD('Toolchain gates:'));
  const gateResults = [];
  for (const g of gates) {
    const r = opts.jsonOutput ? runSilent(g) : runGate(g.label, g.command);
    gateResults.push({ label: g.label, ...r });
  }

  const config = await loadConfig();
  const preReg = loadPreReg();
  const participantText = await loadParticipantText(config);
  const issues = evaluatePreflight({
    config,
    preReg,
    strictDeployment: opts.strictDeployment,
    participantText,
    uncommittedPaths: uncommittedShippedPaths(),
  });
  const issueSummary = formatIssues(issues);

  if (opts.jsonOutput) {
    const summary = {
      strict_deployment: opts.strictDeployment,
      gates: gateResults.map((g) => ({ label: g.label, ok: g.ok })),
      issues,
      ok:
        gateResults.every((g) => g.ok) && issues.filter((i) => i.severity === 'error').length === 0,
    };
    console.log(JSON.stringify(summary));
    process.exit(summary.ok ? 0 : 1);
  }

  console.log(BOLD('\nDeployment readiness:'));
  if (issues.length === 0) {
    console.log(`  ${GREEN('✓')} all checks passed`);
  } else {
    console.log(issueSummary.rendered);
  }

  const allGatesOk = gateResults.every((g) => g.ok);
  const noBlockingIssues = issueSummary.errors === 0;
  const exitOk = allGatesOk && noBlockingIssues;

  console.log('');
  if (exitOk) {
    console.log(
      `${GREEN('✓ READY')}  build_id=${BOLD(config.build_id)} (locked at ${preReg.pre_reg_lock_iso})`
    );
    if (issueSummary.warnings > 0) {
      console.log(
        YELLOW(
          `  ${issueSummary.warnings} warning(s) — acceptable for pilot, but resolve before main batch.`
        )
      );
    }
  } else {
    console.log(`${RED('✗ NOT READY')}`);
    if (!allGatesOk) {
      const failed = gateResults.filter((g) => !g.ok).map((g) => g.label);
      console.log(`  failing gates: ${failed.join(', ')}`);
    }
    if (issueSummary.errors > 0) {
      console.log(`  ${issueSummary.errors} blocking issue(s) above`);
    }
  }
  process.exit(exitOk ? 0 : 1);
}

function runSilent(g) {
  try {
    execSync(g.command, { cwd: ROOT, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/* Only run main() when invoked as a CLI; importing the module for tests
 * (which we do in tests/preflight.test.js) should not trigger the gate runs. */
const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  main(process.argv).catch((err) => {
    console.error('preflight: unexpected error', err);
    process.exit(1);
  });
}
