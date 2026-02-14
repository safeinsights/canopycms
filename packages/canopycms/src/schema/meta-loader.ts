import { promises as fs } from 'fs'
import { join } from 'pathe'
import { z } from 'zod'
import chokidar from 'chokidar'

import type { ContentFormat, FieldConfig, CollectionConfig, RootCollectionConfig, EntryTypeConfig } from '../config'
import { extractSlugFromFilename } from '../content-id-index'

/**
 * Schema reference for entry types in a collection.
 * Each entry type has a name, format, and fields reference to the schema registry.
 */
const entryTypeSchemaRefSchema = z.object({
  name: z.string().min(1),
  format: z.enum(['md', 'mdx', 'json']),
  fields: z.string().min(1),  // Schema registry key (validated at resolution time)
  label: z.string().optional(),
  default: z.boolean().optional(),
  maxItems: z.number().int().positive().optional(),
})

/**
 * Zod schema for .collection.json files
 *
 * A collection folder can contain:
 * - entries: Array of entry types with their own schemas
 * - collections: Nested collections (discovered via their own .collection.json files)
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
  entries: z.array(entryTypeSchemaRefSchema).optional(),
  order: z.array(z.string()), // Embedded IDs for ordering items (required)
}).refine(
  (data) => data.entries && data.entries.length > 0,
  { message: 'Collection must have at least one entry type' }
)

/**
 * Zod schema for root .collection.json file (content/.collection.json)
 * Like other collections but no name/path (derived from contentRoot)
 */
const rootCollectionMetaSchema = z.object({
  label: z.string().optional(),
  entries: z.array(entryTypeSchemaRefSchema).optional(),
  order: z.array(z.string()).optional(), // Embedded IDs for ordering items
})

export type EntryTypeMeta = {
  name: string
  format: 'md' | 'mdx' | 'json'
  fields: string  // Schema registry key
  label?: string
  default?: boolean
  maxItems?: number
}

export type CollectionMeta = {
  name: string
  label?: string
  entries?: EntryTypeMeta[]
  order: string[] // Embedded IDs for ordering items (required)
}

export type RootCollectionMeta = {
  label?: string
  entries?: EntryTypeMeta[]
  order?: string[] // Embedded IDs for ordering items
}

/**
 * Recursively scans a directory for .collection.json files.
 *
 * Discovery Rules:
 * - Scans recursively from the base directory (content root)
 * - Each directory can have at most ONE .collection.json file
 * - Collection path is derived from the directory structure (e.g., "docs/api" for content/docs/api/)
 * - Collection name comes from the "name" field in .collection.json, NOT the directory name
 * - Directories without .collection.json are still scanned for nested collections
 * - Invalid .collection.json files cause the entire scan to fail with a descriptive error
 *
 * @param baseDir - The directory to scan (absolute path)
 * @param relativePath - Current path relative to content root (used for recursion)
 * @returns Array of collection metadata with resolved paths
 */

/**
 * Strip embedded ID from a directory or file name.
 * e.g., "docs.bChqT78gcaLd" -> "docs"
 * e.g., "home.agfzDt2RLpSn.json" -> "home"
 */
function stripEmbeddedIdFromName(name: string): string {
  // Use extractSlugFromFilename which handles the ID extraction logic
  return extractSlugFromFilename(name)
}

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
      // Strip embedded ID from folder name for logical path
      // e.g., "docs.bChqT78gcaLd" -> "docs"
      const logicalName = stripEmbeddedIdFromName(folderName)
      const folderPath = relativePath ? `${relativePath}/${logicalName}` : logicalName
      const absolutePath = join(baseDir, folderName)
      const metaPath = join(absolutePath, '.collection.json')

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
        const nestedCollections = await scanForCollectionMeta(absolutePath, folderPath)
        collections.push(...nestedCollections)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          // File exists but is invalid
          console.error(`Error loading ${metaPath}:`, err)
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
 * This function orchestrates the complete discovery process:
 * 1. Attempts to load the root .collection.json (contentRoot/.collection.json) - optional
 * 2. Recursively scans all subdirectories for .collection.json files
 * 3. Returns both root configuration and nested collections
 *
 * Meta File Structure:
 * - Root: contentRoot/.collection.json (optional, defines root-level entry types)
 * - Collections: contentRoot/[path]/.collection.json (defines collection in that directory)
 *
 * @param contentRoot - Absolute path to the content directory
 * @returns Object containing root meta (if exists) and array of collection metas with paths
 * @throws Error if any .collection.json file is malformed or invalid
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
  } catch (err) {
    // No root .collection.json - that's okay
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, that's fine
    } else {
      throw err
    }
  }

  // If file exists, try to read and parse it
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

  // Scan for collection folders
  const collections = await scanForCollectionMeta(contentRoot)

  return { root, collections }
}

/**
 * Resolve schema references for entry types
 */
function resolveEntryTypes(
  entryTypes: EntryTypeMeta[],
  schemaRegistry: Record<string, readonly FieldConfig[]>,
  contextName: string
): EntryTypeConfig[] {
  return entryTypes.map((entryType) => {
    const schema = schemaRegistry[entryType.fields]
    if (!schema) {
      throw new Error(
        `Schema reference "${entryType.fields}" in entry type "${entryType.name}" (${contextName}) not found in registry. ` +
        `Available schemas: ${Object.keys(schemaRegistry).join(', ')}`
      )
    }

    return {
      name: entryType.name,
      label: entryType.label,
      format: entryType.format as ContentFormat,
      fields: schema,
      default: entryType.default,
      maxItems: entryType.maxItems,
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

  // Resolve entry types
  if (meta.entries && meta.entries.length > 0) {
    result.entries = resolveEntryTypes(
      meta.entries,
      schemaRegistry,
      `collection "${meta.name}"`
    )
  }

  // Pass through order array (embedded IDs for sorting)
  if (meta.order) {
    result.order = meta.order
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
 * Resolve schema references for root collection and all collections.
 *
 * This function takes the loaded meta files (which contain string references like "postSchema")
 * and resolves them to actual FieldConfig[] arrays from the schema registry.
 *
 * Resolution Process:
 * 1. Root entry types: Resolve "fields" string to schema registry lookup
 * 2. Top-level collections: Resolve recursively, building nested tree structure
 * 3. Nested collections: Automatically grouped under their parent collections
 *
 * @param metaFiles - Loaded meta files from loadCollectionMetaFiles()
 * @param schemaRegistry - Map of schema names to FieldConfig arrays
 * @returns Fully resolved root collection config ready for use by CanopyCMS
 * @throws Error if any schema reference doesn't exist in registry (with helpful suggestions)
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

  // Pass through root label if present
  if (metaFiles.root?.label) {
    result.label = metaFiles.root.label
  }

  // Resolve root entry types
  if (metaFiles.root?.entries && metaFiles.root.entries.length > 0) {
    result.entries = resolveEntryTypes(
      metaFiles.root.entries,
      schemaRegistry,
      'root collection'
    )
  }

  // Pass through root order array (embedded IDs for sorting)
  if (metaFiles.root?.order) {
    result.order = metaFiles.root.order
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
