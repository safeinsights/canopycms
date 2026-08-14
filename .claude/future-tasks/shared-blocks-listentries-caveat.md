# Shared/referenced blocks mostly work — but `listEntries` never resolves them

## Priority: P2 [BOTH]

From adopter request #16 in `../website/docs/canopycms-requests.md`
("shared/referenced blocks"), triaged during the 2026-08-14 go-live backlog
re-baseline. **This epic (`integration-202608-b`, PR #235) is addressing the
caveat below now** — don't double-build.

## What already works

`resolveReferencesInData` already recurses into block templates
(`content-store.ts:1654-1673`), and `resolveSingleReference` returns the full
target entry's data (`content-store.ts:1720-1732`). So a block field that
references another entry (a shared "team member" card, a shared CTA block,
etc.) resolves correctly through `read()`.

## The caveat

`listEntries` reads files **raw off disk** and never resolves references at
all (see the general finding in
[listentries-acl-awareness.md](listentries-acl-awareness.md) about
`listEntries`'s read path). So any surface built off `listEntries` — a search
index, a sitemap, an AI-content export — sees a shared block as either `null`
or a bare reference ID, never the resolved data. This is the same underlying
gap `#17`'s search-document work
([search-document-extraction-primitives.md](search-document-extraction-primitives.md))
runs into, and the same one
[resolved-references-url.md](resolved-references-url.md) is designed around.

## Action

Document the caveat explicitly (README, wherever reference fields and
`listEntries` are both covered): reference resolution is a `read()`-time
behavior, not a `listEntries`-time one. If/when `listEntries` grows resolution
(tracked as an open question in the `#17` and "resolved references carry a
URL" files, since it changes `listEntries`'s cost profile), this caveat
collapses on its own — no separate fix needed here beyond the doc note and
keeping the interacting files in sync.
