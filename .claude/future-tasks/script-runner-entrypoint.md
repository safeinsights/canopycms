# A supported script-runner entrypoint

## Priority: P2 [BOTH]

From the 2026-08-13/14 site audits of `../docs-site-proto` and `../website`,
triaged as part of the 2026-08-14 go-live backlog re-baseline. No existing
task file covered this.

## Problem

There is no blessed way to run a standalone script (a migration, a bulk
ingest, a content-validation pass, an ad hoc report) with CanopyCMS loaded
and configured the normal way. Both sites carry repeated `@ts-ignore`
comments for `.ts` import specifiers in their scripts directories, working
around the lack of a real entrypoint rather than using one that doesn't
exist.

This is the shared prerequisite underneath several other items filed in this
same re-baseline: the boot-block duplication noted in
[search-document-extraction-primitives.md](resolved/search-document-extraction-primitives.md)
(`createCanopyServices` + `createCanopyContext` + `STATIC_DEPLOY_USER`, byte-
similar in both sites' scripts), and the programmatic content-authoring gap in
[content-authoring-api-id-generator.md](content-authoring-api-id-generator.md)
(`docs-site-proto/scripts/ingest-dataset.ts`). Both sites keep re-solving "how
do I get a working Canopy context outside of a Next.js request" from
scratch, and the `@ts-ignore` scars are the visible symptom.

## Proposed solution

A documented, supported script-runner pattern — likely a small CLI helper or
a documented boot function (reusing the CLI's existing config-loading
machinery, which already loads adopter config via `jiti` per
`cli-sync-migrate-ignore-adopter-content-root.md`'s notes on the CLI's
loader) that:

- Resolves and loads the adopter's `canopycms.config.ts` the same way the CLI
  already does.
- Produces a working `services`/context object suitable for scripting (read,
  and per
  [content-authoring-api-id-generator.md](content-authoring-api-id-generator.md),
  write).
- Removes the need for `@ts-ignore`d `.ts` import specifiers by being a real,
  typed entrypoint rather than an ad hoc script importing internal source
  paths.

## Related

- [content-authoring-api-id-generator.md](content-authoring-api-id-generator.md)
  — the concrete first consumer of this.
- [search-document-extraction-primitives.md](resolved/search-document-extraction-primitives.md)
  — documents the boot-block pattern this would formalize.
- `cli-sync-migrate-ignore-adopter-content-root.md` — the CLI's existing
  config-loading path this should reuse rather than duplicate.
