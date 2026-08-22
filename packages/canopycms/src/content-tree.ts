/**
 * Content tree builder for adopters.
 *
 * Walks the schema + filesystem and returns a tree of content nodes that
 * adopters can use for navigation, sitemaps, search indexes, breadcrumbs, etc.
 *
 * Nodes carry Canopy's structural facts (logicalPath, contentId, collection
 * metadata, entry metadata). Display concerns like labels are left to the
 * adopter via the `extract` callback.
 */

import type { FlatSchemaItem, ContentFormat } from './config'

/**
 * Adopter-supplied registry mapping entry type names (as they appear in
 * filenames: `partner.index.yaml` → `'partner'`) to their data shapes.
 *
 * Pair with `TypeFromEntrySchema<typeof yourSchema>` to derive shapes from
 * schemas you've already defined — no redeclaration needed.
 *
 * @example
 * ```ts
 * import { defineEntrySchema, type TypeFromEntrySchema } from 'canopycms'
 *
 * const partnerSchema = defineEntrySchema([
 *   { name: 'name', type: 'string', isTitle: true },
 *   { name: 'tagline', type: 'string' },
 * ])
 * const docSchema = defineEntrySchema([
 *   { name: 'title', type: 'string' },
 * ])
 *
 * interface MyEntries {
 *   partner: TypeFromEntrySchema<typeof partnerSchema>
 *   doc: TypeFromEntrySchema<typeof docSchema>
 * }
 *
 * const canopy = await getCanopyForBuild()
 * await canopy.buildContentTree<NavFields, MyEntries>({
 *   extract: (data, meta) => {
 *     if (meta.kind === 'collection' && meta.indexEntry?.entryType === 'partner') {
 *       // meta.indexEntry.data is narrowed to PartnerContent
 *       return { name: meta.indexEntry.data.name }
 *     }
 *     return { name: '' }
 *   },
 * })
 * ```
 */
export type EntryTypeMap = Record<string, object>

/**
 * Default TEntryTypes when an adopter hasn't supplied one.
 * The index signature preserves the loose shape — `meta.indexEntry.data`
 * stays `Record<string, unknown>`, useful for unstructured access without
 * opting in to the discriminated-union pattern. Exported so callers wrapping
 * `buildContentTree` (e.g. CanopyBuildContext) share the same default.
 */
export type DefaultEntryTypes = { [entryType: string]: Record<string, unknown> }

/** Metadata passed to the extract callback. */
export interface ContentTreeExtractMeta<TEntryTypes = DefaultEntryTypes> {
  kind: 'collection' | 'entry'
  logicalPath: LogicalPath
  /**
   * Entry type name — present when kind is 'entry'.
   * Narrows to a literal union when TEntryTypes is supplied.
   */
  entryType?: keyof TEntryTypes & string
  /** Content format — present when kind is 'entry'. */
  format?: ContentFormat
  /**
   * The entry with slug 'index' inside a collection, when present.
   * Represents the collection's "identity" under the directory-as-page pattern
   * (e.g., a partner's metadata for /data-catalog/<partner>/, a section landing
   * for /docs/<section>/). Only populated when kind === 'collection' AND the
   * collection contains an entry with slug 'index'. Undefined for collections
   * at the maxDepth cap (entries aren't loaded there).
   *
   * When TEntryTypes is supplied, this becomes a discriminated union: narrow
   * on `indexEntry.entryType` and `data` is typed accordingly.
   */
  indexEntry?: {
    [K in keyof TEntryTypes & string]: {
      entryType: K
      format: ContentFormat
      data: TEntryTypes[K]
    }
  }[keyof TEntryTypes & string]
}
import type { LogicalPath, ContentId, Slug } from './paths/types'
import { isIndexSlug } from './utils/entry-url'
import {
  createReferenceResolver,
  listCollectionEntries,
  resolveCollectionItemReferences,
  sortByOrder,
  type CollectionListItem,
  type CollectionSchemaItem,
  type ContentVisibilityOptions,
} from './content-listing'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContentTreeNode<T = unknown> {
  /** URL path, e.g. "/docs/getting-started". Computed by buildPath option. */
  path: string
  /** Logical CMS path */
  logicalPath: LogicalPath
  /** 'collection' or 'entry' */
  kind: 'collection' | 'entry'
  /** Content ID (collections from schema, entries from filename) */
  contentId?: ContentId
  /** Collection metadata — present when kind === 'collection' */
  collection?: {
    name: string
    label?: string
  }
  /** Entry metadata — present when kind === 'entry' */
  entry?: {
    slug: Slug
    entryType: string
    format: ContentFormat
    /** Raw entry data (frontmatter for md/mdx, parsed JSON for json). */
    data: Record<string, unknown>
  }
  /** Adopter-extracted custom fields from the extract callback */
  fields?: T
  /** Children (entries + subcollections interleaved by order array) */
  children?: ContentTreeNode<T>[]
}

