# Logging: the ban list is hand-curated, so its coverage is a snapshot

## Priority: P3

Found 2026-08-23 by the [baseline structural evaluation](../../docs/reviews/2026-08-structure.md).

## Problem

`utils/logger.ts` (`canopyLog*`) and `worker/log.ts` (`workerLog*`) both carry long
doc comments explaining that a bare `console` line in a worker-reachable module
loses its CloudWatch event boundary — the agent keys `multi_line_start_pattern` on
the ISO-8601 prefix, so an unprefixed line is folded into the PREVIOUS event.

`eslint.config.mjs:216-247` bans `console` member access in exactly **four
hand-listed shared modules**, and the config's own comment admits the problem:

> *"This list is a standing hazard: it is maintained by hand."*

Measured (excluding tests, `cli/`, stories, and the logger modules themselves):
**~40 bare `console.*` call sites** in server-side non-editor code, against 38
`canopyLog*` call sites. The four exempted files are clean; **every other
server-side module is not.**

The sharpest example is `http/handler.ts`, which uses **both, in the same
function**: a comment at `:16-19` states *"canopyLogError, not console.error:
http/handler.ts is shared code"*, then `:241`, `:248` and `:400` use
`console.error` while `:279` and `:302` use `canopyLogError`.

Others on worker-reachable paths today, and so not covered by a list that says they
are: `services.ts:353,399,456,476` (the settings-branch PR path),
`api/github-sync.ts:45,73,111,158,195` (explicitly a worker task),
`api/branch.ts:660,687,744`, `api/branch-merge.ts:65`, `api/branch-status.ts:99`,
`reference-resolver.ts:67,156`, `content-store.ts:2114`,
`authorization/permissions/loader.ts:50`, `assets/pipeline.ts:239,257`,
`ai/generate.ts:247,371,492`, `ai/handler.ts:114`, `static/index.ts:384`, and
`canopycms-next/src/{static,adapter,context-wrapper}.ts`.

## Fix

Two halves, and the second is the one that matters:

1. Sweep the ~40 server-side sites to `canopyLog*`. Mechanical.
2. **Stop curating the list by hand.** Derive the eslint `files:` scope from
   dependency-cruiser's worker-entry reachability, so a module that becomes
   worker-reachable is covered automatically. This is what the config comment
   itself proposes, and `lint:cycles` (added 2026-08-23) already demonstrates
   cruising the full graph in CI.

Until (2) lands, (1) is another snapshot.

## Related

- The `[REDACT]` tag in `utils/error.ts` — the adjacent rule about what error text
  may reach a browser
