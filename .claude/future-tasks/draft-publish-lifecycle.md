# Draft/publish: decided — publish state is branch-only

## Priority: P1 [BOTH]

**Status: decided 2026-08-14 by JP. No package feature will be built.** This
file was opened by the 2026-08-14 go-live re-baseline proposing a schema-level
draft/published concept; that proposal is withdrawn and replaced by the
decision below. The KB cleanup it identified is still real and still owed.

## Decision

**Publish state is branch-only. CanopyCMS will not grow a per-entry
draft/published field.**

The contract, in full:

- **Merged to the base branch ⇒ public. Unmerged ⇒ not public.** There is no
  third state.
- **`noindex` ⇒ public but unadvertised** — the entry is built, its URL
  resolves for anyone holding the link, and it is absent from sitemap, RSS and
  index grids with `robots: noindex` on the page. It is *not* a hiding
  mechanism. (One adopter site's own SEO helper already states this
  precisely.)
- **No enumeration helper may invent a publish filter.** `collectStaticPaths`,
  `collectRoutableEntries` and friends filter on `noindex` only. The sitemap/SEO
  helpers shipped on this epic branch after this decision was drafted, and they
  comply: exclusion is the SEO group's `noindex` flag plus an explicit `exclude`
  predicate, and nothing reads a publish field. Note the name — the earlier design
  note proposed `collectPublishedEntries`; what shipped is `collectRoutableEntries`,
  because "routable" is what it actually answers and "published" is a question this
  decision says the package does not ask.
- **Corollary: don't merge unfinished content.** If it isn't ready, it stays on
  its branch. Both adopters currently do the opposite and their docs must say so.

This is not new architecture. It is what `ARCHITECTURE.md` has always said —
"Clicking 'Submit' requests publication—it does not actually publish... The
content becomes live only after the PR is merged on GitHub and the site is
rebuilt/deployed." The gap was that nothing stated the *negative* half (there
is no per-entry override), so an adopter invented one.

## Why not a per-entry field

Each argument for one was tested against the code and failed:

- **Timed reveal** ("merge now, show later"). Dead: the sites are statically
  built and pushed by GitHub Actions, so nothing becomes visible until a build
  runs. This needs a scheduled rebuild regardless; a status field buys nothing.
- **Retirement / archival.** Dead: `validation/deletion-checker.ts` already
  blocks deleting a referenced entry (`canDelete: referencedBy.length === 0`),
  and an `archived` state would need that same guard or inbound links 404 — so
  it saves no work over deleting. `git revert` restores the file byte-for-byte,
  content ID included, so retirement-by-delete is fully recoverable.
- **Editor friction** ("a branch just to hide a page is heavy"). Dead: hiding a
  page is the same branch flow as *any* edit, which the architecture already
  requires for everything.
- **Long-lived branches.** Survives — see the hand-off below. It is a workflow
  question, not a reason for a schema primitive.

Rejected sub-options, for the record: a reserved boolean `draft` (wrong default
polarity — absent ⇒ published, so a half-written entry ships), and an
adopter-named field the package filters on (that *is* the convention that just
failed, with no enforcement added).

The KB's own editorial-workflow status field (used only on certain
machine-generated content, unrelated to page visibility) stays separate and
untouched. Unifying it with a visibility concept would force an editorial
"needs curation" state to also answer "is this public?", and the right answer
differs per site.

## The finding that motivated this (verified, and still owed a fix)

The documentation site's own README and contributor docs tell authors `draft`
is a frontmatter field they can set to hide a page. Every part of that is
verified:

| Claim | Verified |
|---|---|
| The README and contributor docs both document `draft` as a frontmatter field | yes |
| The schema never declares it — the only similarly-named thing is an unrelated editorial-workflow status option on a different content kind | yes |
| No content file sets `draft:` | yes |
| Three separate call sites check it anyway: a route guard, a tree-building helper, and the search-index builder | yes |

**One correction to the original write-up.** The three filters are not dead in
the sense of "could never work." `validateEntryData` iterates only declared
schema fields and neither rejects nor strips undeclared keys;
`normalizeContentPayload` carries the whole read payload into editor form state
and `buildWritePayload` spreads it back. A hand-authored `draft: true` **would**
round-trip through an editor save and **would** hide the page.

The real trap is narrower and worse: **the editor renders no control for it.**
The entire premise of the deployment is non-technical editors, and they cannot
set the field. The docs promise a capability the editor cannot deliver, and
nothing tests the three filters, so nobody would notice if they broke.

## What is owed

### In this repo (this task)

- State the contract where it is findable — `ARCHITECTURE.md`, under
  Content Workflow, so the next person asking "how do I unpublish" finds the
  answer instead of inventing one.
- Stop the second convention shipping: `static-export-sitemap.md` proposed an
  `opts.publishedField` (default `published`; absent ⇒ published) — a publish
  convention of *opposite polarity* to the KB's `draft`, neither enforced.
  Removed in favour of noindex-only filtering.

### In the documentation site's own repo (cross-repo follow-up, not done here)

The live trap, and the reason this is P1:

- Correct the README and contributor docs to stop listing `draft` as a
  frontmatter field, and say instead that unfinished content stays on its branch.
- Delete the three filters and the `draft` key in the tree-extract shape.
  They give false assurance about a control no editor can reach.
- Leave the unrelated editorial-workflow status field alone.

### In the marketing site's own repo (cross-repo follow-up, not done here)

No urgent change. Its `isNoindex` predicate is *correct* under this decision —
including its "unfinished stubs stay out of both" usage, which is hereby
sanctioned rather than a misuse. When the package ships `extractSeoFields`,
delete the local SEO-helper fork and route through it.

## Hand-off: long-lived branches

Branch-only makes long-lived content branches **legitimate** — a half-written
article is simply an open branch. That contradicts
[content-lifecycle-scenarios.md](content-lifecycle-scenarios.md)'s stated
assumption ("current assumption is short-lived; state it and design the
guardrails that keep branches short").

Per JP: **assume some branches will be long-lived, because human reviewers
forget about them.** The guardrails to design are therefore staleness
*surfacing and recovery*, not prevention. Recorded in that file; not solved here.

## Related

- [content-lifecycle-scenarios.md](content-lifecycle-scenarios.md) — owns the
  long-lived-branch question handed off above.
- [static-export-sitemap.md](resolved/static-export-sitemap.md) — consumes this contract;
  its publish-filter option was removed by this decision.
- [static-export-seo-metadata.md](resolved/static-export-seo-metadata.md) — owns
  `noindex`, which this decision makes the *sole* per-entry visibility lever.
- [listentries-acl-awareness.md](resolved/listentries-acl-awareness.md) — its
  unpublished-data concern is about *branch* content, not draft-flagged entries.
- [resolved-reference-shape.md](resolved/resolved-reference-shape.md) — its "is this
  visible" question dissolves: within a branch, everything is equally visible.
