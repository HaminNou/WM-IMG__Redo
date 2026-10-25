/**
 * scripts/deploy.sh must only ever publish code that was tested and committed.
 *
 * It used to build whatever was on disk and name the deploy commit after HEAD
 * even when the build was marked "-dirty". It now refuses unless the tree is
 * clean, the branch is main, HEAD is origin/main and strict preflight passes,
 * checks the build's own commit stamp, and has a --dry-run.
 *
 * Each test builds a throw-away sandbox of real git repositories in the OS temp
 * folder: a work repo, a bare "origin" and a bare deploy target. The real
 * deploy.sh is copied in; preflight and the build are small stubs whose result
 * the test controls through environment variables. Nothing here touches the
 * network or any real repository.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_SH = join(ROOT, 'scripts/deploy.sh');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.org',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.org',
  GIT_TERMINAL_PROMPT: '0',
};

const sandboxes = [];
afterEach(() => {
  for (const s of sandboxes.splice(0)) rmSync(s, { recursive: true, force: true });
});

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf-8',
    ...opts,
    env: { ...process.env, ...GIT_ENV, ...(opts.env ?? {}) },
  });
  return r;
}
const git = (cwd, ...args) => {
  const r = sh('git', args, { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-sandbox-'));
  sandboxes.push(root);
  const work = join(root, 'work');
  const proj = join(work, 'proj');
  const origin = join(root, 'origin.git');
  const target = join(root, 'target.git');
  mkdirSync(join(proj, 'scripts'), { recursive: true });

  /* The deploy target: a bare repo with one commit on main. */
  git(root, 'init', '--bare', '-b', 'main', target);
  const seed = join(root, 'seed');
  git(root, 'clone', target, seed);
  writeFileSync(join(seed, 'README.md'), 'deploy target\n');
  git(seed, 'checkout', '-B', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'seed');
  git(seed, 'push', 'origin', 'main');
  rmSync(seed, { recursive: true, force: true });

  /* The work repo, with the real script and stubs for preflight and build. */
  copyFileSync(DEPLOY_SH, join(proj, 'scripts/deploy.sh'));
  writeFileSync(
    join(proj, 'scripts/preflight.js'),
    'process.exit(Number(process.env.STUB_PREFLIGHT_EXIT ?? 0));\n'
  );
  writeFileSync(
    join(proj, 'package.json'),
    JSON.stringify({ name: 'proj', private: true, scripts: { build: 'node build.js' } })
  );
  writeFileSync(
    join(proj, 'build.js'),
    [
      "const { execSync } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const sha = execSync('git rev-parse --short=12 HEAD').toString().trim();",
      "const stamp = process.env.FAKE_DIRTY === '1' ? sha + '-dirty' : sha;",
      "fs.mkdirSync('dist/assets', { recursive: true });",
      "fs.writeFileSync('dist/index.html', '<html></html>');",
      "fs.writeFileSync('dist/assets/main.js', 'var build_commit=\"' + stamp + '\";');",
      /* Same size and the same modification time every build: the case where rsync's
       * default quick check would skip a file whose CONTENT changed. */
      "fs.utimesSync('dist/assets/main.js', 1700000000, 1700000000);",
      /* Optionally a very long file list, to produce more rsync output than a pipe holds. */
      'const n = Number(process.env.FAKE_MANY_FILES ?? 0);',
      "for (let i = 0; i < n; i++) fs.writeFileSync('dist/assets/' + 'long-file-name-'.repeat(6) + i + '.js', 'x');",
      '',
    ].join('\n')
  );
  writeFileSync(join(proj, '.gitignore'), 'dist/\n');
  git(proj, 'init', '-b', 'main');
  git(proj, 'add', '-A');
  git(proj, 'commit', '-m', 'Initial program');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(proj, 'remote', 'add', 'origin', origin);
  git(proj, 'push', 'origin', 'main');

  const deployDir = join(work, 'deploytarget');
  const run = (args = [], env = {}) =>
    sh('bash', ['scripts/deploy.sh', ...args], {
      cwd: proj,
      env: { DEPLOY_REPO: 'owner/deploytarget', DEPLOY_REMOTE_URL: target, ...env },
    });
  return { root, proj, origin, target, deployDir, run };
}

const targetHead = (sb) => git(sb.target, 'rev-parse', 'main');

