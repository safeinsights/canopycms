# Schema mutation/invalidation paths hardcode 'content' instead of honoring config.contentRoot

## RESOLVED — 2026-08-12 (`fix/adopter-config-correctness`)

Both sites below now build their content root from `config.contentRoot`. Two things
were larger than this file anticipated:

1. **A third site, found by the regression test.** `content-store.ts`'s
   `idIndex()` called `buildFromFilenames('content')`, so with a non-default
   content root the ID index was built by scanning a directory that does not
   exist — empty. Every ID-based lookup (reference resolution, entry links,
   `deleteEntry`'s order cleanup, rename) silently missed, while path-based
   reads kept working. Fixed with a new optional
   `ContentStoreOptions.contentRootName`, threaded from all 10 production
   construction sites (each already had the config in scope). This is why the
   test mattered: the two sites named below were fixed and the end-to-end
   delete test still failed.
2. **Multi-segment content roots.** `contentRoot: 'content/posts'` is documented
   as valid in `config/helpers.ts`, but `SchemaOps` derived `branchRoot` as
   `dirname(contentRoot)` (one level too deep — schema lock and `.canopy-meta`
   in the wrong directory) and the root-collection logical path as
   `basename(contentRoot)` (never matches `cms/content`). The constructor now
   takes an explicit `branchRoot` and derives `contentRootName` via
   `path.relative`, which fixes all three `basename` sites at once. Omitting
   `branchRoot` reproduces the old derivation exactly, so existing callers and
   tests are unaffected.

Regression tests: `api/schema.test.ts` ("contentRoot configuration"),
`api/entries.test.ts` ("honors a non-default config.contentRoot…"),
`schema/schema-store.test.ts` ("multi-segment contentRoot"). All were confirmed
to fail before the corresponding fix.

## Priority: P3

Surfaced by the EFS cross-process concurrency epic's second review (2026-07-21), while
implementing fixes from a follow-up adversarial review of that epic's PRs. Not itself a
concurrency bug, but adjacent to the schema-cache/content-index work that review
touched, and worth tracking so it doesn't get lost.

## Problem

Most of the codebase correctly derives the content root's directory name from config,
falling back to `'content'` only when unset:

```ts
const contentRootName = services.config.contentRoot || 'content'
```

(see `content-reader.ts`, `context.ts`, `http/handler.ts`, `api/content.ts`,
`ai/handler.ts`, `build/generate-ai-content.ts`, `dev-content-watcher.ts` — all follow
this pattern.)

But two call sites construct the `SchemaOps` content root with the literal string
`'content'`, ignoring `config.contentRoot` entirely:

- `packages/canopycms/src/api/schema.ts`'s `getSchemaOps()`:
  ```ts
  const contentRoot = path.join(context.branchRoot, 'content')
  ```
- `packages/canopycms/src/api/entries.ts`'s `deleteEntryHandler()` (comment there even
  says "Construct exactly like api/schema.ts's getSchemaOps"):
  ```ts
  path.join(branchContext.branchRoot, 'content')
  ```

`schema-store.ts` itself derives its notion of the content root's name correctly —
`path.basename(this.contentRoot)` (used for logical-path comparisons and the eager
schema re-resolve's `contentRootName` argument) — but that derivation is moot if the
`contentRoot` path handed in by the caller was already built from the wrong literal.
For an adopter who configures a non-default `contentRoot` (e.g. `"cms-content"`),
`api/schema.ts` and `api/entries.ts`'s schema/delete-entry paths would silently operate
on (or fail to find) the wrong directory, while every other content-facing code path
would correctly use the configured name.

## Scope

- `packages/canopycms/src/api/schema.ts` — `getSchemaOps()`
- `packages/canopycms/src/api/entries.ts` — `deleteEntryHandler()`'s `SchemaOps`
  construction
- Possibly `schema-store.ts`'s basename derivations (lines ~196, ~477, ~860), once the
  callers are fixed, to confirm they still round-trip correctly with a custom root name

## Fix sketch

Both call sites already have `ctx.services.config` in scope. Replace the hardcoded
`'content'` with the same pattern used everywhere else:

```ts
const contentRootName = ctx.services.config.contentRoot || 'content'
const contentRoot = path.join(context.branchRoot, contentRootName)
```

Add a regression test with a non-default `contentRoot` configured, exercising both the
schema mutation endpoints and `deleteEntry`, to lock in the fix and prevent the two call
sites from drifting out of sync with the rest of the codebase again.

## Related

- `docs/concurrency.md` — schema-cache eager re-resolve passes `contentRootName` through
  from these same call sites; a wrong root name here would silently break that
  mitigation too (resolving/persisting against the wrong directory)
