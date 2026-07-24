# branches.updateAccess allows editing the base branch's ACL

## Priority: P3

Surfaced by the protected-base-branch work (2026-07-24). The endpoint got a
"future tightening" code comment (api/branch.ts `updateBranchAccess`) instead of
a guard, because it only rewrites metadata, not content.

## Problem

`PATCH /:branch/access` rewrites `branch.json`'s `allowedUsers`/`allowedGroups`.
On the protected base branch, an ACL is mostly meaningless (content is read-only
in prod, submit is blocked) — but a base-branch ACL entry does feed
`canPerformWorkflowAction`'s `allowed_by_acl` path, so it can grant Withdraw
rights on the base branch to arbitrary users. Low impact (Withdraw on a base
branch is a no-op unless it was wrongly marked submitted), but incoherent.

## Fix sketch

Either reject `updateAccess` on protected branches (consistent with
delete/submit), or leave ACLs writable but exclude protected branches from the
`allowed_by_acl` workflow grant. Decide alongside the submitted-branch locking
work ([submitted-branch-edit-locking.md](submitted-branch-edit-locking.md)),
which touches the same authorization seam.
