import nodePath from 'node:path'

import type {
  FieldConfig,
  FlatSchemaItem,
  InlineGroupFieldConfig,
  ObjectFieldConfig,
  ReferenceOptionSort,
} from './config'
import type { ContentStore } from './content-store'
import type { ContentIdIndex, IdLocation } from './content-id-index'
import { extractSlugFromFilename, extractEntryTypeFromFilename } from './content-id-index'
import { sortByOrder } from './content-listing'
import {
  entryLogicalPath,
  type ContentId,
  type LogicalPath,
  type PhysicalPath,
  type Slug,
} from './paths'
import { DEFAULT_SEO_FIELD_NAMES, isNoindexEntry, type SeoFieldLocation } from './static/seo'

export interface ReferenceOption {
  id: string
  label: string
  collection: string
  /**
   * Present when the target is `noindex` at `config.seo`'s location, so a page that lists only
   * indexed entries won't show it. `fieldLabel` is the editor label of the target's own noindex
   * field, so the picker can name the setting in the words the editor sees on that entry.
   */
  noindex?: { fieldLabel: string }
}

export interface LoadReferenceOptionsSettings {
  /** Where entries keep their SEO fields: `CanopyConfig.seo`. */
  seo?: SeoFieldLocation
  /** Default `'label'`. */
  sort?: ReferenceOptionSort
}

type SortValue = string | number | undefined

interface Loaded {
  option: ReferenceOption
  contentId: ContentId
  sortValue: SortValue
}

/**
 * Loads the options a reference field's picker offers. Resolving a stored reference to its
 * target is `ContentStore`'s job (`read()`, `resolveReferenceTarget`).
 */
export class ReferenceResolver {
  constructor(
    private store: ContentStore,
    private idIndex: ContentIdIndex,
  ) {}

  /**
   * Load all available reference options for a reference field.
   *
   * Scans collections (including subcollections) and/or filters by entry type.
   * At least one of `collections` or `entryTypes` should be provided.
   *
   * @param canAccess - Optional permission predicate, called with each candidate's
   *   logical path (`entryLogicalPath`) before it is read. Returning false skips the entry entirely --
   *   no file I/O, no label, no option -- so a caller who can't read a path never
   *   triggers a read for content they won't be allowed to see anyway.
   * @param settings - The SEO location the `noindex` marker reads, and the option order.
   */
  async loadReferenceOptions(
    collections?: LogicalPath[],
    displayField = 'title',
    search?: string,
    entryTypes?: string[],
    canAccess?: (logicalPath: LogicalPath) => boolean,
    settings: LoadReferenceOptionsSettings = {},
  ): Promise<ReferenceOption[]> {
    const loaded: Loaded[] = []
    const sort = settings.sort ?? 'label'
    const sortField = typeof sort === 'object' ? sort.field : undefined
    const noindexLabels = new NoindexFieldLabels(this.store.getSchemaItems(), settings.seo)

    // Collection-scoped queries go through getCollectionEntryPaths (it normalizes paths -- e.g.
    // 'authors' -> 'content/authors' -- and consults the schema index); an entryTypes-only query
    // has no collection scope, so it reads the ID index directly.
    type Candidate = { relativePath: PhysicalPath; collection: LogicalPath; slug: Slug }
    let candidates: Candidate[]
    if (collections && collections.length > 0) {
      const results = await Promise.all(
        collections.map((col) => this.store.getCollectionEntryPaths(col)),
      )
      candidates = results.flat()
    } else {
      candidates = this.idIndex
        .getAllEntryLocations()
        .filter(
          (loc): loc is IdLocation & { collection: LogicalPath; slug: Slug } =>
            loc.type === 'entry' && !!loc.collection && !!loc.slug,
        )
    }

    if (entryTypes && entryTypes.length > 0) {
      candidates = candidates.filter((loc) => {
        const entryType = extractEntryTypeFromFilename(nodePath.basename(loc.relativePath))
        return entryType != null && entryTypes.includes(entryType)
      })
    }

    for (const location of candidates) {
      if (!location.collection || !location.slug) continue
      // Skip denied paths before any file I/O.
      if (canAccess && !canAccess(entryLogicalPath(location.collection, location.slug))) continue

      const id = this.idIndex.findByPath(location.relativePath)
      if (!id) continue

      try {
        const filename = nodePath.basename(location.relativePath)
        const normalizedSlug = extractSlugFromFilename(filename)

        // Only the label is read, so the candidate's own references stay unresolved.
        const doc = await this.store.read(location.collection, normalizedSlug as Slug, {
          resolveReferences: false,
          allowUnavailableEntryType: true,
        })
        const label = String(doc.data[displayField] || doc.data.title || normalizedSlug)

        if (search && !label.toLowerCase().includes(search.toLowerCase())) {
          continue
        }

        const option: ReferenceOption = { id, label, collection: location.collection }
        if (isNoindexEntry(doc.data, settings.seo)) {
          const entryType = extractEntryTypeFromFilename(filename) ?? ''
          option.noindex = { fieldLabel: noindexLabels.get(location.collection, entryType) }
        }
        loaded.push({
          option,
          contentId: id,
          sortValue: sortField === undefined ? undefined : sortValueAt(doc.data, sortField),
        })
      } catch (error) {
        console.error('Failed to read entry for reference options:', {
          collection: location.collection,
          slug: location.slug,
          error,
        })
        continue
      }
    }

    if (sort === 'collection') return sortByCollection(loaded, this.store.getSchemaItems())
    if (typeof sort === 'object') return sortByField(loaded, sort.direction ?? 'asc')
    return loaded.map((l) => l.option).sort(byLabel)
  }
}

const byLabel = (a: ReferenceOption, b: ReferenceOption): number => a.label.localeCompare(b.label)

