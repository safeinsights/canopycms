/**
 * Core AI content generation engine.
 *
 * Shared by both the route handler (runtime) and build utility (static).
 * Reads content from ContentStore, converts to markdown, and produces
 * a manifest + file map.
 */

import path from 'node:path'

import { minimatch } from 'minimatch'

import type { ContentStore, ContentDocument, MarkdownDocument } from '../content-store'
import type { FlatSchemaItem, EntryTypeConfig } from '../config'
import { extractEntryTypeFromFilename } from '../content-id-index'
import { entryToMarkdown } from './json-to-markdown'
import type {
  AIContentConfig,
  AIEntry,
  AIEntryMeta,
  AIManifest,
  AIManifestCollection,
  AIManifestEntry,
  AIManifestBundle,
} from './types'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  store: ContentStore
  flatSchema: FlatSchemaItem[]
  /** The content root name (e.g., 'content') */
  contentRoot: string
  config?: AIContentConfig
}

export interface GenerateResult {
  manifest: AIManifest
  /** Map from clean path to markdown content (e.g., 'posts/all.md' → '...') */
  files: Map<string, string>
}

/**
 * Generate all AI content from the content store.
 *
 * Walks the schema tree, reads entries, converts to markdown,
 * and produces per-entry files, per-collection all.md files,
 * bundle files, and a manifest.
 */
export async function generateAIContent(options: GenerateOptions): Promise<GenerateResult> {
  const { store, flatSchema, contentRoot, config } = options
  const files = new Map<string, string>()

  // Build lookup maps from flat schema
  const collections = flatSchema.filter(
    (item): item is FlatSchemaItem & { type: 'collection' } => item.type === 'collection',
  )

  // Track all entries for bundle filtering
  const allEntries: AIEntry[] = []
  // Track manifest collections (tree structure)
  const manifestCollections: AIManifestCollection[] = []
  // Track root-level entries (entries in the content root, not in a subcollection)
  const rootEntries: AIManifestEntry[] = []

  // Process each collection
  for (const collection of collections) {
    // Skip the content root itself — we process its children
    if (collection.logicalPath === contentRoot) continue

    // Check exclusion
    if (isCollectionExcluded(collection.logicalPath, contentRoot, config)) continue

    // Only process top-level collections and direct subcollections here
    // (subcollections are handled recursively via their parent)
    if (collection.parentPath && collection.parentPath !== contentRoot) continue

    const collectionResult = await processCollection(
      store,
      collection,
      flatSchema,
      contentRoot,
      config,
    )

    allEntries.push(...collectionResult.entries)
    for (const [filePath, content] of collectionResult.files) {
      files.set(filePath, content)
    }
    manifestCollections.push(collectionResult.manifestCollection)
  }

  // Process root-level entries (entries in content root, not in any subcollection)
  const rootCollection = collections.find((c) => c.logicalPath === contentRoot)
  if (rootCollection?.entries) {
    const rootResult = await processRootEntries(store, rootCollection, contentRoot, config)
    allEntries.push(...rootResult.entries)
    for (const [filePath, content] of rootResult.files) {
      files.set(filePath, content)
    }
    rootEntries.push(...rootResult.manifestEntries)
  }

  // Process bundles
  const manifestBundles: AIManifestBundle[] = []
  if (config?.bundles) {
    for (const bundle of config.bundles) {
      const matchingEntries = allEntries.filter((entry) =>
        matchesBundleFilter(entry, bundle.filter, contentRoot),
      )
      if (matchingEntries.length > 0) {
        const bundleContent = matchingEntries
          .map((e) => entryToMarkdown(e, config))
          .join('\n---\n\n')
        const bundlePath = `bundles/${bundle.name}.md`
        files.set(bundlePath, bundleContent)
        manifestBundles.push({
          name: bundle.name,
          description: bundle.description,
          file: bundlePath,
          entryCount: matchingEntries.length,
        })
      }
    }
  }

  // Build manifest
  const manifest: AIManifest = {
    generated: new Date().toISOString(),
    entries: rootEntries,
    collections: manifestCollections,
    bundles: manifestBundles,
  }

  files.set('manifest.json', JSON.stringify(manifest, null, 2))

  return { manifest, files }
}

