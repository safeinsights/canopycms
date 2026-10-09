/**
 * Core AI content generation engine.
 *
 * Shared by both the route handler (runtime) and build utility (static).
 * Reads content from ContentStore, converts to markdown, and produces
 * a manifest + file map.
 */

import path from 'node:path'
import fs from 'node:fs/promises'

import { minimatch } from 'minimatch'

import type { ContentStore, ContentDocument, MarkdownDocument } from '../content-store'
import type { FlatSchemaItem, EntryTypeConfig } from '../config'
import { isDataOnlyFormat } from '../utils/format'
import {
  extractEntryTypeFromFilename,
  extractIdFromFilename,
  type ContentIdIndex,
} from '../content-id-index'
import { hasTraversalSequence } from '../paths'
import { getErrorMessage, isNodeError } from '../utils/error'
import { entryToMarkdown } from './json-to-markdown'
import {
  createReferenceRendering,
  createReferenceTargetResolver,
  maskUnexportedTargets,
  resolveReferenceFields,
  type ReferenceTargetResolver,
} from './references'
import { resolveEntryLinksInText, type EntryLinkUrlResolver } from '../entry-link-resolver'
import type {
  AIContentConfig,
  AIEntry,
  AIEntryMeta,
  AIManifest,
  AIManifestCollection,
  AIManifestEntry,
  AIManifestBundle,
  EntryTransformContext,
} from './types'

