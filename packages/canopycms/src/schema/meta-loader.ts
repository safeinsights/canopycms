import { promises as fs } from 'fs'
import { join } from 'pathe'
import { z } from 'zod'
import chokidar from 'chokidar'
import { getErrorMessage } from '../utils/error'
// canopyLogError/canopyLogWarn, not console.*: this module sits in the
// worker's runtime import closure (worker/git-sync.ts and worker/rebase.ts ->
// content-index-generation.ts -> branch-schema-cache.ts -> schema/resolver.ts
// -> here), so a bare console line would land in worker.log without the
// ISO-8601 prefix the CloudWatch agent's multi_line_start_pattern needs (see
// worker/log.ts). Plain console under Lambda/dev, as everywhere else -- see
// utils/logger.ts.
import { canopyLogError, canopyLogWarn } from '../utils/logger'

import type {
  ContentFormat,
  CollectionConfig,
  RootCollectionConfig,
  EntryTypeConfig,
} from '../config'
import type { ContentId } from '../paths/types'
import type { EntrySchemaRegistry } from './types'
import { extractSlugFromFilename, extractIdFromFilename } from '../content-id-index'

/**
 * Zod schema for entry type metadata in .collection.json files.
 * Each entry type has a name, format, and schema reference to the entry schema registry.
 */
const entryTypeMetaSchema = z.object({
  name: z.string().min(1),
  format: z.enum(['md', 'mdx', 'json', 'yaml']),
  schema: z.string().min(1), // Entry schema registry key (validated at resolution time)
  label: z.string().optional(),
  description: z.string().optional(),
  default: z.boolean().optional(),
  maxItems: z.number().int().positive().optional(),
})

/**
 * Zod schema for .collection.json files. `schema` can't be validated against
 * the entry schema registry here — the registry is only available at
 * runtime, and checking at parse time would create a loader → services →
 * config → loader circular dependency — so schema references are checked in
 * the resolution functions instead, with clear error messages.
 */
const collectionMetaSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().optional(),
    description: z.string().optional(),
    entries: z.array(entryTypeMetaSchema).optional(),
    order: z.array(z.string()).default([]), // Embedded IDs for ordering; optional in the file, [] = alphabetical
  })
  .refine((data) => data.entries && data.entries.length > 0, {
    message: 'Collection must have at least one entry type',
  })

/**
 * Zod schema for root .collection.json file (content/.collection.json)
 * Like other collections but no name/path (derived from contentRoot)
 */
const rootCollectionMetaSchema = z.object({
  label: z.string().optional(),
  entries: z.array(entryTypeMetaSchema).optional(),
  order: z.array(z.string()).optional(), // Embedded IDs for ordering items
})

export type EntryTypeMeta = {
  name: string
  format: 'md' | 'mdx' | 'json' | 'yaml'
  schema: string // Entry schema registry key
  label?: string
  default?: boolean
  maxItems?: number
}

export type CollectionMeta = {
  name: string
  label?: string
  entries?: EntryTypeMeta[]
  order: string[] // Embedded IDs for ordering; optional in the file (defaults to [] = alphabetical)
}

export type RootCollectionMeta = {
  label?: string
  entries?: EntryTypeMeta[]
  order?: string[] // Embedded IDs for ordering items
}

/** Extracts the slug only — e.g. "post.hello-world.{id}.md" -> "hello-world" (the entry-type prefix and extension are dropped too, not just the ID). */
function stripEmbeddedIdFromName(name: string): string {
  return extractSlugFromFilename(name)
}

/**
 * Recursively scans a directory for .collection.json files. Each directory
 * has at most one; a directory without one is still scanned for nested
 * collections beneath it. A collection's name comes from `.collection.json`'s
 * "name" field, not the directory name. An invalid file fails the whole scan
 * with a descriptive error.
 *
 * @param baseDir - The directory to scan (absolute path)
 * @param relativePath - Current path relative to content root (used for recursion)
 * @returns Array of collection metadata with resolved paths
 */
async function scanForCollectionMeta(
  baseDir: string,
  relativePath: string = '',
): Promise<Array<CollectionMeta & { path: string; contentId?: ContentId }>> {
  const collections: Array<CollectionMeta & { path: string; contentId?: ContentId }> = []

  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const folderName = entry.name
      const logicalName = stripEmbeddedIdFromName(folderName)
      // Extract embedded ContentId from directory name (e.g., "posts.a1b2c3d4e5f6" → "a1b2c3d4e5f6")
      const collectionContentId = extractIdFromFilename(folderName) ?? undefined
      const folderPath = relativePath ? `${relativePath}/${logicalName}` : logicalName
      const absolutePath = join(baseDir, folderName)
      const metaPath = join(absolutePath, '.collection.json')

      try {
        await fs.access(metaPath)
        const content = await fs.readFile(metaPath, 'utf-8')
        const parsed = JSON.parse(content)

        const meta = collectionMetaSchema.parse(parsed) as CollectionMeta

        collections.push({
          ...meta,
          path: folderPath,
          contentId: collectionContentId,
        })

        const nestedCollections = await scanForCollectionMeta(absolutePath, folderPath)
        collections.push(...nestedCollections)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // File exists but is invalid
          canopyLogError(`Error loading ${metaPath}:`, err)
          throw new Error(`Invalid .collection.json in ${folderPath}: ${(err as Error).message}`)
        }
        // No .collection.json - still scan subfolders in case they have collections
        const nestedCollections = await scanForCollectionMeta(absolutePath, folderPath)
        collections.push(...nestedCollections)
      }
    }

    return collections
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
}

