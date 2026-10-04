// Public server-side API for adopters. Every named re-export carries its own JSDoc, because
// TypeScript's propagation through `export { X } from './module'` is inconsistent across LSP
// versions and module-resolution modes and adopters would otherwise get no hover text. Follow the
// pattern for new top-level public re-exports (see DEVELOPING.md).

export * from './content-reader'
export * from './services'
export * from './build-mode'
export * from './context'
export { operatingStrategy } from './operating-mode'
export * from './authorization/groups'

/**
 * One-call factory for a **build/admin** Canopy context, for standalone scripts outside a
 * Next.js request or build phase. Reads the filesystem as a synthetic admin user and bypasses
 * ALL branch/path ACLs — never use it in request-handling code. Full security note in the
 * source JSDoc.
 */
export { createBuildCanopy, type CreateBuildCanopyOptions } from './build-canopy'

/**
 * Resolve a CanopyUser for a request: loads internal groups from the settings workspace (the
 * single source of truth — never a content branch clone) and merges them into an auth-plugin
 * result via `authResultToCanopyUser`. Shared by the core HTTP handler and the Next.js SSR
 * wrapper so the "authenticate -> load groups -> merge" pipeline cannot drift between them.
 */
export { resolveCanopyUser, type ResolveCanopyUserDeps } from './resolve-canopy-user'
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
 * Create a type-safe entry schema registry with runtime validation. Keys are the strings
 * `.collection.json` files reference via `entry.schema`; key them by entry-type name so
 * `EntryTypesFromRegistry<typeof yourRegistry>` derives `buildContentTree`'s `TEntryTypes` map.
 * Source JSDoc has the example and the full validation list.
 */
export { createEntrySchemaRegistry } from './entry-schema-registry'

/**
 * Validate that entry-schema references in `.collection.json` files exist in the registry —
 * at build time, so a stale reference fails there rather than at request time.
 */
export { validateEntrySchemaRegistry } from './entry-schema-registry'

/**
 * Derive a discriminated-union entry-type map from a registry value: pass
 * `typeof entrySchemaRegistry`. The registry must be keyed by entry-type name for the result
 * to plug straight into `buildContentTree`'s `TEntryTypes` generic.
 */
export type { EntryTypesFromRegistry } from './entry-schema'

/**
 * Resolve an entry's display title through the full fallback chain: a schema-marked `isTitle`
 * field, then `data.title`/`data.name`, then an entry-type label, then a humanized slug, then
 * `"Untitled"`. Search-document and index builders in particular need a title for every result
 * regardless of which field the schema uses.
 *
 * Client-safe (its only imports are types, erased at compile time), so it is exported from the
 * root `canopycms` entry as well as here, where build/admin scripts look for it.
 */
export { resolveEntryTitle } from './utils/title-field'

/** Generate a Canopy-format 12-character Base58 content ID. */
export { generateId } from './id'

/** Returns true if a string is a valid 12-character Base58 Canopy ID. */
export { isValidId } from './id'

/**
 * Build a hierarchical tree of content nodes from the schema and filesystem. Pass `TEntryTypes`
 * (typically `EntryTypesFromRegistry<typeof entrySchemaRegistry>`) for narrowed access to
 * `meta.indexEntry.data` after switching on `meta.entryType` in an `extract` callback.
 * `canopycms-next` adopters usually call `canopy.buildContentTree(...)` via
 * `getCanopyForBuild()` instead of the bare function.
 */
export { buildContentTree } from './content-tree'

export type {
  ContentTreeNode,
  BuildContentTreeOptions,
  ContentTreeExtractMeta,
  EntryTypeMap,
  DefaultEntryTypes,
} from './content-tree'

/**
 * `buildContentTree`'s default URL path builder: strips the `{contentRootName}/` prefix,
 * collapses an entry's `index` slug to its parent collection's path, and lowercases the result.
 * Call it from inside a custom `buildPath` rather than reimplementing it — the `buildPath`
 * option REPLACES the default outright, it does not compose with it.
 */
export { defaultBuildPath } from './content-tree'

/** List all content entries as a flat array. */
export { listEntries } from './content-listing'

export type { ListEntriesItem, ListEntriesOptions } from './content-listing'

/**
 * Parse a content filename `{type}.{slug}.{id}.{ext}` into `{ type, slug, id }`. `id` must be a
 * valid 12-character Base58 content ID (no ambiguous `0`, `O`, `I`, `l`) or the parse fails.
 * Pass `entryTypes` to also require `type` to match a known entry-type name. Full grammar in
 * the source JSDoc.
 */
export { parseTypedFilename } from './content-listing'

