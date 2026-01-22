/**
 * Schema Store - handles reading and writing .collection.json files.
 *
 * This module provides CRUD operations for collection schema metadata:
 * - Create/update/delete collections
 * - Add/update/remove entry types
 * - Update ordering of items within collections
 *
 * All mutations are branch-specific (like content edits).
 */

import { promises as fs } from 'fs'
import path from 'path'
import { z } from 'zod'

import type { ContentFormat, FieldConfig } from '../config'
import { resolveCollectionPath } from '../content-id-index'
import { generateId } from '../id'
import { toLogicalPath, validateAndNormalizePath } from '../paths'
import type { LogicalPath } from '../paths/types'

// Re-export types from client-safe module
export type {
  CreateCollectionInput,
  CreateEntryTypeInput,
  UpdateCollectionInput,
  UpdateEntryTypeInput,
} from './schema-store-types'

// Import types for internal use
import type {
  CreateCollectionInput,
  CreateEntryTypeInput,
  UpdateCollectionInput,
  UpdateEntryTypeInput,
} from './schema-store-types'

/**
 * Raw collection meta as stored in .collection.json
 */
interface CollectionMetaFile {
  name: string
  label?: string
  entries?: Array<{
    name: string
    label?: string
    format: ContentFormat
    fields: string
    default?: boolean
    maxItems?: number
  }>
  order?: string[]
}

/**
 * Raw root collection meta as stored in content/.collection.json
 */
interface RootCollectionMetaFile {
  entries?: Array<{
    name: string
    label?: string
    format: ContentFormat
    fields: string
    default?: boolean
    maxItems?: number
  }>
  order?: string[]
}

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const entryTypeInputSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  format: z.enum(['md', 'mdx', 'json']),
  fields: z.string().min(1),
  default: z.boolean().optional(),
  maxItems: z.number().int().positive().optional(),
})

const createCollectionInputSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  parentPath: z.string().optional(),
  entries: z.array(entryTypeInputSchema).min(1, 'Collection must have at least one entry type'),
})

const updateCollectionInputSchema = z.object({
  name: z.string().min(1).optional(),
  label: z.string().optional(),
  order: z.array(z.string()).optional(),
})

const updateEntryTypeInputSchema = z.object({
  label: z.string().optional(),
  format: z.enum(['md', 'mdx', 'json']).optional(),
  fields: z.string().min(1).optional(),
  default: z.boolean().optional(),
  maxItems: z.number().int().positive().optional(),
})

// ============================================================================
// SchemaStore Class
// ============================================================================

export class SchemaStore {
  constructor(
    private readonly contentRoot: string,
    private readonly schemaRegistry: Record<string, readonly FieldConfig[]>,
  ) {}

  // --------------------------------------------------------------------------
  // Validation Helpers
  // --------------------------------------------------------------------------

  /**
   * Validate that a schema reference exists in the registry
   */
  validateSchemaReference(schemaKey: string): boolean {
    return schemaKey in this.schemaRegistry
  }

  /**
   * Validate all schema references in entry types
   */
  private validateEntryTypeSchemas(entryTypes: CreateEntryTypeInput[]): {
    valid: boolean
    error?: string
  } {
    for (const entryType of entryTypes) {
      if (!this.validateSchemaReference(entryType.fields)) {
        const available = Object.keys(this.schemaRegistry).join(', ')
        return {
          valid: false,
          error: `Schema reference "${entryType.fields}" not found. Available: ${available}`,
        }
      }
    }
    return { valid: true }
  }

  /**
   * Validate path to prevent traversal attacks
   */
  private validatePath(targetPath: string): {
    valid: boolean
    normalizedPath?: string
    error?: string
  } {
    const result = validateAndNormalizePath(this.contentRoot, targetPath)
    if (!result.valid) {
      return { valid: false, error: result.error || 'Invalid path' }
    }
    return { valid: true, normalizedPath: result.normalizedPath }
  }

  // --------------------------------------------------------------------------
  // Read Operations
  // --------------------------------------------------------------------------

  /**
   * Read a collection's .collection.json file
   */
  async readCollectionMeta(collectionPath: LogicalPath): Promise<CollectionMetaFile | null> {
    // Resolve logical path to physical path with embedded IDs
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      return null
    }

