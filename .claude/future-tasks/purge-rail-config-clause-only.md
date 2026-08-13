# Base-branch purge rail re-derives "is base" instead of using getBranchProtection

**Priority:** P2 — data-loss-adjacent gap, softened by purge being a reversible trash-rename
**Found:** 2026-07-31, independent review of the e2e coverage sweep (Fable final pass)

## Problem

`authorization/protected-branch.ts` documents itself as the single source of
truth for "is this the base branch" and carries TWO clauses: (1) the name
matches `config.defaultBaseBranch ?? 'main'` (sanitized), and (2) a workspace
whose recorded `baseBranch` equals its own name is a base workspace **even
after `defaultBaseBranch` drifts** (dev git-HEAD switch, prod config change).

The admin purge/scan surfaces re-derive clause (1) only:

- `packages/canopycms/src/api/admin-branch-health.ts` (~line 178):
  `purgeBranchDirHandler` refuses purge only when
  `params.dirName === sanitizeBranchName(config.defaultBaseBranch ?? 'main')`.
- `packages/canopycms/src/branch-health.ts` (~line 135): `scanBranchHealth`
  flags `isBaseBranch` with the same comparison, which is what the UI's
  `purgeGateFor` disable rail keys off.

So a base workspace left behind by a base-branch drift, whose metadata is
corrupt or missing, scans as an ordinary corrupt/orphan directory and is
purgeable from the admin panel — the "unrecoverable in prod" scenario the
rail exists to prevent. (Softened: purge is a `.trash-*` rename with 30-day
retention, not a delete.)

## Caveat

When the metadata is corrupt, the recorded `baseBranch` is unreadable, so
clause (2) cannot be evaluated from the file. The realistic fix is:

1. Route the clause-(1) comparison through `getBranchProtection` so the two
   sites can never drift from the source of truth, and
2. Document in `admin-branch-health.ts` that the purge rail is
   config-clause-only for unparseable metadata (or additionally refuse to
   purge any dir whose name matches a PREVIOUS `defaultBaseBranch` recorded
   somewhere durable, if that ever exists).

## Coverage note

`apps/test-app/e2e/tests/admin-branch-health.spec.ts`'s "the base branch can
never be purged" test pins the config-clause 400 + disabled UI control; it
stays green through this gap by design (the drift scenario is not
constructible in the e2e harness without a config change mid-run).
