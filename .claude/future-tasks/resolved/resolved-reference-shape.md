# What a resolved reference contains — embed vs link

**RESOLVED** 2026-08-21, branch `feat/resolved-reference-shape`, epic
`epic/adopter-request-intake`. Supersedes and merges two files that were the same question
from opposite sides: `resolved-references-url.md` (the link case underserved) and
`resolved-reference-md-body.md` (the embed case underserved).

## The problem

A resolved reference was `{ id, slug, collection, ...frontmatter }` — which serves neither
job it is actually used for:

- **Embed** — render the target inline (a shared call-to-action block). Wants the target's
  content, prose included. An md/mdx target's prose lives on `doc.body` and was never spread
  in, so an embed got frontmatter only, and a search index built over pages with shared
  blocks silently contained nothing for them.
- **Link** — point at the target (related posts, an author byline). Wants a title and a URL.
  There was no URL, so you could not actually link.

The link half had a measured cost: the KB site ran a **second full `listEntries` pass** over
the whole content tree purely to build a contentId → urlPath table, and set
`resolveReferences: false` on some pages because paying for resolution *and* a separate URL
lookup was worse than hand-rolling both.

Surfaced while reviewing adopter request #16 (PR #242), which gave listings the ability to
resolve references at all and so made the shape question consequential.

## What shipped

**`urlPath` on every resolved reference, unconditionally.** Computed by the existing
`computeEntryUrl` (`utils/entry-url.ts`) from the `location.collection`/`location.slug` the
resolver already holds — no extra I/O. Deliberately the forward collection+slug → URL rule,
NOT `url-path-resolver.ts`'s reverse URL → entry direction, which has its own open
disagreement about how many URLs an index entry answers at (see
[url-resolver-index-entry-extra-url.md](url-resolver-index-entry-extra-url.md)).

`listEntries`' own inline `urlPath` computation was replaced with the same call, so a listed
entry's `urlPath` and a resolved reference's `urlPath` are now one function by construction
rather than two copies free to drift. A test pins the agreement.

**The target's body via `includeBody` on the field**, defaulting to `false`. Declared on
`ReferenceFieldConfig`, not on `read()`/`listEntries()`, because embed-vs-link is a property
of the content model rather than the call — and one call routinely contains both kinds. A
page with a shared CTA *and* a related-posts list cannot be served by a single call-level
setting, and a call-level flag would have reintroduced the same-field-two-shapes problem it
was meant to remove. The body arrives under the *target* entry type's own body field name
(`isBody: true`, else `body`), so an `isBody`-renamed field is honored.

The batch resolve cache is keyed by `id` + `includeBody`, since two fields can reference one
target with different settings; keying by id alone would have let traversal order decide the
shape for both.

**Type inference caught up.** `TypeFromEntrySchema` now intersects `ResolvedReferenceMeta`
(`id`, `slug`, `collection`, `urlPath`) onto a resolved reference's inferred shape. The
first three were always returned at runtime and always missing from the type — one source of
the library-internal type error `adopter-migration.md` records under
`exactOptionalPropertyTypes` + `skipLibCheck: false`.

## Now deletable in adopter repos

A contentId → urlPath index built by a second `listEntries` pass, and the page-level
`resolveReferences: false` escape hatch it forced.

## Left open

If a reference field's `resolvedSchema` declares a body field but `includeBody` is not set,
the inferred type still promises a body the runtime omits. Unchanged from before this work —
`includeBody` is what makes the promise true — and tightening it needs type-level machinery
to derive the body field name from the schema tuple. Tracked in
[resolved-reference-inferred-body.md](../resolved-reference-inferred-body.md).

## Related

- [reference-resolution-bypasses-path-acls.md](../reference-resolution-bypasses-path-acls.md) —
  P1, and the other open question about resolution: targets are resolved without a path-ACL
  check. Untouched here.
- [graymatter-cache-shared-frontmatter.md](../graymatter-cache-shared-frontmatter.md) — the
  residual `read()`-level aliasing of md frontmatter.
- [shared-blocks-listentries-caveat.md](shared-blocks-listentries-caveat.md) — the
  documentation half of #16.

[BOTH]
