# `editor/` back-compat shims in a codebase whose rules say no back-compat

## Priority: P3

Found 2026-08-23 during the baseline structural evaluation, while writing
[editor/AGENTS.md](../../packages/canopycms/src/editor/AGENTS.md).

## Problem

`packages/canopycms/src/editor/PermissionManager.tsx` (12 lines) and
`packages/canopycms/src/editor/GroupManager.tsx` (9 lines) are pure re-export
shims. Their own comments state why they exist:

> This file maintains backward compatibility for imports.
> The actual implementation is in ./permission-manager/

`CLAUDE.md` says the opposite, as a standing project rule:

> This is new code — no legacy compat needed, no migrations.

There is no external consumer to be compatible with. Every importer is inside
this package:

- `editor/Editor.tsx:39,40`
- `editor/PermissionManager.test.tsx`, `editor/PermissionManager.stories.tsx`
- `editor/GroupManager.test.tsx`, `editor/GroupManager.stories.tsx`

Neither symbol is on `canopycms/client` by way of these files — `client.ts`
does not re-export them at all.

## Why it is worth doing

Small on its own, but it is the shape that costs an agent time: two files with
near-identical names (`PermissionManager.tsx` and `permission-manager/`) where
one is real and one is a redirect, and nothing at the call site says which. The
`editor/` directory is 176 files; every avoidable ambiguity in it is worth
removing.

## Fix

Point the six importers at `./permission-manager` and `./group-manager`, delete
the two shims. Mechanical, type-checked by the compiler, no behavior change.

Consider in the same pass whether `permission-manager/` should gain its own
tests: it has 11 source files (incl. `PermissionEditor.tsx`, 321 lines) and no
tests in the directory, covered only indirectly through
`PermissionManager.test.tsx`. That half is bigger and could be split out to
[test-gap-backfill.md](test-gap-backfill.md) instead.

## Related

- [test-gap-backfill.md](test-gap-backfill.md) — where the `permission-manager/`
  coverage half belongs if it is not done here
