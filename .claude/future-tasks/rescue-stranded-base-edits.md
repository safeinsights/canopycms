# Rescue tooling for stranded edits on a protected branch clone

## Priority: P2

Surfaced by the protected-base-branch work (2026-07-24). The first deployed prod
instance let editors save directly on `main` before protection existed; recovery is
currently a manual EFS runbook (docs/deploying-to-aws.md → Troubleshooting →
"Stranded edits on the base branch"). JP chose runbook-only for that incident and
deferred tooling.

## Problem

When a branch clone holds uncommitted edits that can never reach a PR (the
pre-protection saves on `main`, or any future guard bypass), there is no
Canopy-level way to move them onto a real editing branch. The manual runbook
requires shell access to EFS and git literacy — exactly what the CMS exists to
avoid. Meanwhile the worker's `refreshBaseBranchWorkspace()` skips fast-forwarding
a dirty base clone every sync cycle, so the stranded state also degrades base
syncing until someone intervenes.

## Fix sketch

A small admin-only capability (CLI command and/or API action) that:

1. Creates a new editing branch (normal `openOrCreateBranch` path, forked from
   origin base).
2. Copies the dirty/untracked `content/**` state from the source clone into the
   new branch's clone (reuse `sync-core.ts`'s tree-diff/copy primitives).
3. Resets the source clone to `origin/<base>` and normalizes its
   `.canopy-meta/branch.json` (status back to `editing`, drop `syncStatus`).

Surfacing it in the editor (a "Rescue edits…" action on a branch the server
reports as protected + dirty) is a possible second step; CLI-first is fine.

## Related

- `authorization/protected-branch.ts` — the predicate that makes base clones
  read-only in prod (so new stranding should only come from bypasses)
- `worker/cms-worker.ts` `refreshBaseBranchWorkspace()` — logs and skips on dirty
  base clones; its log line is the detection signal
- `sync-core.ts` — prompt-free tree diff/copy primitives to reuse
