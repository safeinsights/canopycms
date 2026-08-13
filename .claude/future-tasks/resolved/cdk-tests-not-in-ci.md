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

**Failures are reported per package (`--no-bail`).** `pnpm -r run test` stops at
the first failing package, and pnpm runs topologically with `canopycms` first —
so a flake there (see [[markdownfield-mdxeditor-mount-flake]], which reproduced
twice during this work) would have masked the very deploy-template assertions
this change exists to enforce. The root `test` script now passes `--no-bail`.
Verified by planting a deliberately failing test in `canopycms`: without the
flag only `packages/canopycms` ran; with it every package ran, the CDK suite
still reported 82/82, and the overall exit code was still 1. So it does not
weaken the gate — it stops one package's failure from hiding another's.

**Deploy guard: `pnpm test` leaves a non-deployable Lambda bundle on disk.**
Caught in review, and it is a footgun this work introduced rather than found.
`canopycms-cdk`'s `test` runs `build:test-fixtures`, which `rmSync`s
`lambda/asset-transform/dist` and rebuilds it WITHOUT sharp. `canary/bin/canary.ts`
imports `AssetSupport` from `../../src/index`, so an in-repo `cdk synth`/`deploy`
resolves `Code.fromAsset()` against that same directory: run the tests, then
deploy, and the transform Lambda ships with no sharp binary and throws at cold
start on the first image request. Before this change the on-disk artifact was
always deployable, because running the CDK suite required the full `build:lambda`.

The guard went through two wrong shapes before the right one, and both
corrections came out of review:

1. *Warn in a doc comment* ("never pass `--skip-native` on a deploy path") —
   wrong ACTOR. The risk is not someone passing the flag; it is `pnpm test`
   passing it for them and leaving the artifact behind.
2. *Check for `.skip-native` at the deploy entrypoint* — wrong POLARITY and
   wrong PLACE. A negative marker fails OPEN on any path nobody anticipated,
   and this one is reachable: if `build:lambda`'s `npm install sharp` throws
   (offline, proxy, an npm too old for `--os`/`--cpu`/`--libc`) or the
   platform-binary check fails, `main()`'s catch sets a non-zero exit code but
   leaves the partial `dist/` — `handler.js` + `package.json`, no sharp, and no
   `.skip-native` marker either. Reproduced during review, and the CDK suite
   runs 82/82 green against exactly that bundle. A "is it marked bad?" test
   waves it straight through to a deploy.

**Final shape: a positive `.deployable` marker, checked in the construct.**
`build:lambda` writes `.deployable` (recording `sharpRange` and the verified
`platformPkgDir`) as the LAST act of a successful full build, reachable only
after the platform-binary check passes — so the file can only exist if the
native install actually verified. `AssetSupport` requires it and throws
otherwise, with `requireDeployableBundle?: boolean` (default `true`) as the
opt-out that only this package's own tests pass. Truth table:

| situation | marker | outcome |
| --- | --- | --- |
| full build succeeds | present | allowed |
| `--skip-native` fixture | absent | blocked |
| build fails at `npm install` | absent | blocked |
| build fails at platform check | absent | blocked |
| future/hand-rolled build path | absent | blocked |
| stale marker blocking a good build | impossible | — `rmSync(distDir)` runs unconditionally at the top of every build |

Placement is the construct, not `canary/bin/canary.ts`. The canary is the only
in-repo CDK app that resolves `Code.fromAsset()` against local source today
(`examples/aws-deployment` imports from the published package and never touches
`AssetSupport`; the adopter template `npm ci`s the registry build), so an
entrypoint check would have fixed this instance — but fail-open, with every
future local-source entrypoint having to remember it. In the construct, new
entrypoints inherit the protection. For adopters it is inert: `prepack` runs the
full build, so the published asset always carries the marker (confirmed via
`npm pack --dry-run` that the dotfile really is included).

The asset path is hoisted to a single `transformAssetDir` shared by the guard
and `Code.fromAsset()`, so the check can never end up statting a different
directory than the one being deployed. The positive marker also makes THAT
failure mode fail closed, since producer and consumer compute their paths
independently.

Verified all four states: skip-native fixture → CDK suite still 82/82 (opt-out
works); skip-native fixture → synth refuses; partial build with neither marker
→ synth refuses (the case the negative check missed); real `build:lambda` →
marker written → synth exits 0.

Minor accepted tradeoff: `pnpm --filter canopycms-cdk test` now always rebuilds
fixtures (~3s) even when `dist/` is current. Worth it to kill the
`CannotFindAsset` papercut on a fresh clone.

## Related

[[worker-log-timestamps]] — the task whose new CDK test surfaced this.
