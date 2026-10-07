import type { CollectionItem, ListEntriesResponse } from '../api/entries'
import type { ContentFormat, EntrySchema, FlatSchemaItem } from '../config'
import type { FormValue } from './FormRenderer'
import type { EditorEntry, EditorCollection } from './Editor'
import type { TreeNodeData } from '@mantine/core'
// Import directly from normalize to avoid pulling in server-only branch.ts
import { normalizeFilesystemPath } from '../paths/normalize'
import { computeEntryUrl, isIndexSlug } from '../utils/entry-url'
import { isDataOnlyFormat } from '../utils/format'
import {
  isAbsoluteUrl,
  joinUrlPrefix,
  matchTrailingSlash,
  readTrailingSlashEnv,
  stripTrailingSlashes,
} from '../utils/url-prefix'
export interface PreviewContext {
  branchName?: string
  /** `editor.previewBase`: routes by root entry path, collection path or name; `false` is no page. */
  previewBaseByCollection?: Record<string, string | false>
  /** `editor.previewPrefix`: where the host mounts the pages the preview pane loads. */
  previewPrefix?: string
}

/**
 * The slug a `previewBase` route is extended by, or '' for an index entry: an index entry's URL
 * is its collection's, the collapse `computeEntryUrl` applies, and `resolveUrlPathCandidates`
 * refuses `/x/index`, so a preview built that way 404s.
 */
const encodePreviewSlug = (slug?: string): string => (isIndexSlug(slug) ? '' : encodeSegments(slug))

const encodeSegments = (value?: string): string =>
  (value ?? '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')

type PreviewEntry = {
  collectionPath?: string
  collectionName?: string
  slug?: string
  itemType?: string
  previewSrc?: string
}

/** Splits `url` before its query or fragment, so a path can be extended without entering either. */
const splitPathSuffix = (url: string): [string, string] => {
  const index = url.search(/[?#]/)
  return index === -1 ? [url, ''] : [url.slice(0, index), url.slice(index)]
}

/** Adds `?branch=` to the query, ahead of any fragment. */
const appendBranch = (url: string, branchName?: string): string => {
  if (!branchName) return url
  const hashIndex = url.indexOf('#')
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex)
  const separator = beforeHash.includes('?') ? '&' : '?'
  return `${beforeHash}${separator}branch=${encodeURIComponent(branchName)}${hash}`
}

/**
 * The `previewBase` value under `key`, or `undefined` for none. An empty value counts as none, and
 * so does anything `Object.prototype` supplies.
 */
const previewBaseFor = (
  bases: Record<string, string | false> | undefined,
  key: string | undefined,
): string | false | undefined =>
  bases && key && Object.prototype.hasOwnProperty.call(bases, key) && bases[key] !== ''
    ? bases[key]
    : undefined

/**
 * The entry's route on the host site, or `undefined` when it has no page. The first
 * `previewBaseByCollection` key present decides: for a root entry its own path
 * (`<contentRoot>/<slug>`, used as-is), then its collection path, then its collection name (both
 * with the slug appended). The spelling `<parent>/<name>` names both an entry and a same-named
 * sibling collection (a landing entry beside its folder), so below the root it is read only as a
 * collection key, and at the root one key routes both.
 * A `false` value means no page. With no key, the route is the entry's `urlPath`, by the rule
 * `listEntries` publishes it, so a root entry previews at `/<slug>` and only a root index at `/`.
 * Site-relative unless a matching value is absolute.
 */
const buildPreviewRoute = (
  entry: PreviewEntry,
  { previewBaseByCollection, contentRoot = 'content' }: PreviewContext & { contentRoot?: string },
): string | undefined => {
  const collectionPath = normalizeFilesystemPath(entry.collectionPath ?? '')
  const isRootEntry = collectionPath === normalizeFilesystemPath(contentRoot)
  const entryRoute = previewBaseFor(
    previewBaseByCollection,
    isRootEntry && entry.slug ? `${collectionPath}/${entry.slug}` : undefined,
  )
  if (entryRoute !== undefined) return entryRoute === false ? undefined : entryRoute

  const pathBase = previewBaseFor(previewBaseByCollection, collectionPath)
  const base = pathBase ?? previewBaseFor(previewBaseByCollection, entry.collectionName)
  if (base === false) return undefined
  if (base === undefined) {
    const urlPath = computeEntryUrl(collectionPath, entry.slug ?? '', contentRoot)
    return `/${encodeSegments(urlPath)}`
  }
  const encoded = encodePreviewSlug(entry.slug)
  const [basePathPart, suffix] = splitPathSuffix(base)
  const trimmed = stripTrailingSlashes(basePathPart)
  return `${encoded ? `${trimmed}/${encoded}` : basePathPart || '/'}${suffix}`
}

/**
 * Builds the preview iframe `src` for an entry: its route under `previewPrefix`, under the
 * deployment `basePath` (`CanopyClientConfig.basePath`, e.g. `/preview-123`), in the host's
 * trailing-slash form, with `?branch=`. An absolute prefix skips the `basePath`. An absolute route
 * (from `previewBaseByCollection`) skips all three and gets only `?branch=`. An entry's own
 * `previewSrc` gets only the `basePath`.
 *
 * The result must equal the framed page's own URL: the `<iframe src>` (`PreviewFrame.tsx`)
 * 404s without the prefixes, and a URL the host redirects costs a round trip
 * on every load. `trailingSlash` defaults to the value `withCanopy` inlines at build time.
 *
 * `undefined` means the entry has no page, so the editor frames nothing rather than another page.
 */
export const buildPreviewSrc = (
  entry: PreviewEntry,
  context: PreviewContext & { contentRoot?: string; basePath?: string; trailingSlash?: boolean },
): string | undefined => {
  if (entry.previewSrc) return joinUrlPrefix(context.basePath, entry.previewSrc)
  const route = buildPreviewRoute(entry, context)
  if (route === undefined) return undefined
  // An absolute route is another site's URL, so the host's trailing-slash form says nothing
  // about it.
  if (isAbsoluteUrl(route)) return appendBranch(route, context.branchName)
  const mounted = joinUrlPrefix(context.basePath, joinUrlPrefix(context.previewPrefix, route))
  const shaped = matchTrailingSlash(mounted, context.trailingSlash ?? readTrailingSlashEnv())
  return appendBranch(shaped, context.branchName)
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
  ) => string | undefined
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
