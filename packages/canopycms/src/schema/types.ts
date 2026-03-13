/**
 * Types for schema loading and resolution.
 */

import type { FieldConfig, RootCollectionConfig } from '../config'

/**
 * Entry schema registry maps entry schema names to field definitions.
 * Used by .collection.json files to reference reusable entry schemas.
 */
export type EntrySchemaRegistry = Record<string, readonly FieldConfig[]>


/**
 * Information about a schema source for debugging.
 */
export interface SchemaSourceInfo {
  /** File path relative to content root */
  path: string
  /** Type of schema source */
  type: 'root' | 'collection'
  /** Collection names defined in this source */
  collections: string[]
}

/**
 * Result of schema resolution.
 */
export interface SchemaResolutionResult {
  /** Resolved schema ready for use */
  schema: RootCollectionConfig
  /** Information about schema sources for debugging */
  sources: SchemaSourceInfo[]
}
