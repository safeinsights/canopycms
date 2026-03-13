import type { CollectionItem, ListEntriesResponse } from '../api/entries'
import type { ContentFormat, EntrySchema, FlatSchemaItem } from '../config'
import type { FormValue } from './FormRenderer'
import type { EditorEntry, EditorCollection } from './Editor'
import type { TreeNodeData } from '@mantine/core'
// Import directly from normalize to avoid pulling in server-only branch.ts
import { normalizeCollectionPath } from '../paths/normalize'
export { normalizeCollectionPath }

export interface PreviewContext {
  branchName?: string
  previewBaseByCollection?: Record<string, string>
}

export const encodeSlug = (value?: string): string =>
  (value ?? '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')


export const buildPreviewSrc = (
  entry: { collectionPath?: string; collectionName?: string; slug?: string; itemType?: string; previewSrc?: string },
  { branchName, previewBaseByCollection, contentRoot }: PreviewContext & { contentRoot?: string }
): string => {
  if (entry.previewSrc) return entry.previewSrc
  const appendBranch = (url: string) => {
    if (!branchName) return url
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}branch=${encodeURIComponent(branchName)}`
  }

  // Root-level entries have collectionPath === contentRoot (e.g., 'content')
  const isRootEntry = contentRoot && entry.collectionPath === contentRoot

  if (isRootEntry) {
    // Check for custom preview URL in previewBaseByCollection
    const customPreview = previewBaseByCollection?.[`${contentRoot}/${entry.slug}`]
    if (customPreview) {
      return appendBranch(customPreview)
    }
    // Default root entries to root path
    return appendBranch('/')
  }

  const base =
    (entry.collectionPath && previewBaseByCollection?.[entry.collectionPath]) ??
    (entry.collectionName && previewBaseByCollection?.[entry.collectionName])
  if (!base) {
    // Build URL from collection path + slug
    const collectionPath = entry.collectionPath ? normalizeCollectionPath(entry.collectionPath) : ''
    const encoded = encodeSlug(entry.slug)
    const segments = [collectionPath, encoded].filter(Boolean)
    const url = segments.length > 0 ? `/${segments.join('/')}` : '/'
    return appendBranch(url)
  }
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  const encoded = encodeSlug(entry.slug)
  const url = encoded ? `${trimmed}/${encoded}` : trimmed || '/'
  return appendBranch(url)
}

export const normalizeContentPayload = (raw: unknown): FormValue => {
  const candidate = raw as Record<string, unknown> | undefined
  const data = (candidate?.data as Record<string, unknown> | undefined) ?? candidate
  if (data && typeof data === 'object' && 'format' in data && 'data' in data) {
    const format = data.format as ContentFormat
    const payloadData = (data.data as Record<string, unknown>) ?? {}
    if (format === 'json') return payloadData
    return {
      ...payloadData,
      body: typeof (data as any).body === 'string' ? (data as any).body : '',
    }
  }
  return (data as FormValue) ?? {}
}

export const buildWritePayload = (entry: { collectionPath?: string; slug?: string; format?: ContentFormat }, value: FormValue) => {
  if (!entry.format) return value
  if (entry.format === 'json') {
    return {
      format: 'json' as const,
      data: value,
    }
  }
  const { body, ...rest } = value
  return {
    format: entry.format,
    data: rest,
    body: typeof body === 'string' ? body : '',
  }
}

interface BuildEntriesFromListParams {
  response: ListEntriesResponse
  branchName: string
  resolvePreviewSrc: (entry: Pick<CollectionItem, 'collectionPath' | 'collectionName' | 'slug' | 'entryType'>) => string
  contentRoot: string
  flatSchema: FlatSchemaItem[]
}

export const buildEntriesFromListResponse = ({
  response,
  branchName,
  resolvePreviewSrc,
  contentRoot,
  flatSchema,
}: BuildEntriesFromListParams): EditorEntry[] => {
  return response.entries.map((entry) => {
    // Resolve schema from flatSchema using parentPath + name
    let schema: EntrySchema = []
    if (entry.collectionPath && entry.entryType) {
      const entryTypeItem = flatSchema.find(
        (item) =>
          item.type === 'entry-type' &&
          item.parentPath === entry.collectionPath &&
          item.name === entry.entryType
      )
      if (entryTypeItem && entryTypeItem.type === 'entry-type') {
        schema = entryTypeItem.fields
      }
    }

    const isRootEntry = entry.collectionPath === contentRoot
    const apiPath = isRootEntry
      ? `/api/canopycms/${branchName}/content/${encodeURIComponent(entry.slug)}`
      : `/api/canopycms/${branchName}/content/${encodeURIComponent(entry.collectionPath)}/${encodeURIComponent(entry.slug)}`

    return {
      path: entry.logicalPath,
      contentId: entry.contentId,
      label: entry.title || entry.slug || entry.collectionName || entry.collectionPath,
      status: entry.exists === false ? 'missing' : entry.entryType ?? 'entry',
      fields: schema,
      apiPath,
      previewSrc: resolvePreviewSrc(entry),
      collectionPath: entry.collectionPath,
      collectionName: entry.collectionName,
      slug: entry.slug,
      format: entry.format,
      type: 'entry' as const,
      canEdit: entry.canEdit,
    }
  })
}

/**
 * Builds a map of collection IDs to their labels for breadcrumb display.
 * Recursively walks through nested collections to build a flat map.
 *
 * @param collections - The collection tree structure
 * @returns A Map where keys are collection IDs (paths) and values are labels
 */
export const buildCollectionLabels = (collections?: EditorCollection[]): Map<string, string> => {
  const map = new Map<string, string>()
  if (!collections) return map

  const walk = (nodes: EditorCollection[]) => {
    for (const c of nodes) {
      map.set(c.path, c.label ?? c.name)
      if (c.children) {
        walk(c.children)
      }
    }
  }
  walk(collections)
  return map
}

/**
 * Builds breadcrumb segments for an entry based on its collection hierarchy.
 *
 * @param currentEntry - The entry to build breadcrumbs for (or undefined for root)
 * @param collectionLabels - Map of collection IDs to labels
 * @returns Array of breadcrumb segment strings, starting with 'All Files'
 *
 * @example
 * ```ts
 * // Entry in nested collection
 * const entry = { collectionPath: 'content/docs/guides', slug: 'config' }
 * const labels = new Map([
 *   ['content', 'Content'],
 *   ['content/docs', 'Documentation'],
 *   ['content/docs/guides', 'Guides']
 * ])
 * buildBreadcrumbSegments(entry, labels)
 * // Returns: ['All Files', 'Documentation', 'Guides']
 * ```
 */
export const buildBreadcrumbSegments = (
  currentEntry: EditorEntry | undefined,
  collectionLabels: Map<string, string>
): string[] => {
  if (!currentEntry) return ['All Files']
  const segments = ['All Files']

  // Show collection hierarchy for entries that belong to a collection
  if (currentEntry.collectionPath) {
    // Split the collectionPath into path parts and build cumulative paths
    // e.g., "content/documentation/guides" -> ["content/documentation", "content/documentation/guides"]
    const parts = currentEntry.collectionPath.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) {
      const pathUpToHere = parts.slice(0, i + 1).join('/')
      const label = collectionLabels.get(pathUpToHere)
      if (label) {
        segments.push(label)
      }
    }
  }

  // Add slug path segments (for nested slugs like "folder/file")
  const slugSegments = (currentEntry.slug ?? '').split('/').filter(Boolean)
  if (slugSegments.length > 1) {
    segments.push(...slugSegments.slice(0, -1))
  }

  return segments
}

/**
 * Calculates which collection nodes need to be expanded to show the path to a specific entry.
 * Recursively walks the tree to find the target entry and marks all ancestor collections as expanded.
 *
 * @param entryPath - The entry path to find (e.g., "blog/my-post")
 * @param treeData - The tree data structure from Mantine Tree
 * @returns Record<string, boolean> - Expanded state object where keys are collection node values
 *
 * @example
 * ```ts
 * const treeData = [
 *   {
 *     value: 'collection:blog',
 *     children: [
 *       { value: 'blog/post-1' },
 *       {
 *         value: 'collection:blog/featured',
 *         children: [{ value: 'blog/featured/my-post' }]
 *       }
 *     ]
 *   }
 * ]
 * calculatePathToEntry('blog/featured/my-post', treeData)
 * // Returns: { 'collection:blog': true, 'collection:blog/featured': true }
 * ```
 */
export const calculatePathToEntry = (
  entryPath: string | undefined,
  treeData: TreeNodeData[]
): Record<string, boolean> => {
  if (!entryPath) return {}

  const pathToExpand: Record<string, boolean> = {}

  /**
   * Recursive function to find entry and mark parent collections as expanded.
   * @param nodes - Current level of tree nodes to search
   * @param ancestors - Accumulated ancestor node values (collection IDs) from root to current position
   * @returns true if the target entry was found in this subtree
   */
  const findAndMarkPath = (nodes: TreeNodeData[], ancestors: string[]): boolean => {
    for (const node of nodes) {
      // Found the target entry
      if (node.value === entryPath) {
        // Mark all ancestors as expanded
        for (const ancestor of ancestors) {
          pathToExpand[ancestor] = true
        }
        return true
      }

      // Search children recursively if they exist
      if (node.children && node.children.length > 0) {
        const currentPath = [...ancestors, node.value]
        const found = findAndMarkPath(node.children, currentPath)

        if (found) {
          // Mark this node as expanded since the target was found in its subtree
          pathToExpand[node.value] = true
          return true
        }
      }
    }

    return false
  }

  findAndMarkPath(treeData, [])
  return pathToExpand
}