// ---------------------------------------------------------------------------
// Collection processing
// ---------------------------------------------------------------------------

interface CollectionProcessResult {
  entries: AIEntry[]
  files: Map<string, string>
  manifestCollection: AIManifestCollection
}

async function processCollection(
  store: ContentStore,
  collection: FlatSchemaItem & { type: 'collection' },
  flatSchema: FlatSchemaItem[],
  contentRoot: string,
  config?: AIContentConfig,
): Promise<CollectionProcessResult> {
  const files = new Map<string, string>()
  const entries: AIEntry[] = []
  const cleanPath = stripContentRoot(collection.logicalPath, contentRoot)
  const manifestEntries: AIManifestEntry[] = []

  // Read entries directly in this collection (not subcollections)
  const listed = await store.listCollectionEntries(collection.logicalPath)

  // Filter to only entries in this exact collection (not subcollections)
  const directEntries = listed.filter((e) => e.collection === collection.logicalPath)

  for (const listEntry of directEntries) {
    const entryTypeName = extractEntryTypeFromFilename(path.basename(listEntry.relativePath))
    if (!entryTypeName) continue

    // Check entry type exclusion
    if (config?.exclude?.entryTypes?.includes(entryTypeName)) continue

    // Find the entry type config to get schema fields
    const entryTypeConfig = findEntryType(collection, entryTypeName)
    if (!entryTypeConfig) continue

    try {
      const doc = await store.read(listEntry.collection, listEntry.slug, {
        resolveReferences: false,
      })

      const aiEntry = docToAIEntry(doc, listEntry.slug, entryTypeName, entryTypeConfig, cleanPath)

      // Check predicate exclusion
      if (config?.exclude?.where?.(aiEntry)) continue

      entries.push(aiEntry)

      // Write individual entry file
      const entryFilePath = `${cleanPath}/${listEntry.slug}.md`
      const entryMarkdown = entryToMarkdown(aiEntry, config)
      files.set(entryFilePath, entryMarkdown)

      manifestEntries.push({
        slug: listEntry.slug,
        title: aiEntry.data.title ? String(aiEntry.data.title) : undefined,
        file: entryFilePath,
      })
    } catch (err) {
      console.warn(
        `AI content: skipping entry "${listEntry.slug}" in ${collection.logicalPath}:`,
        err instanceof Error ? err.message : err,
      )
      continue
    }
  }

  // Process subcollections
  const subcollections = flatSchema.filter(
    (item): item is FlatSchemaItem & { type: 'collection' } =>
      item.type === 'collection' && item.parentPath === collection.logicalPath,
  )

  const manifestSubcollections: AIManifestCollection[] = []
  for (const sub of subcollections) {
    if (isCollectionExcluded(sub.logicalPath, contentRoot, config)) continue

    const subResult = await processCollection(store, sub, flatSchema, contentRoot, config)
    entries.push(...subResult.entries)
    for (const [filePath, content] of subResult.files) {
      files.set(filePath, content)
    }
    manifestSubcollections.push(subResult.manifestCollection)
  }

  // Write all.md for this collection (includes direct entries + subcollection entries)
  if (entries.length > 0) {
    const allContent = entries.map((e) => entryToMarkdown(e, config)).join('\n---\n\n')
    const allPath = `${cleanPath}/all.md`
    files.set(allPath, allContent)
  }

  const manifestCollection: AIManifestCollection = {
    name: collection.name,
    label: collection.label,
    description: collection.description,
    path: cleanPath,
    allFile: entries.length > 0 ? `${cleanPath}/all.md` : undefined,
    entryCount: entries.length,
    entries: manifestEntries,
    subcollections: manifestSubcollections.length > 0 ? manifestSubcollections : undefined,
  }

  return { entries, files, manifestCollection }
}

// ---------------------------------------------------------------------------
// Root entry processing
// ---------------------------------------------------------------------------

interface RootEntryResult {
  entries: AIEntry[]
  files: Map<string, string>
  manifestEntries: AIManifestEntry[]
}

