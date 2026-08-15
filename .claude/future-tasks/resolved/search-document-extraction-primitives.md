# Search-document extraction: the requested API is wrong; ship the real primitives instead

**RESOLVED (2026-08-14, epic `integration-202608-b`)** — all five items under "What
this epic ships" are done. `parseTypedFilename`, `defaultBuildPath`, and the
`updatedAt` carry-through landed first (commit `4a8992fe` and follow-ups). This task
closes out the remaining three: `resolveEntryTitle` is exported from `canopycms/server`
(and, since it turned out to be client-safe, the root `canopycms` entry too);
`toPlainText` — a new function built on `ai/strip-mdx.ts`'s `stripMdxImports`, not a
re-export of it — ships from `canopycms/ai` (not `canopycms/server` as originally
sketched below; `ai/` is where the underlying stripper already lived, and it's an
existing entrypoint, so the "no new package entrypoint" constraint still holds either
way); and the boot-block pattern is formalized as `createBuildCanopy(config, options)`
in `canopycms/server` rather than left as prose documentation, since embodying the
pattern as one importable, stubbable function is a stronger fix for the
top-level-`await`-can't-be-tested problem than describing it would have been. See
`docs/adopter-migration.md`'s "Unreleased" section for the adopter-facing writeup,
including the `extractSearchDocuments`-is-not-being-built reasoning restated for a
public audience.

## Priority: P2 [BOTH]

From adopter request #17, an adopter's own requests list
("search-document extraction"), triaged during the 2026-08-14 go-live backlog
re-baseline. **This epic (`integration-202608-b`, PR #235) is implementing the
primitives below now** — the `extractSearchDocuments` API itself is a
deliberate non-build, see "Not building".

## Why the requested API is wrong

The two adopters' actual search-index derivations
(one site: ~715 LOC / 4 files; the other: ~289 LOC / 2 files, per the
2026-08-13 site audits) share almost nothing at the "walk the content and
produce a search document" level — different field selection, different
weighting, different chunking. A single `extractSearchDocuments` function
would either be too opinionated to fit either site, or so parameterized it
stops saving anyone anything. **What IS duplicated between them isn't the
extraction logic — it's three lower-level primitives underneath it:**

1. **The boot block.** `createCanopyServices` + `createCanopyContext` +
   `STATIC_DEPLOY_USER` setup is byte-similar in both sites' build scripts.
2. **A markdown → plaintext stripper.** Exists internally already —
   `ai/strip-mdx.ts:19` — but isn't exported. Both sites independently wrote
   their own.
3. **Title derivation.** Exists internally already — `utils/title-field.ts:60`
   `resolveEntryTitle` — but isn't exported either. Same story.

## Related duplication, same root cause

`content-listing.ts:94`'s `parseTypedFilename` is a fourth case of the same
pattern: it's already `export const` at the module level but never
re-exported from `server.ts` or `index.ts`, so it's unreachable from outside
the package. Four hand-rolled copies were found across the two audited adopter
repos — in a build-time mtime collector, a content-integrity test (whose own
comment says it mirrors this very function), a helper recovering an entry type
from a path, and ad hoc route-level maps. They disagreed with each other on
segment count and case-folding, and two of them backed a link-integrity check,
so the drift silently narrowed what that check covered — a real correctness
risk, not just duplication. Exporting it properly (this epic, see the program log) removes
the reason the copies exist.

`listEntries` dropping `updatedAt` is the same target file's other reason to
exist: `listCollectionEntries` already `fs.stat`s every entry and sets
`updatedAt` (`content-listing.ts:383-398`), but `listEntries` discards it
(`content-listing.ts:251-263`) even though it does the same per-entry work.
One adopter's build-time mtime module exists to work around both gaps at
once — it hand-parses filenames (see `parseTypedFilename` above) **and** stats
files for mtimes. Carrying `updatedAt` through `listEntries` deletes such a
module outright, not just the filename-parsing half of it.

## What this epic ships

- Export the markdown stripper (`ai/strip-mdx.ts`'s functionality) off an
  existing entrypoint (`canopycms/server` — no new package entrypoint).
- Export `resolveEntryTitle` (`utils/title-field.ts:60`) the same way.
- Export `parseTypedFilename` (`content-listing.ts:94`) from `server.ts`/the
  main barrel so the four hand-rolled copies can be deleted.
- Carry `updatedAt` through `listEntries` (`content-listing.ts:251-263`),
  matching what `listCollectionEntries` already computes.
- Document the boot-block pattern (`createCanopyServices` +
  `createCanopyContext` + `STATIC_DEPLOY_USER`) as the recommended shape for a
  standalone script, tying into
  [script-runner-entrypoint.md](../script-runner-entrypoint.md).

## Not building

`extractSearchDocuments` as a single opinionated API — see the reasoning
above. Adopters compose the exported primitives into whatever shape their
search index actually needs.

## Related

- [shared-blocks-listentries-caveat.md](shared-blocks-listentries-caveat.md) —
  the reference-resolution half of "what a search index sees" is now
  documented prominently (README's "Listing Entries" and "Shared / Referenced
  Blocks" sections), but the underlying gap — `listEntries` still never
  resolves references — remains open as a capability, not just a doc gap.
