import fs from 'node:fs/promises'
import path from 'node:path'

import matter from 'gray-matter'

import type { ContentFormat, CanopyConfig, FlatCollection } from './config'
import { flattenSchema, resolveSchema } from './config'
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
  private readonly schemaIndex: Map<string, FlatCollection>
  private readonly _idIndex: ContentIdIndex
  private indexLoaded: boolean = false

  constructor(root: string, config: CanopyConfig) {
    this.root = path.resolve(root)
    const resolved = resolveSchema(config.schema, config.contentRoot ?? 'content')
    const flat = flattenSchema(resolved)
    this.schemaIndex = new Map(flat.map((c) => [c.fullPath, c]))
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

  private assertCollection(collectionPath: string): FlatCollection {
    const normalized = collectionPath.split(/[\\/]+/).filter(Boolean).join('/')
    const collection = this.schemaIndex.get(normalized)
    if (!collection) {
      throw new ContentStoreError(`Unknown collection: ${collectionPath}`)
    }
    return collection
  }

  private extensionFor(format: ContentFormat): string {
    if (format === 'md') return '.md'
    if (format === 'mdx') return '.mdx'
    return '.json'
  }

  private buildPaths(collection: FlatCollection, slug: string) {
    const ext = this.extensionFor(collection.format)
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`

    if (collection.type === 'entry') {
      const resolvedEntryPath = path.resolve(this.root, `${collection.fullPath}${ext}`)
      if (!resolvedEntryPath.startsWith(rootWithSep)) {
        throw new ContentStoreError('Path traversal detected')
      }
      return {
        absolutePath: resolvedEntryPath,
        relativePath: path.relative(this.root, resolvedEntryPath),
      }
    }

    const safeSlug = slug.replace(/^\/+/, '')
    if (!safeSlug) {
      throw new ContentStoreError('Slug is required for collection entries')
    }
    // Validate slug doesn't contain path separators
    validateSlug(safeSlug)
    const collectionRoot = path.resolve(this.root, collection.fullPath)
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

  /**
   * Trivial path resolution: last segment = slug, rest = collection path
   * This enables clean URLs like /content/books/1995/biography where:
   * - Collection path: books/1995
   * - Slug: biography
   * OR entry path: books/1995/biography (if it's an entry type)
   */
  resolvePath(pathSegments: string[]): { schemaItem: FlatCollection; slug: string } {
    if (pathSegments.length === 0) {
      throw new ContentStoreError('Empty path')
    }

    // Last segment is the slug (or entry name)
    const slug = pathSegments[pathSegments.length - 1]
    const collectionPath = pathSegments.slice(0, -1).join('/')

    // Try as collection + slug
    const normalized = collectionPath.split(/[\\/]+/).filter(Boolean).join('/')
    const collection = this.schemaIndex.get(normalized)
    if (collection?.type === 'collection') {
      return { schemaItem: collection, slug }
    }

    // Try as entry (full path, no slug)
    const fullPath = pathSegments.join('/')
    const normalizedFull = fullPath.split(/[\\/]+/).filter(Boolean).join('/')
    const entry = this.schemaIndex.get(normalizedFull)
    if (entry?.type === 'entry') {
      return { schemaItem: entry, slug: '' }
    }

    throw new ContentStoreError(`No schema item found for path: ${fullPath}`)
  }

  resolveDocumentPath(collectionPath: string, slug = '') {
    const collection = this.assertCollection(collectionPath)
    return this.buildPaths(collection, slug)
  }

  async read(
    collectionPath: string,
    slug = '',
    options: { resolveReferences?: boolean } = {}
  ): Promise<ContentDocument> {
    const collection = this.assertCollection(collectionPath)
    const { absolutePath, relativePath } = this.buildPaths(collection, slug)
    const raw = await fs.readFile(absolutePath, 'utf8')

    let doc: ContentDocument

    if (collection.format === 'json') {
      const data = JSON.parse(raw) as Record<string, unknown>
      doc = {
        collection: collection.fullPath,
        collectionName: collection.name,
        format: 'json',
        data,
        relativePath,
        absolutePath,
      }
    } else {
      const parsed = matter(raw)
      doc = {
        collection: collection.fullPath,
        collectionName: collection.name,
        format: collection.format,
        data: (parsed.data as Record<string, unknown>) ?? {},
        body: parsed.content,
        relativePath,
        absolutePath,
      }
    }

    // Automatic reference resolution (defaults to true)
    if (options.resolveReferences !== false) {
      doc.data = await this.resolveReferencesInData(doc.data, collection.fields)
    }

    return doc
  }

  async write(collectionPath: string, slug = '', input: WriteInput): Promise<ContentDocument> {
    const idIndex = await this.idIndex()
    const collection = this.assertCollection(collectionPath)
    if (collection.format !== input.format) {
      throw new ContentStoreError(
        `Format mismatch: collection expects ${collection.format}, got ${input.format}`
      )
    }
    const { absolutePath, relativePath } = this.buildPaths(collection, slug)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })

    if (input.format === 'json') {
      const json = JSON.stringify(input.data ?? {}, null, 2)
      await fs.writeFile(absolutePath, `${json}\n`, 'utf8')

      // Assign ID (index.add() will check if ID already exists and return early)
      await idIndex.add({
        type: 'entry',
        relativePath,
        collection: collectionPath,
        slug
      })

      return {
        collection: collection.fullPath,
        collectionName: collection.name,
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
      slug
    })

    return {
      collection: collection.fullPath,
      collectionName: collection.name,
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
    const { relativePath } = this.buildPaths(
      this.assertCollection(collectionPath),
      slug
    )
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
    fields: any[]
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
