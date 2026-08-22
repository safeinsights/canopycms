# Root `scripts/*.mjs` are never linted — RESOLVED

Resolved 2026-08-22 on `chore/lint-root-scripts`, into epic
`infra-review-2026-08`.

## What was wrong

`pnpm lint` is `pnpm -r run lint`, which recurses over the five workspace
packages. The repo-root `scripts/` directory is not a package, so nothing in it
was ever linted. `lint-staged` did not reach these files either: its glob listed
`js,jsx,ts,tsx,md,html,css,json,yaml,yml` and omitted `mjs`, so root scripts
were touched by neither prettier nor eslint on commit. Both halves had to be
closed; fixing only the config would still have left nothing running it.

Measured before the fix: **90 errors and 4 warnings across all seven root
scripts**. Four of those scripts gate CI or the pre-commit hook themselves
(`lint:tasks`, `lint:actions`, `check:esm`) — the repo was gating merges on
scripts that nothing linted.

## What was done

1. `eslint.config.mjs` declares node globals for `**/*.mjs`, which cleared 69 of
   the 90 errors (all `no-undef` on `console`/`process`/`setTimeout`), and turns
   off `no-console` for them — same rationale as the existing `**/cli/**`
   override. Placed BEFORE the `**/worker/**` blocks so the worker's stricter
   console ban still wins.
2. `lint:scripts` (`eslint scripts/ *.mjs --max-warnings 0`) added to
   package.json and wired into CI as its own step.
3. `mjs`/`cjs` added to the lint-staged glob.
4. The four warnings suppressed individually, at the line, each with its reason.

## Two things the original filing got wrong

**The ReDoS was not real.** This file claimed a `security/detect-unsafe-regex`
warning in `check-future-tasks.mjs` meant "a ReDoS there stalls every commit
that touches the backlog". That was a hypothesis written as a finding. Both
flagged regexes were timed against adversarial non-matching input: 0.2ms and
0.5ms at 50–60KB, i.e. linear. `safe-regex` flags on **star height alone**, and
in both cases the inner `*` sits inside a `(?:...)?` group — a `?` matches at
most once, so there is no nested repetition to backtrack through. Both are false
positives, and so are the two `detect-non-literal-regexp` warnings in
`bump-version.mjs`, whose interpolated pieces are `String.raw` constants
declared two lines above with no injection surface.

They are suppressed per-line rather than by disabling the rules for the
directory, and that distinction was verified rather than assumed: adding
`/^(a+)+$/` to a root script still fails `lint:scripts`, as does an undefined
variable. `--max-warnings 0` means a suppressed warning cannot quietly return,
and an unused disable directive surfaces if a regex is later rewritten.

**The scope was wider than "root scripts".** The same missing-globals gap was
open in `apps/dual-build-fixture/next.config.mjs` (1 error) and
`packages/canopycms-cdk/lambda/asset-transform/build.mjs` (5 errors). Every
`.mjs` file in this repo is node tooling or config — browser code is `.ts`/
`.tsx` — so the override is scoped to `**/*.mjs` rather than to one directory.

## Left open

`lint:scripts` covers `scripts/` and root-level `*.mjs`. Package-internal `.mjs`
(`packages/canopycms/scripts/postbuild.mjs`, the CDK `build.mjs`) is reached
only if that package's own lint script includes it; both now lint clean under
the new globals, but nothing guarantees they stay that way.
