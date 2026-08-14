# Expose `listEntries` beyond build context — but it has no ACL awareness

## Priority: P1 [BOTH]

From adopter request #11 in `../website/docs/canopycms-requests.md` ("typed
listing with data"), triaged during the 2026-08-14 go-live backlog re-baseline.

## What's already there

`listEntries` already returns exactly what the request asks for, in one pass:
`{urlPath, pathSegments, slug, entryType, data, schema}` per item
(`content-listing.ts:132-165`, `:251-263`), and it's already on
`CanopyBuildContext` (`context.ts:83-86`). So the data shape isn't the gap.

## The actual gap: no route to it that isn't privileged

`NextCanopyContextResult` (`context-wrapper.ts:132-174`) — what a normal
server component gets from `getCanopyContext()` — exposes no `listEntries` at
all. The only object that has it is `getCanopyForBuild()`, which throws at
request time via `guardBuildContext`. So today there is exactly one way to call
`listEntries`, and it is explicitly build-only.

That's not an oversight — it's a real gap in the model. **`listEntries` has no
ACL awareness**: `context.ts:301-306` passes no user through, and
`content-listing.ts` performs zero access checks anywhere in its read path. It
is latent only because `getCanopyForBuild()` throwing at prod request time is
the thing currently preventing an unauthenticated caller from enumerating every
entry's full data, including ones they couldn't `read()` directly. Widening the
route to `listEntries` without addressing that widens an unenforced surface,
not just a convenience gap.

## Options

1. **Filter through `services.checkContentAccess`.** Thread the resolved user
   through `listEntries`/`listCollectionEntries` and drop (or redact) entries
   the caller can't read, the same way `read()` already enforces per-entry
   access. Correct for a real request-time listing API, but touches the hot
   listing path per-entry and needs a perf check against large collections
   (see `entry-navigator-scalability.md` for the existing pagination story on
   the editor side).
2. **Ship it build-only, rejecting at request time — like `guardBuildContext`
   already does.** Keep `listEntries` exactly where it is today and just widen
   *documentation*, not the surface: this is arguably already "done" and the
   request is really asking for discoverability of `getCanopyForBuild()` for
   static-generation call sites (sitemap, search index, static params), not a
   new runtime API. Cheapest option; ships nothing new.
3. **Expose it unfiltered on `NextCanopyContextResult`, with a loud doc
   warning.** Fastest to build, but hands out full entry data (including any
   unpublished/draft content per `content-lifecycle-scenarios.md` and
   `draft-publish-lifecycle.md`) to anyone who can reach the page. Not
   recommended without option 1's filtering, or a narrower "published only,
   metadata only" carve-out.

Option 1 is the only one that's actually correct for a request-time API; 2 is
the pragmatic no-op; 3 should not ship alone.

## Interacts with

- [authorization-enforcement-consolidation.md](authorization-enforcement-consolidation.md)
  — whichever option is chosen, it should reuse that file's planned shared
  matcher rather than adding a **sixth** divergent ACL check. If that
  consolidation lands first, option 1 becomes materially cheaper.
- [entry-navigator-scalability.md](entry-navigator-scalability.md) — same
  "check access per entry in a listing" shape already exists in the editor;
  don't re-solve it twice.

## Not decided

Which option to take. Recorded here so the next session picks up the design
question rather than re-deriving that the gap is security-shaped, not a data
gap.
