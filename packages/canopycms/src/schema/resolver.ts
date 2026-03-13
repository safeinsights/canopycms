/**
 * Schema resolver for CanopyCMS.
 *
 * Loads and resolves schema from .collection.json files in the content directory.
 * This is the single source of truth for collection structure.
 *
 * Field schemas are defined in the entry schema registry and referenced by name
 * in .collection.json files for reusability and type safety.
 */

import type { RootCollectionConfig } from '../config'
import type { EntrySchemaRegistry, SchemaResolutionResult, SchemaSourceInfo } from './types'
import { loadCollectionMetaFiles, resolveCollectionReferences } from './meta-loader'

/**
 * Resolve schema from .collection.json files.
 *
 * This is the primary entry point for loading schema configuration.
 * It discovers all .collection.json files in the content directory
 * and resolves schema references using the provided registry.
 *
 * @param contentRoot - Path to the content directory
 * @param entrySchemaRegistry - Map of entry schema names to field definitions
 * @returns Resolved schema configuration
 * @throws Error if schema references cannot be resolved
 */
export async function resolveSchema(
  contentRoot: string,
  entrySchemaRegistry: EntrySchemaRegistry,
): Promise<SchemaResolutionResult> {
  // Load all .collection.json meta files
  const metaFiles = await loadCollectionMetaFiles(contentRoot)

  // Build source info for debugging
  const sources: SchemaSourceInfo[] = []

  if (metaFiles.root) {
    sources.push({
      path: '.collection.json',
      type: 'root',
      collections: [],
    })
  }

  for (const collection of metaFiles.collections) {
    sources.push({
      path: `${collection.path}/.collection.json`,
      type: 'collection',
      collections: [collection.name],
    })
  }

  // Resolve schema references to actual field definitions
  const schema = resolveCollectionReferences(metaFiles, entrySchemaRegistry)

  return { schema, sources }
}

/**
 * Check if content root has any .collection.json files.
 *
 * @param contentRoot - Path to the content directory
 * @returns true if at least one .collection.json file exists
 */
export async function hasSchemaFiles(contentRoot: string): Promise<boolean> {
  const metaFiles = await loadCollectionMetaFiles(contentRoot)
  return metaFiles.root !== null || metaFiles.collections.length > 0
}

/**
 * Validate schema completeness.
 *
 * Checks that the resolved schema has at least one collection or
 * root entries definition.
 *
 * @param schema - Resolved schema to validate
 * @returns true if schema is valid
 */
export function isValidSchema(schema: RootCollectionConfig): boolean {
  const hasEntries = !!(schema.entries && schema.entries.length > 0)
  const hasCollections = !!(schema.collections && schema.collections.length > 0)
  return hasEntries || hasCollections
}
