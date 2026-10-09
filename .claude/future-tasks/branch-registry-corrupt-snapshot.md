---
priority: P2
adopters: BOTH
summary: >-
  `branch-registry.ts` regenerates its snapshot only on a not-found error and rethrows a `SyntaxError`, so a corrupt `branches.json` on EFS fails branch listing for every editor until someone deletes the file by hand. Regenerate on a parse failure
---
# A corrupt `branches.json` bricks branch listing for every editor

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
