# [P2] `canopycms` test files `mkdtemp` without cleanup, leaking temp directories

Found 2026-09-09 while fixing the CDK suite's cloud-assembly leak
([cdk-test-synth-leaks-tmpdir.md](resolved/cdk-test-synth-leaks-tmpdir.md)).
That fix was scoped to `packages/canopycms-cdk`; this is the same defect shape
in `packages/canopycms`, which has a far larger suite.

## What was screened, and what was confirmed

A grep of `*.test.ts` files under `packages/` that call `mkdtemp` but contain no
`rmSync`/`fs.rm`/`rmdirSync`/`rimraf` anywhere returned **10 files**. Three were
read and confirmed to have no cleanup path at all:

- `packages/canopycms/src/url-collision.test.ts:20` — `beforeEach` creates
  `canopy-url-collision-*` and nothing removes it, so this leaks **one directory
  per test**, not one per file.
- `packages/canopycms/src/utils/git.test.ts:15` — a `tmpDir()` helper
  (`canopycms-utilsgit-*`) with no cleanup anywhere in the file.
- `packages/canopycms/src/branch-health.test.ts:12` — same shape
  (`canopycms-branch-health-*`).

The remaining seven are screened-but-unread and may include false positives (a
shared helper that cleans up, or a differently-named teardown):
`paths/__tests__/branch.test.ts`, `branch-workspace.test.ts`,
`content-reader.test.ts`, `api/entries.test.ts`, and the three
`ai/__tests__/*.integration.test.ts`. Confirm each before changing it.

Note `packages/canopycms/src/__integration__/test-utils/test-workspace.ts`
already exists as a shared workspace helper — check whether it (or something
like it) is the right home for the fix rather than adding cleanup 10 times.

## Magnitude is NOT measured, and that is step 1

Unlike the CDK leak, nothing here has been quantified. The honest position:
these directories hold a few small files each, not a 0.6-3.2 MB cloud assembly, so
this is **not** known to be a disk-filling bug and should not be written up as
one. What is known is that the accumulation is unbounded and the suite is large.

Measure before fixing, using the technique that settled the CDK case — it is the
only thing that distinguishes "worth doing" from "worth closing as won't-fix":

```
T=$(node -e 'console.log(require("os").tmpdir())')
before=$(ls -1 "$T" | wc -l)
pnpm --filter canopycms test
after=$(ls -1 "$T" | wc -l)
```

Count entries, not bytes, first — the inode/entry count is the plausible harm
here, and `du` on thousands of tiny directories is slow and misleading.

## If this is fixed, consider extracting rather than copying

The CDK fix's machinery (a `globalSetup`-owned per-run root, a pid in the root
name so an interrupted run's root can be swept safely, and a `setupFiles` hook
asserting the tmpdir gained nothing) currently lives in
`packages/canopycms-cdk/test-support/test-synth.ts` and `synth-leak-guard.ts`.
If the fix here reuses that shape, extract it before the second copy exists
rather than after -- a duplicated pid-naming convention that drifts is worse
than either copy alone.

## The rule worth reusing

The CDK fix's durable half was not the cleanup, it was the **assertion**: a test
that snapshots the tmpdir entry set before and after and fails on any addition,
mutation-checked by reintroducing the leak. Cleanup without that assertion
regresses silently, which is how the CDK leak survived eight days. If this is
fixed, fix it with an assertion — and note the ordering trap recorded in the
resolved CDK task: non-vacuity checks placed *before* the leak assertion mask it
under the very mutation meant to prove it works.