    const metaPath = path.join(physicalPath, '.collection.json')
    try {
      const content = await fs.readFile(metaPath, 'utf-8')
      return JSON.parse(content) as CollectionMetaFile
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  /**
   * Read root collection meta (content/.collection.json)
   */
  async readRootCollectionMeta(): Promise<RootCollectionMetaFile | null> {
    const metaPath = path.join(this.contentRoot, '.collection.json')
    try {
      const content = await fs.readFile(metaPath, 'utf-8')
      return JSON.parse(content) as RootCollectionMetaFile
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  /**
   * Check if a collection is empty (has no content files)
   */
  async isCollectionEmpty(collectionPath: LogicalPath): Promise<boolean> {
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      // Collection doesn't exist, consider it empty
      return true
    }

    try {
      const entries = await fs.readdir(physicalPath, { withFileTypes: true })
      // Check for content files (not .collection.json or subdirectories that are collections)
      for (const entry of entries) {
        if (entry.isFile() && entry.name !== '.collection.json') {
          return false
        }
      }
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return true
      }
      throw err
    }
  }

  // --------------------------------------------------------------------------
  // Write Operations
  // --------------------------------------------------------------------------

  /**
   * Write a collection's .collection.json file
   */
  private async writeCollectionMeta(physicalPath: string, meta: CollectionMetaFile): Promise<void> {
    const metaPath = path.join(physicalPath, '.collection.json')
    const content = JSON.stringify(meta, null, 2) + '\n'
    await fs.writeFile(metaPath, content, 'utf-8')
  }

  /**
   * Write root collection meta
   */
  private async writeRootCollectionMeta(meta: RootCollectionMetaFile): Promise<void> {
    const metaPath = path.join(this.contentRoot, '.collection.json')
    const content = JSON.stringify(meta, null, 2) + '\n'
    await fs.writeFile(metaPath, content, 'utf-8')
  }

  // --------------------------------------------------------------------------
  // Collection Operations
  // --------------------------------------------------------------------------

  /**
   * Create a new collection
   */
  async createCollection(
    input: CreateCollectionInput,
  ): Promise<{ collectionPath: LogicalPath; contentId: string }> {
    // Validate input
    const parseResult = createCollectionInputSchema.safeParse(input)
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`)
    }

    // Validate schema references
    const schemaValidation = this.validateEntryTypeSchemas(input.entries)
    if (!schemaValidation.valid) {
      throw new Error(schemaValidation.error)
    }

    // Determine parent directory
    let parentPhysicalPath: string
    if (input.parentPath) {
      const resolved = await resolveCollectionPath(this.contentRoot, input.parentPath)
      if (!resolved) {
        throw new Error(`Parent collection not found: ${input.parentPath}`)
      }
      parentPhysicalPath = resolved
    } else {
      parentPhysicalPath = this.contentRoot
    }

    // Generate embedded ID for new collection
    const contentId = generateId()
    const dirName = `${input.name}.${contentId}`
    const physicalPath = path.join(parentPhysicalPath, dirName)

    // Create directory
    await fs.mkdir(physicalPath, { recursive: true })

    // Build collection meta with empty order array (required for ordering support)
    const meta: CollectionMetaFile = {
      name: input.name,
      label: input.label,
      entries: input.entries.map((et) => ({
        name: et.name,
        label: et.label,
        format: et.format,
        fields: et.fields,
        default: et.default,
        maxItems: et.maxItems,
      })),
      order: [], // Initialize with empty order array
    }

    // Write .collection.json
    await this.writeCollectionMeta(physicalPath, meta)

    // Add new collection's contentId to parent's order array
    const parentLogicalPath = input.parentPath ? toLogicalPath(input.parentPath) : toLogicalPath('')
    const parentMeta = await this.readCollectionMeta(parentLogicalPath)
    if (parentMeta) {
      // Initialize parent's order array if it doesn't exist
      const existingOrder = parentMeta.order ?? []
      parentMeta.order = [...existingOrder, contentId]
      await this.writeCollectionMeta(parentPhysicalPath, parentMeta)
    }

    // Build logical path
    const logicalPath = input.parentPath
      ? toLogicalPath(`${input.parentPath}/${input.name}`)
      : toLogicalPath(input.name)

    return { collectionPath: logicalPath, contentId }
  }

  /**
   * Update a collection's metadata
   */
  async updateCollection(
    collectionPath: LogicalPath,
    updates: UpdateCollectionInput,
  ): Promise<void> {
    // Validate input
    const parseResult = updateCollectionInputSchema.safeParse(updates)
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`)
    }

    // Resolve path
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    // Read existing meta
    const meta = await this.readCollectionMeta(collectionPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    // Apply updates
    if (updates.name !== undefined) {
      meta.name = updates.name
    }
    if (updates.label !== undefined) {
      meta.label = updates.label
    }
    if (updates.order !== undefined) {
      meta.order = updates.order
    }

    // Write back
    await this.writeCollectionMeta(physicalPath, meta)
  }

