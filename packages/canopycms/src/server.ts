// Public server-side API for adopters. JSDoc is duplicated at each named
// re-export so it shows on hover in adopter editors — TypeScript propagation
// through `export { X } from './module'` is inconsistent across LSP versions
// and module-resolution modes. New top-level public re-exports should follow
// the same pattern (see DEVELOPING.md).

export * from './content-reader'
export * from './services'
export * from './build-mode'
export * from './context'
export { operatingStrategy } from './operating-mode'
export * from './authorization/groups'
export * from './branch-workspace'
export * from './content-store'
export {
  loadCollectionMetaFiles,
  resolveCollectionReferences,
  watchCollectionMetaFiles,
  resolveSchema,
} from './schema'
export type { CollectionMeta, RootCollectionMeta } from './schema'

/**
 * Create a type-safe entry schema registry with runtime validation.
 *
 * Maps each entry-type's name to its `EntrySchema`. Keys are referenced by
 * `.collection.json` files via the `entry.schema` property. Recommended
 * convention is to key by entry-type name (filename token, also the value of
 * `meta.entryType` in tree-builder callbacks) — that way
 * `EntryTypesFromRegistry<typeof yourRegistry>` derives the
 * discriminated-union map for `buildContentTree`'s `TEntryTypes` parameter
 * automatically. See `createEntrySchemaRegistry`'s source-file JSDoc for the
 * full example.
 */
export { createEntrySchemaRegistry } from './entry-schema-registry'

/**
 * Validate that entry-schema references in `.collection.json` files exist in
 * the registry. Useful at build time to fail fast on stale references rather
 * than at request time.
 */
export { validateEntrySchemaRegistry } from './entry-schema-registry'

/**
 * Derive a discriminated-union entry-type map from a registry value. Pass
 * `typeof entrySchemaRegistry` as the type argument. The registry must be
 * keyed by entry-type name for the result to plug straight into
 * `buildContentTree`'s `TEntryTypes` generic.
 */
export type { EntryTypesFromRegistry } from './entry-schema'

/** Generate a Canopy-format 12-character Base58 content ID. */
export { generateId } from './id'

/** Returns true if a string is a valid 12-character Base58 Canopy ID. */
export { isValidId } from './id'

/**
 * Build a hierarchical tree of content nodes from the schema and filesystem.
 *
 * Pass `TEntryTypes` (typically `EntryTypesFromRegistry<typeof entrySchemaRegistry>`)
 * to get narrowed access to `meta.indexEntry.data` after switching on
 * `meta.entryType` in your `extract` callback.
 *
 * Adopters using `canopycms-next` typically call `canopy.buildContentTree(...)`
 * via `getCanopyForBuild()` rather than the bare function.
 */
export { buildContentTree } from './content-tree'

export type {
  ContentTreeNode,
  BuildContentTreeOptions,
  ContentTreeExtractMeta,
  EntryTypeMap,
  DefaultEntryTypes,
} from './content-tree'

/** List all content entries as a flat array. */
export { listEntries } from './content-listing'

export type { ListEntriesItem, ListEntriesOptions } from './content-listing'

/**
 * Resolve a canopy entry-link to its URL. Pair with the field-walker variants
 * (`resolveEntryLinksInText`, `resolveEntryLinksInData`) when rendering MDX
 * bodies or arbitrary frontmatter that may contain link tokens.
 */
export {
  resolveEntryUrl,
  resolveEntryLinksInText,
  resolveEntryLinksInData,
  extractEntryLinkIds,
} from './entry-link-resolver'

export type { EntryLinkUrlResolver } from './entry-link-resolver'

/** Compute the canonical URL for an entry given its logical path + slug. */
export { computeEntryUrl } from './utils/entry-url'

/** Collect static paths for `generateStaticParams` / sitemap emission. */
export { collectStaticPaths } from './static'

export type { StaticPathEntry, CollectStaticPathsOptions } from './static'

/**
 * Start a chokidar-backed watcher that detects divergence between the dev
 * working tree and the resolved branch clone. Dev mode only.
 */
export { startDevContentWatcher } from './dev-content-watcher'

export type { StartDevContentWatcherOptions } from './dev-content-watcher'
