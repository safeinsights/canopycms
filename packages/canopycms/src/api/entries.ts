import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

import matter from 'gray-matter'

import type { FieldConfig, ContentFormat, FlatSchemaItem } from '../config'
import { ContentStoreError } from '../content-store'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { defineEndpoint } from './route-builder'
import { getFormatExtension } from '../utils/format'

type CollectionKind = 'collection' | 'entry'

export interface EntryCollectionSummary {
  id: string
  name: string
  label?: string
  path: string
  format: ContentFormat
  type: CollectionKind
  schema: readonly FieldConfig[]
  parentId?: string
  children?: EntryCollectionSummary[]
}

export interface CollectionItem {
  id: string
  slug: string
  collectionId: string
  collectionName: string
  format: ContentFormat
  itemType: 'entry' | 'singleton'
  path: string
  title?: string
  updatedAt?: string
  exists?: boolean
}

export interface ListEntriesParams {
  branch: string
  collection?: string
  limit?: number
  cursor?: string
  q?: string
  recursive?: boolean
}

export interface ListEntriesResponse {
  collections: EntryCollectionSummary[]
  entries: CollectionItem[]
  pagination: {
    cursor?: string
    hasMore: boolean
    limit: number
  }
}

/** Response type for listing entries */
export type EntriesResponse = ApiResponse<ListEntriesResponse>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const listEntriesParamsSchema = z.object({
  branch: z.string().min(1),
  collection: z.string().optional(),
  limit: z.number().optional(),
  cursor: z.string().optional(),
  q: z.string().optional(),
  recursive: z.boolean().optional(),
})

