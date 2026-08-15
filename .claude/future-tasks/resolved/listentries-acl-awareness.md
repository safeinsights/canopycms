# Expose `listEntries` beyond build context — but it has no ACL awareness

## RESOLVED (2026-08-14) — option 1 shipped: enforcement, not deferral

From adopter request #11, an adopter's own requests list ("typed
listing with data"), triaged during the 2026-08-14 go-live backlog re-baseline.
JP decided the open question the same day; implemented on
`fix/listing-acl-enforcement` off `integration-202608-b`.

## What shipped

**Option 1** (filter through the existing access checker), plus the binding the
adopter asked for:

- `context.ts`'s request-scoped `listEntries` **and** `buildContentTree` now
  filter through a memoized `ContentVisibilityOptions` predicate built from
  `services.createContentAccessChecker(branchContext, branchRoot, user)`.
- The predicate is applied inside `content-listing.ts` / `content-tree.ts` at
  each `listCollectionEntries` call site, so a denied entry's data never reaches
  `extract` — including as the `meta.indexEntry` handed to a collection's
  `extract`, which emits no node of its own and was the leak a
  `listEntries`-only fix would have missed.
- `NextCanopyContextResult` gained a phase-selecting `listEntries` (build
  context at build, ACL-enforced runtime context at request), matching the
  existing `read`/`readByUrlPath` shape. No new package entrypoint; no new API
  surface, since `ListEntriesOptions.filter` already covers the adopter's
  `entryType` and `noindex` needs.

## Why enforcement, not deferral

Carried over from the branch-only publish decision, which landed the same day
([draft-publish-lifecycle.md](../draft-publish-lifecycle.md)) and sharpens the
case for the option chosen here.

The original analysis framed the deferral option's exposure as "hands out
unpublished/draft content". Under the branch-only decision there is no such
category: publish state is the branch, so on an **unmerged branch every entry is
unpublished by definition**, and a request-time reader on that branch would see
all of it. That makes the exposure **sharper, not weaker** — there is no
per-entry flag to fall back on as a second line of defence, which is precisely
why filtering through the real access checker was the right call rather than
shipping build-only and revisiting later.

## Corrections to this file's original analysis

Three things it got wrong, recorded because they drove the decision:

1. **It was not latent.** This file said the gap was held closed by
   `getCanopyForBuild()` throwing at prod request time. But `CanopyContext
   extends CanopyBuildContext`, so `getCanopy().listEntries()` — the context
   documented as request-scoped and ACL-enforcing — already returned unfiltered
   full-`data` listings on a `mode:'prod'` + `deployedAs:'server'` deployment.
   `guardBuildContext` only ever guarded the *build* context. The proposed
   binding would have made the gap convenient, not reachable.

2. **`buildContentTree` had the identical hole**, on the same context, and was
   the more likely one to be hit first (it is the older, more-used API). Fixing
   only `listEntries` would have left a same-shape hole one method over.

3. **Option 1 was cheaper than described here.** This file worried about "the
   hot listing path per-entry" and a possible **sixth** ACL matcher.
   `createContentAccessChecker` already existed as the *batch* primitive for
   exactly this — it hoists branch access, the settings/permissions root, and
   the rule load out of the loop and returns a **synchronous** per-path check,
   and `api/entries.ts` already used it. So the per-entry cost is an `isAdmin`
   short-circuit or one `minimatch` per configured rule with no I/O, and it
   routes through `authorization/path.ts` — matcher #1 of the five, not a new
   one. Being server-only, it never implicated `lint:bundle`.

Option 2 (ship build-only) was rejected on a cost this file did not price: the
editor preview pane is an iframe onto the host app's own page URL, so an index
page previewed in a deployed prod editor would have thrown a 500 rather than
rendered — and `ARCHITECTURE.md`'s level-scoped `defaultPathAccess` documents
"a CMS-served site that is also publicly readable without auth" as a supported
shape, which option 2 would have declared incompatible with index pages.

## Adopter-side note

The multi-segment bug reported alongside request #11 (`'/blog/' + lastSegment`
resolving to a nonexistent URL) was **already fixed** on the marketing site
before this landed — its own content-listing helper now joins the full
segment path in one place. What request #11 buys them now is the N+1 and a
`urlPath` that round-trips by construction.

## Related

- [authorization-enforcement-consolidation.md](../authorization-enforcement-consolidation.md)
  — the runtime context is now another caller of matcher #1 and must be migrated
  with the rest when the shared matcher lands
- [context-listing-branch-pinning.md](../context-listing-branch-pinning.md) —
  split out of this work: neither method takes a `branch` option, and in prod
  they always list the base branch
- [list-permission-level.md](../list-permission-level.md) — a `'list'` level
  would change what these two filter on (`'list'` rather than `'read'`)
