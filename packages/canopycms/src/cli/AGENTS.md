# `cli/` — CLI

The `canopycms` commands and adopter-project scaffolding.

Split out of the root [AGENTS.md](../../../../AGENTS.md) on 2026-08-23, where this had grown to
93 words inside a single bullet. The **code comment at the point of the rule is
authoritative**; this file is the map to where those rules live.

## Overview

CLI commands (`init`, `init-deploy`, `worker run-once`, `generate-ai-content`, `sync`, `migrate`); project-root discovery (`project-root.ts`)

`cli.ts`'s `KNOWN_AUTH_MODES`/`KnownAuthMode`/`isKnownAuthMode(value)` are exported so `worker run-once`'s auth-mode dispatch is independently testable — the dispatch below only recognizes `'clerk'`/`'dev'` and its surrounding `catch` fires solely on an import FAILURE, so before this guard a typo'd `CANOPY_AUTH_MODE` (e.g. `Clerk`) selected no plugin, silently skipped the auth-cache refresh, and still exited 0

## `project-detect.ts`

best-effort adopter-project detection (package manager, default branch, GitHub owner/repo, missing CDK deps) consumed by `init-deploy aws`, which now also scaffolds a full CDK app (`cdk.json`, `infrastructure/bin/app.ts`, `infrastructure/lib/cms-stack.ts`) via `templates.ts`
