import fs from 'node:fs/promises'
import path from 'node:path'

import matter from 'gray-matter'

import type { ContentFormat, FlatSchemaItem, EntryTypeConfig } from './config'
import { ContentIdIndex, extractIdFromFilename, extractSlugFromFilename, extractEntryTypeFromFilename, resolveCollectionPath } from './content-id-index'
import { generateId } from './id'
import { getFormatExtension } from './utils/format'
import { normalizeFilesystemPath, type LogicalPath, type PhysicalPath, type EntrySlug, type ContentId } from './paths'

export type MarkdownDocument = {
  format: 'md' | 'mdx'
  data: Record<string, unknown>
  body: string
}

export type JsonDocument = {
  format: 'json'
  data: Record<string, unknown>
}

export type ContentDocument = (MarkdownDocument | JsonDocument) & {
  collection: LogicalPath
  collectionName: string
  relativePath: PhysicalPath
  absolutePath: string
}

export type WriteInput =
  | { format: 'md' | 'mdx'; data?: Record<string, unknown>; body: string }
  | { format: 'json'; data: Record<string, unknown> }

export class ContentStoreError extends Error {}

/**
 * Get the default entry type from a collection's entries array.
 * Returns the entry marked as default, or the first one, or undefined if no entries.
 */
function getDefaultEntryType(entries: readonly EntryTypeConfig[] | undefined): EntryTypeConfig | undefined {
  if (!entries || entries.length === 0) return undefined
  return entries.find(e => e.default) || entries[0]
}

/**
 * Validates that a slug doesn't contain slashes or backslashes.
 * Slugs must be simple filenames (last path segment only).
 */
function validateSlug(slug: string): void {
  if (slug.includes('/')) {
    throw new ContentStoreError(
      'Slugs cannot contain forward slashes. Use nested collections instead.'
    )
  }
  if (slug.includes('\\')) {
    throw new ContentStoreError(
      'Slugs cannot contain backslashes. Use nested collections instead.'
    )
  }
}

export class ContentStore {
  private readonly root: string
  private readonly schemaIndex: Map<string, FlatSchemaItem>
  private readonly _idIndex: ContentIdIndex
  private indexLoaded: boolean = false

  constructor(root: string, flatSchema: FlatSchemaItem[]) {
    this.root = path.resolve(root)
    this.schemaIndex = new Map(flatSchema.map((item) => [item.logicalPath, item]))
    this._idIndex = new ContentIdIndex(this.root)
  }

  /**
   * Get the ID index, ensuring it's loaded first.
   * This getter automatically loads the index on first access.
   */
  public async idIndex(): Promise<ContentIdIndex> {
    if (!this.indexLoaded) {
      await this._idIndex.buildFromFilenames('content')
      this.indexLoaded = true
    }
    return this._idIndex
  }

  /**
   * Get all schema items for iteration.
   * Used internally by ReferenceResolver for path matching.
   */
  public getSchemaItems(): IterableIterator<FlatSchemaItem> {
    return this.schemaIndex.values()
  }

  private assertSchemaItem(path: LogicalPath): FlatSchemaItem {
    const normalized = normalizeFilesystemPath(path)
    const item = this.schemaIndex.get(normalized)
    if (!item) {
      throw new ContentStoreError(`Unknown schema item: ${path}`)
    }
    return item
  }

  private assertCollection(collectionPath: LogicalPath): FlatSchemaItem & { type: 'collection' } {
    const item = this.assertSchemaItem(collectionPath)
    if (item.type !== 'collection') {
      throw new ContentStoreError(`Path is not a collection: ${collectionPath}`)
    }
    return item
  }

