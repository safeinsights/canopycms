import type { CollectionItem, ListEntriesResponse } from '../api/entries'
import type { ContentFormat, FieldConfig } from '../config'
import type { FormValue } from './FormRenderer'
import type { EditorEntry, EditorCollection } from './Editor'

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
  entry: {
    collectionId?: string
    collectionName?: string
    slug?: string
    itemType?: string
    previewSrc?: string
  },
  { branchName, previewBaseByCollection }: PreviewContext,
): string => {
  if (entry.previewSrc) return entry.previewSrc
  const appendBranch = (url: string) => {
    if (!branchName) return url
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}branch=${encodeURIComponent(branchName)}`
  }
  const base =
    (entry.collectionId && previewBaseByCollection?.[entry.collectionId]) ??
    (entry.collectionName && previewBaseByCollection?.[entry.collectionName])
  if (!base) {
    if (entry.itemType === 'singleton') return '/'
    const encoded = encodeSlug(entry.slug)
    const url = encoded ? `/${encoded}` : '/'
    return appendBranch(url)
  }
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  if (entry.itemType === 'singleton') return appendBranch(trimmed || '/')
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

export const buildWritePayload = (
  entry: { collectionId?: string; slug?: string; format?: ContentFormat },
  value: FormValue,
) => {
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
  resolvePreviewSrc: (
    entry: Pick<CollectionItem, 'collectionId' | 'collectionName' | 'slug' | 'itemType'>,
  ) => string
  existingEntries: EditorEntry[]
  initialEntries: EditorEntry[]
  currentEntry?: EditorEntry
}

export const buildEntriesFromListResponse = ({
  response,
  branchName,
  resolvePreviewSrc,
  existingEntries,
  currentEntry,
  initialEntries,
}: BuildEntriesFromListParams): EditorEntry[] => {
  const schemaByCollection = new Map<string, readonly FieldConfig[]>()
  const collectSchemas = (nodes: ListEntriesResponse['collections']) => {
    nodes.forEach((node) => {
      schemaByCollection.set(node.id, node.schema)
      if (node.children) collectSchemas(node.children)
    })
  }
  collectSchemas(response.collections)
  return response.entries.map((entry) => {
    const schema =
      schemaByCollection.get(entry.collectionId) ??
      existingEntries.find((e) => e.collectionId === entry.collectionId)?.schema ??
      currentEntry?.schema ??
      initialEntries.find((e) => e.collectionId === entry.collectionId)?.schema ??
      []
    return {
      id: entry.id,
      label: entry.title || entry.slug || entry.collectionName || entry.collectionId,
      status: entry.exists === false ? 'missing' : (entry.itemType ?? 'entry'),
      schema,
      apiPath:
        entry.itemType === 'singleton'
          ? `/api/canopycms/${branchName}/content/${encodeURIComponent(entry.collectionId)}`
          : `/api/canopycms/${branchName}/content/${encodeURIComponent(entry.collectionId)}/${encodeURIComponent(entry.slug)}`,
      previewSrc: resolvePreviewSrc(entry),
      collectionId: entry.collectionId,
      collectionName: entry.collectionName,
      slug: entry.itemType === 'singleton' ? '' : entry.slug,
      format: entry.format,
      type: entry.itemType,
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
      map.set(c.id, c.label ?? c.name)
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
 * const entry = { collectionId: 'content/docs/guides', slug: 'config' }
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
  collectionLabels: Map<string, string>,
): string[] => {
  if (!currentEntry) return ['All Files']
  const segments = ['All Files']

  // Show collection hierarchy for entries and singletons that belong to a collection
  if (currentEntry.collectionId) {
    // Split the collectionId into path parts and build cumulative paths
    // e.g., "content/documentation/guides" -> ["content/documentation", "content/documentation/guides"]
    const parts = currentEntry.collectionId.split('/').filter(Boolean)
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
