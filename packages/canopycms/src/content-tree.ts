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
import type { LogicalPath, ContentId, EntrySlug } from './paths/types'
import { listCollectionEntries, sortByOrder, type CollectionListItem } from './content-listing'

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
    slug: EntrySlug
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

export interface BuildContentTreeOptions<T = unknown> {
  /** Starting collection path. Defaults to content root. */
  rootPath?: string
  /**
   * Extract typed custom fields from each node's raw data.
   * For entries: data is frontmatter (md/mdx) or parsed JSON.
   * For collections: data is `{ name, label }` from the schema.
   */
  extract?: (
    data: Record<string, unknown>,
    node: { kind: 'collection' | 'entry'; logicalPath: LogicalPath },
  ) => T
  /**
   * Filter: return false to exclude a node and its descendants.
   * Runs after extract, so `fields` is available.
   */
  filter?: (node: ContentTreeNode<T>) => boolean
  /** Custom URL path builder. Default: strips content root prefix, joins with /. */
  buildPath?: (logicalPath: LogicalPath, kind: 'collection' | 'entry') => string
  /**
   * Custom sort for children at each level.
   * When provided, replaces the default sort (order array → alphabetical).
   * Runs after extract + filter, so `fields` is available.
   */
  sort?: (a: ContentTreeNode<T>, b: ContentTreeNode<T>) => number
  /** Max depth to traverse. Default: unlimited. */
  maxDepth?: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type CollectionSchemaItem = Extract<FlatSchemaItem, { type: 'collection' }>

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

/** Default path builder: strips the content root prefix and prepends /. */
const defaultBuildPath = (logicalPath: LogicalPath, contentRootName: string): string => {
  const prefix = contentRootName ? `${contentRootName}/` : ''
  const stripped =
    prefix && logicalPath.startsWith(prefix) ? logicalPath.slice(prefix.length) : logicalPath
  return stripped ? `/${stripped}` : '/'
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
 */
export async function buildContentTree<T = unknown>(
  branchRoot: string,
  flatSchema: FlatSchemaItem[],
  contentRootName: string,
  options?: BuildContentTreeOptions<T>,
): Promise<ContentTreeNode<T>[]> {
  const childrenByParent = groupByParent(flatSchema)
  const extract = options?.extract
  const filter = options?.filter
  const buildPath =
    options?.buildPath ?? ((lp: LogicalPath) => defaultBuildPath(lp, contentRootName))
  const customSort = options?.sort
  const maxDepth = options?.maxDepth

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
    // Build collection node (before children, so filter can reject early)
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
    if (extract) {
      node.fields = extract(collectionData, {
        kind: 'collection',
        logicalPath: collection.logicalPath,
      })
    }
    if (filter && !filter(node)) return null

    // If at max depth, return collection without children
    if (maxDepth !== undefined && depth >= maxDepth) return node

    // Gather child collections and entries in parallel
    const childCollections = childrenByParent.get(collection.logicalPath) ?? []
    const [childCollectionNodes, entries] = await Promise.all([
      Promise.all(childCollections.map((child) => buildNode(child, depth + 1))),
      listCollectionEntries(branchRoot, collection),
    ])

    // Build entry nodes
    const entryNodes: ContentTreeNode<T>[] = []
    for (const entry of entries) {
      const entryNode = buildEntryNode(entry, buildPath, extract)
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
    listCollectionEntries(branchRoot, rootCollection),
  ])

  const rootEntryNodes: ContentTreeNode<T>[] = []
  for (const entry of rootEntries) {
    const entryNode = buildEntryNode(entry, buildPath, extract)
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
function buildEntryNode<T>(
  entry: CollectionListItem,
  buildPath: (lp: LogicalPath, kind: 'collection' | 'entry') => string,
  extract?: BuildContentTreeOptions<T>['extract'],
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
    node.fields = extract(entry.data, {
      kind: 'entry',
      logicalPath: entry.logicalPath,
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
