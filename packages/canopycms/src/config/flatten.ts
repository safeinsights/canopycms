/**
 * Schema flattening utilities for O(1) lookups.
 */

import { join, normalize } from 'pathe'

import type {
  CollectionConfig,
  EntryTypeConfig,
  FlatSchemaItem,
  RootCollectionConfig,
} from './types'

/**
 * Normalize a path value by splitting, filtering empty segments, and rejoining.
 */
export const normalizePathValue = (val: string): string =>
  normalize(val).split('/').filter(Boolean).join('/')

/**
 * Normalize all paths in the root collection schema.
 * Recursively processes nested collections.
 */
export const normalizeSchemaPathsRoot = (root: RootCollectionConfig): RootCollectionConfig => {
  const normalizeCollection = (
    collection: CollectionConfig,
    parentPath = ''
  ): CollectionConfig => {
    const fullPath = parentPath ? join(parentPath, collection.path) : collection.path
    const normalizedFull = normalizePathValue(fullPath)
    if (!normalizedFull || normalizedFull.includes('..')) {
      throw new Error(`Invalid path for collection "${collection.name}"`)
    }

    return {
      ...collection,
      path: normalizePathValue(collection.path),
      collections: collection.collections?.map((c: CollectionConfig) =>
        normalizeCollection(c, normalizedFull)
      ),
    }
  }

  return {
    ...root,
    collections: root.collections?.map((c: CollectionConfig) => normalizeCollection(c)),
  }
}

/**
 * Flatten the root collection schema into a flat array for O(1) lookups.
 * Traverses the nested schema structure and returns all collections and entry types
 * with their full paths resolved.
 *
 * @param root - The root collection configuration
 * @param basePath - Optional base path to prepend (e.g., 'content')
 * @returns Array of flattened schema items with full paths
 *
 * @example
 * const flat = flattenSchema(config.schema, 'content')
 * const map = new Map(flat.map(item => [item.fullPath, item]))
 * const item = map.get('content/posts') // O(1) lookup
 */
export const flattenSchema = (root: RootCollectionConfig, basePath = ''): FlatSchemaItem[] => {
  const flat: FlatSchemaItem[] = []
  const base = normalizePathValue(basePath || '')

  const walkCollection = (collection: CollectionConfig, parentPath: string) => {
    const normalizedPath = normalizePathValue(collection.path)
    // Build fullPath: if we have a parent, join with parent; otherwise use collection path
    let fullPath: string
    if (parentPath) {
      // Child collection: use only the collection name (leaf segment), not the full path
      // The full path from collection.path includes parent path segments that are already in parentPath
      fullPath = join(parentPath, collection.name)
    } else {
      // Root-level collection: prepend base path
      fullPath = base ? join(base, normalizedPath) : normalizedPath
    }
    const normalizedFull = normalizePathValue(fullPath)

    // Add the collection itself
    flat.push({
      type: 'collection',
      fullPath: normalizedFull,
      name: collection.name,
      label: collection.label,
      parentPath: parentPath || undefined,
      entries: collection.entries,
      collections: collection.collections,
    })

    // Add entry types in this collection
    if (collection.entries) {
      for (const entryType of collection.entries as readonly EntryTypeConfig[]) {
        // Entry type path is collection path + entry type name
        const entryTypePath = join(normalizedFull, entryType.name)
        flat.push({
          type: 'entry-type',
          fullPath: normalizePathValue(entryTypePath),
          name: entryType.name,
          label: entryType.label,
          parentPath: normalizedFull,
          format: entryType.format,
          fields: entryType.fields,
          default: entryType.default,
          maxItems: entryType.maxItems,
        })
      }
    }

    // Recursively process nested collections
    if (collection.collections) {
      for (const child of collection.collections) {
        walkCollection(child, normalizedFull)
      }
    }
  }

  // Add root-level entry types
  if (root.entries) {
    for (const entryType of root.entries as readonly EntryTypeConfig[]) {
      // Root entry type path is base + entry type name
      const entryTypePath = base ? join(base, entryType.name) : entryType.name
      flat.push({
        type: 'entry-type',
        fullPath: normalizePathValue(entryTypePath),
        name: entryType.name,
        label: entryType.label,
        parentPath: base, // Root entry types have base as parent (empty string if no base)
        format: entryType.format,
        fields: entryType.fields,
        default: entryType.default,
        maxItems: entryType.maxItems,
      })
    }
  }

  // Process root-level collections
  if (root.collections) {
    for (const collection of root.collections) {
      walkCollection(collection, '')
    }
  }

  return flat
}
