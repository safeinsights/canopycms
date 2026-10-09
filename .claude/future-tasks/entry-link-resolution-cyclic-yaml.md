---
priority: P3
adopters: BOTH
summary: >-
  `resolveEntryLinksInData` (entry-link-resolver.ts) walks every value of an entry's data with no visited-set, so YAML frontmatter or a YAML entry whose anchors form a cycle (`a: &x { b: *x }`, which both `yaml` and gray-matter's js-yaml parse into a real cycle) overflows the stack on every read of that entry, and an alias "billion laughs" costs an exponential walk (gray-matter's js-yaml has no alias cap). Fix: a `WeakSet` of visited objects, as the delete guard's `findLinkingPaths` (validation/deletion-checker.ts) now has
---
# Entry-link resolution recurses without a visited-set

Found while reviewing the delete guard for referenced entries, which walks the same data the same
way and was given a visited-set there. The reader's walk is unchanged.

**Reachability:** only hand-committed YAML; the editor never writes aliases. A cyclic entry makes
its own reads throw `RangeError: Maximum call stack size exceeded`; a large alias fan-out makes them
slow.

**Fix:** pass a `WeakSet<object>` through `resolveEntryLinksInData` and return a repeated object
unchanged. Add a test with a self-referencing record, mirroring
`validation/__tests__/deletion-checker.test.ts`'s cyclic case.