export interface GenerateOptions {
  store: ContentStore
  flatSchema: FlatSchemaItem[]
  /** The content root name (e.g., 'content') */
  contentRoot: string
  config?: AIContentConfig
  /** Custom URL resolver for entry links. */
  entryLinkUrl?: EntryLinkUrlResolver
  /**
   * ISO-8601 timestamp to record as the manifest's `generated`. Defaults to now.
   *
   * Passed in rather than read from the environment here so this stays a pure function of its
   * arguments: the runtime route handler wants a live clock, the build path wants a pinned or
   * omitted value, and only the caller knows which it is.
   */
  generatedAt?: string
  /**
   * Artifact identifier to record as the manifest's `buildId`. Supplying this WITHOUT
   * `generatedAt` omits `generated` entirely — see `AIManifest.generated`.
   */
  buildId?: string
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
 *
 * Runs in two phases because a reference may only show a target that is itself exported: every
 * entry is read and filtered first, which settles the exported set, and only then are references
 * to anything outside it masked, entry transforms run, and markdown rendered.
 */
export async function generateAIContent(options: GenerateOptions): Promise<GenerateResult> {
  const { store, flatSchema, contentRoot, config, entryLinkUrl, generatedAt, buildId } = options
  const files = new Map<string, string>()

  const idIndex = await store.idIndex()
  const read: EntryReadContext = {
    store,
    contentRoot,
    config,
    idIndex,
    entryLinkUrl,
    resolveTarget: createReferenceTargetResolver(store),
  }

  const collections = flatSchema.filter(
    (item): item is FlatSchemaItem & { type: 'collection' } => item.type === 'collection',
  )

  const collectionNodes: CollectionNode[] = []
  for (const collection of collections) {
    // Skip the content root itself — we process its children
    if (collection.logicalPath === contentRoot) continue

    if (isCollectionExcluded(collection.logicalPath, contentRoot, config)) continue

    // Only process top-level collections and direct subcollections here
    // (subcollections are handled recursively via their parent)
    if (collection.parentPath && collection.parentPath !== contentRoot) continue

    collectionNodes.push(await collectCollection(read, collection, flatSchema))
  }

  // Root-level entries (entries in content root, not in any subcollection)
  const rootCollection = collections.find((c) => c.logicalPath === contentRoot)
  const rootEntries = rootCollection?.entries ? await collectEntries(read, rootCollection, '') : []

  // Collection entries first, then root entries: the order every all.md and bundle lists them in
  const allPending = [...collectionNodes.flatMap(subtreeEntries), ...rootEntries]
  const exportedIds = new Set(
    allPending.map((p) => p.contentId).filter((id): id is string => id !== null),
  )
  const references = createReferenceRendering(idIndex, flatSchema, entryLinkUrl)
  for (const pending of allPending) {
    maskUnexportedTargets(pending.entry, exportedIds)
    // Fold in adopter-supplied markdown (e.g. a colocated sibling artifact), once per entry
    await runEntryTransform(pending.entry, pending.absolutePath, pending.contentId, config)
    try {
      pending.markdown = entryToMarkdown(pending.entry, config, references)
    } catch (err) {
      console.warn(
        `AI content: skipping entry "${pending.entry.slug}" in ${pending.collectionPath}:`,
        getErrorMessage(err),
      )
    }
  }

  const manifestCollections = collectionNodes.map((node) => emitCollection(node, files))
  const manifestRootEntries = emitEntries(rootEntries, files)

  const allEntries = allPending.filter(isRendered)
  const manifestBundles: AIManifestBundle[] = []
  if (config?.bundles) {
    for (const bundle of config.bundles) {
      // Validate bundle name to prevent path traversal
      if (/[/\\]|\.\./.test(bundle.name)) {
        throw new Error(`Invalid bundle name "${bundle.name}": must not contain slashes or ".."`)
      }
      const matchingEntries = allEntries.filter((pending) =>
        matchesBundleFilter(pending.entry, bundle.filter, contentRoot),
      )
      if (matchingEntries.length > 0) {
        const bundleContent = matchingEntries.map((p) => p.markdown).join('\n---\n\n')
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

  // `generated` is emitted unless the caller named an artifact but no timestamp: a build id says
  // "this content is identified by an artifact, not by when a runner happened to build it", and a
  // wall clock alongside it would be a claim the artifact cannot support months later. Key order
  // is fixed (id before date) so the JSON is byte-stable across runs.
  const manifest: AIManifest = {
    ...(buildId ? { buildId } : {}),
    ...(generatedAt || !buildId ? { generated: generatedAt || new Date().toISOString() } : {}),
    entries: manifestRootEntries,
    collections: manifestCollections,
    bundles: manifestBundles,
  }

  files.set('manifest.json', JSON.stringify(manifest, null, 2))

  return { manifest, files }
}

/** What reading one entry needs, shared by every collection in a run. */
interface EntryReadContext {
  store: ContentStore
  contentRoot: string
  config?: AIContentConfig
  idIndex: ContentIdIndex
  entryLinkUrl?: EntryLinkUrlResolver
  resolveTarget: ReferenceTargetResolver
}

/** An entry that passed every exclusion; `markdown` is set once it renders. */
interface PendingEntry {
  entry: AIEntry
  contentId: string | null
  absolutePath: string
  collectionPath: string
  filePath: string
  markdown?: string
}

type RenderedEntry = PendingEntry & { markdown: string }

function isRendered(pending: PendingEntry): pending is RenderedEntry {
  return pending.markdown !== undefined
}

interface CollectionNode {
  collection: FlatSchemaItem & { type: 'collection' }
  cleanPath: string
  entries: PendingEntry[]
  subcollections: CollectionNode[]
}

/** A collection's direct entries, then each subcollection's, in the order all.md lists them. */
function subtreeEntries(node: CollectionNode): PendingEntry[] {
  return [...node.entries, ...node.subcollections.flatMap(subtreeEntries)]
}

async function collectCollection(
  read: EntryReadContext,
  collection: FlatSchemaItem & { type: 'collection' },
  flatSchema: FlatSchemaItem[],
): Promise<CollectionNode> {
  const cleanPath = stripContentRoot(collection.logicalPath, read.contentRoot)
  const entries = await collectEntries(read, collection, cleanPath)

  const subcollections: CollectionNode[] = []
  for (const sub of flatSchema) {
    if (sub.type !== 'collection' || sub.parentPath !== collection.logicalPath) continue
    if (isCollectionExcluded(sub.logicalPath, read.contentRoot, read.config)) continue
    subcollections.push(await collectCollection(read, sub, flatSchema))
  }

  return { collection, cleanPath, entries, subcollections }
}

/** Read, resolve and filter the entries directly in `collection` (not its subcollections). */
async function collectEntries(
  read: EntryReadContext,
  collection: FlatSchemaItem & { type: 'collection' },
  cleanPath: string,
): Promise<PendingEntry[]> {
  const { store, contentRoot, config, idIndex, entryLinkUrl, resolveTarget } = read
  const pending: PendingEntry[] = []

  const listed = await store.getCollectionEntryPaths(collection.logicalPath)
  // Filter to only entries in this exact collection (not subcollections)
  const directEntries = listed.filter((e) => e.collection === collection.logicalPath)

  for (const listEntry of directEntries) {
    const entryTypeName = extractEntryTypeFromFilename(path.basename(listEntry.relativePath))
    if (!entryTypeName) continue

    if (config?.exclude?.entryTypes?.includes(entryTypeName)) continue

    const entryTypeConfig = findEntryType(collection, entryTypeName)
    if (!entryTypeConfig) continue

    try {
      const doc = await store.read(listEntry.collection, listEntry.slug, {
        resolveReferences: false,
      })
      doc.data = await resolveReferenceFields(doc.data, entryTypeConfig.schema, resolveTarget)

      const aiEntry = docToAIEntry(doc, listEntry.slug, entryTypeName, entryTypeConfig, cleanPath)

      if (aiEntry.body) {
        aiEntry.body = resolveEntryLinksInText(aiEntry.body, idIndex, contentRoot, entryLinkUrl)
      }

      if (config?.exclude?.where?.(aiEntry)) continue

      pending.push({
        entry: aiEntry,
        contentId: extractIdFromFilename(path.basename(listEntry.relativePath)),
        absolutePath: doc.absolutePath,
        collectionPath: collection.logicalPath,
        filePath: cleanPath ? `${cleanPath}/${listEntry.slug}.md` : `${listEntry.slug}.md`,
      })
    } catch (err) {
      console.warn(
        `AI content: skipping entry "${listEntry.slug}" in ${collection.logicalPath}:`,
        getErrorMessage(err),
      )
    }
  }

  return pending
}

/** Write each rendered entry's file and return its manifest rows. */
function emitEntries(entries: PendingEntry[], files: Map<string, string>): AIManifestEntry[] {
  return entries.filter(isRendered).map((pending) => {
    files.set(pending.filePath, pending.markdown)
    return {
      slug: pending.entry.slug,
      title: pending.entry.data.title ? String(pending.entry.data.title) : undefined,
      file: pending.filePath,
    }
  })
}

/** Write a collection's entry files and all.md, recursively, and return its manifest node. */
function emitCollection(node: CollectionNode, files: Map<string, string>): AIManifestCollection {
  const manifestEntries = emitEntries(node.entries, files)
  const manifestSubcollections = node.subcollections.map((sub) => emitCollection(sub, files))

  // all.md covers direct entries + subcollection entries
  const rendered = subtreeEntries(node).filter(isRendered)
  const allPath = `${node.cleanPath}/all.md`
  if (rendered.length > 0) {
    files.set(allPath, rendered.map((p) => p.markdown).join('\n---\n\n'))
  }

  return {
    name: node.collection.name,
    label: node.collection.label,
    description: node.collection.description,
    path: node.cleanPath,
    allFile: rendered.length > 0 ? allPath : undefined,
    entryCount: rendered.length,
    entries: manifestEntries,
    subcollections: manifestSubcollections.length > 0 ? manifestSubcollections : undefined,
  }
}

function stripContentRoot(logicalPath: string, contentRoot: string): string {
  if (logicalPath.startsWith(contentRoot + '/')) {
    return logicalPath.slice(contentRoot.length + 1)
  }
  return logicalPath
}

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

function findEntryType(
  collection: FlatSchemaItem & { type: 'collection' },
  entryTypeName: string,
): EntryTypeConfig | undefined {
  return collection.entries?.find((e) => e.name === entryTypeName)
}

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
    body: !isDataOnlyFormat(doc.format) ? (doc as MarkdownDocument).body : undefined,
    fields: entryTypeConfig.schema,
  }
}

/**
 * Build a sibling-file reader bound to a single directory. The returned function reads a bare
 * filename colocated in `dir`, refusing anything that could escape it (slashes, `..`, absolute
 * paths). Resolves `null` when the file is missing or is not a regular file. Path-safety and IO
 * stay inside the package — the absolute path is never handed to the caller.
 */
function makeReadSibling(dir: string): (name: string) => Promise<string | null> {
  const resolvedDir = path.resolve(dir)
  return async (name: string): Promise<string | null> => {
    if (
      !name ||
      name.includes('/') ||
      name.includes('\\') ||
      path.isAbsolute(name) ||
      hasTraversalSequence(name)
    ) {
      return null
    }
    const abs = path.resolve(resolvedDir, name)
    // Defense in depth: the resolved file must sit directly inside `dir`.
    if (path.dirname(abs) !== resolvedDir) return null
    try {
      // lstat (not stat) so a symlink in the entry dir can't redirect the read outside it:
      // lstat reports the link itself, whose isFile() is false, so it's rejected as a non-file.
      const stats = await fs.lstat(abs)
      if (!stats.isFile()) return null
      return await fs.readFile(abs, 'utf8')
    } catch (err) {
      if (isNodeError(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null
      throw err
    }
  }
}

/**
 * Run the configured entry transform (if any), caching its returned markdown on
 * `entry.appendedSections`. The transform receives the entry's content ID and a directory-bound
 * `readSibling`. Runs once per entry; the cached result is reused across the per-entry file, the
 * collection `all.md`, and any bundle that includes this entry. A throwing transform is logged and
 * skipped — the entry still renders without the appended section (distinct from an unreadable
 * entry, which is skipped entirely upstream).
 */
async function runEntryTransform(
  entry: AIEntry,
  absolutePath: string,
  contentId: string | null,
  config?: AIContentConfig,
): Promise<void> {
  const transform = config?.entryTransforms?.[entry.entryType]
  if (!transform) return
  const ctx: EntryTransformContext = {
    contentId: contentId ?? '',
    readSibling: makeReadSibling(path.dirname(absolutePath)),
  }
  try {
    const appended = await transform(entry, ctx)
    if (appended) entry.appendedSections = appended
  } catch (err) {
    console.warn(
      `AI content: entry transform for "${entry.slug}" (${entry.entryType}) failed:`,
      getErrorMessage(err),
    )
  }
}

/** Filters are AND'd: an entry must satisfy every filter field that's set. */
function matchesBundleFilter(
  entry: AIEntryMeta,
  filter: NonNullable<AIContentConfig['bundles']>[number]['filter'],
  contentRoot: string,
): boolean {
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

  if (filter.entryTypes) {
    if (!filter.entryTypes.includes(entry.entryType)) return false
  }

  if (filter.paths) {
    const entryPath = entry.collection ? `${entry.collection}/${entry.slug}` : entry.slug
    const matches = filter.paths.some((pattern) => minimatch(entryPath, pattern))
    if (!matches) return false
  }

  if (filter.where) {
    if (!filter.where(entry)) return false
  }

  return true
}