async function processRootEntries(
  store: ContentStore,
  rootCollection: FlatSchemaItem & { type: 'collection' },
  contentRoot: string,
  config?: AIContentConfig,
): Promise<RootEntryResult> {
  const files = new Map<string, string>()
  const entries: AIEntry[] = []
  const manifestEntries: AIManifestEntry[] = []

  const listed = await store.listCollectionEntries(rootCollection.logicalPath)
  // Only direct entries in root (not in subcollections)
  const directEntries = listed.filter((e) => e.collection === rootCollection.logicalPath)

  for (const listEntry of directEntries) {
    const entryTypeName = extractEntryTypeFromFilename(path.basename(listEntry.relativePath))
    if (!entryTypeName) continue

    if (config?.exclude?.entryTypes?.includes(entryTypeName)) continue

    const entryTypeConfig = findEntryType(rootCollection, entryTypeName)
    if (!entryTypeConfig) continue

    try {
      const doc = await store.read(listEntry.collection, listEntry.slug, {
        resolveReferences: false,
      })

      const aiEntry = docToAIEntry(doc, listEntry.slug, entryTypeName, entryTypeConfig, '')

      if (config?.exclude?.where?.(aiEntry)) continue

      entries.push(aiEntry)

      const entryFilePath = `${listEntry.slug}.md`
      const entryMarkdown = entryToMarkdown(aiEntry, config)
      files.set(entryFilePath, entryMarkdown)

      manifestEntries.push({
        slug: listEntry.slug,
        title: aiEntry.data.title ? String(aiEntry.data.title) : undefined,
        file: entryFilePath,
      })
    } catch (err) {
      console.warn(
        `AI content: skipping root entry "${listEntry.slug}":`,
        err instanceof Error ? err.message : err,
      )
      continue
    }
  }

  return { entries, files, manifestEntries }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip contentRoot prefix from a logical path */
function stripContentRoot(logicalPath: string, contentRoot: string): string {
  if (logicalPath.startsWith(contentRoot + '/')) {
    return logicalPath.slice(contentRoot.length + 1)
  }
  return logicalPath
}

/** Check if a collection is excluded by path */
function isCollectionExcluded(
  logicalPath: string,
  contentRoot: string,
  config?: AIContentConfig,
): boolean {
  if (!config?.exclude?.collections) return false
  const cleanPath = stripContentRoot(logicalPath, contentRoot)
  return config.exclude.collections.some(
    (pattern) =>
      // Match against clean path or full logical path
      minimatch(cleanPath, pattern) || minimatch(logicalPath, pattern),
  )
}

/** Find an entry type config by name within a collection */
function findEntryType(
  collection: FlatSchemaItem & { type: 'collection' },
  entryTypeName: string,
): EntryTypeConfig | undefined {
  return collection.entries?.find((e) => e.name === entryTypeName)
}

/** Convert a ContentDocument to an AIEntry */
function docToAIEntry(
  doc: ContentDocument,
  slug: string,
  entryTypeName: string,
  entryTypeConfig: EntryTypeConfig,
  cleanCollectionPath: string,
): AIEntry {
  return {
    slug,
    collection: cleanCollectionPath,
    collectionName: doc.collectionName,
    entryType: entryTypeName,
    format: doc.format,
    data: doc.data,
    body: doc.format !== 'json' ? (doc as MarkdownDocument).body : undefined,
    fields: entryTypeConfig.schema,
  }
}

/** Check if an entry matches a bundle filter (filters are AND'd) */
function matchesBundleFilter(
  entry: AIEntryMeta,
  filter: NonNullable<AIContentConfig['bundles']>[number]['filter'],
  contentRoot: string,
): boolean {
  // Collections filter
  if (filter.collections) {
    const matches = filter.collections.some((pattern) => {
      const cleanPattern = stripContentRoot(pattern, contentRoot)
      return (
        entry.collection === cleanPattern ||
        entry.collection === pattern ||
        entry.collection.startsWith(cleanPattern + '/')
      )
    })
    if (!matches) return false
  }

  // Entry types filter
  if (filter.entryTypes) {
    if (!filter.entryTypes.includes(entry.entryType)) return false
  }

  // Path glob filter
  if (filter.paths) {
    const entryPath = entry.collection ? `${entry.collection}/${entry.slug}` : entry.slug
    const matches = filter.paths.some((pattern) => minimatch(entryPath, pattern))
    if (!matches) return false
  }

  // Predicate filter
  if (filter.where) {
    if (!filter.where(entry)) return false
  }

  return true
}
