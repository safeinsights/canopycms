/**
 * Schema Store Types - Client-safe type definitions for schema CRUD operations.
 *
 * These types are separated from schema-store.ts to allow client-side code
 * to import them without pulling in Node.js dependencies (fs, path).
 */

import type { ContentFormat } from '../config'
import type { LogicalPath } from '../paths/types'

export interface CreateCollectionInput {
  name: string
  label?: string
  parentPath?: LogicalPath // Parent collection path (empty/undefined for root-level)
  entries: CreateEntryTypeInput[]
}

export interface CreateEntryTypeInput {
  name: string
  label?: string
  format: ContentFormat
  schema: string // Entry schema registry key
  default?: boolean
  maxItems?: number
}

export interface UpdateCollectionInput {
  name?: string
  label?: string
  slug?: string // Directory name for renaming (e.g., "posts" in "posts.{id}/")
  order?: string[] // Embedded IDs for ordering
}

export interface UpdateEntryTypeInput {
  label?: string
  format?: ContentFormat
  schema?: string // Entry schema registry key
  default?: boolean
  maxItems?: number
}
