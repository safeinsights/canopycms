---
priority: P2
adopters: BOTH
summary: >-
  RESOLVED (2026-10-09). `BranchRegistry.list()` treats an unparseable snapshot, or one failing a zod shape check (version 2, generation, each entry's branch held to branch.json's own schema), like an absent one: it warns once per registry path and regenerates through the existing temp+rename `regenerate()`. Other read errors still propagate. On `fix/branch-metadata-robustness`
---
# A corrupt `branches.json` bricks branch listing for every editor

## Status: RESOLVED 2026-10-09

`list()` regenerates over an unparseable or wrong-shaped snapshot, warning once per registry path
(the de-duplication matters when the marker is unreadable and the rebuilt snapshot is served
without being persisted). No new lock: `regenerate()` already captures the marker before it scans
and writes by temp+rename, and the corrupt file is only ever replaced by a fresh scan. Tests in
`branch-registry.test.ts`.

## Priority: P2 [BOTH]

`branch-registry.ts` (`list()`, lines 84-93) regenerates the snapshot only when reading it throws
a not-found error and rethrows a `SyntaxError`. A truncated or hand-damaged `branches.json` on EFS
therefore fails branch listing for **every** editor until someone deletes the file by hand.

## Fix

Treat an unparseable snapshot like an absent one: log it, regenerate from the branch directories,
and overwrite. The snapshot is a cache of the branch directories, so regenerating loses nothing.
Parse failures only; other read errors (permissions, I/O) still propagate. Test: write garbage to
the snapshot path, call `list()`, and assert it returns the regenerated branches and leaves a valid
file behind.

## Related

- [branch-metadata-no-schema-validation.md](branch-metadata-no-schema-validation.md): the same
  failure class for `branch.json`
