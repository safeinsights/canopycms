# CI never runs the canopycms-cdk test suite

> **RESOLVED 2026-08-12** (`fix/cdk-tests-in-ci`). Both the CI gap and the
> `worker/` static-checking gap below are fixed; see the resolution notes at the
> bottom. This file also absorbed a duplicate write-up of the same finding
> (`cdk-tests-never-run-in-ci.md`, filed independently the same day via PR #188)
> — that file is deleted and its distinct framing folded in here.

Found 2026-08-12 while adding CDK assertion tests for
[[worker-log-timestamps]]: the new test passed locally, and then I checked
whether CI would ever have run it. It would not.

## Problem

`.github/workflows/ci.yml`'s only test step is scoped to one package:

```yaml
- name: Run tests
  working-directory: packages/canopycms
  run: pnpm test
```

So `pnpm test` resolves to that package's script, not the root's recursive
`pnpm -r run test`. Everything in `packages/canopycms-cdk/src/**/*.test.ts`
— 82 assertion tests at time of writing — has never run in CI.

This is not theoretical coverage loss. Those tests are the *only* automated
check on the deployment template, and they encode exactly the class of
regression nobody notices until a deploy: the LaunchConfiguration→LaunchTemplate
migration (fresh AWS accounts cannot create LaunchConfigurations at all), the
Lambda↔EFS egress rule, the CloudFront-only Function URL, the ASG update policy
that makes `cdk deploy` actually reach the worker, and the Lambda log-group
names that must NOT collide with auto-created `/aws/lambda/*` groups. Several
were added *as regression tests for bugs that already shipped once*.

Note `pnpm typecheck` IS recursive, so the CDK package is type-checked in CI —
which is probably why this went unnoticed. Type errors are caught; assertion
failures are not.

## Fix

Add the CDK package to the CI test matrix. The wrinkle is fixtures: its tests
synth real constructs, and `s3assets.Asset` / `lambda.Code.fromAsset` require
the bundle directories to exist first:

```
pnpm --filter canopycms-cdk run build:worker   # esbuild, fast
pnpm --filter canopycms-cdk run build:lambda   # esbuild + real `npm install sharp` for linux/arm64
```

`build:lambda` is the expensive half — it does a genuine platform-targeted
install. Two options:

1. Run both builds before the CDK test step (simplest; costs the sharp install
   on every CI run — the publish workflows already pay this, so it is a known
   quantity).
2. Note that synth only needs the *directory* to exist, not a working sharp —
   `build:lambda`'s esbuild step runs first and writes `dist/handler.js` before
   the install. A CI-only `build:lambda --skip-native` (or just running the
   esbuild half) would make the CDK suite cheap to gate on. Verified locally:
   with sharp's install failing under a sandbox, all 82 tests still pass.

Option 2 is preferable if the CDK suite should run on every PR.

## Related gap in the same package: `worker/` is neither linted nor typechecked

Found in the same pass. `packages/canopycms-cdk`:

- `tsconfig.json` sets `"include": ["src/**/*"]`
- the lint script covers `src/ 'lambda/**/*.ts' 'canary/**/*.ts'`

Neither covers `worker/` — so `worker/index.ts`, the actual entrypoint that
runs on the production EC2 instance, gets no static checking at all. Its only
gate today is `build:worker`, and esbuild bundles happily through type errors.

Fix is small: add `worker/**/*.ts` to the lint glob, and either extend the
tsconfig include or add a `worker/tsconfig.json` alongside the existing
`lambda/` and `canary/` ones (the typecheck script already chains three `tsc`
invocations, so a fourth fits the established pattern).

## Resolution (2026-08-12, `fix/cdk-tests-in-ci`)

**Option 2 was taken, and it was the right call.** `build.mjs` grew a
`--skip-native` flag that runs the esbuild half and skips the platform-targeted
`npm install sharp`. `lambda.Code.fromAsset()` only needs the asset directory to
exist — synth never executes the handler, so the linux/arm64 binary is
irrelevant to every assertion the suite makes. From a fully clean tree
(`worker/dist` and `lambda/asset-transform/dist` both deleted) the whole CDK
suite now runs in **4.3s wall clock, 82/82 passing**, which is cheap enough to
gate every PR with no argument about CI minutes.

Guardrails on the flag, since it produces a deliberately non-deployable bundle:
it writes a `.skip-native` marker into `dist/` so a test-only build is
identifiable on disk rather than inferred from a log, and the log line says
`NOT DEPLOYABLE` out loud. The marker cannot go stale — the script `rmSync`s
`dist/` on every run. `prepack` and both publish workflows call `build:lambda`
with no flags and are untouched; verified the real build still installs
`@img/sharp-linux-arm64` and leaves no marker.

**The gap was wider than "the CDK suite".** Because the step was pinned to
`working-directory: packages/canopycms`, `pnpm test` resolved to that one
package's script — so `canopycms-next` (51 tests), `canopycms-auth-dev` (42) and
`canopycms-auth-clerk` (26) had never run in CI either. **201 previously
ungated tests** now run. The fix removes `working-directory` so the step runs
the root recursive `pnpm -r run test`, which also means a newly added package is
covered by default instead of needing someone to remember. Confirmed every
workspace `test` script is vitest (`apps/example1` is a no-op echo), so no
browser/e2e work is pulled into the unit job — Playwright stays in its own.

Local DX is fixed by the same change rather than separately: `canopycms-cdk`'s
`test` script now chains a `build:test-fixtures` step, so a fresh clone's
`pnpm test` works instead of failing with `CannotFindAsset`. That was the
duplicate write-up's main practical complaint.

**`worker/` static-checking gap: also fixed here.** Added
`packages/canopycms-cdk/worker/tsconfig.json` (mirroring the existing `lambda/`
and `canary/` ones), chained a fourth `tsc --noEmit -p worker/tsconfig.json`
into the typecheck script, and added `'worker/**/*.ts'` to the lint glob. Both
pass clean today with no source changes — the code was fine, it simply had
nothing checking it.

One caveat worth knowing: `pnpm -r run test` bails on first failure, so a flake
in `canopycms` (see [[markdownfield-mdxeditor-mount-flake]], which reproduced
twice during this work) now prevents the later packages' tests from running at
all. Not a regression — they ran zero times before — but it does mean that flake
is now worth fixing on its own merits, since it can mask the CDK gate.

## Related

[[worker-log-timestamps]] — the task whose new CDK test surfaced this.
