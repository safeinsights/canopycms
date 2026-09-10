# [P2] Drop the `--conditions=import` workaround from adopter CDK apps once the fixed packages ship

Created 2026-09-09, alongside the fix for the missing `require` condition in every
published package's `publishConfig.exports` (branch
`claude/canopycms-cdk-exports-commonjs-8a3afa`). This is the half that lives in the
**adopter infrastructure repos**, not here, which is why it is a task rather than part
of that change.

## What the workaround is

An adopter hit `ERR_PACKAGE_PATH_NOT_EXPORTED` on the first `cdk synth` after their CDK
app began importing from `canopycms-cdk`. Their `cdk.json` `app` command now carries:

```
NODE_OPTIONS=--conditions=import
```

which adds `import` to the condition set Node accepts for `require()`, scoped to that one
subprocess. It was deliberately not put in a shell profile or a package.json script,
either of which would also have reached their test runner and CLI scripts. Their blast
radius was measured rather than assumed: of 52 packages loaded during a full synth, five
declare an `import` condition at all, and none of them is `aws-cdk-lib`, `constructs`, or
any `@aws-sdk` package.

## Why it should come out

The root cause is fixed in this repo: all five published packages now declare
`types`/`import`/`require` conditions, and `pnpm check:esm` requires every entry point
from a real `.cjs` file in CI, so the class cannot silently return. Once the adopter
bumps to a release carrying that fix, the flag is dead weight — and worse than neutral,
because **it masks exactly this defect class**. A future package that loses its `require`
condition would keep working in that one repo and fail for everyone else.

## What doing this looks like

1. Wait for a release containing the fix (anything after `0.0.65`; confirm against the
   installed tarball's `package.json`, not against main — see
   [the note on `pnpm pack` vs `npm pack`](../../docs/adopter-migration.md)).
2. In the adopter repo, remove `NODE_OPTIONS=--conditions=import` from `cdk.json`'s `app`
   command and run `cdk synth`. It should succeed unchanged; diff the synthesized
   templates against the previous output to confirm nothing else moved.
3. Delete the pinning test that asserts the flag is present. That test documents itself as
   unable to detect the problem it guards — a correct call at the time, and precisely why
   it should not outlive the workaround.

## The part worth remembering

Their full suite — 900+ tests including a dual-synth check across two account
configurations — passed green against an app the CDK CLI could not load at all, because
Vitest resolves through Vite, which uses the `import` condition. The divergence was
between the test runner's resolver and Node's, and no assertion inside the runner could
reach it. It surfaced only because a deploy step ran `cdk synth` by hand. That shape
generalizes: see [DEVELOPING.md](../../DEVELOPING.md#published-package-esm-import-check)
for how this repo now covers it.
