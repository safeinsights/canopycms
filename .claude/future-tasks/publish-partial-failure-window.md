# [P2] A FAILING publish step leaves the same mismatched dist-tags cancellation did

Found by the human review of PR #257 (2026-08-22), rated low-medium. The
infra-review epic closed the *cancellation* path and its analysis was entirely
about cancellation; this is the sibling case nobody filed.

## The gap

`publish.yml` publishes the five packages as five sequential steps. The epic set
`cancel-in-progress: false`, so a superseding push can no longer kill a run
part-way. But a **failure** in step 3 produces the identical state: `latest`
moved for `canopycms` and `canopycms-next`, not for the other three.

Because `pnpm pack` resolves `workspace:*` to an exact version at pack time, the
published peer dependencies are exact pins — so `npm i canopycms
canopycms-auth-clerk` during that window is an ERESOLVE, which is the same
consequence the concurrency comment already calls out as worse than a subtle
incompatibility.

## What is already mitigated

The `--min` registry floor makes the *version* self-healing: the next run derives
`max(committed, registry) + 1` and republishes all five in lockstep, so the skew
clears on the next successful push to main. What is unaddressed is the window in
between, and nothing currently even reports it.

## Fix direction

Two cheap steps, in order of value:

1. **Pack all five, then publish all five.** That shrinks the failure window from
   "any pack OR publish failure" to "a registry-side failure mid-sequence" — most
   of the realistic failure surface (a build/pack problem in package 4) moves to
   before anything has been published.
2. **An `if: failure()` step that prints which packages already published.**
   Turns a silent broken window into an actionable log line naming exactly what
   is mismatched, which is what an operator needs to decide whether to wait for
   the self-heal or intervene.

Neither changes the happy path. Consider alongside
[release-required-status-checks.md](release-required-status-checks.md), which is
the other open release-pipeline item.
