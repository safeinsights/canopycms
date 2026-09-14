# `cli/` — CLI

The `canopycms` commands and adopter-project scaffolding.

The **code comment at the point of the rule is authoritative**; this file is the map to
where those rules live.

## Overview

CLI commands (`init`, `init-deploy`, `init-github-app`, `worker run-once`, `generate-ai-content`, `sync`, `migrate`); project-root discovery (`project-root.ts`)

`cli.ts`'s `KNOWN_AUTH_MODES`/`KnownAuthMode`/`isKnownAuthMode(value)` are exported so `worker run-once`'s auth-mode dispatch is independently testable — the dispatch below only recognizes `'clerk'`/`'dev'` and its surrounding `catch` fires solely on an import FAILURE, so before this guard a typo'd `CANOPY_AUTH_MODE` (e.g. `Clerk`) selected no plugin, silently skipped the auth-cache refresh, and still exited 0

## `init-github-app.ts`

Registers the GitHub App the worker authenticates as, via GitHub's App-manifest flow.
`CANOPY_APP_PERMISSIONS` (`github-app-manifest.ts`) is the whole security surface and each entry carries the call site
that forces it; `github-app-permission-drift.test.ts` keeps it in step by driving the worker's
dispatch table against a recording `Proxy` rather than grepping (the call sites have three
spellings and one spans lines, so a textual scan passed vacuously).

Three invariants whose reasons are in the file header, not here: **one App per site** (an App's
private key is App-level, so a shared App means one site's leaked key mints writes on another
site's repository); **`fetch`, never Octokit** (an App JWT needs `Bearer`, and
`@octokit/auth-app` is a lint error in this package — so the JWT is hand-rolled over
`node:crypto`); and **the key's destination is never this tool's business** (`-- <cmd>` on
stdin, or `--key-out`; no AWS or other cloud concept in the code).

`cli.ts`'s `parseArgs` passes minimist's `'--': true` solely so this command can recover a
clean argv for `spawn`; `passthroughArgs(argv)` narrows it without an `any`.

## `project-detect.ts`

best-effort adopter-project detection (package manager, default branch, GitHub owner/repo, missing CDK deps) consumed by `init-deploy aws`, which now also scaffolds a full CDK app (`cdk.json`, `infrastructure/bin/app.ts`, `infrastructure/lib/cms-stack.ts`, and the `infrastructure/tsconfig.json` the generated workflow type-checks it with) via `templates.ts`