  /**
   * Delete a collection (must be empty)
   */
  async deleteCollection(collectionPath: LogicalPath): Promise<void> {
    // Check if empty
    const isEmpty = await this.isCollectionEmpty(collectionPath)
    if (!isEmpty) {
      throw new Error('Collection must be empty before deletion. Delete all entries first.')
    }

    // Resolve path
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    // Delete the directory (including .collection.json)
    await fs.rm(physicalPath, { recursive: true })
  }

  // --------------------------------------------------------------------------
  // Entry Type Operations
  // --------------------------------------------------------------------------

  /**
   * Add an entry type to a collection
   */
  async addEntryType(collectionPath: LogicalPath, entryType: CreateEntryTypeInput): Promise<void> {
    // Validate input
    const parseResult = entryTypeInputSchema.safeParse(entryType)
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`)
    }

    // Validate schema reference
    if (!this.validateSchemaReference(entryType.fields)) {
      const available = Object.keys(this.schemaRegistry).join(', ')
      throw new Error(`Schema reference "${entryType.fields}" not found. Available: ${available}`)
    }

    // Resolve path
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    // Read existing meta
    const meta = await this.readCollectionMeta(collectionPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    // Check for duplicate name
    if (meta.entries?.some((et) => et.name === entryType.name)) {
      throw new Error(`Entry type "${entryType.name}" already exists in this collection`)
    }

    // Add entry type
    meta.entries = meta.entries || []
    meta.entries.push({
      name: entryType.name,
      label: entryType.label,
      format: entryType.format,
      fields: entryType.fields,
      default: entryType.default,
      maxItems: entryType.maxItems,
    })

    // Write back
    await this.writeCollectionMeta(physicalPath, meta)
  }

  /**
   * Update an entry type in a collection
   */
  async updateEntryType(
    collectionPath: LogicalPath,
    entryTypeName: string,
    updates: UpdateEntryTypeInput,
  ): Promise<void> {
    // Validate input
    const parseResult = updateEntryTypeInputSchema.safeParse(updates)
    if (!parseResult.success) {
      throw new Error(`Invalid input: ${parseResult.error.message}`)
    }

    // Validate schema reference if provided
    if (updates.fields && !this.validateSchemaReference(updates.fields)) {
      const available = Object.keys(this.schemaRegistry).join(', ')
      throw new Error(`Schema reference "${updates.fields}" not found. Available: ${available}`)
    }

    // Resolve path
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    // Read existing meta
    const meta = await this.readCollectionMeta(collectionPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    // Find entry type
    const entryType = meta.entries?.find((et) => et.name === entryTypeName)
    if (!entryType) {
      throw new Error(`Entry type "${entryTypeName}" not found in collection`)
    }

    // Apply updates
    if (updates.label !== undefined) {
      entryType.label = updates.label
    }
    if (updates.format !== undefined) {
      entryType.format = updates.format
    }
    if (updates.fields !== undefined) {
      entryType.fields = updates.fields
    }
    if (updates.default !== undefined) {
      entryType.default = updates.default
    }
    if (updates.maxItems !== undefined) {
      entryType.maxItems = updates.maxItems
    }

    // Write back
    await this.writeCollectionMeta(physicalPath, meta)
  }

  /**
   * Remove an entry type from a collection
   */
  async removeEntryType(collectionPath: LogicalPath, entryTypeName: string): Promise<void> {
    // Resolve path
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    // Read existing meta
    const meta = await this.readCollectionMeta(collectionPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    // Check entry type exists
    const index = meta.entries?.findIndex((et) => et.name === entryTypeName) ?? -1
    if (index === -1) {
      throw new Error(`Entry type "${entryTypeName}" not found in collection`)
    }

    // Ensure at least one entry type remains
    if (meta.entries!.length === 1) {
      throw new Error(
        'Cannot remove last entry type. Collection must have at least one entry type.',
      )
    }

    // Remove entry type
    meta.entries!.splice(index, 1)

    // Write back
    await this.writeCollectionMeta(physicalPath, meta)
  }

  // --------------------------------------------------------------------------
  // Order Operations
  // --------------------------------------------------------------------------

  /**
   * Update the order of items in a collection
   */
  async updateOrder(collectionPath: LogicalPath, order: string[]): Promise<void> {
    // Check if this is the root collection
    if (!collectionPath || collectionPath === this.contentRoot) {
      // Update root collection meta
      let meta = await this.readRootCollectionMeta()
      if (!meta) {
        meta = {}
      }
      meta.order = order
      await this.writeRootCollectionMeta(meta)
      return
    }

    // Update regular collection
    await this.updateCollection(collectionPath, { order })
  }
}

// ============================================================================
// Exports
// ============================================================================

export {
  createCollectionInputSchema,
  updateCollectionInputSchema,
  entryTypeInputSchema,
  updateEntryTypeInputSchema,
}
