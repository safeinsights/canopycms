/**
 * Schema Module
 *
 * This module provides schema loading and resolution for CanopyCMS.
 * Schema structure is defined in .collection.json files (single source of truth)
 * while field schemas are defined in an entry schema registry for reusability.
 *
 * @example
 * ```ts
 * import { resolveSchema } from 'canopycms/schema'
 *
 * const { schema, sources } = await resolveSchema(contentRoot, entrySchemaRegistry)
 * ```
 */

// Types
export type { EntrySchemaRegistry, SchemaSourceInfo, SchemaResolutionResult } from './types'

// Meta loader (low-level API)
export {
  loadCollectionMetaFiles,
  resolveCollectionReferences,
  watchCollectionMetaFiles,
  type CollectionMeta,
  type RootCollectionMeta,
} from './meta-loader'

// Resolver (high-level API)
export { resolveSchema, hasSchemaFiles, isValidSchema } from './resolver'
