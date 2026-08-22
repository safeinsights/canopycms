# Root `scripts/*.mjs` are never linted

## What

`pnpm lint` is `pnpm -r run lint`, which recurses over the five workspace
packages. The repo-root `scripts/` directory is not a workspace package, so
nothing in it has ever been linted, and `eslint.config.mjs` has no block
scoping node globals to it.

## Why it matters

Measured on the `epic/infra-review-2026-08` branch, 2026-08-22: running eslint
over `scripts/` by hand reports problems in **all seven files -- 90 errors and
4 warnings**.

| Script | Errors | Warnings |
| ------ | -----: | -------: |
| `check-esm-imports.mjs` | 36 | 0 |
| `check-future-tasks.mjs` | 17 | 1 |
| `add-js-extensions.mjs` | 11 | 1 |
| `prerelease-version.mjs` | 9 | 0 |
| `wait-for-pr-checks.mjs` | 8 | 0 |
| `check-action-pins.mjs` | 6 | 0 |
| `bump-version.mjs` | 3 | 2 |

Almost all of the errors are one cause: no node globals are declared for these
files, so every `process`, `console`, `setTimeout` and `URL` reference reads as
`no-undef`. Those are false positives against the code as written -- these are
node CLI scripts and those globals exist -- but they are also exactly why a real
defect in `scripts/` has nowhere to surface.

That matters more than it did when this was first written, because four of these
scripts are now load-bearing in CI and in the pre-commit hook:
`lint:tasks` (`check-future-tasks.mjs`), `lint:actions` (`check-action-pins.mjs`),
and `check:esm` (`add-js-extensions.mjs --self-test && check-esm-imports.mjs`).
The repo gates merges on scripts that nothing lints.

The four warnings deserve their own look rather than a blanket suppression --
`security/detect-unsafe-regex` in `check-future-tasks.mjs` runs in the
pre-commit hook, so a ReDoS there stalls every commit that touches the backlog.

## Steps

1. Add a flat-config block scoping node globals to `scripts/**/*.mjs`
   (`languageOptions: { globals: globals.node }`), which clears the `no-undef`
   class outright.
2. Decide on `no-console` for this directory. Most of these scripts print with
   bare `console.log`; the project-wide rule allows only `warn`/`error`/`info`.
   Either add a `no-console: off` override for `scripts/**` (matching the
   existing `**/cli/**` override) or convert to `process.stdout.write`, as
   [wait-for-pr-checks.mjs](../../scripts/wait-for-pr-checks.mjs) already does.
3. Wire the directory into a lint task that actually runs -- a root-level
   `eslint scripts/` step, since `pnpm -r` structurally cannot reach it.
4. Triage the four remaining warnings individually, starting with
   `detect-unsafe-regex` in `check-future-tasks.mjs`.

## Why it was deferred

Found while adding [wait-for-pr-checks.mjs](../../scripts/wait-for-pr-checks.mjs),
whose own file is affected. Fixing it means changing `eslint.config.mjs` and the
root lint wiring, and it newly red-flags six pre-existing scripts -- unrelated
churn to carry inside a tooling change.
