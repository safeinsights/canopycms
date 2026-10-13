---
priority: P2
adopters: BOTH
summary: >-
  New 2026-10-13, from PR 547's review. `createCollectionInner` (`schema/schema-store.ts`) never checks for a sibling collection with the same name, so a second create of "notes" under a parent writes another `notes.<id>` directory with the same logical path. A retried create that had landed after no answer is the likely way in
---

# A collection create accepts a duplicate sibling name

`SchemaStore.createCollection` → `createCollectionInner` resolves the parent and writes
`<name>.<newId>` with no check for an existing sibling of that name. Two directories then share
one logical path (`content/posts/notes`), and which one a path lookup finds is undefined.

The editor now refills an unanswered create only after a fresh content-tree read shows it did
not land (`Editor.tsx`, `CollectionDraft`), but a create that lands after that read, or one sent
from another editor, still gets through.

## Fix

Inside the schema lock, refuse a create whose name matches an existing sibling collection, with
a 409 the editor shows as "A collection named "notes" already exists here." Add a schema-store
test and an API test.
