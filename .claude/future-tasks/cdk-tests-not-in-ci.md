# CI never runs the canopycms-cdk test suite

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

## Related

[[worker-log-timestamps]] — the task whose new CDK test surfaced this.
