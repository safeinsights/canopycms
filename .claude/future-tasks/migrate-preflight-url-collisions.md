# `canopycms migrate` can author both URL-collision shapes with no plan-time warning

**Status:** Open. **Priority: P3.** Found 2026-08-21 by the bypass sweep of
[url-collision-authoring-guard.md](resolved/url-collision-authoring-guard.md) — the question was
"what else creates entries without passing the write boundary", and the migrate CLI was the one
answer that is both reachable by an adopter and cheaply fixable.

## What

`cli/migrate.ts` writes content files directly, so none of the write-boundary guards apply. Two
distinct collisions it can author from a plausible source tree:

1. **In-collection same-slug.** `slugifyName` collapses distinct source names — `Getting
   Started.md` and `getting_started.md` both become `getting-started`, producing two same-slug
   files in one directory. That violates the invariant `ContentStore` enforces on every other
   write path (`buildPaths`' type-agnostic slug scan plus the `expectedVersion: null` guard).
2. **The cross-collection contested URL.** `guides.md` alongside a `guides/index.md` migrates into
   exactly the shape the new guard exists to refuse: both compute `/guides`, and only one is
   reachable.

Both are caught later by `assertNoDuplicateUrlPaths` at build time, so nothing ships broken
silently. But the adopter meets it as a failed build some time after the migration, with no
connection drawn back to the two source files that caused it.

## Why this is worth doing, cheaply

The migrate command already builds a **plan** enumerating every source→destination rename before
writing anything. Detecting both shapes is a pure function over that plan — group destinations by
the `urlPath` they will produce and report any group of more than one — with no filesystem work
and no new rule: `computeEntryUrl` and `findDuplicateUrlPaths` already exist and are exported.

Emitting it at plan time turns "your build failed weeks later" into "these two source files map
to the same URL, rename one before continuing", naming both paths.

## Not in scope

Refusing the migration. A retrofit is exactly the situation where an adopter may want to get the
content in and sort collisions out afterwards, and the build guard already stops a broken deploy.
Warn and name the files; let them decide.

## Related

- [url-collision-authoring-guard.md](resolved/url-collision-authoring-guard.md) — the write-boundary
  guard, which the migrate CLI deliberately bypasses (it writes files directly).
- [url-resolver-index-entry-extra-url.md](resolved/url-resolver-index-entry-extra-url.md) — added
  the build-time duplicate-URL guard that currently catches this after the fact.

[NEITHER]