/**
 * Loads all .collection.json meta files from contentRoot, including root.
 *
 * Meta File Structure:
 * - Root: contentRoot/.collection.json (optional, defines root-level entry types)
 * - Collections: contentRoot/[path]/.collection.json (defines collection in that directory)
 *
 * @param contentRoot - Absolute path to the content directory
 * @returns Object containing root meta (if exists) and array of collection metas with paths
 * @throws Error if any .collection.json file is malformed or invalid
 */
export async function loadCollectionMetaFiles(contentRoot: string): Promise<{
  root: RootCollectionMeta | null
  collections: Array<CollectionMeta & { path: string; contentId?: ContentId }>
}> {
  let root: RootCollectionMeta | null = null
  const rootMetaPath = join(contentRoot, '.collection.json')

  try {
    await fs.access(rootMetaPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, that's fine
    } else {
      throw err
    }
  }

  try {
    const content = await fs.readFile(rootMetaPath, 'utf-8')
    const parsed = JSON.parse(content)
    root = rootCollectionMetaSchema.parse(parsed) as RootCollectionMeta
  } catch (err) {
    // Only handle errors if the file exists (not ENOENT)
    const errno = (err as NodeJS.ErrnoException).code
    if (errno !== 'ENOENT') {
      throw new Error(`Invalid root .collection.json`)
    }
  }

  const collections = await scanForCollectionMeta(contentRoot)

  return { root, collections }
}

function resolveEntryTypes(
  entryTypes: EntryTypeMeta[],
  entrySchemaRegistry: EntrySchemaRegistry,
  contextName: string,
): EntryTypeConfig[] {
  return entryTypes.map((entryType) => {
    const resolvedSchema = entrySchemaRegistry[entryType.schema]
    if (!resolvedSchema) {
      throw new Error(
        `Schema reference "${entryType.schema}" in entry type "${entryType.name}" (${contextName}) not found in registry. ` +
          `Available schemas: ${Object.keys(entrySchemaRegistry).join(', ')}`,
      )
    }

    // Note: "body" field name validation for md/mdx formats is handled by the
    // entry schema registry (isBody constraints). Not checked here because
    // resolvedSchema includes nested object fields where "body" is a valid name.

    return {
      name: entryType.name,
      label: entryType.label,
      format: entryType.format as ContentFormat,
      schema: resolvedSchema,
      schemaRef: entryType.schema,
      default: entryType.default,
      maxItems: entryType.maxItems,
    }
  })
}

function resolveCollectionMeta(
  meta: CollectionMeta & { path: string; contentId?: ContentId },
  entrySchemaRegistry: EntrySchemaRegistry,
  allCollections: Array<CollectionMeta & { path: string; contentId?: ContentId }>,
): CollectionConfig {
  const entries =
    meta.entries && meta.entries.length > 0
      ? resolveEntryTypes(meta.entries, entrySchemaRegistry, `collection "${meta.name}"`)
      : undefined

  // Find nested collections (subfolders with .collection.json)
  const nestedCollections = allCollections.filter((col) => {
    return (
      col.path.startsWith(`${meta.path}/`) &&
      col.path.split('/').length === meta.path.split('/').length + 1
    )
  })

  const collections =
    nestedCollections.length > 0
      ? nestedCollections.map((nestedMeta) =>
          resolveCollectionMeta(nestedMeta, entrySchemaRegistry, allCollections),
        )
      : undefined

  return {
    name: meta.name,
    label: meta.label,
    path: meta.path,
    contentId: meta.contentId,
    ...(entries && { entries }),
    ...(meta.order && { order: meta.order }),
    ...(collections && { collections }),
  }
}

/**
 * Resolve schema references for root collection and all collections.
 *
 * This function takes the loaded meta files (which contain string references like "postSchema")
 * and resolves them to actual EntrySchema arrays from the entry schema registry.
 *
 * @param metaFiles - Loaded meta files from loadCollectionMetaFiles()
 * @param entrySchemaRegistry - Map of schema names to EntrySchema arrays
 * @returns Fully resolved root collection config ready for use by CanopyCMS
 * @throws Error if any schema reference doesn't exist in registry (with helpful suggestions)
 */
export function resolveCollectionReferences(
  metaFiles: {
    root: RootCollectionMeta | null
    collections: Array<CollectionMeta & { path: string; contentId?: ContentId }>
  },
  entrySchemaRegistry: EntrySchemaRegistry,
): RootCollectionConfig {
  // Build result object dynamically to avoid readonly conflicts
  const result: Record<string, unknown> = {}

  if (metaFiles.root?.label) {
    result.label = metaFiles.root.label
  }

  if (metaFiles.root?.entries && metaFiles.root.entries.length > 0) {
    result.entries = resolveEntryTypes(
      metaFiles.root.entries,
      entrySchemaRegistry,
      'root collection',
    )
  }

  if (metaFiles.root?.order) {
    result.order = metaFiles.root.order
  }

  // Resolve top-level collections (no slashes in path)
  const topLevelCollections = metaFiles.collections.filter((meta) => !meta.path.includes('/'))

  if (topLevelCollections.length > 0) {
    result.collections = topLevelCollections.map((meta) =>
      resolveCollectionMeta(meta, entrySchemaRegistry, metaFiles.collections),
    )
  }

  return result as RootCollectionConfig
}

export function watchCollectionMetaFiles(contentRoot: string, onChange: () => void): () => void {
  const watcher = chokidar.watch(`${contentRoot}/**/.collection.json`, {
    ignoreInitial: true,
  })

  watcher.on('add', onChange)
  watcher.on('change', onChange)
  watcher.on('unlink', onChange)
  // Handle watcher errors (e.g. inotify ENOSPC/EMFILE) so an unhandled 'error' event can't crash dev.
  watcher.on('error', (err) =>
    canopyLogWarn(`CanopyCMS: .collection.json watcher error: ${getErrorMessage(err)}`),
  )

  return () => watcher.close()
}
