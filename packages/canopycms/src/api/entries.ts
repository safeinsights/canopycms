import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import matter from 'gray-matter'

import type { FieldConfig, ContentFormat, FlatCollection, ResolvedSchemaItem } from '../config'
import { ContentStore, ContentStoreError } from '../content-store'
import { flattenSchema, resolveSchema } from '../config'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { resolveBranchWorkspace } from '../paths'

type CollectionKind = 'collection' | 'singleton'

export interface EntryCollectionSummary {
  id: string
  name: string
  label?: string
  path: string
  format: ContentFormat
  type: CollectionKind
  schema: FieldConfig[]
  parentId?: string
  children?: EntryCollectionSummary[]
}

export interface EntryListItem {
  id: string
  slug: string
  collectionId: string
  collectionName: string
  format: ContentFormat
  type: 'entry' | 'singleton'
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
}

export interface ListEntriesResponse {
  collections: EntryCollectionSummary[]
  entries: EntryListItem[]
  pagination: {
    cursor?: string
    hasMore: boolean
    limit: number
  }
}

const extensionFor = (format: ContentFormat): string => {
  if (format === 'md') return '.md'
  if (format === 'mdx') return '.mdx'
  return '.json'
}

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

const listCollectionEntries = async (root: string, collection: FlatCollection): Promise<EntryListItem[]> => {
  const ext = extensionFor(collection.format)
  const collectionRoot = path.resolve(root, collection.fullPath)
  normalizePath(root, collectionRoot)
  const entries: EntryListItem[] = []
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(collectionRoot, { withFileTypes: true })
  } catch (err: any) {
    if (err?.code === 'ENOENT') return []
    throw err
  }

  const files = dirents.filter((d) => d.isFile() && d.name.endsWith(ext)).sort((a, b) => a.name.localeCompare(b.name))
  for (const file of files) {
    const absolutePath = path.join(collectionRoot, file.name)
    const relativePath = normalizePath(root, absolutePath)
    const slug = file.name.slice(0, -ext.length)
    const stats = await fs.stat(absolutePath)
    const title = await readTitle(absolutePath, collection.format)
    entries.push({
      id: `${collection.fullPath}/${slug}`,
      slug,
      collectionId: collection.fullPath,
      collectionName: collection.name,
      format: collection.format,
      type: 'entry',
      path: relativePath,
      title,
      updatedAt: stats.mtime.toISOString(),
      exists: true,
    })
  }
  return entries
}

const singletonEntry = async (root: string, collection: FlatCollection): Promise<EntryListItem> => {
  const ext = extensionFor(collection.format)
  const absolutePath = path.resolve(root, `${collection.fullPath}${ext}`)
  const relativePath = normalizePath(root, absolutePath)
  let exists = true
  let updatedAt: string | undefined
  try {
    const stats = await fs.stat(absolutePath)
    updatedAt = stats.mtime.toISOString()
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      exists = false
    } else {
      throw err
    }
  }
  const title = exists ? await readTitle(absolutePath, collection.format) : undefined
  const slug = collection.fullPath.split('/').pop() ?? collection.name
  return {
    id: `${collection.fullPath}/singleton`,
    slug,
    collectionId: collection.fullPath,
    collectionName: collection.name,
    format: collection.format,
    type: 'singleton',
    path: relativePath,
    title,
    updatedAt,
    exists,
  }
}

const normalizeCollectionId = (value: string): string =>
  value
    .split(/[\\/]+/)
    .filter(Boolean)
    .join('/')

const toSummary = (node: ResolvedSchemaItem): EntryCollectionSummary => ({
  id: node.fullPath,
  name: node.name,
  label: node.label,
  path: node.fullPath,
  format: node.format,
  type: node.type,
  schema: node.fields,
  parentId: node.parentPath,
  children: node.children?.map(toSummary),
})

const filterSchemaTree = (
  nodes: ResolvedSchemaItem[],
  targetId?: string
): ResolvedSchemaItem[] => {
  if (!targetId) return nodes
  const filtered: ResolvedSchemaItem[] = []
  for (const node of nodes) {
    if (node.fullPath === targetId) {
      filtered.push(node)
      continue
    }
    if (node.children) {
      const childMatches = filterSchemaTree(node.children, targetId)
      if (childMatches.length > 0) {
        filtered.push({ ...node, children: childMatches })
      }
    }
  }
  return filtered
}

export const listEntries = async (
  ctx: ApiContext,
  req: ApiRequest<undefined>,
  params: ListEntriesParams
): Promise<ApiResponse<ListEntriesResponse>> => {
  if (!params.branch) {
    return { ok: false, status: 400, error: 'branch is required' }
  }

  const branchState = await ctx.getBranchState(params.branch)
  if (!branchState) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchWorkspace(branchState, branchMode)
  const root = branchPaths.branchRoot
  const store = new ContentStore(root, ctx.services.config)
  const resolvedSchema = resolveSchema(ctx.services.config.schema, ctx.services.config.contentRoot)
  const flatCollections = flattenSchema(resolvedSchema)

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

  const entries: EntryListItem[] = []
  for (const collection of targetCollections) {
    try {
      const items =
        collection.type === 'singleton'
          ? [await singletonEntry(root, collection)]
          : await listCollectionEntries(root, collection)
      items.sort((a, b) => a.slug.localeCompare(b.slug))
      for (const item of items) {
        const normalized = store.resolveDocumentPath(
          item.collectionId,
          item.type === 'singleton' ? '' : item.slug
        )
        const access = await ctx.services.checkContentAccess(branchState, root, normalized.relativePath, req.user, 'read')
        if (!access.allowed) continue
        if (search) {
          const haystack = `${item.slug} ${item.title ?? ''} ${item.collectionName ?? ''}`.toLowerCase()
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
  }

  const paged = entries.slice(offset, offset + limit)
  const nextCursor = offset + limit < entries.length ? String(offset + limit) : undefined

  const filteredSchema = filterSchemaTree(resolvedSchema, targetId)
  const collections: EntryCollectionSummary[] = filteredSchema.map(toSummary)

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
