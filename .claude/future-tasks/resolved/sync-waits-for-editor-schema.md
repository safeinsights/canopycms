---
priority: P1
adopters: BOTH
summary: >-
  RESOLVED 2026-10-09. Each CMS process records its schema names and registry fingerprint in `content-branches/.schema-registry.json`; the worker's git sync holds the base branch while incoming collection meta names a schema that record lacks (fail-open, bounded at 30 min), and System health shows "Waiting for editor deploy"
---

# Sync waits for the editor's schema registry

**Status:** Resolved 2026-10-09 (`worker/schema-gate.ts`, `schema-registry-record.ts`). **Priority: P1.** Filed 2026-10-09 from adopter request 96, part (a).
Part (b), per-collection degradation on an unknown schema, is a separate change.

## Problem

A merge that adds a schema to the registry (code) and content meta referencing it reaches
the editor two ways: the worker's next git sync (every 5 min) and the image deploy (4–5 min).
Neither waits for the other. When the sync wins, `schema/meta-loader.ts` throws "Schema
reference … not found in registry" for every branch, since the rebase loop carries the new
meta onto every editor branch.

## Decided shape (JP, 2026-10-09)

- The editor writes `{contentBranchesRoot}/.editor-registry.json` (schema names, content
  root, build identity) by temp+rename, only when it differs, at server-process start and
  never in build mode. Same pattern as `.sparse-cone.json` (`branch-sparse.ts`).
- `reconcileTrackedBranches` (`worker/git-sync.ts`) holds the base branch's fast-forward
  while the incoming tip references a schema name that the record lacks and that the
  current base does not already reference.
- Fail open with no readable record. Hold at most a configurable bound (30 min default),
  then advance and log loudly; (b) degrades what is left.
- The hold is reported in `worker-status.json` and shown in System health as "waiting for
  editor deploy". No adopter touchpoint.
