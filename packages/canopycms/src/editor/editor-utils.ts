import type { CollectionItem, ListEntriesResponse } from '../api/entries'
import type {
  ContentFormat,
  EntrySchema,
  EntryTypeUnavailable,
  FieldConfig,
  FlatSchemaItem,
  InlineGroupFieldConfig,
} from '../config'
import type { FormValue } from './FormRenderer'
import type { EditorEntry, EditorCollection, EditorEntryType } from './Editor'
import type { TreeNodeData } from '@mantine/core'
// Import directly from normalize to avoid pulling in server-only branch.ts
import { normalizeFilesystemPath } from '../paths/normalize'
import { humanizeName, schemaLabel } from './schema-label'
import { computeEntryUrl, isIndexSlug } from '../utils/entry-url'
import { titleFieldPath } from '../utils/title-field'
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
export const buildPreviewRoute = (
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

/** Whether a `buildPreviewRoute` route is the site's root page: `/`, with any query or fragment. */
const isHomeRoute = (route: string | undefined): boolean =>
  route !== undefined &&
  !isAbsoluteUrl(route) &&
  stripTrailingSlashes(splitPathSuffix(route)[0]) === ''

/**
 * The entry the editor opens when none is asked for: the one whose route is `/`, else the first
 * with a preview, else the first. `routeFor` gives the route before any prefix or base path
 * (`buildPreviewRoute`), so `previewPrefix` and `basePath` never hide the root page.
 */
export const resolveHomeEntry = <T extends { previewSrc?: string }>(
  entries: readonly T[],
  routeFor?: (entry: T) => string | undefined,
): T | undefined =>
  (routeFor && entries.find((entry) => isHomeRoute(routeFor(entry)))) ||
  entries.find((entry) => entry.previewSrc) ||
  entries[0]

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

/**
 * The label an entry of this type goes by when the type allows only one entry (`maxItems: 1`):
 * the type's own, as "Site settings" names the site's one settings entry. Undefined for any other
 * type, and for an unlabelled one, whose entry keeps its title.
 */
const singletonLabel = (type: { label?: string; maxItems?: number }): string | undefined =>
  type.maxItems === 1 && type.label ? type.label : undefined

export const buildEntriesFromListResponse = ({
  response,
  resolvePreviewSrc,
  flatSchema,
}: BuildEntriesFromListParams): EditorEntry[] => {
  return response.entries.map((entry) => {
    // Resolve schema from flatSchema using parentPath + name
    let schema: EntrySchema = []
    let unavailable: EntryTypeUnavailable | undefined
    let typeName: string | undefined
    if (entry.collectionPath && entry.entryType) {
      const entryTypeItem = flatSchema.find(
        (item) =>
          item.type === 'entry-type' &&
          item.parentPath === entry.collectionPath &&
          item.name === entry.entryType,
      )
      if (entryTypeItem && entryTypeItem.type === 'entry-type') {
        schema = entryTypeItem.schema
        unavailable = entryTypeItem.unavailable
        typeName = singletonLabel(entryTypeItem)
      }
    }

    return {
      path: entry.logicalPath,
      contentId: entry.contentId,
      label: typeName || entry.title || entry.slug || entry.collectionName || entry.collectionPath,
      ...(entry.title && { title: entry.title }),
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
      ...(unavailable && { unavailable }),
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

const findEntryType = (
  collections: EditorCollection[] | undefined,
  entry: Pick<EditorEntry, 'collectionPath' | 'entryType'>,
): EditorEntryType | undefined => {
  const find = (nodes: EditorCollection[]): EditorCollection | undefined => {
    for (const c of nodes) {
      if (c.path === entry.collectionPath) return c
      const inner = c.children ? find(c.children) : undefined
      if (inner) return inner
    }
    return undefined
  }
  const collection = collections ? find(collections) : undefined
  return collection?.entryTypes?.find((t) => t.name === entry.entryType)
}

/**
 * An entry's type as its collection labels it, else its name read as words; undefined when
 * untyped.
 */
export const entryTypeLabel = (
  collections: EditorCollection[] | undefined,
  entry: Pick<EditorEntry, 'collectionPath' | 'entryType'>,
): string | undefined => {
  if (!entry.entryType) return undefined
  return findEntryType(collections, entry)?.label ?? humanizeName(entry.entryType)
}

/**
 * The type shown under an entry's label in the content tree: `entryTypeLabel`, except for a
 * singleton, whose label already is its type's (`singletonLabel`). @internal Exported for tests.
 */
export const entryTypeLine = (
  collections: EditorCollection[] | undefined,
  entry: Pick<EditorEntry, 'collectionPath' | 'entryType'>,
): string | undefined => {
  const type = findEntryType(collections, entry)
  return type && singletonLabel(type) ? undefined : entryTypeLabel(collections, entry)
}

/**
 * An entry's second line in the content tree: "Missing" when its file is gone, else its
 * `entryTypeLine`, else its status read as words.
 */
export const entryStatusLabel = (
  collections: EditorCollection[] | undefined,
  entry: Pick<EditorEntry, 'status' | 'collectionPath' | 'entryType'>,
): string | undefined => {
  if (entry.status === 'missing') return 'Missing'
  if (entry.entryType) return entryTypeLine(collections, entry)
  return entry.status && humanizeName(entry.status)
}

/**
 * Where an entry's name comes from, which "Change URL" explains. The title chain is the server's
 * (`resolveEntryTitle`): a non-empty title-field value, else a non-empty string `title` or `name`
 * value whatever its field's type, else the type's label, else the slug. A labelled singleton is
 * named by its type whatever its title. `fieldLabel` is absent when no field of that name is in the
 * schema.
 */
export type EntryNameSource =
  | { from: 'type' }
  | { from: 'title'; fieldLabel?: string }
  | { from: 'slug' }

/**
 * `data` is the entry's value where it is at hand; without it, a schema with a title field, or a
 * `title` or `name` field, is taken to name the entry from it.
 */
export const entryNameSource = (
  collections: EditorCollection[] | undefined,
  entry: Pick<EditorEntry, 'collectionPath' | 'entryType' | 'schema'>,
  data?: Record<string, unknown>,
): EntryNameSource => {
  const type = findEntryType(collections, entry)
  if (type && singletonLabel(type)) return { from: 'type' }
  const titlePath = titleFieldPath(entry.schema)
  if (data) {
    const plain = data.title ?? data.name
    const plainName = isNonEmptyString(plain) ? (data.title != null ? 'title' : 'name') : undefined
    if (titlePath && isNonEmptyString(valueAt(data, titlePath))) {
      return { from: 'title', fieldLabel: pathLabel(entry.schema, titlePath) }
    }
    if (plainName) return { from: 'title', fieldLabel: pathLabel(entry.schema, [plainName]) }
  } else {
    if (titlePath) return { from: 'title', fieldLabel: pathLabel(entry.schema, titlePath) }
    const named = ['title', 'name'].find((name) => findField(entry.schema, name))
    if (named) return { from: 'title', fieldLabel: pathLabel(entry.schema, [named]) }
  }
  if (type?.label) return { from: 'type' }
  return { from: 'slug' }
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== ''

/** The value at a data `path`, through nested objects. */
const valueAt = (data: Record<string, unknown>, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined,
    data,
  )

/**
 * The label of the field at a data `path`, with its enclosing objects' labels before it
 * ("Hero › Heading"); undefined when the schema has no such field.
 */
const pathLabel = (schema: EntrySchema, path: readonly string[]): string | undefined => {
  const labels: string[] = []
  let fields: readonly FieldConfig[] | undefined = schema
  for (const name of path) {
    const field: FieldConfig | undefined = fields && findField(fields, name)
    if (!field) return undefined
    labels.push(schemaLabel(field))
    fields = field.type === 'object' && 'fields' in field && !field.list ? field.fields : undefined
  }
  return labels.join(' › ')
}

const isInlineGroup = (field: FieldConfig): field is InlineGroupFieldConfig =>
  field.type === 'group'

/** The field named `name` among `fields`, looking through inline groups, which hold no data. */
const findField = (fields: readonly FieldConfig[], name: string): FieldConfig | undefined => {
  for (const field of fields) {
    if (isInlineGroup(field)) {
      const inner = findField(field.fields, name)
      if (inner) return inner
    } else if (field.name === name) return field
  }
  return undefined
}

/** One crumb before the entry's own: a collection, or a folder of a nested slug. */
export type BreadcrumbSegment =
  | {
      label: string
      /** The collection the crumb reveals in the content panel. */
      collectionPath: string
      folder?: undefined
    }
  | {
      label: string
      /** A slug folder, which is not a node of the content tree, so it navigates nowhere. */
      folder: true
      collectionPath?: undefined
    }

/**
 * Builds breadcrumb segments for an entry based on its collection hierarchy. The first path part
 * is skipped as the content root, which the tree does not show, so a root entry has none.
 */
export const buildBreadcrumbSegments = (
  currentEntry: EditorEntry | undefined,
  collectionLabels: Map<string, string>,
): BreadcrumbSegment[] => {
  const segments: BreadcrumbSegment[] = []
  if (!currentEntry) return segments

  if (currentEntry.collectionPath) {
    const parts = currentEntry.collectionPath.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) {
      const pathUpToHere = parts.slice(0, i + 1).join('/')
      const label = collectionLabels.get(pathUpToHere)
      if (label) segments.push({ label, collectionPath: pathUpToHere })
    }
  }

  const slugSegments = (currentEntry.slug ?? '').split('/').filter(Boolean)
  for (const folder of slugSegments.slice(0, -1)) segments.push({ label: folder, folder: true })

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