const normalizePath = (root: string, target: string): string => {
  const resolvedRoot = path.resolve(root)
  const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`
  const resolvedTarget = path.resolve(target)
  if (!resolvedTarget.startsWith(withSep)) {
    throw new ContentStoreError('Path traversal detected')
  }
  return path.relative(resolvedRoot, resolvedTarget).split(path.sep).join('/')
}

const readTitle = async (filePath: string, format: ContentFormat): Promise<string | undefined> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    if (format === 'json') {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const title = parsed.title ?? parsed.name
      return typeof title === 'string' ? title : undefined
    }
    const parsed = matter(raw)
    const frontmatterTitle = (parsed.data as any)?.title ?? (parsed.data as any)?.name
    return typeof frontmatterTitle === 'string' ? frontmatterTitle : undefined
  } catch {
    return undefined
  }
}

const listCollectionEntries = async (
  root: string,
  collection: FlatSchemaItem,
): Promise<CollectionItem[]> => {
  // Only collections with entries can be listed
  if (collection.type !== 'collection' || !collection.entries) {
    return []
  }

  const format = collection.entries.format || 'json'
  const ext = getFormatExtension(format)
  const collectionRoot = path.resolve(root, collection.fullPath)
  normalizePath(root, collectionRoot)
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(collectionRoot, { withFileTypes: true })
  } catch (err: any) {
    if (err?.code === 'ENOENT') return []
    throw err
  }

  const files = dirents
    .filter((d) => d.isFile() && d.name.endsWith(ext))
    .sort((a, b) => a.name.localeCompare(b.name))

  // Parallelize file stats and title reads for better performance
  const entries = await Promise.all(
    files.map(async (file) => {
      const absolutePath = path.join(collectionRoot, file.name)
      const relativePath = normalizePath(root, absolutePath)
      const slug = file.name.slice(0, -ext.length)
      const [stats, title] = await Promise.all([
        fs.stat(absolutePath),
        readTitle(absolutePath, format),
      ])
      return {
        id: `${collection.fullPath}/${slug}`,
        slug,
        collectionId: collection.fullPath,
        collectionName: collection.name,
        format,
        itemType: 'entry' as const,
        path: relativePath,
        title,
        updatedAt: stats.mtime.toISOString(),
        exists: true,
      }
    }),
  )
  return entries
}

/**
 * List entries from a collection and all its nested child collections
 */
const listCollectionEntriesRecursive = async (
  root: string,
  targetPath: string,
  flatCollections: FlatSchemaItem[],
): Promise<CollectionItem[]> => {
  // Find all collections that are descendants of the target path
  const descendants = flatCollections.filter((item) => {
    return item.fullPath === targetPath || item.fullPath.startsWith(`${targetPath}/`)
  })

  // Parallelize listing entries from all descendant collections
  const collectionsWithEntries = descendants.filter(
    (item) => item.type === 'collection' && item.entries,
  )
  const results = await Promise.all(
    collectionsWithEntries.map((item) => listCollectionEntries(root, item)),
  )

  return results.flat()
}

const normalizeCollectionId = (value: string): string =>
  value
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')

/**
 * Build collection summaries from flat schema items.
 * Includes both collections and singletons.
 */
const buildCollectionSummaries = (
  flatCollections: FlatSchemaItem[],
  targetId?: string,
): EntryCollectionSummary[] => {
  // Filter to target collection and its descendants if targetId is provided
  const filtered = targetId
    ? flatCollections.filter(
        (item) => item.fullPath === targetId || item.fullPath.startsWith(`${targetId}/`),
      )
    : flatCollections

  // Convert to summaries
  return filtered.map((item) => {
    if (item.type === 'collection') {
      return {
        id: item.fullPath,
        name: item.name,
        label: item.label,
        path: item.fullPath,
        format: item.entries?.format || 'json',
        type: 'collection' as const,
        schema: item.entries?.fields || [],
        parentId: item.parentPath,
      }
    } else {
      // Singleton - use old 'entry' terminology for backward compatibility in API
      return {
        id: item.fullPath,
        name: item.name,
        label: item.label,
        path: item.fullPath,
        format: item.format,
        type: 'entry' as const, // Old terminology for singletons
        schema: item.fields,
        parentId: item.parentPath,
      }
    }
  })
}

export const listEntriesHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof listEntriesParamsSchema>,
): Promise<EntriesResponse> => {
  if (!params.branch) {
    return { ok: false, status: 400, error: 'branch is required' }
  }

  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const root = context.branchRoot
  const flatCollections = ctx.services.flatSchema

  const targetId = params.collection ? normalizeCollectionId(params.collection) : undefined
  let targetCollections = flatCollections

  if (targetId) {
    const match = flatCollections.find((c) => c.fullPath === targetId)
    if (!match) {
      return { ok: false, status: 404, error: 'Collection not found' }
    }
    targetCollections = [match]
  }

  const maxLimit = 200
  const limit = Math.min(Math.max(params.limit ?? 50, 1), maxLimit)
  const offset = Number.isFinite(Number(params.cursor)) ? Number(params.cursor) : 0
  const search = params.q?.toLowerCase()
  const recursive = params.recursive ?? false

  const entries: CollectionItem[] = []

  if (recursive && targetId) {
    // Recursive mode: list entries from target collection and all its children
    try {
      const items = await listCollectionEntriesRecursive(root, targetId, flatCollections)
      items.sort((a, b) => a.slug.localeCompare(b.slug))
      for (const item of items) {
        // Use the path already included in the item
        const access = await ctx.services.checkContentAccess(
          context,
          root,
          item.path,
          req.user,
          'read',
        )
        if (!access.allowed) continue
        if (search) {
          const haystack =
            `${item.slug} ${item.title ?? ''} ${item.collectionName ?? ''}`.toLowerCase()
          if (!haystack.includes(search)) {
            continue
          }
        }
        entries.push(item)
      }
    } catch (err) {
      if (err instanceof ContentStoreError) {
        return { ok: false, status: 400, error: err.message }
      }
      throw err
    }
  } else {
    // Non-recursive mode: list entries from target collections and singletons
    for (const item of targetCollections) {
      // Handle singletons
      if (item.type === 'singleton') {
        try {
          // Try to read the singleton file to get its title
          const format = item.format
          const ext = getFormatExtension(format)
          const singletonPath = path.resolve(root, `${item.fullPath}${ext}`)

          let title: string | undefined
          let exists = false
          try {
            await fs.readFile(singletonPath, 'utf8')
            exists = true
            title = await readTitle(singletonPath, format)
          } catch (err: any) {
            if (err?.code !== 'ENOENT') throw err
            // File doesn't exist yet - that's okay for singletons
          }

          // Check permissions
          const relativePath = path.relative(root, singletonPath)
          const access = await ctx.services.checkContentAccess(
            context,
            root,
            relativePath,
            req.user,
            'read',
          )
          if (!access.allowed) continue

          // Apply search filter
          if (search) {
            const haystack = `${item.name} ${title ?? ''} ${item.label ?? ''}`.toLowerCase()
            if (!haystack.includes(search)) {
              continue
            }
          }

          entries.push({
            id: item.fullPath,
            slug: '',
            collectionId: item.fullPath,
            collectionName: item.name,
            format,
            itemType: 'singleton',
            path: relativePath,
            title: title || item.label || item.name,
            exists,
          })
        } catch (err) {
          if (err instanceof ContentStoreError) {
            return { ok: false, status: 400, error: err.message }
          }
          throw err
        }
        continue
      }

      // Handle collections
      try {
        const items = await listCollectionEntries(root, item)
        items.sort((a, b) => a.slug.localeCompare(b.slug))
        for (const entry of items) {
          // Use the path already included in the item
          const access = await ctx.services.checkContentAccess(
            context,
            root,
            entry.path,
            req.user,
            'read',
          )
          if (!access.allowed) continue
          if (search) {
            const haystack =
              `${entry.slug} ${entry.title ?? ''} ${entry.collectionName ?? ''}`.toLowerCase()
            if (!haystack.includes(search)) {
              continue
            }
          }
          entries.push(entry)
        }
      } catch (err) {
        if (err instanceof ContentStoreError) {
          return { ok: false, status: 400, error: err.message }
        }
        throw err
      }
    }
  }

  const paged = entries.slice(offset, offset + limit)
  const nextCursor = offset + limit < entries.length ? String(offset + limit) : undefined

  const collections = buildCollectionSummaries(flatCollections, targetId)

  return {
    ok: true,
    status: 200,
    data: {
      collections,
      entries: paged,
      pagination: {
        cursor: nextCursor,
        hasMore: Boolean(nextCursor),
        limit,
      },
    },
  }
}

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * List entries for a branch
 * GET /:branch/entries
 */
export const listEntries = defineEndpoint({
  namespace: 'entries',
  name: 'list',
  method: 'GET',
  path: '/:branch/entries',
  params: listEntriesParamsSchema,
  responseType: 'EntriesResponse',
  response: {} as EntriesResponse,
  defaultMockData: {
    collections: [],
    entries: [],
    pagination: {
      hasMore: false,
      limit: 50,
    },
  },
  handler: listEntriesHandler,
})

/**
 * Exported routes for router registration
 */
export const ENTRY_ROUTES = {
  list: listEntries,
} as const
