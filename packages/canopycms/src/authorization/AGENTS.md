# `authorization/` — Authorization

Branch and path access control, groups, and the protected-base-branch policy.

The **code comment at the point of the rule is authoritative**; this file is the map to
where those rules live.

## Overview

Unified access control (branch + path permissions, groups, protected-base-branch policy). `protected-branch.ts` is the single source of truth for base-branch protection: `getBranchProtection()` answers whether a branch is the base branch, submit-blocked, and/or read-only; `getBranchWriteProtection()` adds `writeBlocked`, authorizes content writes and renders editor locks, and its doc comment states the fail-closed rule for a missing `status`.

## `settings-file-store.ts`

layered cross-host locking for the settings workspace's mutable JSON files (`mutateSettingsJsonFile` wraps withLock + withOccFileLock + withOccRetry/writeOccJsonFile; permissions/groups loaders expose `mutatePermissionsFile`/`mutateGroupsFile` on top) — see [docs/concurrency.md](../../../../docs/concurrency.md)
