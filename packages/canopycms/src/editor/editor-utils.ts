import type { CollectionItem, ListEntriesResponse } from '../api/entries'
import type { ContentFormat, EntrySchema, FlatSchemaItem } from '../config'
import type { FormValue } from './FormRenderer'
import type { EditorEntry, EditorCollection } from './Editor'
import type { TreeNodeData } from '@mantine/core'
// Import directly from normalize to avoid pulling in server-only branch.ts
import { normalizeCollectionPath } from '../paths/normalize'
import { isIndexSlug } from '../utils/entry-url'
import { isDataOnlyFormat } from '../utils/format'
import { joinUrlPrefix } from '../utils/url-prefix'
export { normalizeCollectionPath }

export interface PreviewContext {
  branchName?: string
  previewBaseByCollection?: Record<string, string>
}

/**
 * The slug portion of a preview URL, or '' for an index entry -- `resolveUrlPathCandidates`
 * refuses `/x/index`, so a preview built that way 404s.
 *
 * An index entry's URL is its COLLECTION's path, the same collapse `computeEntryUrl`,
 * `listEntries`, and `defaultBuildPath` apply.
 *
 * Kept separate from `computeEntryUrl`, which shares only the index decision: this builder
 * must percent-encode each segment and must NOT lowercase, since a preview base is
 * adopter-supplied and case-sensitive.
 */
const encodePreviewSlug = (slug?: string): string => (isIndexSlug(slug) ? '' : encodeSlug(slug))

export const encodeSlug = (value?: string): string =>
  (value ?? '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')

/**
 * Builds the (unprefixed) preview URL -- see `buildPreviewSrc` below, which wraps this with the
 * deployment `basePath`. Split out so that prefixing happens exactly once, at the end, uniformly
 * across every branch (including the `entry.previewSrc` escape hatch).
 */
const buildRawPreviewSrc = (
  entry: {
    collectionPath?: string
    collectionName?: string
    slug?: string
    itemType?: string
    previewSrc?: string
  },
  { branchName, previewBaseByCollection, contentRoot }: PreviewContext & { contentRoot?: string },
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
    const customPreview = previewBaseByCollection?.[`${contentRoot}/${entry.slug}`]
    if (customPreview) {
      return appendBranch(customPreview)
    }
    return appendBranch('/')
  }

  const base =
    (entry.collectionPath && previewBaseByCollection?.[entry.collectionPath]) ??
    (entry.collectionName && previewBaseByCollection?.[entry.collectionName])
  if (!base) {
    // Pass contentRoot through so a non-default (or multi-segment, e.g.
    // "cms/content") configured root is stripped too; normalizeCollectionPath
    // defaults to 'content' when contentRoot is undefined.
    const collectionPath = entry.collectionPath
      ? normalizeCollectionPath(entry.collectionPath, contentRoot)
      : ''
    const encoded = encodePreviewSlug(entry.slug)
    const segments = [collectionPath, encoded].filter(Boolean)
    const url = segments.length > 0 ? `/${segments.join('/')}` : '/'
    return appendBranch(url)
  }
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  const encoded = encodePreviewSlug(entry.slug)
  const url = encoded ? `${trimmed}/${encoded}` : trimmed || '/'
  return appendBranch(url)
}

/**
 * Builds the preview iframe `src` for an entry, prefixed with the deployment `basePath`
 * (`CanopyClientConfig.basePath`, e.g. `/preview-123`) when configured.
 *
 * This matters twice: the raw `<iframe src>` (`PreviewFrame` in preview-bridge.tsx) 404s
 * without the prefix under a basePath, and `resolvePreviewPath` there compares the same
 * string against `window.location.pathname` -- which browsers report WITH the basePath --
 * so an unprefixed `previewSrc` also breaks draft sync / click-to-focus even when the
 * iframe itself resolves.
 *
 * Applied via `joinUrlPrefix`: a no-op when `basePath` is unset, and passes an
 * already-absolute `previewSrc` (a cross-origin override) through untouched.
 */
export const buildPreviewSrc = (
  entry: {
    collectionPath?: string
    collectionName?: string
    slug?: string
    itemType?: string
    previewSrc?: string
  },
  context: PreviewContext & { contentRoot?: string; basePath?: string },
): string => {
  return joinUrlPrefix(context.basePath, buildRawPreviewSrc(entry, context))
}

export const normalizeContentPayload = (raw: unknown): FormValue => {
  const candidate = raw as Record<string, unknown> | undefined
  const data =
    candidate && 'format' in candidate && 'data' in candidate
      ? candidate
      : ((candidate?.data as Record<string, unknown> | undefined) ?? candidate)
  if (data && typeof data === 'object' && 'format' in data && 'data' in data) {
    const format = data.format as ContentFormat
    const payloadData = (data.data as Record<string, unknown>) ?? {}
    if (isDataOnlyFormat(format)) return payloadData
    return {
      ...payloadData,
      body:
        typeof (data as Record<string, unknown>).body === 'string'
          ? (data as Record<string, unknown>).body
          : '',
    }
  }
  return (data as FormValue) ?? {}
}

export const buildWritePayload = (
  entry: { collectionPath?: string; slug?: string; format?: ContentFormat },
  value: FormValue,
) => {
  if (!entry.format) return value
  if (isDataOnlyFormat(entry.format)) {
    return {
      format: entry.format,
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
  resolvePreviewSrc: (
    entry: Pick<CollectionItem, 'collectionPath' | 'collectionName' | 'slug' | 'entryType'>,
  ) => string
  flatSchema: FlatSchemaItem[]
}

export const buildEntriesFromListResponse = ({
  response,
  resolvePreviewSrc,
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
          item.name === entry.entryType,
      )
      if (entryTypeItem && entryTypeItem.type === 'entry-type') {
        schema = entryTypeItem.schema
      }
    }

    return {
      path: entry.logicalPath,
      contentId: entry.contentId,
      label: entry.title || entry.slug || entry.collectionName || entry.collectionPath,
      status: entry.exists === false ? 'missing' : (entry.entryType ?? 'entry'),
      schema: schema,
      previewSrc: resolvePreviewSrc(entry),
      collectionPath: entry.collectionPath,
      collectionName: entry.collectionName,
      slug: entry.slug,
      format: entry.format,
      entryType: entry.entryType,
      type: 'entry' as const,
      canEdit: entry.canEdit,
    }
  })
}

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
 */
export const buildBreadcrumbSegments = (
  currentEntry: EditorEntry | undefined,
  collectionLabels: Map<string, string>,
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
 */
export const calculatePathToEntry = (
  entryPath: string | undefined,
  treeData: TreeNodeData[],
): Record<string, boolean> => {
  if (!entryPath) return {}

  const pathToExpand: Record<string, boolean> = {}

  const findAndMarkPath = (nodes: TreeNodeData[], ancestors: string[]): boolean => {
    for (const node of nodes) {
      if (node.value === entryPath) {
        for (const ancestor of ancestors) {
          pathToExpand[ancestor] = true
        }
        return true
      }

      if (node.children && node.children.length > 0) {
        const currentPath = [...ancestors, node.value]
        const found = findAndMarkPath(node.children, currentPath)

        if (found) {
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
