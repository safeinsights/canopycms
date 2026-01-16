import { promises as fs } from 'fs'
import { join } from 'pathe'
import { z } from 'zod'
import chokidar from 'chokidar'

import type { ContentFormat, FieldConfig, CollectionConfig, SingletonConfig, RootCollectionConfig } from './config'

/**
 * Schema reference for entries in a collection (replaces actual FieldConfig[] with string reference)
 */
const entriesSchemaRefSchema = z.object({
  format: z.enum(['md', 'mdx', 'json']).optional(),
  fields: z.string().min(1),  // Schema registry key (validated at resolution time)
})

/**
 * Schema reference for a singleton (replaces actual FieldConfig[] with string reference)
 */
const singletonSchemaRefSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),  // Relative path within this collection
  format: z.enum(['md', 'mdx', 'json']),
  fields: z.string().min(1),  // Schema registry key (validated at resolution time)
  label: z.string().optional(),
})

/**
 * Zod schema for .collection.json files
 *
 * A collection folder can contain:
 * - entries: Repeatable items with a shared schema
 * - singletons: Single files within this collection
 *
 * Nested collections are NOT defined here - they have their own .collection.json files in subfolders.
 *
 * Note: We can't validate `fields` against registry keys at parse time because:
 * 1. Schema registry is passed at runtime (not available during Zod schema definition)
 * 2. Would create circular dependency (loader → services → config → loader)
 *
 * Validation of schema references happens in resolution functions with clear error messages.
 */
const collectionMetaSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  entries: entriesSchemaRefSchema.optional(),
  singletons: z.array(singletonSchemaRefSchema).optional(),
}).refine(
  (data) => data.entries || data.singletons,
  { message: 'Collection must have entries or singletons' }
)

/**
 * Zod schema for root .collection.json file (content/.collection.json)
 * Like other collections but no name/path (derived from contentRoot)
 */
const rootCollectionMetaSchema = z.object({
  entries: entriesSchemaRefSchema.optional(),
  singletons: z.array(singletonSchemaRefSchema).optional(),
})

export type CollectionMeta = {
  name: string
  label?: string
  entries?: {
    format?: 'md' | 'mdx' | 'json'
    fields: string  // Schema registry key
  }
  singletons?: Array<{
    name: string
    path: string
    label?: string
    format: 'md' | 'mdx' | 'json'
    fields: string  // Schema registry key
  }>
}

export type RootCollectionMeta = {
  entries?: {
    format?: 'md' | 'mdx' | 'json'
    fields: string  // Schema registry key
  }
  singletons?: Array<{
    name: string
    path: string
    label?: string
    format: 'md' | 'mdx' | 'json'
    fields: string  // Schema registry key
  }>
}

/**
 * Recursively scans a directory for .collection.json files
 * Path is derived from folder name (not in meta file)
 */
async function scanForCollectionMeta(
  baseDir: string,
  relativePath: string = ''
): Promise<Array<CollectionMeta & { path: string }>> {
  const collections: Array<CollectionMeta & { path: string }> = []

  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const folderName = entry.name
      const folderPath = relativePath ? `${relativePath}/${folderName}` : folderName
      const fullPath = join(baseDir, folderName)
      const metaPath = join(fullPath, '.collection.json')

      // Try to load collection meta file
      try {
        await fs.access(metaPath)
        const content = await fs.readFile(metaPath, 'utf-8')
        const parsed = JSON.parse(content)

        // Validate with Zod
        const meta = collectionMetaSchema.parse(parsed) as CollectionMeta

        collections.push({
          ...meta,
          path: folderPath,  // Path derived from folder name
        })

        // Recursively scan for nested collection folders (they'll have their own .collection.json files)
        const nestedCollections = await scanForCollectionMeta(fullPath, folderPath)
        collections.push(...nestedCollections)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // File exists but is invalid
          console.error(`Error loading ${metaPath}:`, err)
          throw new Error(`Invalid .collection.json in ${folderPath}: ${(err as Error).message}`)
        }
        // No .collection.json - still scan subfolders in case they have collections
        const nestedCollections = await scanForCollectionMeta(fullPath, folderPath)
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
 * Loads all .collection.json meta files from contentRoot, including root
 */
export async function loadCollectionMetaFiles(
  contentRoot: string
): Promise<{
  root: RootCollectionMeta | null
  collections: Array<CollectionMeta & { path: string }>
}> {
  // Load root .collection.json (optional)
  let root: RootCollectionMeta | null = null
  const rootMetaPath = join(contentRoot, '.collection.json')

  try {
    await fs.access(rootMetaPath)
    const content = await fs.readFile(rootMetaPath, 'utf-8')
    const parsed = JSON.parse(content)
    root = rootCollectionMetaSchema.parse(parsed) as RootCollectionMeta
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // File exists but is invalid
      console.error(`Error loading ${rootMetaPath}:`, err)
      throw new Error(`Invalid root .collection.json: ${(err as Error).message}`)
    }
    // No root .collection.json - that's okay
  }

  // Scan for collection folders
  const collections = await scanForCollectionMeta(contentRoot)

  return { root, collections }
}

