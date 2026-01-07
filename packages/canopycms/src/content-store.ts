import fs from 'node:fs/promises'
import path from 'node:path'

import matter from 'gray-matter'

import type { ContentFormat, CanopyConfig, FlatCollection } from './config'
import { flattenSchema, resolveSchema } from './config'

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
  private readonly schemaIndex: Map<string, FlatCollection>

  constructor(root: string, config: CanopyConfig) {
    this.root = path.resolve(root)
    const resolved = resolveSchema(config.schema, config.contentRoot ?? 'content')
    const flat = flattenSchema(resolved)
    this.schemaIndex = new Map(flat.map((c) => [c.fullPath, c]))
  }

  private assertCollection(collectionPath: string): FlatCollection {
    const normalized = collectionPath
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/')
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
    const normalized = collectionPath
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/')
    const collection = this.schemaIndex.get(normalized)
    if (collection?.type === 'collection') {
      return { schemaItem: collection, slug }
    }

    // Try as entry (full path, no slug)
    const fullPath = pathSegments.join('/')
    const normalizedFull = fullPath
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/')
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

  async read(collectionPath: string, slug = ''): Promise<ContentDocument> {
    const collection = this.assertCollection(collectionPath)
    const { absolutePath, relativePath } = this.buildPaths(collection, slug)
    const raw = await fs.readFile(absolutePath, 'utf8')

    if (collection.format === 'json') {
      const data = JSON.parse(raw) as Record<string, unknown>
      return {
        collection: collection.fullPath,
        collectionName: collection.name,
        format: 'json',
        data,
        relativePath,
        absolutePath,
      }
    }

    const parsed = matter(raw)
    return {
      collection: collection.fullPath,
      collectionName: collection.name,
      format: collection.format,
      data: (parsed.data as Record<string, unknown>) ?? {},
      body: parsed.content,
      relativePath,
      absolutePath,
    }
  }

  async write(collectionPath: string, slug = '', input: WriteInput): Promise<ContentDocument> {
    const collection = this.assertCollection(collectionPath)
    if (collection.format !== input.format) {
      throw new ContentStoreError(
        `Format mismatch: collection expects ${collection.format}, got ${input.format}`,
      )
    }
    const { absolutePath, relativePath } = this.buildPaths(collection, slug)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })

    if (input.format === 'json') {
      const json = JSON.stringify(input.data ?? {}, null, 2)
      await fs.writeFile(absolutePath, `${json}\n`, 'utf8')
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
}
