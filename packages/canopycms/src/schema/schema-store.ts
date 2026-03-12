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
import { generateId, isValidId } from '../id'
import { createLogicalPath, validateAndNormalizePath } from '../paths'
import type { LogicalPath, ContentId } from '../paths/types'
import type { CanopyServices } from '../services'

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

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

/** Max length for names and slugs (filesystem path safety) */
const MAX_NAME_LENGTH = 64
/** Max length for labels */
const MAX_LABEL_LENGTH = 128

const entryTypeInputSchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  label: z.string().max(MAX_LABEL_LENGTH).optional(),
  format: z.enum(['md', 'mdx', 'json']),
  fields: z.string().min(1),
  default: z.boolean().optional(),
  maxItems: z.number().int().positive().optional(),
})

const createCollectionInputSchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  label: z.string().max(MAX_LABEL_LENGTH).optional(),
  parentPath: z.string().optional(),
  entries: z.array(entryTypeInputSchema).min(1, 'Collection must have at least one entry type'),
})

const updateCollectionInputSchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
  label: z.string().max(MAX_LABEL_LENGTH).optional(),
  slug: z.string().min(1).max(MAX_NAME_LENGTH).optional(), // Directory name (e.g., "posts" in "posts.{id}/")
  order: z.array(z.string()).optional(),
})

