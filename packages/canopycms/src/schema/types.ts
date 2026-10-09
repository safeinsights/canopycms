/**
 * Types for schema loading and resolution.
 */

import type { EntrySchema, RootCollectionConfig } from '../config'

/**
 * Entry schema registry maps entry schema names to field definitions.
 * Used by .collection.json files to reference reusable entry schemas.
 */
export type EntrySchemaRegistry = Record<string, EntrySchema>

/**
 * Information about a schema source for debugging.
 */
export interface SchemaSourceInfo {
  /** File path relative to content root */
  path: string
  type: 'root' | 'collection'
  /** Collection names defined in this source */
  collections: string[]
}

export interface SchemaResolutionResult {
  /** Resolved schema ready for use */
  schema: RootCollectionConfig
  /** Information about schema sources for debugging */
  sources: SchemaSourceInfo[]
  /** What a degraded resolve left out; always empty for a strict one. */
  issues: SchemaIssue[]
}

/**
 * A part of a branch's schema the running code could not resolve, contained rather than thrown
 * (see `BranchSchemaCache` for where that applies). `unknown-schema` marks one entry type
 * unavailable; `reference-entry-type` leaves a reference field scoped to a type the content does
 * not declare, which offers no options until it does.
 */
export type SchemaIssue =
  | {
      kind: 'unknown-schema'
      /** The collection's path relative to the content root; '' for the root collection. */
      collectionPath: string
      entryType: string
      schemaRef: string
      metaFile: string
      message: string
    }
  | {
      kind: 'reference-entry-type'
      message: string
    }

/** How resolution treats a `.collection.json` naming an entry schema the registry lacks. */
export type UnknownSchemaPolicy = 'throw' | 'degrade'
