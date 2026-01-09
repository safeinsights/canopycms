import fs from 'node:fs/promises'
import path from 'node:path'

import matter from 'gray-matter'

import type { ContentFormat, CanopyConfig, FlatSchemaItem } from './config'
import { flattenSchema } from './config'
import { ContentIdIndex } from './content-id-index'

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
      'Slugs cannot contain forward slashes. Use nested collections instead.',
    )
  }
  if (slug.includes('\\')) {
    throw new ContentStoreError('Slugs cannot contain backslashes. Use nested collections instead.')
  }
}

export class ContentStore {
  private readonly root: string
  private readonly schemaIndex: Map<string, FlatSchemaItem>
  private readonly _idIndex: ContentIdIndex
  private indexLoaded: boolean = false

  constructor(root: string, config: CanopyConfig) {
    this.root = path.resolve(root)
    const flat = flattenSchema(config.schema, config.contentRoot ?? 'content')
    this.schemaIndex = new Map(flat.map((item) => [item.fullPath, item]))
    this._idIndex = new ContentIdIndex(this.root)
  }

  /**
   * Get the ID index, ensuring it's loaded first.
   * This getter automatically loads the index on first access.
   */
  public async idIndex(): Promise<ContentIdIndex> {
    if (!this.indexLoaded) {
      await this._idIndex.buildFromSymlinks('content')
      this.indexLoaded = true
    }
    return this._idIndex
  }

  private assertSchemaItem(path: string): FlatSchemaItem {
    const normalized = path
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/')
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

  private extensionFor(format: ContentFormat): string {
    if (format === 'md') return '.md'
    if (format === 'mdx') return '.mdx'
    return '.json'
  }

  private buildPaths(schemaItem: FlatSchemaItem, slug: string) {
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`

    // Singletons: fullPath includes complete path
    if (schemaItem.type === 'singleton') {
      const format = schemaItem.format
      const ext = this.extensionFor(format)
      const resolvedPath = path.resolve(this.root, `${schemaItem.fullPath}${ext}`)

      if (!resolvedPath.startsWith(rootWithSep)) {
        throw new ContentStoreError('Path traversal detected')
      }

      return {
        absolutePath: resolvedPath,
        relativePath: path.relative(this.root, resolvedPath),
      }
    }

    // Collection entries: append slug to collection path
    if (schemaItem.type === 'collection') {
      const safeSlug = slug.replace(/^\/+/, '')
      if (!safeSlug) {
        throw new ContentStoreError('Slug is required for collection entries')
      }
      validateSlug(safeSlug)

      const format = schemaItem.entries?.format || 'json'
      const ext = this.extensionFor(format)
      const collectionRoot = path.resolve(this.root, schemaItem.fullPath)

      if (!collectionRoot.startsWith(rootWithSep)) {
        throw new ContentStoreError('Path traversal detected')
      }

      const resolved = path.resolve(collectionRoot, `${safeSlug}${ext}`)
      const collectionRootWithSep = collectionRoot.endsWith(path.sep)
        ? collectionRoot
        : `${collectionRoot}${path.sep}`

      if (!resolved.startsWith(collectionRootWithSep)) {
        throw new ContentStoreError('Path traversal detected')
      }

      return {
        absolutePath: resolved,
        relativePath: path.relative(this.root, resolved),
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
    const normalized = fullPath
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/')

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
    const normalizedCollection = collectionPath
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/')
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

  resolveDocumentPath(schemaPath: string, slug = '') {
    const schemaItem = this.assertSchemaItem(schemaPath)
    return this.buildPaths(schemaItem, slug)
  }

  async read(
    collectionPath: string,
    slug = '',
    options: { resolveReferences?: boolean } = {},
  ): Promise<ContentDocument> {
    const schemaItem = this.assertSchemaItem(collectionPath)
    const { absolutePath, relativePath } = this.buildPaths(schemaItem, slug)
    const raw = await fs.readFile(absolutePath, 'utf8')

    let doc: ContentDocument
    let format: ContentFormat
    let fields: any[]

    if (schemaItem.type === 'singleton') {
      format = schemaItem.format
      fields = schemaItem.fields
    } else {
      // Collection entry
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
      throw new ContentStoreError(`Format mismatch: expects ${expectedFormat}, got ${input.format}`)
    }
    const { absolutePath, relativePath } = this.buildPaths(schemaItem, slug)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })

    if (input.format === 'json') {
      const json = JSON.stringify(input.data ?? {}, null, 2)
      await fs.writeFile(absolutePath, `${json}\n`, 'utf8')

      // Assign ID (index.add() will check if ID already exists and return early)
      await idIndex.add({
        type: 'entry',
        relativePath,
        collection: collectionPath,
        slug,
      })

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

    // Assign ID (index.add() will check if ID already exists and return early)
    await idIndex.add({
      type: 'entry',
      relativePath,
      collection: collectionPath,
      slug,
    })

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
    const { relativePath } = this.buildPaths(this.assertCollection(collectionPath), slug)
    return idIndex.findByPath(relativePath)
  }

  /**
   * Delete an entry and its associated ID symlink.
   */
  async delete(collectionPath: string, slug: string): Promise<void> {
    const idIndex = await this.idIndex()
    const collection = this.assertCollection(collectionPath)
    const { absolutePath, relativePath } = this.buildPaths(collection, slug)

    // Get ID before deleting
    const id = idIndex.findByPath(relativePath)

    // Delete file
    await fs.unlink(absolutePath)

    // Remove symlink
    if (id) {
      await idIndex.remove(id)
    }
  }

  /**
   * Recursively resolve reference fields in data.
   * This traverses objects, arrays, and blocks to find and resolve all reference fields.
   */
  private async resolveReferencesInData(
    data: Record<string, unknown>,
    fields: any[],
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
              typeof id === 'string' ? this.resolveSingleReference(id, idIndex) : null,
            ),
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
                : item,
            ),
          )
        } else if (typeof value === 'object') {
          resolved[field.name] = await this.resolveReferencesInData(
            value as Record<string, unknown>,
            field.fields,
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
          }),
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
    idIndex: ContentIdIndex,
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