/**
 * Resolve schema references for singletons
 */
function resolveSingletons(
  singletons: Array<{
    name: string
    path: string
    label?: string
    format: 'md' | 'mdx' | 'json'
    fields: string
  }>,
  schemaRegistry: Record<string, readonly FieldConfig[]>,
  contextName: string
): SingletonConfig[] {
  return singletons.map((singleton) => {
    const schema = schemaRegistry[singleton.fields]
    if (!schema) {
      throw new Error(
        `Schema reference "${singleton.fields}" in singleton "${singleton.name}" (${contextName}) not found in registry. ` +
        `Available schemas: ${Object.keys(schemaRegistry).join(', ')}`
      )
    }

    return {
      name: singleton.name,
      label: singleton.label,
      path: singleton.path,
      format: singleton.format as ContentFormat,
      fields: schema,
    }
  })
}

/**
 * Resolve schema references for a single collection
 */
function resolveCollectionMeta(
  meta: CollectionMeta & { path: string },
  schemaRegistry: Record<string, readonly FieldConfig[]>,
  allCollections: Array<CollectionMeta & { path: string }>
): CollectionConfig {
  // Build result object dynamically to avoid readonly conflicts
  const result: any = {
    name: meta.name,
    label: meta.label,
    path: meta.path,
  }

  // Resolve entries schema reference
  if (meta.entries) {
    const schema = schemaRegistry[meta.entries.fields]
    if (!schema) {
      throw new Error(
        `Schema reference "${meta.entries.fields}" in collection "${meta.name}" not found in registry. ` +
        `Available schemas: ${Object.keys(schemaRegistry).join(', ')}`
      )
    }

    result.entries = {
      format: meta.entries.format,
      fields: schema,
    }
  }

  // Resolve singletons
  if (meta.singletons && meta.singletons.length > 0) {
    result.singletons = resolveSingletons(
      meta.singletons,
      schemaRegistry,
      `collection "${meta.name}"`
    )
  }

  // Find nested collections (subfolders with .collection.json)
  const nestedCollections = allCollections.filter((col) => {
    // Nested if it starts with this collection's path + /
    return col.path.startsWith(`${meta.path}/`) &&
           col.path.split('/').length === meta.path.split('/').length + 1
  })

  if (nestedCollections.length > 0) {
    result.collections = nestedCollections.map((nestedMeta) =>
      resolveCollectionMeta(nestedMeta, schemaRegistry, allCollections)
    )
  }

  return result as CollectionConfig
}

/**
 * Resolve schema references for root collection and all collections
 */
export function resolveCollectionReferences(
  metaFiles: {
    root: RootCollectionMeta | null
    collections: Array<CollectionMeta & { path: string }>
  },
  schemaRegistry: Record<string, readonly FieldConfig[]>
): RootCollectionConfig {
  // Build result object dynamically to avoid readonly conflicts
  const result: any = {}

  // Resolve root entries
  if (metaFiles.root?.entries) {
    const schema = schemaRegistry[metaFiles.root.entries.fields]
    if (!schema) {
      throw new Error(
        `Schema reference "${metaFiles.root.entries.fields}" in root collection not found in registry. ` +
        `Available schemas: ${Object.keys(schemaRegistry).join(', ')}`
      )
    }

    result.entries = {
      format: metaFiles.root.entries.format,
      fields: schema,
    }
  }

  // Resolve root singletons
  if (metaFiles.root?.singletons && metaFiles.root.singletons.length > 0) {
    result.singletons = resolveSingletons(
      metaFiles.root.singletons,
      schemaRegistry,
      'root collection'
    )
  }

  // Resolve top-level collections (no slashes in path)
  const topLevelCollections = metaFiles.collections.filter((meta) => !meta.path.includes('/'))

  if (topLevelCollections.length > 0) {
    result.collections = topLevelCollections.map((meta) =>
      resolveCollectionMeta(meta, schemaRegistry, metaFiles.collections)
    )
  }

  return result as RootCollectionConfig
}

/**
 * Watch for changes to .collection.json files
 */
export function watchCollectionMetaFiles(
  contentRoot: string,
  onChange: () => void
): () => void {
  const watcher = chokidar.watch(
    `${contentRoot}/**/.collection.json`,
    { ignoreInitial: true }
  )

  watcher.on('add', onChange)
  watcher.on('change', onChange)
  watcher.on('unlink', onChange)

  // Return cleanup function
  return () => watcher.close()
}
