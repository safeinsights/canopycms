# A supported script write path (and the scripting-entrypoint cluster)

## Priority: P3 [BOTH]

The read half of scripting ships: `createBuildCanopy(config, { entrySchemaRegistry })`
(`build-canopy.ts`, exported from `canopycms/server`) boots a read context for a standalone
`tsx`/`node` script as the synthetic admin user, bypassing ACLs. `generateId` (`id.ts`) is also
exported from `canopycms/server`, so an ingest script no longer needs to copy the Base58 alphabet.

## What is left: a write path

An adopter's dataset-ingestion script writes entry YAML with raw `writeFileSync`, outside
CanopyCMS's write path. Bulk-ingested content therefore:

- **Bypasses schema validation.** Nothing checks the YAML against the entry type's schema the way
  `ContentStore.write()` does via `validation/entry-validator.ts`, so a malformed import is
  invisible until something downstream trips on it.
- **Bypasses the ID index.** `ContentStore`'s content-ID index (`content-index-generation.ts`) is
  maintained by the package's own write and scan paths; hand-dropped files are not registered, so
  reference resolution and ID lookups can miss them until a rescan.

There is no documented, supported way to author content from a script that gets the validation and
indexing guarantees the editor save path gets.

**Direction:** a server-side function that performs the same write as the editor save path (schema
validation, ID assignment, index update), documented as the scripting write entrypoint and reachable
from `createBuildCanopy`'s context. It must not bypass the content-write lock
(see [content-write-lock-coverage-gaps.md](content-write-lock-coverage-gaps.md)).

## Related

- [build-canopy-scripts-outside-next-build.md](build-canopy-scripts-outside-next-build.md): the
  open decision on where `createBuildCanopy` and `generate-ai-content` read content from outside
  `next build`.
- [content-validation-gate.md](content-validation-gate.md): a validating write path still would not
  catch a render-exploding MDX body; the two are complementary.
- [search-document-extraction-primitives.md](resolved/search-document-extraction-primitives.md):
  documents the boot-block pattern `createBuildCanopy` formalizes.
- [cli-sync-migrate-ignore-adopter-content-root.md](cli-sync-migrate-ignore-adopter-content-root.md):
  the CLI's config-loading path a script runner should reuse.
