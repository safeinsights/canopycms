# CI never runs the `canopycms-cdk` test suite (81 tests, including the deployment-security assertions)

**Priority:** P1

Found 2026-08-12 while running the gates for `fix/asset-decoder-mismatch`.

## Symptom

`.github/workflows/ci.yml`'s only unit-test step is:

```yaml
- name: Run tests
  working-directory: packages/canopycms
  run: pnpm test
```

It is scoped to `packages/canopycms`, so `pnpm -r run test` never fans out to the
other workspace projects. `canopycms-cdk`'s 81 tests across 3 files have no CI
gate at all. Nothing else in the workflow references `canopycms-cdk` (`grep`
confirms zero matches in `ci.yml`).

## Why it matters

These are not incidental tests. The suite asserts the deployment invariants the
hardening work was specifically about, by name:

- `DEP-H2: the Function URL requires AWS_IAM (not public)`
- `DEP-H2: only CloudFront may invoke the Function URL`
- `DEP-H2: CloudFront reaches the Function URL through an OAC that signs with SigV4`
- `DEP-C1: the Lambda security group has egress to EFS on 2049`
- `B5a/B5b/B5c: no CachePolicy ... allowlists Authorization/Host/Cookie as a header`
- the transform Lambda's log-group-scoped IAM statement, and its Function URL lock

A regression that makes the transform Function URL publicly invokable would pass
CI today. For a system whose whole prod story is "Lambda with no internet behind
CloudFront", these are exactly the assertions that should be gated.

## Second, smaller problem: the tests need prebuilt artifacts

Running them is not just a matter of widening the CI scope. In a fresh worktree
`pnpm --filter canopycms-cdk test` fails 63/81 with:

```
CannotFindAsset: Cannot find asset at packages/canopycms-cdk/lambda/asset-transform/dist
CannotFindAsset: Cannot find asset at packages/canopycms-cdk/worker/dist
```

The CDK constructs resolve `s3assets.Asset` against real bundle directories that
only exist after `build:lambda` and `build:worker`. Those two builds run only in
`publish.yml` / `publish-prerelease.yml`, never in `ci.yml`, and the package's
`test` script has no `pretest` hook. Confirmed the suite goes 81/81 green once
both are built.

This also means a plain root-level `pnpm test` is red in any fresh clone/worktree
until someone knows to run the two builds first — a papercut for contributors and
agents alike, and probably why the CI gap went unnoticed.

## Fix direction

Add a `pretest` (or an explicit CI step) in `packages/canopycms-cdk` that runs
`build:worker` + `build:lambda`, then either widen the CI test step to the
workspace root (`pnpm test`, dropping `working-directory`) or add a dedicated
cdk job. Prefer the workspace-root widening so newly-added packages are covered
by default rather than needing to be remembered — but check the added CI wall
time first, since the two bundles take a few seconds each.

Relates to [[dual-build-ci]] (same shape of gap: a deploy-critical path with no
CI gate) and [[program-b-canopy-hardening]] (the epic that added most of these
assertions).
