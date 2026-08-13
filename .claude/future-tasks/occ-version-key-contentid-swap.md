# OCC version tokens are keyed by contentId, so a contentId swap silently disables conflict detection

Found while fixing the branch-switch stale-mirror bug
([program-b-final-review-followups.md](resolved/program-b-final-review-followups.md),
HIGH #3, resolved 2026-08-12). That fix closed the branch-switch *trigger*; the
underlying fragility is still there and can be reached without a branch switch.

## The problem

`editor/hooks/useEntryManager.ts` files OCC version tokens in
`entryVersionsRef`, keyed `${branch}:${contentId}` and captured in `loadEntry`.
`saveEntry` looks the token up under the key built from **the entry object it is
handed at save time**. Nothing guarantees that object is the same one the load
captured its token from.

When the two disagree, the lookup misses, `expectedVersion` is omitted, and
`content-store.ts` runs its mtime comparison only
`if (input.expectedVersion !== undefined)` — so the write skips conflict
detection entirely and blind-overwrites. It is silent: no 409, no warning, and
the user who lost their edit is the *other* editor.

## How to reach it without a branch switch

1. Editor 1 opens `content/posts/hello` (token filed under `${branch}:${id1}`).
2. Another editor deletes and recreates that path, so it gets a fresh contentId
   `id2`.
3. Any refresh replaces editor 1's in-memory entry object — e.g. the automatic
   post-save refresh in `Editor.tsx`, or `refreshEntries` after a create/rename.
4. Editor 1 saves. The lookup is now `${branch}:${id2}`, misses, and the write
   goes out version-less — precisely the concurrent-edit case OCC exists for.

Narrow (it needs a delete+recreate of the same path), which is why it was not
folded into the branch-switch fix.

## Fix direction

The client-side key is the wrong place to enforce this. Prefer making the
**server** refuse to skip the check: on the editor write path, reject (or at
minimum warn on) a version-less write to an entry that already exists, so
"no token" can never silently mean "no conflict detection". A version-less
create stays legitimate.

If a client-side change is wanted too, key the token by logical path rather than
contentId — the path is what `loadEntry`/`saveEntry` already agree on, since
both build the request path from `collectionPath` + `slug`.

## Guard to add

A test asserting the invariant directly: a write to an existing entry from the
editor path must carry `expectedVersion`. Today that invariant is only asserted
in the branch-switch regression test in `useEntryManager.test.ts`.
