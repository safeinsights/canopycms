---
priority: P3
adopters: BOTH
summary: >-
  New 2026-10-09. Any non-static API process sharing a workspace's branches root writes `.schema-registry.json`, last write wins, so a second server with a different registry (a deploy-shape-(b) server, a dev process pointed at the shared workspace) could lift the worker's schema hold early or hold against the wrong registry. Safe in today's one-editor topology; decide whether the record should name its writer's role or refuse a foreign writer
---

# The schema-registry record has no single writer

**Status:** Open. **Priority: P3.** Filed 2026-10-09 from the review of the schema gate
([sync-waits-for-editor-schema.md](resolved/sync-waits-for-editor-schema.md)).

## State

`recordServedSchemaRegistry` (`packages/canopycms/src/schema-registry-record.ts`) runs at every
API handler start whose registry is non-empty and which does not read from a checkout. The worker's
schema gate (`worker/schema-gate.ts`) trusts the last record written. With one editor deployment
per workspace, every writer serves the same image, so the record tracks it.

## Risk

A second API process on the same branches root with a different registry flips the record:

- a superset registry lifts a hold before the editor serving requests can resolve the schema,
  which is the failure the gate exists to prevent;
- a subset registry holds content the serving editor could resolve, until the 30-minute bound.

## Options

1. Stamp the writer's role (editor Lambda vs other) and have the gate read only the editor's.
2. Key the record by deployment or by process role, one file each.
3. Document that a workspace root has exactly one API deployment, and leave the code as is.
