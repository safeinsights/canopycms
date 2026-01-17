import fs from 'node:fs/promises'
import path from 'node:path'

import matter from 'gray-matter'

import type { ContentFormat, FlatSchemaItem } from './config'
import { ContentIdIndex, extractIdFromFilename, extractSlugFromFilename, resolveCollectionPath } from './content-id-index'
import { generateId } from './id'
import { getFormatExtension } from './utils/format'

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
  collection: string
  collectionName: string
  relativePath: string
  absolutePath: string
}

export type WriteInput =
  | { format: 'md' | 'mdx'; data?: Record<string, unknown>; body: string }
  | { format: 'json'; data: Record<string, unknown> }

export class ContentStoreError extends Error {}

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
    this.schemaIndex = new Map(flatSchema.map((item) => [item.fullPath, item]))
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

  private assertSchemaItem(path: string): FlatSchemaItem {
    const normalized = path.split(/[\\/]+/).filter(Boolean).join('/')
    const item = this.schemaIndex.get(normalized)
    if (!item) {
      throw new ContentStoreError(`Unknown schema item: ${path}`)
    }
    return item
  }

  private assertCollection(collectionPath: string): FlatSchemaItem & { type: 'collection' } {
    const item = this.assertSchemaItem(collectionPath)
    if (item.type !== 'collection') {
      throw new ContentStoreError(`Path is not a collection: ${collectionPath}`)
    }
    return item
  }

  /**
   * Build absolute and relative paths with security validation.
   * For collection entries, includes the ID in the filename.
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
   */
  private async buildPaths(
    schemaItem: FlatSchemaItem,
    slug: string,
    options: { existingId?: string } = {}
  ): Promise<{ absolutePath: string; relativePath: string; id?: string }> {
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`

    // Singletons: fullPath includes complete path, but filename may have embedded ID
    if (schemaItem.type === 'singleton') {
      const format = schemaItem.format
      const ext = getFormatExtension(format)

      // Try to find existing singleton file with embedded ID
      // Pattern: {name}.{12-char-id}.{ext} or {name}.{ext}
      const singletonDir = path.dirname(path.resolve(this.root, schemaItem.fullPath))
      const singletonName = path.basename(schemaItem.fullPath)

      let resolvedPath = path.resolve(this.root, `${schemaItem.fullPath}${ext}`)

      // Check if file with embedded ID exists
      try {
        const entries = await fs.readdir(singletonDir, { withFileTypes: true })
        const matchingFile = entries.find((entry) => {
          if (!entry.isFile()) return false
          if (!entry.name.endsWith(ext)) return false
          // Extract slug from filename (part before the ID)
          const slug = extractSlugFromFilename(entry.name)
          return slug === singletonName
        })

        if (matchingFile) {
          resolvedPath = path.resolve(singletonDir, matchingFile.name)
        }
      } catch (err) {
        // Directory doesn't exist yet, use default path without ID
      }

      // Security: Prevent path traversal
      if (!resolvedPath.startsWith(rootWithSep)) {
        throw new ContentStoreError('Path traversal detected')
      }

      return {
        absolutePath: resolvedPath,
        relativePath: path.relative(this.root, resolvedPath),
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

      const format = schemaItem.entries?.format || 'json'
      const ext = getFormatExtension(format)

      // Resolve the full collection path with embedded IDs
      // e.g., "content/docs/api" → "content/docs.bChqT78gcaLd/api.meiuwxTSo7UN"
      let collectionRoot = await resolveCollectionPath(this.root, schemaItem.fullPath)

      if (!collectionRoot) {
        // Collection directory doesn't exist yet - use logical path
        // (Directory will be created on write if needed)
        collectionRoot = path.resolve(this.root, schemaItem.fullPath)
      }

      // Security: Prevent path traversal at collection level
      if (!collectionRoot.startsWith(rootWithSep)) {
        throw new ContentStoreError('Path traversal detected')
      }

      // Check if file already exists (editing case)
      let id = options.existingId

      if (!id) {
        // Try to find existing file with this slug
        const entries = await fs.readdir(collectionRoot, { withFileTypes: true }).catch(() => [])
        const existingFile = entries.find((entry) => {
          if (entry.isDirectory()) return false
          const existingSlug = extractSlugFromFilename(entry.name)
          return existingSlug === safeSlug
        })

        if (existingFile) {
          id = extractIdFromFilename(existingFile.name) || undefined
        }
      }

      // Generate new ID if needed
      if (!id) {
        id = generateId()
      }

      // Build filename with embedded ID: slug.id.ext
      const filename = `${safeSlug}.${id}${ext}`
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
        relativePath: path.relative(this.root, resolved),
        id,
      }
    }

    throw new ContentStoreError('Invalid schema item type')
  }

  /**
   * Path resolution: resolves a URL path to a schema item
   * - Try as singleton first (full path match)
   * - Then try as collection + slug (last segment = slug)
   */
  resolvePath(pathSegments: string[]): {
    schemaItem: FlatSchemaItem
    slug: string
    itemType: 'entry' | 'singleton'
  } {
    if (pathSegments.length === 0) {
      throw new ContentStoreError('Empty path')
    }

    const fullPath = pathSegments.join('/')
    const normalized = fullPath.split(/[\\/]+/).filter(Boolean).join('/')

    // Try as singleton first
    const singleton = this.schemaIndex.get(normalized)
    if (singleton?.type === 'singleton') {
      return {
        schemaItem: singleton,
        slug: '',
        itemType: 'singleton',
      }
    }

    // Try as collection + slug
    const slug = pathSegments[pathSegments.length - 1]
    const collectionPath = pathSegments.slice(0, -1).join('/')
    const normalizedCollection = collectionPath.split(/[\\/]+/).filter(Boolean).join('/')
    const collection = this.schemaIndex.get(normalizedCollection)

    if (collection?.type === 'collection' && collection.entries) {
      return {
        schemaItem: collection,
        slug,
        itemType: 'entry',
      }
    }

    throw new ContentStoreError(`No schema item found for path: ${fullPath}`)
  }

  async resolveDocumentPath(schemaPath: string, slug = '') {
    const schemaItem = this.assertSchemaItem(schemaPath)
    return await this.buildPaths(schemaItem, slug)
  }

  async read(
    collectionPath: string,
    slug = '',
    options: { resolveReferences?: boolean } = {}
  ): Promise<ContentDocument> {
    const schemaItem = this.assertSchemaItem(collectionPath)
    const { absolutePath, relativePath } = await this.buildPaths(schemaItem, slug)
    const raw = await fs.readFile(absolutePath, 'utf8')

    let doc: ContentDocument
    let format: ContentFormat
    let fields: readonly any[]

    if (schemaItem.type === 'singleton') {
      format = schemaItem.format
      fields = schemaItem.fields
    } else {
      // Collection entry
      // Note: Collections can exist without entries (e.g., only containing subcollections/singletons)
      // In such cases, fallback to default format and empty fields
      format = schemaItem.entries?.format || 'json'
      fields = schemaItem.entries?.fields || []
    }

    if (format === 'json') {
      const data = JSON.parse(raw) as Record<string, unknown>
      doc = {
        collection: schemaItem.fullPath,
        collectionName: schemaItem.name,
        format: 'json',
        data,
        relativePath,
        absolutePath,
      }
    } else {
      const parsed = matter(raw)
      doc = {
        collection: schemaItem.fullPath,
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

  async write(collectionPath: string, slug = '', input: WriteInput): Promise<ContentDocument> {
    const idIndex = await this.idIndex()
    const schemaItem = this.assertSchemaItem(collectionPath)

    const expectedFormat =
      schemaItem.type === 'singleton' ? schemaItem.format : schemaItem.entries?.format || 'json'

    if (expectedFormat !== input.format) {
      throw new ContentStoreError(
        `Format mismatch: expects ${expectedFormat}, got ${input.format}`
      )
    }
    const { absolutePath, relativePath, id } = await this.buildPaths(schemaItem, slug)
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
            slug,
          })
        }
      }

      return {
        collection: schemaItem.fullPath,
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
          slug,
        })
      }
    }

    return {
      collection: schemaItem.fullPath,
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
  async readById(id: string): Promise<ContentDocument | null> {
    const idIndex = await this.idIndex()
    const location = idIndex.findById(id)
    if (!location || location.type !== 'entry') return null
    return this.read(location.collection!, location.slug!)
  }

  /**
   * Get the ID for an entry given its collection and slug.
   * Returns null if no ID exists yet.
   */
  async getIdForEntry(collectionPath: string, slug: string): Promise<string | null> {
    const idIndex = await this.idIndex()
    const { relativePath } = await this.buildPaths(this.assertCollection(collectionPath), slug)
    return idIndex.findByPath(relativePath)
  }

  /**
   * Delete an entry and remove it from the index.
   */
  async delete(collectionPath: string, slug: string): Promise<void> {
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
