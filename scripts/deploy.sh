#!/usr/bin/env bash
# Deploy compiled dist/ to the public GitHub Pages repo.
#
# Set DEPLOY_REPO to the target repository as <owner>/<name>
# (e.g. DEPLOY_REPO=owner/deploy-repo bash scripts/deploy.sh).
#
# Usage: bash scripts/deploy.sh [--dry-run] [--allow-unpushed]
#
#   --dry-run         run every check and the build, show what would change in
#                     the deploy repo, and stop before anything is cloned,
#                     copied, committed or pushed.
#   --allow-unpushed  accept a HEAD that is not yet on origin/main. Without it,
#                     what participants run could be code that exists nowhere
#                     else.
#
# What this script does, in order:
#   0. Refuses to continue unless ALL of these hold:
#        - the working tree is clean (no modified or untracked files);
#        - the branch is main;
#        - HEAD is the same commit as origin/main (after a fetch), unless
#          --allow-unpushed;
#        - `node scripts/preflight.js --strict-deployment` passes.
#      A build from anything else would not be the code that was tested and
#      committed, and the commit id written into every data row would not
#      identify it.
#   1. Builds dist/ via `npm run build`, and checks that the build is stamped
#      with HEAD's commit id and not "-dirty".
#   2. Clones the deploy repo to a sibling worktree (../<name>)
#      on first run; pulls it on subsequent runs.
#   3. Mirrors dist/ → that worktree (rsync --delete; preserves .git).
#   4. Restores the .nojekyll / README.md / .gitignore that should always
#      live in the deploy repo but never in dist/.
#   5. Commits with a message that carries the build's commit id, then pushes.
#      Skips the commit + push entirely if nothing changed.
#
# Environment:
#   DEPLOY_REPO        required, <owner>/<name>
#   DEPLOY_REMOTE_URL  optional; clone URL of the deploy repo (default: the
#                      GitHub URL for DEPLOY_REPO). Used by the tests.
#
# Requirements: git, node, npm, rsync, and push rights to the deploy repo.

set -euo pipefail

DRY_RUN=0
ALLOW_UNPUSHED=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --allow-unpushed) ALLOW_UNPUSHED=1 ;;
    -h|--help) sed -n '2,38p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "deploy: unknown option: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$BUILD_DIR/dist"
DEPLOY_REPO="${DEPLOY_REPO:?set DEPLOY_REPO=<owner>/<name>}"
DEPLOY_REMOTE_URL="${DEPLOY_REMOTE_URL:-https://github.com/$DEPLOY_REPO.git}"
DEPLOY_DIR="$(cd "$BUILD_DIR/.." && pwd)/${DEPLOY_REPO##*/}"

fail() { echo "deploy: REFUSED: $*" >&2; exit 1; }

echo "==> Checking the source tree"
cd "$BUILD_DIR"
git rev-parse --git-dir >/dev/null 2>&1 || fail "$BUILD_DIR is not a git repository"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || fail "the branch is '$BRANCH', not main"

if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  fail "the working tree has uncommitted or untracked files (listed above); commit or remove them first"
fi

HEAD_FULL="$(git rev-parse HEAD)"
if [ "$ALLOW_UNPUSHED" -eq 0 ]; then
  git fetch --quiet origin main || fail "could not fetch origin/main to compare with HEAD"
  ORIGIN_FULL="$(git rev-parse origin/main)"
  [ "$HEAD_FULL" = "$ORIGIN_FULL" ] || fail "HEAD ($HEAD_FULL) is not origin/main ($ORIGIN_FULL); push first, or pass --allow-unpushed"
fi

echo "==> Strict preflight"
node scripts/preflight.js --strict-deployment || fail "strict preflight did not pass"

# The commit id every data row will carry: the same 12 characters vite.config.js uses.
SRC_SHA="$(git rev-parse --short=12 HEAD)"
SRC_DESC="$(git log -1 --pretty=%s)"

echo "==> Building dist/"
npm run build

# The preflight and the build must agree about the tree: the id compiled into
# the bundle is HEAD's, and it is not marked dirty.
if grep -rqF "${SRC_SHA}-dirty" "$DIST_DIR"; then
  fail "the build is stamped ${SRC_SHA}-dirty"
fi
if ! grep -rqF "$SRC_SHA" "$DIST_DIR"; then
  fail "the build does not contain the commit id $SRC_SHA"
fi
echo "    build stamped with commit $SRC_SHA"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> --dry-run: all checks passed and the build is ready. Nothing was cloned, copied, committed or pushed."
  if [ -d "$DEPLOY_DIR/.git" ]; then
    echo "==> Files that would change in $DEPLOY_DIR:"
    # Not `rsync ... | head -50`: under `set -o pipefail` a long list makes rsync die of
    # SIGPIPE once head has stopped reading, and the whole script exits non-zero
    # before it can say it succeeded. The list goes to a file first.
    CHANGES_FILE="$(mktemp)"
    rsync -an --checksum --delete --itemize-changes \
      --exclude=.git --exclude=.gitignore --exclude=.nojekyll --exclude=README.md --exclude=.DS_Store \
      "$DIST_DIR/" "$DEPLOY_DIR/" > "$CHANGES_FILE"
    sed -n '1,50p' "$CHANGES_FILE"
    CHANGES_TOTAL="$(wc -l < "$CHANGES_FILE" | tr -d ' ')"
    if [ "$CHANGES_TOTAL" -gt 50 ]; then
      echo "    ... and $((CHANGES_TOTAL - 50)) more ($CHANGES_TOTAL in all)"
    fi
    rm -f "$CHANGES_FILE"
  else
    echo "    (the deploy repo $DEPLOY_DIR does not exist yet; it would be cloned from $DEPLOY_REMOTE_URL)"
  fi
  exit 0
fi

if [ ! -d "$DEPLOY_DIR/.git" ]; then
  echo "==> Cloning $DEPLOY_REPO to $DEPLOY_DIR (first run)"
  git clone "$DEPLOY_REMOTE_URL" "$DEPLOY_DIR"
else
  echo "==> Pulling $DEPLOY_REPO"
  ( cd "$DEPLOY_DIR" && git pull --ff-only )
fi

echo "==> Mirroring dist/ → $DEPLOY_DIR"
# --checksum: compare file CONTENT, not just size and modification time. A rebuild
# that changes same-length text inside a file within the same second would
# otherwise be skipped and the old code would stay published.
rsync -a --checksum --delete \
  --exclude=.git \
  --exclude=.gitignore \
  --exclude=.nojekyll \
  --exclude=README.md \
  --exclude=.DS_Store \
  "$DIST_DIR/" "$DEPLOY_DIR/"

# Always keep these housekeeping files; create them if missing.
[ -f "$DEPLOY_DIR/.nojekyll" ] || touch "$DEPLOY_DIR/.nojekyll"
[ -f "$DEPLOY_DIR/.gitignore" ] || printf ".DS_Store\n" > "$DEPLOY_DIR/.gitignore"

cd "$DEPLOY_DIR"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "==> No changes to deploy — dist/ matches the deploy repo."
  exit 0
fi

git add -A
git commit -m "Deploy ${SRC_SHA}: ${SRC_DESC}"
git push origin main
echo "==> Deployed build ${SRC_SHA} to $DEPLOY_REPO"