describe('deploy.sh refuses to publish anything but tested, committed code', () => {
  it('refuses a modified tracked file, and clones, builds and pushes nothing', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.proj, 'package.json'), JSON.stringify({ changed: true }));
    const before = targetHead(sb);
    const r = sb.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSED.*uncommitted or untracked/);
    expect(existsSync(join(sb.proj, 'dist'))).toBe(false);
    expect(existsSync(sb.deployDir)).toBe(false);
    expect(targetHead(sb)).toBe(before);
  });

  it('refuses an untracked file', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.proj, 'scratch.txt'), 'x');
    const r = sb.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSED.*uncommitted or untracked/);
    expect(r.stderr).toContain('scratch.txt');
  });

  it('refuses any branch but main', () => {
    const sb = makeSandbox();
    git(sb.proj, 'checkout', '-b', 'feature');
    const r = sb.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSED.*'feature', not main/);
  });

  it('refuses a HEAD that is not on origin/main, unless --allow-unpushed', () => {
    const sb = makeSandbox();
    writeFileSync(join(sb.proj, 'extra.txt'), 'x');
    git(sb.proj, 'add', '-A');
    git(sb.proj, 'commit', '-m', 'unpushed work');
    const r = sb.run(['--dry-run']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSED.*not origin\/main/);
    const ok = sb.run(['--dry-run', '--allow-unpushed']);
    expect(ok.status, ok.stderr).toBe(0);
  });

  it('refuses when strict preflight fails', () => {
    const sb = makeSandbox();
    const r = sb.run([], { STUB_PREFLIGHT_EXIT: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSED.*strict preflight/);
    expect(existsSync(join(sb.proj, 'dist'))).toBe(false);
  });

  it('refuses a build stamped -dirty even when git looks clean', () => {
    const sb = makeSandbox();
    const r = sb.run([], { FAKE_DIRTY: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSED.*-dirty/);
    expect(existsSync(sb.deployDir)).toBe(false);
  });

  it('rejects an unknown option', () => {
    const sb = makeSandbox();
    const r = sb.run(['--yolo']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown option');
  });
});

describe('deploy.sh on a clean, pushed main', () => {
  it('--dry-run with a long list of changed files still finishes and exits 0', () => {
    /* rsync -n | head -50 under `set -o pipefail` ended the whole script with status 141
     * (SIGPIPE) when rsync wrote more than the pipe holds after head had stopped reading. */
    const sb = makeSandbox();
    git(sb.root, 'clone', sb.target, sb.deployDir); /* an existing deploy clone: rsync runs */
    const before = targetHead(sb);
    const r = sb.run(['--dry-run'], { FAKE_MANY_FILES: '6000' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Files that would change');
    expect(r.stdout).toMatch(/\.\.\. and \d+ more \(\d+ in all\)/);
    expect(
      r.stdout.split('\n').filter((l) => l.includes('long-file-name')).length
    ).toBeLessThanOrEqual(50);
    expect(targetHead(sb)).toBe(before);
  }, 60_000);

  it('--dry-run checks and builds, then changes nothing', () => {
    const sb = makeSandbox();
    const before = targetHead(sb);
    const r = sb.run(['--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('--dry-run');
    expect(r.stdout).toContain('build stamped with commit');
    expect(existsSync(sb.deployDir)).toBe(false);
    expect(targetHead(sb)).toBe(before);
  });

  it('deploys, names the commit after the build id, and a second run changes nothing', () => {
    const sb = makeSandbox();
    const sha = git(sb.proj, 'rev-parse', '--short=12', 'HEAD');
    const r = sb.run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Deployed build ${sha}`);
    const message = git(sb.target, 'log', '-1', '--format=%s', 'main');
    expect(message).toBe(`Deploy ${sha}: Initial program`);
    expect(readFileSync(join(sb.deployDir, 'assets/main.js'), 'utf-8')).toContain(sha);
    expect(readFileSync(join(sb.deployDir, 'assets/main.js'), 'utf-8')).not.toContain('-dirty');
    expect(existsSync(join(sb.deployDir, '.nojekyll'))).toBe(true);
    const after = targetHead(sb);
    const again = sb.run();
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('No changes to deploy');
    expect(targetHead(sb)).toBe(after);
  });

  it('a new commit deploys again, with the new id', () => {
    const sb = makeSandbox();
    expect(sb.run().status).toBe(0);
    writeFileSync(join(sb.proj, 'feature.txt'), 'x');
    git(sb.proj, 'add', '-A');
    git(sb.proj, 'commit', '-m', 'Second change');
    git(sb.proj, 'push', 'origin', 'main');
    const sha = git(sb.proj, 'rev-parse', '--short=12', 'HEAD');
    const r = sb.run();
    expect(r.status, r.stderr).toBe(0);
    expect(git(sb.target, 'log', '-1', '--format=%s', 'main')).toBe(`Deploy ${sha}: Second change`);
  });
});
