# History Rewrite: Apply Prettier to Historical Commits

## Context

We added Prettier + ESLint to CanopyCMS on `main`. The last commit is a bulk "Apply prettier formatting and ESLint fixes" commit that touches ~350 files. We want to rewrite history so prettier formatting is baked into each historical commit (preserving `git blame`). After the rewrite, the bulk commit should shrink to just the small ESLint semantic fixes.

## Strategy

1. **Commit all fixes** on `main` (prettier + ESLint together) — this is the starting point
2. **Bundle the repo** — everything is committed, bundle has full history
3. **Other session rewrites history**: runs prettier on every historical commit via `git rebase --exec`
4. **After rewrite**: the bulk fix commit auto-shrinks because prettier changes are already in history. Only ESLint fixes remain in the final commit.

## Step 1: Commit and bundle

```bash
# Commit all the fixes (this is on main)
git add -A
git commit -m "Apply prettier formatting and ESLint fixes"

# Bundle the full repo
git bundle create /tmp/canopycms.bundle --all
```

## Step 2: Prompt for the history-rewriting session

---

I have a git bundle for a repo called CanopyCMS.

The `main` branch has the full project history. The latest commit is a bulk "Apply prettier formatting and ESLint fixes" commit that touches ~350 files. It contains two kinds of changes mixed together:

1. **Prettier formatting** (~300 files, cosmetic) — whitespace, trailing commas, line wrapping, quote style
2. **ESLint semantic fixes** (~90 files, 1-2 lines each) — removed unused imports, replaced `any` types, fixed React hooks, etc.

**Your job**: Rewrite the history so that every historical commit on `main` is prettier-formatted. After the rewrite, the final bulk commit should automatically shrink to contain only the ESLint semantic fixes (since prettier changes will already be in every prior commit).

**How prettier should be run on each commit:**

Since historical commits don't have `.prettierrc.json`, pass the config inline:

```bash
npx prettier --no-semi --single-quote --print-width 100 --write "**/*.{ts,tsx,js,jsx,json,md,css,yml}" --ignore-path /dev/null
```

And create a temporary ignore file to skip content directories and build artifacts.

**Step-by-step approach:**

1. Unbundle the repo into a working directory
2. Check out `main`
3. Run `npm ci` to install dependencies (prettier binary will persist in `node_modules` across rebase steps)
4. Identify the bulk fix commit (the latest commit, message: "Apply prettier formatting and ESLint fixes") — note its hash
5. Run an interactive-style rebase from root to the commit BEFORE the bulk fix:

   ```bash
   BULK_FIX_COMMIT=$(git rev-parse HEAD)
   PARENT_OF_BULK=$(git rev-parse HEAD~1)

   git rebase --root --onto --exec '
     # Create temporary prettierignore for content/build dirs
     printf "node_modules\ndist\n.next\n.turbo\ncoverage\ntest-results\nplaywright-report\npackage-lock.json\napps/example1/content\napps/test-app/content\n" > /tmp/.prettierignore-canopy

     npx prettier --no-semi --single-quote --print-width 100 \
       --ignore-path /tmp/.prettierignore-canopy \
       --write "**/*.{ts,tsx,js,jsx,json,md,css,yml}" 2>/dev/null || true

     git add -A
     git diff-index --quiet HEAD || git commit --amend --no-edit
   ' "$PARENT_OF_BULK"
   ```

6. After the rebase, the bulk fix commit needs to be rebased on top. It will likely have conflicts since the prettier changes are already applied. For each conflict, accept the incoming (rebased) version for formatting-only files, and keep the bulk commit's version for files with ESLint changes.

   Alternatively, a simpler approach: after rebasing all commits before the bulk fix, cherry-pick or recreate the ESLint-only changes:
   - Check out the rebased history (prettier is now in every commit)
   - The ESLint fixes are the semantic changes: removed imports, type replacements, hook fixes, etc.
   - These are small and identifiable in the original bulk commit's diff
   - Apply just those changes and commit as "Fix ESLint errors"

7. Create a new bundle with the rewritten history:
   ```bash
   git bundle create /tmp/canopycms-rewritten.bundle --all
   ```

**Important constraints:**

- Do NOT change commit messages (except the bulk fix commit, which should become "Fix ESLint errors")
- Do NOT reorder commits
- If prettier fails on a commit (missing files, early commits with few files), `|| true` handles it
- `npm ci` only needs to run once — `node_modules` persists across rebase exec steps
- The final tree state should be identical to the original `main` HEAD

**What the ESLint-only fixes look like** (for identifying them in the bulk commit):

- Removed unused imports (`import { Foo } from ...` lines deleted)
- Unused variables prefixed with `_` or removed
- `any` replaced with proper types (`unknown`, `Record<string, unknown>`, specific interfaces)
- `let` → `const` where never reassigned
- Conditional `useId()` → unconditional `useId()` + fallback
- `console.log` → `console.info`
- Unescaped `'` → `&apos;` in JSX
- Switch cases wrapped in `{ }` blocks
- Try/catch that only re-throws → removed
- `{}` type → `Record<string, never>` or proper type

---

## Step 3: After the rewrite

1. Unbundle the rewritten repo
2. Verify the final tree matches the original HEAD: `git diff original-main rewritten-main` should be empty
3. Run `npx prettier --check .` — should pass
4. Run `npx eslint packages/canopycms/src/` — should show 0 errors, only warnings
5. Run `npm run typecheck` — should pass
6. Run `npm test` — all 1414 tests should pass
