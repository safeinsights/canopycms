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
import { createLogicalPath } from '../paths/normalize'

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
    const logicalPath = parentPath ? join(parentPath, collection.path) : collection.path
    const normalizedFull = normalizePathValue(logicalPath)
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
 * const map = new Map(flat.map(item => [item.logicalPath, item]))
 * const item = map.get('content/posts') // O(1) lookup
 */
export const flattenSchema = (root: RootCollectionConfig, basePath = ''): FlatSchemaItem[] => {
  const flat: FlatSchemaItem[] = []
  const base = normalizePathValue(basePath || '')

  const walkCollection = (collection: CollectionConfig, parentPath: string) => {
    const normalizedPath = normalizePathValue(collection.path)
    // Build logical path: if we have a parent, join with parent; otherwise use collection path
    let logicalPath: string
    if (parentPath && parentPath !== base) {
      // Nested child collection: use only the collection name (leaf segment), not the full path
      // The full path from collection.path includes parent path segments that are already in parentPath
      logicalPath = join(parentPath, collection.name)
    } else if (parentPath === base) {
      // Root-level collection (direct child of content root): use collection path
      logicalPath = join(base, normalizedPath)
    } else {
      // No parent and no base: use collection path as-is
      logicalPath = normalizedPath
    }
    const normalizedFull = normalizePathValue(logicalPath)

    // Add the collection itself
    flat.push({
      type: 'collection',
      logicalPath: createLogicalPath(normalizedFull),
      name: collection.name,
      label: collection.label,
      parentPath: parentPath ? createLogicalPath(parentPath) : undefined,
      entries: collection.entries,
      collections: collection.collections,
      order: collection.order,
    })

    // Add entry types in this collection
    if (collection.entries) {
      for (const entryType of collection.entries as readonly EntryTypeConfig[]) {
        // Entry type path is collection path + entry type name
        const entryTypePath = join(normalizedFull, entryType.name)
        flat.push({
          type: 'entry-type',
          logicalPath: createLogicalPath(normalizePathValue(entryTypePath)),
          name: entryType.name,
          label: entryType.label,
          parentPath: createLogicalPath(normalizedFull),
          format: entryType.format,
          schema: entryType.schema,
          schemaRef: entryType.schemaRef,
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

  // Add the root collection itself as a normal collection (if we have a base path)
  // This makes content root behave exactly like any other collection, just without a parent
  if (base) {
    flat.push({
      type: 'collection',
      logicalPath: createLogicalPath(base),
      name: base, // Use base path as the name (e.g., 'content')
      label: undefined, // Root collection has no label
      parentPath: undefined, // No parent - this is the root
      entries: root.entries,
      collections: root.collections,
      order: root.order,
    })
  }

  // Add root-level entry types
  // Now their parentPath will reference the root collection we just added above
  if (root.entries) {
    for (const entryType of root.entries as readonly EntryTypeConfig[]) {
      // Root entry type path is base + entry type name
      const entryTypePath = base ? join(base, entryType.name) : entryType.name
      flat.push({
        type: 'entry-type',
        logicalPath: createLogicalPath(normalizePathValue(entryTypePath)),
        name: entryType.name,
        label: entryType.label,
        parentPath: base ? createLogicalPath(base) : createLogicalPath(''), // Now references the root collection (e.g., 'content')
        format: entryType.format,
        schema: entryType.schema,
        schemaRef: entryType.schemaRef,
        default: entryType.default,
        maxItems: entryType.maxItems,
      })
    }
  }

  // Process root-level collections
  // Pass base as parentPath so they are children of the content root collection
  if (root.collections) {
    for (const collection of root.collections) {
      walkCollection(collection, base || '')
    }
  }

  return flat
}
