# Extract a shared branch-name-equality / effective-base helper

## Priority: P3

Surfaced by the protected-base-branch code review (2026-07-24), finding #7
(reuse). Deferred cleanup.

## Problem

`getBranchProtection`'s docstring says it is the single source of truth and "do
not re-derive the comparison elsewhere", yet the same-branch check
`sanitizeBranchName(a) === sanitizeBranchName(b)` is hand-rolled in three
backstops:

- `services.ts` `submitBranch` (~:312)
- `api/github-sync.ts` `syncSubmitPr` (~:44)
- `worker/cms-worker.ts` `push-and-create-or-update-pr` (~:611, vs `this.sanitizedBaseBranch`)

and the effective-base expression `branch.baseBranch ?? config.defaultBaseBranch
?? 'main'` is duplicated in `services.ts:311` and `github-sync.ts:33`. No shared
`isSameBranch(a, b)` / `effectiveBaseBranch(config, branch)` helper exists
(`resolveBaseBranch` in `utils/git.ts` is async git-HEAD detection, a different
concern).

The review-fix pass (finding #3) reduced but did not eliminate the drift risk:
`getBranchProtection` now also honors the recorded `branch.baseBranch`, aligning
it with the backstops' logic — but the low-level comparison is still copy-pasted.

## Fix sketch

Add an exported `isSameBranch(a: string, b: string): boolean` (sanitized compare)
next to `sanitizeBranchName` in `paths/branch.ts`, have `getBranchProtection` and
all four sites call it, and add a small sync `effectiveBaseBranch(config, branch)`
helper for the two duplicated resolution expressions. The worker can use
`isSameBranch` even though `CmsWorkerConfig` lacks `mode` (it only needs the
name comparison, not the full protection predicate).

## Related

- `authorization/protected-branch.ts`, `paths/branch.ts`
- `services.ts`, `api/github-sync.ts`, `worker/cms-worker.ts`
