#!/usr/bin/env bash
# Deploy compiled dist/ to the public GitHub Pages repo.
#
# Set DEPLOY_REPO to the target repository as <owner>/<name>
# (e.g. DEPLOY_REPO=owner/deploy-repo bash scripts/deploy.sh).
#
# What this script does, in order:
#   1. Builds dist/ via `npm run build`.
#   2. Clones the deploy repo to a sibling worktree (../<name>)
#      on first run; pulls it on subsequent runs.
#   3. Mirrors dist/ → that worktree (rsync --delete; preserves .git).
#   4. Restores the .nojekyll / README.md / .gitignore that should always
#      live in the deploy repo but never in dist/.
#   5. Commits with a message referencing the source commit SHA, then pushes.
#      Skips the commit + push entirely if nothing changed.
#
# Requirements: gh CLI authenticated as the repo owner, and rsync.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$BUILD_DIR/dist"
DEPLOY_REPO="${DEPLOY_REPO:?set DEPLOY_REPO=<owner>/<name>}"
DEPLOY_DIR="$(cd "$BUILD_DIR/.." && pwd)/${DEPLOY_REPO##*/}"

echo "==> Building dist/"
( cd "$BUILD_DIR" && npm run build )

if [ ! -d "$DEPLOY_DIR/.git" ]; then
  echo "==> Cloning $DEPLOY_REPO to $DEPLOY_DIR (first run)"
  git clone "https://github.com/$DEPLOY_REPO.git" "$DEPLOY_DIR"
else
  echo "==> Pulling $DEPLOY_REPO"
  ( cd "$DEPLOY_DIR" && git pull --ff-only )
fi

echo "==> Mirroring dist/ → $DEPLOY_DIR"
rsync -a --delete \
  --exclude=.git \
  --exclude=.gitignore \
  --exclude=.nojekyll \
  --exclude=README.md \
  --exclude=.DS_Store \
  "$DIST_DIR/" "$DEPLOY_DIR/"

# Always keep these housekeeping files; create them if missing.
[ -f "$DEPLOY_DIR/.nojekyll" ] || touch "$DEPLOY_DIR/.nojekyll"
[ -f "$DEPLOY_DIR/.gitignore" ] || printf ".DS_Store\n" > "$DEPLOY_DIR/.gitignore"

SRC_SHA="$( cd "$BUILD_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown" )"
SRC_DESC="$( cd "$BUILD_DIR" && git log -1 --pretty=%s 2>/dev/null || echo "unknown source commit" )"

cd "$DEPLOY_DIR"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "==> No changes to deploy — dist/ matches the deploy repo."
  exit 0
fi

git add -A
git commit -m "Deploy ${SRC_SHA}: ${SRC_DESC}"
git push origin main
echo "==> Deployed to $DEPLOY_REPO"
