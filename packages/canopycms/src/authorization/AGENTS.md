# `authorization/` — Authorization

Branch and path access control, groups, and the protected-base-branch policy.

Split out of the root [AGENTS.md](../../../../AGENTS.md) on 2026-08-23, where this had grown to
92 words inside a single bullet. The **code comment at the point of the rule is
authoritative**; this file is the map to where those rules live.

## Overview

Unified access control (branch + path permissions, groups, protected-base-branch policy — `protected-branch.ts`'s `getBranchProtection()` is the single source of truth for whether a branch is the base branch, submit-blocked, and/or read-only; its sibling `getBranchWriteProtection()` adds `writeBlocked` and is what authorizes content writes and renders editor locks — `status` is required there so a missing one fails closed, since `branch.json` is parsed with no schema validation)

## `settings-file-store.ts`

layered cross-host locking for the settings workspace's mutable JSON files (`mutateSettingsJsonFile` wraps withLock + withOccFileLock + withOccRetry/writeOccJsonFile; permissions/groups loaders expose `mutatePermissionsFile`/`mutateGroupsFile` on top) — see [docs/concurrency.md](../../../../docs/concurrency.md)