const updateEntryTypeInputSchema = z.object({
  label: z.string().max(MAX_LABEL_LENGTH).optional(),
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
    private readonly services?: CanopyServices,
  ) {}

  // --------------------------------------------------------------------------
  // Cache Invalidation
  // --------------------------------------------------------------------------

  /**
   * Invalidate schema cache for this branch after mutations.
   * This marks the cache as stale so the next schema load will regenerate it.
   */
  private async invalidateSchemaCache(): Promise<void> {
    if (this.services) {
      // Get branchRoot from contentRoot (parent directory)
      const branchRoot = path.dirname(this.contentRoot)
      await this.services.schemaCacheRegistry.invalidate(branchRoot)
    }
  }

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
   * Check if a collection is empty (has no content files or child collections)
   */
  async isCollectionEmpty(collectionPath: LogicalPath): Promise<boolean> {
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      // Collection doesn't exist, consider it empty
      return true
    }

    try {
      const entries = await fs.readdir(physicalPath, { withFileTypes: true })
      for (const entry of entries) {
        // Content files mean not empty
        if (entry.isFile() && entry.name !== '.collection.json') {
          return false
        }
        // Child collection directories mean not empty
        if (entry.isDirectory()) {
          try {
            await fs.access(path.join(physicalPath, entry.name, '.collection.json'))
            return false
          } catch {
            // Not a collection directory, ignore
          }
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
  ): Promise<{ collectionPath: LogicalPath; contentId: ContentId }> {
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
    // For root-level collections (empty parentPath), we don't update parent order
    const parentLogicalPath = input.parentPath
      ? createLogicalPath(input.parentPath)
      : createLogicalPath('')
    const parentMeta = input.parentPath ? await this.readCollectionMeta(parentLogicalPath) : null
    if (parentMeta) {
      // Initialize parent's order array if it doesn't exist
      const existingOrder = parentMeta.order ?? []
      parentMeta.order = [...existingOrder, contentId]
      await this.writeCollectionMeta(parentPhysicalPath, parentMeta)
    }

    // Build logical path
    const logicalPath = input.parentPath
      ? createLogicalPath(`${input.parentPath}/${input.name}`)
      : createLogicalPath(input.name)

    // Invalidate schema cache after mutation
    await this.invalidateSchemaCache()

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

    // Check if this is the root collection (path equals contentRoot basename, e.g., "content")
    const contentRootName = path.basename(this.contentRoot)
    if (collectionPath === contentRootName) {
      // Update root collection meta
      let meta = await this.readRootCollectionMeta()
      if (!meta) {
        meta = {}
      }
      // Root only supports label and order updates (no name)
      if (updates.label !== undefined) {
        meta.label = updates.label
      }
      if (updates.order !== undefined) {
        meta.order = updates.order
      }
      await this.writeRootCollectionMeta(meta)
      // Invalidate schema cache after mutation
      await this.invalidateSchemaCache()
      return
    }

    // Strip contentRoot prefix to get relative path for regular collection
    // E.g., "content/posts" -> "posts"
    const relativePath = collectionPath.startsWith(`${contentRootName}/`)
      ? collectionPath.slice(contentRootName.length + 1)
      : collectionPath

    // Resolve path for regular collection
    const physicalPath = await resolveCollectionPath(
      this.contentRoot,
      createLogicalPath(relativePath),
    )
    if (!physicalPath) {
      throw new Error(`Collection not found: ${collectionPath}`)
    }

    // Read existing meta
    const meta = await this.readCollectionMeta(relativePath as LogicalPath)
    if (!meta) {
      throw new Error(`Collection meta not found: ${collectionPath}`)
    }

    // Handle slug change (directory rename) if provided
    let finalPhysicalPath = physicalPath
    if (updates.slug !== undefined) {
      // Extract current slug and ID from physical path
      // Format: /path/to/{slug}.{12-char-id}
      const dirName = path.basename(physicalPath)
      const parts = dirName.split('.')

      if (parts.length !== 2 || !isValidId(parts[1])) {
        throw new Error(`Invalid collection directory format: ${dirName}`)
      }

      const currentSlug = parts[0]
      const contentId = parts[1]

      // Only rename if slug is actually different
      if (updates.slug !== currentSlug) {
        // Validate new slug (alphanumeric + hyphens, lowercase)
        if (!/^[a-z][a-z0-9-]*$/.test(updates.slug)) {
          throw new Error(
            'Slug must start with a letter and contain only lowercase letters, numbers, and hyphens',
          )
        }

        // Build new path with new slug + same ID
        const parentDir = path.dirname(physicalPath)
        const newDirName = `${updates.slug}.${contentId}`
        const newPhysicalPath = path.join(parentDir, newDirName)

        // Check if any collection with this slug already exists
        // Need to check for any directory matching {slug}.{any-id}
        try {
          const entries = await fs.readdir(parentDir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith(`${updates.slug}.`)) {
              const parts = entry.name.split('.')
              if (parts.length === 2 && isValidId(parts[1])) {
                throw new Error(`Collection with slug "${updates.slug}" already exists`)
              }
            }
          }
        } catch (err) {
          // Re-throw "already exists" errors
          if ((err as Error).message.includes('already exists')) {
            throw err
          }
          // Ignore other errors (e.g., ENOENT if parent dir doesn't exist somehow)
        }

        // Atomically rename the directory
        await fs.rename(physicalPath, newPhysicalPath)
        finalPhysicalPath = newPhysicalPath

        // Note: Content ID index will rebuild lazily on next access
      }
    }

    // Apply metadata updates
    if (updates.name !== undefined) {
      meta.name = updates.name
    }
    if (updates.label !== undefined) {
      meta.label = updates.label
    }
    if (updates.order !== undefined) {
      meta.order = updates.order
    }

    // Write back to the (potentially renamed) path
    await this.writeCollectionMeta(finalPhysicalPath, meta)

    // Invalidate schema cache after mutation
    await this.invalidateSchemaCache()
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

    // Invalidate schema cache after mutation
    await this.invalidateSchemaCache()
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

    // Invalidate schema cache after mutation
    await this.invalidateSchemaCache()
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

    // Invalidate schema cache after mutation
    await this.invalidateSchemaCache()
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

    // Check for entries still using this type
    const usageCount = await this.countEntriesUsingType(collectionPath, entryTypeName)
    if (usageCount > 0) {
      throw new Error(
        `Cannot remove entry type "${entryTypeName}": ${usageCount} ${usageCount === 1 ? 'entry still uses' : 'entries still use'} it. ` +
          'Delete or migrate those entries first.',
      )
    }

    // Remove entry type
    meta.entries!.splice(index, 1)

    // Write back
    await this.writeCollectionMeta(physicalPath, meta)

    // Invalidate schema cache after mutation
    await this.invalidateSchemaCache()
  }

  // --------------------------------------------------------------------------
  // Usage Counting
  // --------------------------------------------------------------------------

  /**
   * Count the number of entries using a specific entry type in a collection.
   * This is used to prevent breaking changes to entry types that have existing content.
   *
   * @param collectionPath - Logical path to the collection (e.g., "content/posts")
   * @param entryTypeName - Name of the entry type to count
   * @returns Number of entries using this entry type
   *
   * @example
   * ```ts
   * const count = await store.countEntriesUsingType('content/posts', 'post')
   * if (count > 0) {
   *   // Cannot modify schema/format
   * }
   * ```
   */
  async countEntriesUsingType(collectionPath: LogicalPath, entryTypeName: string): Promise<number> {
    // Resolve collection physical path
    const physicalPath = await resolveCollectionPath(this.contentRoot, collectionPath)
    if (!physicalPath) {
      // Collection doesn't exist yet - return 0
      return 0
    }

    try {
      // Read directory entries
      const entries = await fs.readdir(physicalPath, { withFileTypes: true })

      // Count files matching pattern: {entryTypeName}.{slug}.{id}.{ext}
      let count = 0
      for (const entry of entries) {
        // Skip directories and hidden files
        if (entry.isDirectory() || entry.name.startsWith('.')) {
          continue
        }

        // Parse filename: type.slug.id.ext
        const parts = entry.name.split('.')

        // Need at least 4 parts: type, slug, id, ext
        if (parts.length < 4) {
          continue
        }

        // Check if first part matches entry type name
        if (parts[0] !== entryTypeName) {
          continue
        }

        // Check if second-to-last part is a valid 12-char ID
        const candidateId = parts[parts.length - 2]
        if (isValidId(candidateId)) {
          count++
        }
      }

      return count
    } catch (err) {
      // Directory might not exist yet
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0
      }
      throw err
    }
  }

  // --------------------------------------------------------------------------
  // Order Operations
  // --------------------------------------------------------------------------

  /**
   * Update the order of items in a collection
   */
  async updateOrder(collectionPath: LogicalPath, order: string[]): Promise<void> {
    // Check if this is the root collection (path equals contentRoot basename, e.g., "content")
    const contentRootName = path.basename(this.contentRoot)
    if (collectionPath === contentRootName) {
      // Update root collection meta
      let meta = await this.readRootCollectionMeta()
      if (!meta) {
        meta = {}
      }
      meta.order = order
      await this.writeRootCollectionMeta(meta)
      // Invalidate schema cache after mutation
      await this.invalidateSchemaCache()
      return
    }

    // Update regular collection (handles contentRoot prefix stripping internally)
    // Note: updateCollection already invalidates cache, so no need to do it again
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