/**
 * The value at a dotted path, read through own properties only so a path like `__proto__`
 * reads nothing. A non-blank string, a finite number or a valid date counts as a value; a date
 * becomes its ISO string, since md/mdx frontmatter parses an unquoted `YYYY-MM-DD` as a `Date`.
 */
function sortValueAt(data: Record<string, unknown>, path: string): SortValue {
  let current: unknown = data
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  if (typeof current === 'number') return Number.isFinite(current) ? current : undefined
  if (typeof current === 'string') return current.trim() || undefined
  if (current instanceof Date) {
    return Number.isNaN(current.getTime()) ? undefined : current.toISOString()
  }
  return undefined
}

/**
 * Numbers before strings, so a field typed differently across entry types still sorts in one
 * consistent order; numbers compare numerically, strings as plain text, which orders ISO dates.
 */
function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Entries with no value go first under `desc` and last under `asc`: newest-first then puts an
 * entry whose date is not yet stamped at the top, where an editor queueing it looks.
 */
function sortByField(loaded: Loaded[], direction: 'asc' | 'desc'): ReferenceOption[] {
  const sign = direction === 'desc' ? -1 : 1
  return loaded
    .sort((a, b) => {
      if (a.sortValue === undefined || b.sortValue === undefined) {
        if (a.sortValue !== b.sortValue) {
          const aMissingFirst = direction === 'desc'
          return (a.sortValue === undefined) === aMissingFirst ? -1 : 1
        }
      } else {
        const byValue = compareValues(a.sortValue, b.sortValue) * sign
        if (byValue !== 0) return byValue
      }
      return byLabel(a.option, b.option)
    })
    .map((l) => l.option)
}

type CollectionItem = Extract<FlatSchemaItem, { type: 'collection' }>

/**
 * One group per collection in content-tree order: a collection, then each subcollection in its
 * parent's `order`. Within a group, options follow the collection's own `order`, then label.
 */
function sortByCollection(
  loaded: Loaded[],
  schemaItems: Iterable<FlatSchemaItem>,
): ReferenceOption[] {
  const collections = [...schemaItems].filter(
    (item): item is CollectionItem => item.type === 'collection',
  )
  const byPath = new Map(collections.map((c) => [c.logicalPath as string, c]))
  const children = new Map<string, CollectionItem[]>()
  const roots: CollectionItem[] = []
  for (const collection of collections) {
    const parent = collection.parentPath
    if (parent === undefined || !byPath.has(parent)) {
      roots.push(collection)
    } else {
      children.set(parent, [...(children.get(parent) ?? []), collection])
    }
  }

  const treeOrder: CollectionItem[] = []
  const visit = (siblings: CollectionItem[], order: readonly string[] | undefined): void => {
    for (const collection of sortByOrder([...siblings], order, (c) => c.name)) {
      treeOrder.push(collection)
      visit(children.get(collection.logicalPath) ?? [], collection.order)
    }
  }
  visit(roots, undefined)

  const groups = new Map<string, Loaded[]>()
  for (const item of loaded) {
    const path = item.option.collection
    groups.set(path, [...(groups.get(path) ?? []), item])
  }

  const result: ReferenceOption[] = []
  const appendGroup = (path: string, order: readonly string[] | undefined): void => {
    const group = groups.get(path)
    if (!group) return
    groups.delete(path)
    result.push(...sortByOrder(group, order, (l) => l.option.label).map((l) => l.option))
  }
  for (const collection of treeOrder) appendGroup(collection.logicalPath, collection.order)
  // A collection missing from the schema still gets a group, after the known ones.
  for (const path of [...groups.keys()].sort()) appendGroup(path, undefined)
  return result
}

/**
 * The editor label of each entry type's noindex field, found where `seo` says the flag lives:
 * a top-level field (inline groups are transparent), or a field inside the object named by
 * `seo.group`. Falls back to the field's name when the schema has no such field.
 */
class NoindexFieldLabels {
  private readonly entryTypes: Array<Extract<FlatSchemaItem, { type: 'entry-type' }>>
  private readonly cache = new Map<string, string>()
  private readonly fieldName: string

  constructor(
    schemaItems: Iterable<FlatSchemaItem>,
    private readonly seo: SeoFieldLocation | undefined,
  ) {
    this.entryTypes = [...schemaItems].filter(
      (item): item is Extract<FlatSchemaItem, { type: 'entry-type' }> => item.type === 'entry-type',
    )
    this.fieldName = seo?.fields?.noindex || DEFAULT_SEO_FIELD_NAMES.noindex
  }

  get(collection: string, entryType: string): string {
    const key = `${collection}\0${entryType}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const schema = this.entryTypes.find(
      (item) => item.parentPath === collection && item.name === entryType,
    )?.schema
    const label = (schema && this.findLabel(schema)) ?? this.fieldName
    this.cache.set(key, label)
    return label
  }

  private findLabel(schema: readonly FieldConfig[]): string | undefined {
    let fields: readonly FieldConfig[] | undefined = schema
    if (this.seo?.group) {
      const group = findField(schema, this.seo.group)
      fields = group?.type === 'object' ? (group as ObjectFieldConfig).fields : undefined
    }
    const field = fields && findField(fields, this.fieldName)
    return field ? (field.label ?? field.name) : undefined
  }
}

/** A field by data name, looking through inline groups, which store no key of their own. */
function findField(fields: readonly FieldConfig[], name: string): FieldConfig | undefined {
  for (const field of fields) {
    if (field.type === 'group') {
      const inner = findField((field as InlineGroupFieldConfig).fields, name)
      if (inner) return inner
    } else if (field.name === name) {
      return field
    }
  }
  return undefined
}