export interface BuildContentTreeOptions<T = unknown, TEntryTypes = DefaultEntryTypes> {
  /** Starting collection path. Defaults to content root. */
  rootPath?: string
  /**
   * Extract typed custom fields from each node's raw data.
   * For entries: data is frontmatter + body (md/mdx) or parsed JSON.
   * For collections: data is `{ name, label }` from the schema.
   *
   * Supply TEntryTypes to get narrowed access to `meta.indexEntry.data`
   * via discriminated-union narrowing on `meta.indexEntry.entryType`.
   *
   * Note: extract should be a pure mapping. It may be invoked on entry nodes
   * that `filter` later removes (the tree-walk extracts then filters), so any
   * side effects (logging, counters, populating an external index) will see
   * those rejected nodes too.
   */
  extract?: (data: Record<string, unknown>, meta: ContentTreeExtractMeta<TEntryTypes>) => T
  /**
   * Filter: return false to exclude a node and its descendants.
   * Runs after extract, so `fields` is available. Rejecting a collection
   * short-circuits descendant traversal (no recursion into child collections
   * or entry reads beneath the rejected node).
   */
  filter?: (node: ContentTreeNode<T>) => boolean
  /**
   * Custom URL path builder. Replaces the default entirely — it is not composed
   * with it. To extend rather than replace the default behavior, call the exported
   * `defaultBuildPath(logicalPath, contentRootName, kind)` from inside your
   * function and post-process its result (see `canopycms/server`).
   *
   * Default behavior (`defaultBuildPath`):
   * - Strips the `{contentRootName}/` prefix from `logicalPath`.
   * - For entries: collapses an `index` slug to its parent collection's path
   *   (`content/guides/index` → `/guides`, not `/guides/index`); a collection
   *   literally named `index` is unaffected (only entries collapse).
   * - Lowercases the entire result.
   * - Prepends `/`; the content root's own index collapses to `/`.
   */
  buildPath?: (logicalPath: LogicalPath, kind: 'collection' | 'entry') => string
  /**
   * Custom sort for children at each level.
   * When provided, replaces the default sort (order array → alphabetical).
   * Runs after extract + filter, so `fields` is available.
   */
  sort?: (a: ContentTreeNode<T>, b: ContentTreeNode<T>) => number
  /** Max depth to traverse. Default: unlimited. */
  maxDepth?: number
  /**
   * Resolve `reference` fields to the referenced entry's data, the way
   * `read()`/`readByUrlPath()` do. Applies to both entry nodes and the `meta.indexEntry`
   * handed to a collection's `extract`. Off leaves them as the bare id string, or `null`.
   *
   * Same flag, same default (`false`) and same reasoning as `listEntries`' option — see
   * `ListEntriesOptions.resolveReferences` in content-listing.ts for why the default is
   * opt-in rather than matching `read()`, what it costs, and why path ACLs are not applied
   * to the resolved targets.
   */
  resolveReferences?: boolean
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Group flat schema items by parentPath for O(1) child lookup. */
const groupByParent = (flat: FlatSchemaItem[]): Map<string | undefined, CollectionSchemaItem[]> => {
  const map = new Map<string | undefined, CollectionSchemaItem[]>()
  for (const item of flat) {
    if (item.type !== 'collection') continue
    const key = item.parentPath as string | undefined
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(item)
  }
  return map
}

/**
 * Default path builder: strips the content root prefix, lowercases, and prepends /.
 * All URL paths are lowercased unconditionally for consistency with slug normalization.
 * Adopters with case-sensitive slugs (e.g., "API-Reference") will get lowercased URLs.
 *
 * Index entries (slug 'index', any case) are collapsed to their parent collection path,
 * matching the URL convention used by readByUrlPath and listEntries.
 *
 * Exported (also re-exported from `canopycms/server`) so adopters who want to
 * EXTEND this behavior rather than replace it can call it from inside their own
 * `buildPath` and post-process the result, instead of reimplementing the
 * content-root-strip / index-collapse / lowercase logic verbatim.
 */
export const defaultBuildPath = (
  logicalPath: LogicalPath,
  contentRootName: string,
  kind: 'collection' | 'entry',
): string => {
  const prefix = contentRootName ? `${contentRootName}/` : ''
  const stripped =
    prefix && logicalPath.startsWith(prefix) ? logicalPath.slice(prefix.length) : logicalPath
  // Collapse index entries: content/guides/index → /guides (not /guides/index)
  // Only for entries — a collection named "index" should keep its path.
  //
  // The index test runs on the LAST SEGMENT through the shared `isIndexSlug`, so it is
  // case-insensitive and agrees with `computeEntryUrl`. A string `endsWith('/index')` test
  // did not: for an adopter-supplied `content/docs/Index` this said `/docs/index` while
  // `computeEntryUrl` said `/docs`, and `/docs/index` is the one that does NOT round-trip.
  const lastSlash = stripped.lastIndexOf('/')
  const lastSegment = lastSlash === -1 ? stripped : stripped.slice(lastSlash + 1)
  const collapsed =
    kind === 'entry' && isIndexSlug(lastSegment)
      ? lastSlash === -1
        ? ''
        : stripped.slice(0, lastSlash)
      : stripped
  const urlPath = collapsed ? `/${collapsed}` : '/'
  return urlPath.toLowerCase()
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Build a content tree from a flattened schema and the filesystem.
 *
 * @param branchRoot - Absolute path to the branch workspace root
 * @param flatSchema - Flattened schema items (from flattenSchema)
 * @param contentRootName - The content root name (e.g. "content")
 * @param options - Tree-building options
 * @param visibility - Internal path-ACL predicate; see `ContentVisibilityOptions`
 */
export async function buildContentTree<T = unknown, TEntryTypes = DefaultEntryTypes>(
  branchRoot: string,
  flatSchema: FlatSchemaItem[],
  contentRootName: string,
  options?: BuildContentTreeOptions<T, TEntryTypes>,
  visibility?: ContentVisibilityOptions,
): Promise<ContentTreeNode<T>[]> {
  const childrenByParent = groupByParent(flatSchema)
  const extract = options?.extract
  const filter = options?.filter
  const buildPath =
    options?.buildPath ?? ((lp: LogicalPath, kind) => defaultBuildPath(lp, contentRootName, kind))
  const customSort = options?.sort
  const maxDepth = options?.maxDepth

  /**
   * Every entry read in this tree goes through here, so a denied entry is invisible to
   * BOTH the entry nodes and the `indexEntry` surfaced to a collection's `extract` —
   * the latter would otherwise hand a denied index entry's full `data` to the caller
   * even though no node for it is ever emitted.
   */
  const shouldInclude = visibility?.shouldInclude
  // One store + cache for the whole recursive walk, so a block shared across collections is
  // read once for the entire tree rather than once per collection. Null unless opted in —
  // see the `resolveReferences` option above.
  const resolver = options?.resolveReferences
    ? createReferenceResolver(branchRoot, flatSchema, contentRootName)
    : null
  const listVisibleEntries = async (
    collection: CollectionSchemaItem,
  ): Promise<CollectionListItem[]> => {
    const entries = await listCollectionEntries(branchRoot, collection)
    const visible = shouldInclude ? entries.filter((e) => shouldInclude(e.physicalPath)) : entries
    // Resolved here rather than at the two node-building sites so BOTH inherit it — the same
    // reason the ACL filter lives here. A denied entry is filtered above and never resolved.
    return resolver ? resolveCollectionItemReferences(visible, collection, resolver) : visible
  }

  // Find the starting collection(s)
  const rootPath = options?.rootPath ?? contentRootName
  const rootCollection = flatSchema.find(
    (item) => item.type === 'collection' && item.logicalPath === rootPath,
  ) as CollectionSchemaItem | undefined

  if (!rootCollection) return []

  const buildNode = async (
    collection: CollectionSchemaItem,
    depth: number,
  ): Promise<ContentTreeNode<T> | null> => {
    const collectionData: Record<string, unknown> = {
      name: collection.name,
      label: collection.label,
    }
    const node: ContentTreeNode<T> = {
      path: buildPath(collection.logicalPath, 'collection'),
      logicalPath: collection.logicalPath,
      kind: 'collection',
      contentId: collection.contentId,
      collection: {
        name: collection.name,
        label: collection.label,
      },
    }

    // maxDepth branch: don't load entries (no children would be exposed anyway).
    // Consequence: extract sees no indexEntry on depth-capped collections.
    if (maxDepth !== undefined && depth >= maxDepth) {
      if (extract) {
        node.fields = extract(collectionData, {
          kind: 'collection',
          logicalPath: collection.logicalPath,
        })
      }
      if (filter && !filter(node)) return null
      return node
    }

    // Load this collection's entries first (needed for indexEntry detection).
    // We deliberately do NOT parallelize the child-collection recursion here:
    // if `filter` rejects this collection, returning early short-circuits all
    // descendant I/O — preserving the pre-existing "filter prunes whole subtree"
    // optimization that the directory-as-page reorder would otherwise lose.
    const entries = await listVisibleEntries(collection)

    // Surface the 'index' entry (when present) to extract via meta.
    // 'index' is the same magic slug Canopy uses in defaultBuildPath to collapse
    // /foo/index URLs to /foo/, keeping conventions consistent. If a collection
    // contains multiple slug==='index' entries (only possible via hand-edited or
    // merged content — the write path forbids it), the first by filename order
    // wins.
    // The cast bridges runtime string keys to the parametric discriminated union;
    // the adopter narrows on `indexEntry.entryType` to get the typed `data`.
    const idx = entries.find((e) => e.slug === 'index')
    const indexEntry = (
      idx ? { entryType: idx.entryType, format: idx.format, data: idx.data } : undefined
    ) as ContentTreeExtractMeta<TEntryTypes>['indexEntry']

    if (extract) {
      node.fields = extract(collectionData, {
        kind: 'collection',
        logicalPath: collection.logicalPath,
        indexEntry,
      })
    }
    if (filter && !filter(node)) return null

    // Now recurse into child collections (after filter has had a chance to prune)
    const childCollections = childrenByParent.get(collection.logicalPath) ?? []
    const childCollectionNodes = await Promise.all(
      childCollections.map((child) => buildNode(child, depth + 1)),
    )

    // Build entry nodes
    const entryNodes: ContentTreeNode<T>[] = []
    for (const entry of entries) {
      const entryNode = buildEntryNode<T, TEntryTypes>(entry, buildPath, extract)
      if (filter && !filter(entryNode)) continue
      entryNodes.push(entryNode)
    }

    // Combine and interleave by order array (or custom sort)
    const allChildren = interleaveChildren(
      childCollectionNodes.filter((n): n is ContentTreeNode<T> => n !== null),
      entryNodes,
      collection.order,
      customSort,
    )

    // Prune empty collections (no children after filtering)
    if (allChildren.length === 0) return null

    node.children = allChildren
    return node
  }

  // Start from root's children (don't include the root collection itself)
  const topLevelCollections = childrenByParent.get(rootCollection.logicalPath) ?? []

  // Also get entries directly in the root collection
  const [collectionNodes, rootEntries] = await Promise.all([
    Promise.all(topLevelCollections.map((child) => buildNode(child, 1))),
    listVisibleEntries(rootCollection),
  ])

  const rootEntryNodes: ContentTreeNode<T>[] = []
  for (const entry of rootEntries) {
    const entryNode = buildEntryNode<T, TEntryTypes>(entry, buildPath, extract)
    if (filter && !filter(entryNode)) continue
    rootEntryNodes.push(entryNode)
  }

  return interleaveChildren(
    collectionNodes.filter((n): n is ContentTreeNode<T> => n !== null),
    rootEntryNodes,
    rootCollection.order,
    customSort,
  )
}

/** Build a ContentTreeNode for an entry. */
function buildEntryNode<T, TEntryTypes = DefaultEntryTypes>(
  entry: CollectionListItem,
  buildPath: (lp: LogicalPath, kind: 'collection' | 'entry') => string,
  extract?: BuildContentTreeOptions<T, TEntryTypes>['extract'],
): ContentTreeNode<T> {
  const node: ContentTreeNode<T> = {
    path: buildPath(entry.logicalPath, 'entry'),
    logicalPath: entry.logicalPath,
    kind: 'entry',
    contentId: entry.contentId,
    entry: {
      slug: entry.slug,
      entryType: entry.entryType,
      format: entry.format,
      data: entry.data,
    },
  }
  if (extract) {
    // Runtime gives us the raw string entryType; cast to the parametric key
    // type so callers who supply TEntryTypes get the discriminated-union narrowing.
    node.fields = extract(entry.data, {
      kind: 'entry',
      logicalPath: entry.logicalPath,
      entryType: entry.entryType as keyof TEntryTypes & string,
      format: entry.format,
    })
  }
  return node
}

/**
 * Interleave collection nodes and entry nodes.
 * When a custom sort is provided, it replaces the default order-array sort entirely.
 * Otherwise: items in the order array come first (by position), then the rest alphabetically.
 */
function interleaveChildren<T>(
  collectionNodes: ContentTreeNode<T>[],
  entryNodes: ContentTreeNode<T>[],
  order: readonly string[] | undefined,
  customSort?: (a: ContentTreeNode<T>, b: ContentTreeNode<T>) => number,
): ContentTreeNode<T>[] {
  const all = [...collectionNodes, ...entryNodes]
  if (customSort) {
    return all.sort(customSort)
  }
  return sortByOrder(all, order, (item) =>
    item.kind === 'collection' ? (item.collection?.name ?? '') : (item.entry?.slug ?? ''),
  )
}
