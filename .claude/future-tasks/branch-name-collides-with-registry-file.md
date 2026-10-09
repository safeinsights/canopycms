---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-05, reasoned from code, pre-existing. Branch creation does not reserve the branch registry's file names, so an editor can create a branch named `branches.json`, whose workspace path is the registry file. Provisioning or a later registry write then fails with an unhelpful error
---
# A branch can be named after a file in the branches root

## Priority: P3 [BOTH]

Found 2026-10-05 by review of the fix for
[context-read-provisions-requested-branch.md](resolved/context-read-provisions-requested-branch.md).
Reasoned from the code; pre-existing.

## The gap

A branch workspace is the directory `content-branches/<sanitized name>`, and
the branch registry keeps its files beside them in the same directory
(`branches.json`, and `branches.tmp.json` while it is rewritten;
`branch-registry.ts:23-27`).
`createBranchHandler` (`api/branch.ts`) rejects the settings-branch prefix and
`RESERVED_ROUTE_BRANCH_NAMES`, but not those file names. So an editor allowed
to create branches can ask for `branches.json`, whose workspace path is the
registry file. Provisioning then fails, or a later registry write fails, with
an error that does not name the cause.

Reads are already safe: a request-supplied name that hits a file reads as a
missing branch (`namesNoWorkspace`, `paths/branch.ts`).

## Fix sketch

Reserve the registry's file names, raw and sanitized, beside the route names,
or move the registry out of the directory that holds workspaces.
