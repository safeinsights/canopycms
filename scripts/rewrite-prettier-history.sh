#!/bin/bash
set -e

# Rewrite git history to apply prettier formatting to every historical commit.
# Run this from the repo root. Takes ~30-60 minutes.
#
# Prerequisites:
# - All prettier + ESLint fixes are committed on main
# - npm ci has been run (prettier is in node_modules)
#
# What this does:
# 1. Tags current HEAD as original-main (for verification)
# 2. Drops the bulk fix commit
# 3. Runs prettier on every historical commit via filter-branch
# 4. Recreates the ESLint-only fixes as the final commit
# 5. Verifies the final tree matches the original

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Verify we're on main and clean
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree is not clean. Commit or stash changes first."
  exit 1
fi

# Create prettierignore for historical commits that don't have one
IGNORE_FILE="/tmp/.prettierignore-canopy"
printf "node_modules\ndist\n.next\n.turbo\ncoverage\ntest-results\nplaywright-report\npackage-lock.json\napps/example1/content\napps/test-app/content\n" > "$IGNORE_FILE"

# Use absolute path to prettier so it works from any tree-filter working dir
PRETTIER="$REPO_ROOT/node_modules/.bin/prettier"
if [ ! -x "$PRETTIER" ]; then
  echo "ERROR: prettier not found at $PRETTIER — run npm ci first"
  exit 1
fi

echo "=== Step 1: Tag current state for verification ==="
git tag -f original-main HEAD
echo "Tagged HEAD as original-main"

echo ""
echo "=== Step 2: Drop the bulk fix commit ==="
git reset --hard HEAD~1
echo "Reset to parent of bulk fix commit"

echo ""
echo "=== Step 3: Rewrite history with prettier (this takes 30-60 minutes) ==="
echo "Processing $(git rev-list --count HEAD) commits..."
echo ""

FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --tree-filter "
  \"$PRETTIER\" --no-semi --single-quote --print-width 100 \
    --ignore-path \"$IGNORE_FILE\" \
    --write '**/*.{ts,tsx,js,jsx,json,md,css,yml}' 2>/dev/null || true
" --tag-name-filter cat -- --all

echo ""
echo "=== Step 4: Recreate ESLint-only fixes ==="
git diff original-main -- . | git apply --allow-empty
git add -A
if git diff-index --quiet HEAD; then
  echo "No ESLint-only changes remain (all changes were prettier)"
else
  git commit -m "Fix ESLint errors"
  echo "Created ESLint fixes commit"
fi

echo ""
echo "=== Step 5: Verify ==="
DIFF=$(git diff original-main HEAD)
if [ -z "$DIFF" ]; then
  echo "SUCCESS: Final tree matches original-main exactly"
else
  echo "WARNING: Final tree differs from original-main:"
  git diff --stat original-main HEAD
  echo ""
  echo "Review the differences above. Small diffs may be expected if"
  echo "prettier produced slightly different output on historical files."
fi

echo ""
echo "=== Done ==="
echo "Original state is preserved at tag 'original-main'"
echo "To undo everything: git reset --hard original-main"
