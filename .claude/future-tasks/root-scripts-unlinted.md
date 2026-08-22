# Root `scripts/*.mjs` are never linted

## What

`pnpm lint` is `pnpm -r run lint`, which recurses over the five workspace
packages. The repo-root `scripts/` directory is not a workspace package, so
nothing in it has ever been linted -- not `bump-version.mjs`, not
`prerelease-version.mjs`, not `check-future-tasks.mjs`, and not
`wait-for-pr-checks.mjs`.

## Why it matters

Running eslint against `scripts/` by hand on 2026-08-22 produced 38 errors
across the four files. Almost all are one cause: the flat config declares no
node globals for these files, so every `process`, `console`, `setTimeout` and
`URL` reference reads as `no-undef`. They are false positives against the code
as written -- these are node CLI scripts and those globals exist -- but they are
also the reason a real defect in `scripts/` would have nowhere to surface.

`check-future-tasks.mjs` additionally trips `security/detect-unsafe-regex`
(a warning, at line 72). That one deserves a look on its own merits, since a
ReDoS in the backlog checker runs in the pre-commit hook.

## Steps

1. Add a flat-config block scoping node globals to `scripts/**/*.mjs`
   (`languageOptions: { globals: globals.node }`), which clears the `no-undef`
   class outright.
2. Decide on `no-console` for this directory. The existing three scripts print
   with bare `console.log`; the project-wide rule allows only `warn`/`error`/
   `info`. Either add a `no-console: off` override for `scripts/**` (matching
   the existing `**/cli/**` override) or convert them to `process.stdout.write`
   as [wait-for-pr-checks.mjs](../../scripts/wait-for-pr-checks.mjs) already
   does.
3. Wire the directory into a lint task that actually runs -- a root-level
   `eslint scripts/` step, since `pnpm -r` structurally cannot reach it.
4. Triage the `detect-unsafe-regex` warning in `check-future-tasks.mjs:72`.

## Why it was deferred

Found while adding the PR-check watcher, whose own file is affected. Fixing it
means changing `eslint.config.mjs` and the root lint wiring, which newly
red-flags three pre-existing scripts -- unrelated churn inside a tooling PR.