/**
 * Resolve a canopy entry-link to its URL. Pair with the field-walker variants
 * (`resolveEntryLinksInText`, `resolveEntryLinksInData`) when rendering MDX bodies or
 * frontmatter that may contain link tokens.
 */
export {
  resolveEntryUrl,
  resolveEntryLinksInText,
  resolveEntryLinksInData,
  extractEntryLinkIds,
} from './entry-link-resolver'

export type { EntryLinkUrlResolver } from './entry-link-resolver'

/**
 * The canonical URL for an entry from its logical path + slug, plus the shared "is this the
 * collection-index slug?" predicate that decides whether it collapses.
 */
export { computeEntryUrl, isIndexSlug } from './utils/entry-url'

/** Collect static paths for `generateStaticParams` / sitemap emission. */
export { collectStaticPaths } from './static'

export type { StaticPathEntry, CollectStaticPathsOptions } from './static'

/** Enumerate routable entries WITH their data — the input to sitemaps, feeds and search indexes. */
export { collectRoutableEntries } from './static'

export type { RoutableEntry, CollectRoutableEntriesOptions } from './static'

/**
 * Find every URL claimed by more than one entry — the check a production build already runs
 * and fails on. Exported so a content-integrity test can assert it directly instead of
 * hand-rolling the same scan over `listEntries`.
 */
export { findDuplicateUrlPaths } from './static'

export type { DuplicateUrlPath } from './static'

/**
 * SEO field extraction and URL shaping, framework-agnostic. `isNoindexEntry` is the single
 * predicate behind both `robots: noindex` and sitemap exclusion.
 */
export {
  DEFAULT_SEO_FIELD_NAMES,
  extractSeoFields,
  isNoindexEntry,
  isAbsoluteUrl,
  withTrailingSlash,
  resolveSeoUrl,
  stripTrailingSlashes,
} from './static'

export type {
  SeoFields,
  SeoFieldNames,
  SeoFieldLocation,
  SeoOgType,
  SeoTwitterCard,
  ExtractSeoFieldsOptions,
  ResolveSeoUrlOptions,
} from './static'

/**
 * Start a chokidar-backed watcher for divergence between the dev working tree and the resolved
 * branch clone. Dev mode only.
 */
export { startDevContentWatcher } from './dev-content-watcher'

export type { StartDevContentWatcherOptions } from './dev-content-watcher'

/**
 * Instantiate the AssetStore configured by a site's `config.media`. Returns undefined when no
 * store applies: `media` unset with no `devAssetsDir` fallback, `adapter: 'local'` without
 * `directory` and no fallback, or `adapter: 'lfs'` (config literal kept, not yet implemented).
 */
export { createAssetStore } from './assets/factory'

/**
 * The five S3/local bucket-prefix strings (`asset-originals/`, `asset-staging/`, `asset-meta/`,
 * `assets/`, `assets/t/`). Exported so server-only consumers outside this package — notably the
 * prod transform Lambda (`packages/canopycms-cdk/lambda/asset-transform`) — build and parse
 * asset keys through the same constants `S3AssetStore` uses rather than duplicating the strings.
 */
export { ASSET_PREFIXES, type AssetPrefixes } from './assets/keys'

/** Asset metadata sidecar shape (`asset-meta/{hash32}.json`), written by the finalize pipeline and read by the transform layer (dev-mode emulation and the prod transform Lambda). */
export type { AssetMeta } from './assets/types'

/**
 * Parse the three path segments after `assets/t/` (`{directives}/{hash32}/{slug}.{ext}`) into a
 * validated `TransformDirectives` set, or a structured parse error. Reused unchanged by the
 * dev-mode lazy `/assets/t/*` emulation (`api/assets.ts`) and the prod transform Lambda, so the
 * URL grammar is defined in exactly one place.
 */
export { parseTransformPath } from './assets/transform-directives'

export type { ParsedTransformPath, ParseTransformPathResult } from './assets/transform-directives'

/**
 * Canonical string form of a `TransformDirectives` set — the cache key every transform output is
 * stored under (`assets/t/{formatDirectives(...)}/{hash32}/{slug}.{ext}`). Equivalent directive
 * sets (different key order or float formatting) always format to the same string. Reused by the
 * prod transform Lambda so its writes agree with the dev-mode emulation and `assetUrl()`.
 */
export { formatDirectives } from './assets/transform-directives'

/**
 * Apply a parsed `TransformDirectives` set to source image bytes with sharp:
 * resize/format/quality/crop, EXIF stripped on every re-encode, identity included. Server-only
 * (sharp); reused unchanged by the dev-mode lazy `/assets/t/*` emulation and the prod transform
 * Lambda.
 */
export { applyTransform } from './assets/transform'

export type { ApplyTransformInput, TransformResult } from './assets/transform'