  /**
   * Build absolute and relative paths with security validation.
   * For collection entries, includes the ID in the filename.
   * For entry-type items (root-level entries with maxItems: 1), the file is stored
   * in the parent directory with filename pattern: {name}.{id}.{ext}
   *
   * SECURITY BOUNDARY: This method prevents path traversal attacks by:
   * 1. Validating that resolved paths stay within the content root
   * 2. Checking slugs for malicious patterns (via validateSlug)
   * 3. Using path.resolve to normalize paths before validation
   *
   * This validation is performed BEFORE file I/O in resolveDocumentPath(),
   * ensuring permission checks happen before any file system access.
   *
   * @param options.existingId - Optional ID to use (for edits). If not provided, generates new ID.
   * @param options.entryTypeName - For collections with multiple entry types, specify which one to use. Defaults to the default entry type.
   */
  private async buildPaths(
    schemaItem: FlatSchemaItem,
    slug: string,
    options: { existingId?: string; entryTypeName?: string } = {}
  ): Promise<{ absolutePath: string; relativePath: PhysicalPath; id?: string }> {
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`

    // Entry-type items (root-level entries with maxItems: 1):
    // File pattern: {name}.{id}.{ext} in the parent directory
    if (schemaItem.type === 'entry-type') {
      const name = schemaItem.name
      const format = schemaItem.format
      const ext = getFormatExtension(format)

      // Entry types are stored in their parent directory (e.g., content/)
      // parentPath is the content root (e.g., 'content')
      const parentDir = schemaItem.parentPath
        ? path.resolve(this.root, schemaItem.parentPath)
        : this.root

      // Security: Prevent path traversal at parent level
      if (!parentDir.startsWith(rootWithSep)) {
        throw new ContentStoreError('Path traversal detected')
      }

      // Check if file already exists (editing case)
      let id = options.existingId
      let existingFilename: string | undefined

      if (!id) {
        // Try to find existing file with this name
        const entries = await fs.readdir(parentDir, { withFileTypes: true }).catch(() => [])
        const existingFile = entries.find((entry) => {
          if (entry.isDirectory()) return false
          // Match files like: home.agfzDt2RLpSn.json
          const parts = entry.name.split('.')
          return parts.length >= 3 && parts[0] === name && entry.name.endsWith(ext)
        })

        if (existingFile) {
          const parts = existingFile.name.split('.')
          if (parts.length >= 3) {
            // Extract ID from: name.id.ext -> parts[1]
            id = parts[parts.length - 2]
          }
          existingFilename = existingFile.name
        }
      }

      // Build filename: {name}.{id}.{ext}
      let filename: string
      if (existingFilename && !id) {
        // Legacy file without embedded ID - use original filename
        filename = existingFilename
      } else {
        // Generate new ID if needed
        if (!id) {
          id = generateId()
        }
        filename = `${name}.${id}${ext}`
      }

      const resolved = path.resolve(parentDir, filename)
      const parentDirWithSep = parentDir.endsWith(path.sep) ? parentDir : `${parentDir}${path.sep}`

      // Security: Prevent path traversal at file level
      if (!resolved.startsWith(parentDirWithSep)) {
        throw new ContentStoreError('Path traversal detected')
      }

      return {
        absolutePath: resolved,
        relativePath: path.relative(this.root, resolved) as PhysicalPath,
        id,
      }
    }

    // Collection entries: append slug.id.ext to collection path
    if (schemaItem.type === 'collection') {
      const safeSlug = slug.replace(/^\/+/, '')
      if (!safeSlug) {
        throw new ContentStoreError('Slug is required for collection entries')
      }
      // Security: Validate slug format (prevents ../../../etc/passwd)
      validateSlug(safeSlug)

      // Determine which entry type to use
      let entryTypeConfig: EntryTypeConfig | undefined
      if (options.entryTypeName) {
        // Use specified entry type
        entryTypeConfig = schemaItem.entries?.find(e => e.name === options.entryTypeName)
        if (!entryTypeConfig) {
          throw new ContentStoreError(`Entry type '${options.entryTypeName}' not found in collection`)
        }
      } else {
        // Use default entry type
        entryTypeConfig = getDefaultEntryType(schemaItem.entries)
      }

      const format = entryTypeConfig?.format || 'json'
      const ext = getFormatExtension(format)
      const entryTypeName = entryTypeConfig?.name || 'entry'

      // Resolve the full collection path with embedded IDs
      // e.g., "content/docs/api" → "content/docs.bChqT78gcaLd/api.meiuwxTSo7UN"
      let collectionRoot = await resolveCollectionPath(this.root, schemaItem.logicalPath)

      if (!collectionRoot) {
        // Collection directory doesn't exist yet - use logical path
        // (Directory will be created on write if needed)
        collectionRoot = path.resolve(this.root, schemaItem.logicalPath)
      }

      // Security: Prevent path traversal at collection level
      if (!collectionRoot.startsWith(rootWithSep)) {
        throw new ContentStoreError('Path traversal detected')
      }

      // Check if file already exists (editing case)
      let id = options.existingId
      let existingFilename: string | undefined
      let existingEntryType: string | undefined

      if (!id) {
        // Try to find existing file with this slug
        const entries = await fs.readdir(collectionRoot, { withFileTypes: true }).catch(() => [])
        const existingFile = entries.find((entry) => {
          if (entry.isDirectory()) return false
          // Extract entry type from filename to check slug properly
          const fileEntryType = extractEntryTypeFromFilename(entry.name)
          const existingSlug = extractSlugFromFilename(entry.name, fileEntryType || undefined)
          return existingSlug === safeSlug
        })

        if (existingFile) {
          id = extractIdFromFilename(existingFile.name) || undefined
          // Remember original filename for legacy files without IDs
          existingFilename = existingFile.name
          // Extract and preserve entry type from existing file (immutable after creation)
          existingEntryType = extractEntryTypeFromFilename(existingFile.name) || undefined
        }
      }

      // For existing entries, preserve the entry type (immutable after creation)
      // For new entries, use the specified entry type
      const finalEntryTypeName = existingEntryType || entryTypeName

      // Build filename: use existing filename if found, or generate new one with ID
      let filename: string
      if (existingFilename && !id) {
        // Legacy file without embedded ID - use original filename
        filename = existingFilename
      } else {
        // Generate new ID if needed
        if (!id) {
          id = generateId()
        }
        // Build filename with embedded ID: type.slug.id.ext
        // Use finalEntryTypeName to preserve entry type for existing entries
        filename = `${finalEntryTypeName}.${safeSlug}.${id}${ext}`
      }
      const resolved = path.resolve(collectionRoot, filename)
      const collectionRootWithSep = collectionRoot.endsWith(path.sep)
        ? collectionRoot
        : `${collectionRoot}${path.sep}`

      // Security: Prevent path traversal at entry level
      if (!resolved.startsWith(collectionRootWithSep)) {
        throw new ContentStoreError('Path traversal detected')
      }

      return {
        absolutePath: resolved,
        relativePath: path.relative(this.root, resolved) as PhysicalPath,
        id,
      }
    }

    throw new ContentStoreError('Invalid schema item type')
  }

  /**
   * Path resolution: resolves a URL path to a schema item
   * - Try as collection + slug (last segment = slug)
   */
  resolvePath(pathSegments: string[]): {
    schemaItem: FlatSchemaItem
    slug: string
  } {
    if (pathSegments.length === 0) {
      throw new ContentStoreError('Empty path')
    }

    const logicalPath = pathSegments.join('/')

    // Try as collection + slug
    const slug = pathSegments[pathSegments.length - 1]
    const collectionPath = pathSegments.slice(0, -1).join('/')
    const normalizedCollection = normalizeFilesystemPath(collectionPath)
    const collection = this.schemaIndex.get(normalizedCollection)

    if (collection?.type === 'collection' && collection.entries) {
      return {
        schemaItem: collection,
        slug,
      }
    }

    throw new ContentStoreError(`No schema item found for path: ${logicalPath}`)
  }

  async resolveDocumentPath(schemaPath: LogicalPath, slug = '') {
    const schemaItem = this.assertSchemaItem(schemaPath)
    return await this.buildPaths(schemaItem, slug)
  }

  async read(
    collectionPath: LogicalPath,
    slug: EntrySlug | '' = '',
    options: { resolveReferences?: boolean } = {}
  ): Promise<ContentDocument> {
    const schemaItem = this.assertSchemaItem(collectionPath)
    const { absolutePath, relativePath } = await this.buildPaths(schemaItem, slug)
    const raw = await fs.readFile(absolutePath, 'utf8')

    let doc: ContentDocument
    let format: ContentFormat
    let fields: readonly any[]

    if (schemaItem.type === 'entry-type') {
      // Entry type from unified model
      format = schemaItem.format
      fields = schemaItem.fields
    } else {
      // Collection entry
      const defaultEntry = getDefaultEntryType(schemaItem.entries)
      format = defaultEntry?.format || 'json'
      fields = defaultEntry?.fields || []
    }

    if (format === 'json') {
      const data = JSON.parse(raw) as Record<string, unknown>
      doc = {
        collection: schemaItem.logicalPath,
        collectionName: schemaItem.name,
        format: 'json',
        data,
        relativePath,
        absolutePath,
      }
    } else {
      const parsed = matter(raw)
      doc = {
        collection: schemaItem.logicalPath,
        collectionName: schemaItem.name,
        format: format,
        data: (parsed.data as Record<string, unknown>) ?? {},
        body: parsed.content,
        relativePath,
        absolutePath,
      }
    }

    // Automatic reference resolution (defaults to true)
    if (options.resolveReferences !== false) {
      doc.data = await this.resolveReferencesInData(doc.data, fields)
    }

    return doc
  }

  async write(
    collectionPath: LogicalPath,
    slug: EntrySlug | '' = '',
    input: WriteInput,
    entryTypeName?: string
  ): Promise<ContentDocument> {
    const idIndex = await this.idIndex()
    const schemaItem = this.assertSchemaItem(collectionPath)

    // Determine expected format based on entry type
    let expectedFormat: ContentFormat
    if (schemaItem.type === 'entry-type') {
      expectedFormat = schemaItem.format
    } else {
      // For collections, determine format from specified or default entry type
      let entryTypeConfig: EntryTypeConfig | undefined
      if (entryTypeName) {
        entryTypeConfig = schemaItem.entries?.find(e => e.name === entryTypeName)
        if (!entryTypeConfig) {
          throw new ContentStoreError(`Entry type '${entryTypeName}' not found in collection`)
        }
      } else {
        entryTypeConfig = getDefaultEntryType(schemaItem.entries)
      }
      expectedFormat = entryTypeConfig?.format || 'json'
    }

    if (expectedFormat !== input.format) {
      throw new ContentStoreError(
        `Format mismatch: expects ${expectedFormat}, got ${input.format}`
      )
    }
    const { absolutePath, relativePath, id } = await this.buildPaths(schemaItem, slug, { entryTypeName })
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })

    if (input.format === 'json') {
      const json = JSON.stringify(input.data ?? {}, null, 2)
      await fs.writeFile(absolutePath, `${json}\n`, 'utf8')

      // Update index (ID is already in filename)
      if (id) {
        const existing = idIndex.findById(id)
        if (existing) {
          // Update if path changed, otherwise do nothing
          if (existing.relativePath !== relativePath) {
            idIndex.updatePath(id, relativePath)
          }
        } else {
          // Add new entry to index
          idIndex.add({
            type: 'entry',
            relativePath,
            collection: collectionPath,
            slug: slug || undefined,
          })
        }
      }

      return {
        collection: schemaItem.logicalPath,
        collectionName: schemaItem.name,
        format: 'json',
        data: input.data ?? {},
        relativePath,
        absolutePath,
      }
    }

    const file = matter.stringify(input.body, input.data ?? {})
    await fs.writeFile(absolutePath, file, 'utf8')

    // Update index (ID is already in filename)
    if (id) {
      const existing = idIndex.findById(id)
      if (existing) {
        // Update if path changed, otherwise do nothing
        if (existing.relativePath !== relativePath) {
          idIndex.updatePath(id, relativePath)
        }
      } else {
        // Add new entry to index
        idIndex.add({
          type: 'entry',
          relativePath,
          collection: collectionPath,
          slug: slug || undefined,
        })
      }
    }

    return {
      collection: schemaItem.logicalPath,
      collectionName: schemaItem.name,
      format: input.format,
      data: input.data ?? {},
      body: input.body,
      relativePath,
      absolutePath,
    }
  }

  /**
   * Read an entry by its ID (UUID).
   * Returns null if the ID doesn't exist or points to a collection.
   */
  async readById(id: ContentId): Promise<ContentDocument | null> {
    const idIndex = await this.idIndex()
    const location = idIndex.findById(id)
    if (!location || location.type !== 'entry') return null
    return this.read(location.collection!, location.slug!)
  }

  /**
   * Get the ID for an entry given its collection and slug.
   * Returns null if no ID exists yet.
   */
  async getIdForEntry(collectionPath: LogicalPath, slug: EntrySlug): Promise<ContentId | null> {
    const idIndex = await this.idIndex()
    const { relativePath } = await this.buildPaths(this.assertCollection(collectionPath), slug)
    const id = idIndex.findByPath(relativePath)
    // IDs in the index were validated on write (12-char Base58); safe to cast
    return id ? (id as ContentId) : null
  }

  /**
   * Delete an entry and remove it from the index.
   */
  async delete(collectionPath: LogicalPath, slug: EntrySlug): Promise<void> {
    const idIndex = await this.idIndex()
    const collection = this.assertCollection(collectionPath)
    const { absolutePath, relativePath } = await this.buildPaths(collection, slug)

    // Get ID before deleting
    const id = idIndex.findByPath(relativePath)

    // Delete file
    await fs.unlink(absolutePath)

    // Remove from index
    if (id) {
      idIndex.remove(id)
    }
  }

  /**
   * Rename an entry by changing its slug (middle segment of filename).
   * Entry filename pattern: {entryTypeName}.{slug}.{id}.{ext}
   *
   * @param collectionPath - Logical path to the collection
   * @param currentSlug - Current slug of the entry
   * @param newSlug - New slug (must be unique within collection)
   * @returns Object with new logical path
   * @throws ContentStoreError if entry doesn't exist, new slug conflicts, or validation fails
   */
  async renameEntry(
    collectionPath: LogicalPath,
    currentSlug: EntrySlug,
    newSlug: EntrySlug
  ): Promise<{ newPath: LogicalPath }> {
    const idIndex = await this.idIndex()
    const collection = this.assertCollection(collectionPath)

    // Validate new slug format
    validateSlug(newSlug)
    const safeNewSlug = newSlug.replace(/^\/+/, '')
    if (!safeNewSlug) {
      throw new ContentStoreError('New slug cannot be empty')
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(safeNewSlug)) {
      throw new ContentStoreError(
        'Slug must start with a letter or number and contain only lowercase letters, numbers, and hyphens'
      )
    }

    // Get current file path
    const { absolutePath: currentPath, relativePath: currentRelPath, id } = await this.buildPaths(
      collection,
      currentSlug
    )

    // Verify current file exists
    try {
      await fs.access(currentPath)
    } catch {
      throw new ContentStoreError(`Entry not found: ${currentSlug}`)
    }

    // If slugs are the same, no-op
    if (currentSlug === safeNewSlug) {
      return { newPath: `${collectionPath}/${currentSlug}` as LogicalPath }
    }

    // Extract entry type name and extension from current filename
    const currentFilename = path.basename(currentPath)
    const parts = currentFilename.split('.')
    if (parts.length < 4) {
      throw new ContentStoreError(`Invalid entry filename format: ${currentFilename}`)
    }

    const entryTypeName = parts[0]
    const contentId = parts[parts.length - 2]
    const ext = `.${parts[parts.length - 1]}`

    // Build new filename with new slug
    const newFilename = `${entryTypeName}.${safeNewSlug}.${contentId}${ext}`
    const parentDir = path.dirname(currentPath)
    const newPath = path.join(parentDir, newFilename)

    // Check if any file with the new slug already exists (regardless of ID)
    // Need to check for pattern: {entryTypeName}.{newSlug}.{any-id}{ext}
    try {
      const entries = await fs.readdir(parentDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) continue

        // Extract slug from filename using the same pattern
        const existingSlug = extractSlugFromFilename(entry.name, entryTypeName)
        if (existingSlug === safeNewSlug) {
          throw new ContentStoreError(
            `Entry with slug "${safeNewSlug}" already exists in collection "${collectionPath}"`
          )
        }
      }
    } catch (err) {
      // Re-throw "already exists" errors
      if ((err as Error).message.includes('already exists')) {
        throw err
      }
      // Ignore other errors (e.g., ENOENT if parent dir doesn't exist)
    }

    // Atomically rename the file
    await fs.rename(currentPath, newPath)

    // Update the ID index
    const newRelativePath = path.relative(this.root, newPath)
    if (id) {
      idIndex.updatePath(id, newRelativePath)
    }

    // Return new logical path
    const newLogicalPath = `${collectionPath}/${safeNewSlug}` as LogicalPath
    return { newPath: newLogicalPath }
  }

  /**
   * List all entries in a collection.
   * Returns array of entry metadata (relativePath, collection, slug).
   * Returns empty array if the collection doesn't exist.
   */
  async listCollectionEntries(
    collectionPath: LogicalPath
  ): Promise<Array<{ relativePath: PhysicalPath; collection: LogicalPath; slug: EntrySlug }>> {
    const idIndex = await this.idIndex()

    // Try to find the collection in the schema index
    // The schema index uses normalized logical paths like "content/authors"
    // But we might receive either "authors" or "content/authors"
    const normalized = normalizeFilesystemPath(collectionPath)
    let item = this.schemaIndex.get(normalized)

    // If not found by full path, try matching the last segment
    // (handles cases where caller passes "posts" instead of "content/posts")
    if (!item) {
      for (const schemaItem of this.schemaIndex.values()) {
        if (schemaItem.type === 'collection') {
          const lastSegment = schemaItem.logicalPath.split('/').pop()
          if (lastSegment === collectionPath) {
            item = schemaItem
            break
          }
        }
      }
    }

    // Return empty array if collection doesn't exist or isn't a collection
    if (!item || item.type !== 'collection') {
      return []
    }

    const collection = item

    // Get entries directly from collection index (O(1) + O(m))
    // The index now stores logical collection paths, so we can look up directly
    const baseEntries = idIndex.getEntriesInCollection(collection.logicalPath)

    // Filter and map to required format
    const entries: Array<{ relativePath: PhysicalPath; collection: LogicalPath; slug: EntrySlug }> = []

    for (const location of baseEntries) {
      if (location.type === 'entry' && location.slug) {
        // Include entries in this collection or subcollections
        if (location.collection === collection.logicalPath ||
            location.collection?.startsWith(collection.logicalPath + '/')) {
          entries.push({
            relativePath: location.relativePath,
            collection: location.collection,
            slug: location.slug
          })
        }
      }
    }

    return entries
  }

  /**
   * Recursively resolve reference fields in data.
   * This traverses objects, arrays, and blocks to find and resolve all reference fields.
   */
  private async resolveReferencesInData(
    data: Record<string, unknown>,
    fields: readonly any[]
  ): Promise<Record<string, unknown>> {
    const resolved = { ...data }
    const idIndex = await this.idIndex()

    for (const field of fields) {
      const value = data[field.name]

      if (field.type === 'reference') {
        // Single reference
        if (typeof value === 'string' && value) {
          resolved[field.name] = await this.resolveSingleReference(value, idIndex)
        }
        // Array of references (list: true)
        else if (field.list && Array.isArray(value)) {
          resolved[field.name] = await Promise.all(
            value.map((id) =>
              typeof id === 'string' ? this.resolveSingleReference(id, idIndex) : null
            )
          )
        }
      }
      // Recursively handle nested objects
      else if (field.type === 'object' && field.fields && value) {
        if (field.list && Array.isArray(value)) {
          resolved[field.name] = await Promise.all(
            value.map((item) =>
              typeof item === 'object' && item !== null
                ? this.resolveReferencesInData(item as Record<string, unknown>, field.fields!)
                : item
            )
          )
        } else if (typeof value === 'object') {
          resolved[field.name] = await this.resolveReferencesInData(
            value as Record<string, unknown>,
            field.fields
          )
        }
      }
      // Recursively handle blocks
      else if (field.type === 'block' && field.templates && Array.isArray(value)) {
        resolved[field.name] = await Promise.all(
          value.map(async (block: any) => {
            if (!block || typeof block.value !== 'object') return block
            const template = field.templates!.find((t: any) => t.name === block.template)
            if (!template) return block

            return {
              ...block,
              value: await this.resolveReferencesInData(block.value, template.fields),
            }
          })
        )
      }
    }

    return resolved
  }

  /**
   * Resolve a single reference ID to full entry data.
   * Returns null if the reference is invalid or missing.
   * Includes id, slug, and collection fields for debugging.
   */
  private async resolveSingleReference(
    id: string,
    idIndex: ContentIdIndex
  ): Promise<Record<string, unknown> | null> {
    try {
      const location = idIndex.findById(id)

      if (!location || location.type !== 'entry' || !location.collection || !location.slug) {
        return null
      }

      // Read the referenced entry WITHOUT resolving its references (prevent infinite loops)
      const doc = await this.read(location.collection, location.slug, { resolveReferences: false })

      return {
        id,
        slug: location.slug,
        collection: location.collection,
        ...doc.data,
      }
    } catch (error) {
      console.error(`Failed to resolve reference ${id}:`, error)
      return null
    }
  }
}
