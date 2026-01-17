/**
 * Types for schema loading and resolution.
 */

import type { FieldConfig, RootCollectionConfig } from '../config'

/**
 * Schema registry maps schema names to field definitions.
 * Used by .collection.json files to reference reusable field schemas.
 */
export type SchemaRegistry = Record<string, readonly FieldConfig[]>

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
  /** Singleton names defined in this source */
  singletons: string[]
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
