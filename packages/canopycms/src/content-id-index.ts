/**
 * The ContentId -> file path index.
 *
 * Every entry file carries a stable id in its filename (`<type>.<slug>.<id>.md`),
 * and this index is what makes an id-based lookup cheap instead of a directory
 * walk. `ContentStore` owns an instance and consults it on every id-addressed
 * read.
 *
 * Coherency is the whole problem here, and it is cross-process: two Lambdas and
 * the worker can all mutate one branch on shared storage. The design is an
 * on-disk generation marker (`content-index-generation.ts`) plus an in-process
 * registry (`content-index-registry.ts`) — two files whose names read as
 * near-synonyms and do unrelated jobs. Read
 * ../../../docs/concurrency.md before changing any of the three.
 *
 * Also here: the filename-grammar helpers (`extractIdFromFilename`,
 * `extractEntryTypeFromFilename`, `extractSlugFromFilename`). Note that this
 * grammar is LOOSER than what `parseSlug` accepts, which is the gap
 * `static/`'s `assertRoutableSlugs` exists to catch at build time.
 *
 * Module map: ./AGENTS.md.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { isValidId } from './id'
import { isNotFoundError } from './utils/error'
import { canopyLogWarn } from './utils/logger'
import { type LogicalPath, type PhysicalPath, type Slug, type ContentId } from './paths'

/** Logical path representing entries stored at the branch root (no parent collection). Rare in practice. */
const EMPTY_LOGICAL_PATH = '' as LogicalPath

/**
 * Strips the embedded ID from each physical segment to produce a logical path:
 * "content/posts.a1b2c3d4e5f6" → "content/posts".
 */
function toLogicalCollectionPath(physicalPath: string): LogicalPath {
  if (physicalPath === '.') return EMPTY_LOGICAL_PATH
  return physicalPath
    .split('/')
    .map((seg) => extractSlugFromFilename(seg))
    .join('/') as LogicalPath
}

export interface IdLocation {
  id: ContentId
  type: 'entry' | 'collection'
  relativePath: PhysicalPath // e.g. 'content/posts/dune.a1b2c3d4e5f6.json'
  collection?: LogicalPath // e.g. 'content/posts' (for entries only) — always logical, never physical
  slug?: Slug // e.g. 'dune' (for entries only)
}

/**
 * A group of on-disk filenames embedding the same content ID, discovered by
 * {@link ContentIdIndex.buildFromFilenames}. Its doc comment covers how
 * `keptPath` is chosen and why every host chooses the same one.
 */
export interface DuplicateContentId {
  id: ContentId
  /** The path retained in the index (the deterministic winner). Fully usable. */
  keptPath: PhysicalPath
  /** Paths quarantined out of the index. Still on disk, unreachable by ID until repaired. */
  droppedPaths: PhysicalPath[]
}

/**
 * Bidirectional ContentId <-> path index over `{type}.{slug}.{12-char-id}.{ext}`
 * files and `{slug}.{12-char-id}/` directories, scanned lazily on first access
 * into per-process memory. Filenames on disk are the source of truth; the class
 * is not thread-safe and takes no locks. Staleness is bounded as the module
 * header describes, plus ContentStore's suspicious-lookup rebuild.
 *
 * A duplicate embedded ID always predates the scan: concurrent creates each
 * generate a unique ID, and ContentStore.write() refuses to recreate an entry
 * file whose ID the directory listing places at a different slug. A crash does
 * produce one — renameEntry()'s `fs.link()` then `fs.unlink()` is not atomic.
 *
 * `buildFromFilenames()` quarantines such a collision rather than throwing,
 * which would propagate out of every caller and brick read-by-id, reference
 * resolution, listing and every write on the branch. The winner is the
 * lexicographically-SMALLEST relativePath, compared as strings and never by
 * visit order, so hosts scanning in different `readdir()` orders converge on
 * the same one. Losers leave `idToLocation`/`pathToId`/`byCollection` entirely
 * and are recorded in {@link getDuplicateIds} for branch-health.ts and the
 * repair action in api/admin-branch-health.ts: degraded, not dead.
 *
 * Quarantine is an INDEX decision only: this scan never touches the filesystem,
 * and slugs resolve by directory scan (`ContentStore.buildPaths()`), which
 * knows nothing about it, so the dropped file stays addressable by
 * collection+slug. Hence `write()` refuses such a save with
 * `DuplicateContentIdError` — its index-repair step reads "this ID lives
 * elsewhere" as "the slug changed" and would unlink the kept file, a different
 * document. `delete()`/`renameEntry()` stay allowed, each touching only the
 * file the caller addressed, so the dropped file can be removed by hand.
 */
export class ContentIdIndex {
  private idToLocation: Map<string, IdLocation> = new Map()
  private pathToId: Map<string, string> = new Map()
  private byCollection: Map<string, Set<string>> = new Map()
  /**
   * Quarantined (losing) paths per duplicated id, populated by
   * buildFromFilenames only: add()/remove()/updatePath() throw on collision.
   */
  private duplicateIds: Map<string, Set<string>> = new Map()
  private root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  /**
   * Build the index by scanning filenames recursively. Duplicate embedded IDs
   * are quarantined, not thrown on — see the class doc and
   * {@link getDuplicateIds}.
   */
  async buildFromFilenames(startPath: string = ''): Promise<void> {
    await this.scanDirectory(startPath)
  }

  /** Insert a location into all three indexes. Caller must ensure no existing entry for this id. */
  private insertLocation(id: string, location: IdLocation): void {
    this.idToLocation.set(id, location)
    this.pathToId.set(location.relativePath, id)
    if (location.type === 'entry' && location.collection) {
      if (!this.byCollection.has(location.collection)) {
        this.byCollection.set(location.collection, new Set())
      }
      this.byCollection.get(location.collection)!.add(id)
    }
  }

  /** Remove a location from all three indexes, when an earlier duplicate displaces it. */
  private evictLocation(location: IdLocation): void {
    this.idToLocation.delete(location.id)
    this.pathToId.delete(location.relativePath)
    if (location.type === 'entry' && location.collection) {
      const idSet = this.byCollection.get(location.collection)
      if (idSet) {
        idSet.delete(location.id)
        if (idSet.size === 0) this.byCollection.delete(location.collection)
      }
    }
  }

  /** Record a quarantined duplicate path for health reporting (see getDuplicateIds). */
  private recordDuplicate(id: string, droppedPath: string): void {
    let dropped = this.duplicateIds.get(id)
    if (!dropped) {
      dropped = new Set()
      this.duplicateIds.set(id, dropped)
    }
    dropped.add(droppedPath)
  }

  private async scanDirectory(relativePath: string): Promise<void> {
    const absoluteDir = path.join(this.root, relativePath)

    try {
      const entries = await fs.readdir(absoluteDir, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === '_ids_') {
          continue
        }

        const fullRelativePath = path.join(relativePath, entry.name)
        const id = extractIdFromFilename(entry.name)

        if (id) {
          const location: IdLocation = {
            id, // already ContentId from extractIdFromFilename
            type: entry.isDirectory() ? 'collection' : 'entry',
            relativePath: fullRelativePath as PhysicalPath, // filesystem path with embedded IDs
          }

          if (!entry.isDirectory()) {
            const slug = extractSlugFromFilename(entry.name)
            const physicalCollection = path.dirname(fullRelativePath)
            const collectionPath = toLogicalCollectionPath(physicalCollection)
            location.slug = slug
            location.collection = collectionPath
          }

          const existing = this.idToLocation.get(id)
          if (existing) {
            // Quarantine, don't throw (class doc). The winner is the
            // lexicographically-smaller relativePath, so every host picks the
            // same one whatever order readdir handed them to it in.
            const newWins = fullRelativePath < existing.relativePath
            const kept = newWins ? fullRelativePath : existing.relativePath
            const dropped = newWins ? existing.relativePath : fullRelativePath
            if (newWins) {
              this.evictLocation(existing)
              this.recordDuplicate(id, existing.relativePath)
              this.insertLocation(id, location)
            } else {
              this.recordDuplicate(id, fullRelativePath)
            }
            canopyLogWarn(
              `[ContentIdIndex] Duplicate content ID ${id}: "${kept}" and "${dropped}" both ` +
                `embed this ID. Keeping "${kept}" for ID-based lookups (reads, references, ` +
                `listings); "${dropped}" is excluded from those lookups for now but has NOT ` +
                `been deleted -- it is still on disk at that path, and saves addressed to it are ` +
                `refused until this is resolved. An admin can resolve this via ` +
                `the repair-content-duplicates admin action for this branch, which archives ` +
                `"${dropped}" with a dot-prefixed name so future scans stop flagging it. ` +
                `Root: ${this.root}`,
            )
          } else {
            this.insertLocation(id, location)
          }
        }

        if (entry.isDirectory()) {
          await this.scanDirectory(fullRelativePath)
        }
      }
    } catch (err) {
      // Directory might not exist yet
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }
  }

  /**
   * IDs the last buildFromFilenames scan found on more than one file; empty
   * otherwise. Consumed by branch-health.ts's admin scan and by the
   * repair-content-duplicates action (api/admin-branch-health.ts).
   */
  getDuplicateIds(): DuplicateContentId[] {
    const result: DuplicateContentId[] = []
    for (const id of this.duplicateIds.keys()) {
      const duplicate = this.getDuplicateFor(id)
      if (duplicate) result.push(duplicate)
    }
    return result
  }

  /**
   * The quarantine record for ONE id, or null when that id is not duplicated.
   * The O(1) counterpart to {@link getDuplicateIds}, for ContentStore.write()'s
   * duplicate-ID guard: it asks on every save whose resolved path disagrees
   * with the index, so it must not pay to materialize the whole list.
   */
  getDuplicateFor(id: string): DuplicateContentId | null {
    const dropped = this.duplicateIds.get(id)
    if (!dropped) return null
    const kept = this.idToLocation.get(id)
    // Defensive, unreachable: recordDuplicate() always runs alongside an
    // insertLocation() for the same id, so a winner exists once one is recorded.
    if (!kept) return null
    return {
      id: id as ContentId,
      keptPath: kept.relativePath,
      droppedPaths: Array.from(dropped).sort() as PhysicalPath[],
    }
  }

  /** Forward lookup: ID → location (O(1)). */
  findById(id: string): IdLocation | null {
    return this.idToLocation.get(id) || null
  }

  /** Reverse lookup: path → ID (O(1)). */
  findByPath(relativePath: PhysicalPath): ContentId | null {
    return (this.pathToId.get(relativePath) as ContentId | undefined) || null
  }

  /** Every ID location in the index, for validation and reference checking. */
  getAllLocations(): IdLocation[] {
    return Array.from(this.idToLocation.values())
  }

  /** Entries in one collection: O(1) + O(entries in it). */
  getEntriesInCollection(collectionPath: LogicalPath): IdLocation[] {
    const idSet = this.byCollection.get(collectionPath)
    if (!idSet) {
      return []
    }

    const locations: IdLocation[] = []
    for (const id of idSet) {
      const location = this.idToLocation.get(id)
      if (location) {
        locations.push(location)
      }
    }

    return locations
  }

  /**
   * Entries in a collection and every subcollection: "content/docs" returns
   * "content/docs", "content/docs/api", and so on. O(matching collections ×
   * entries each).
   */
  getEntriesInCollectionTree(collectionPath: LogicalPath): IdLocation[] {
    const locations: IdLocation[] = []
    const prefix = collectionPath + '/'

    for (const [key, idSet] of this.byCollection) {
      if (key === collectionPath || key.startsWith(prefix)) {
        for (const id of idSet) {
          const location = this.idToLocation.get(id)
          if (location) {
            locations.push(location)
          }
        }
      }
    }

    return locations
  }

  /**
   * Get all entry locations across all collections.
   * Useful for entryType-only queries where no collection scope is specified.
   *
   * Performance: O(n) where n is total number of entries.
   *
   */
  getAllEntryLocations(): IdLocation[] {
    const locations: IdLocation[] = []

    for (const [, idSet] of this.byCollection) {
      for (const id of idSet) {
        const location = this.idToLocation.get(id)
        if (location && location.type === 'entry') {
          locations.push(location)
        }
      }
    }

    return locations
  }

  /**
   * Add an entry or collection. In-memory only: the file with the embedded ID
   * must already exist on disk, created by ContentStore. Throws on collision.
   */
  add(location: Omit<IdLocation, 'id'>): void {
    const id = extractIdFromFilename(path.basename(location.relativePath))
    if (!id) {
      throw new Error(`Cannot add location without ID in filename: ${location.relativePath}`)
    }

    if (this.idToLocation.has(id)) {
      const existing = this.idToLocation.get(id)!
      throw new Error(
        `ID collision detected: ${id}\n` +
          `  File 1: ${existing.relativePath}\n` +
          `  File 2: ${location.relativePath}`,
      )
    }

    const fullLocation: IdLocation = {
      ...location,
      id, // already ContentId from extractIdFromFilename
    }
    this.idToLocation.set(id, fullLocation)
    this.pathToId.set(location.relativePath, id)

    if (fullLocation.type === 'entry' && fullLocation.collection) {
      if (!this.byCollection.has(fullLocation.collection)) {
        this.byCollection.set(fullLocation.collection, new Set())
      }
      this.byCollection.get(fullLocation.collection)!.add(id)
    }
  }

  /**
   * Remove an entry or collection by ID. In-memory only: the caller deletes the
   * file separately.
   */
  remove(id: ContentId): void {
    const location = this.idToLocation.get(id)
    if (!location) return

    if (location.type === 'entry' && location.collection) {
      const idSet = this.byCollection.get(location.collection)
      if (idSet) {
        idSet.delete(id)
        // Drop empty Sets so the collection map cannot grow without bound.
        if (idSet.size === 0) {
          this.byCollection.delete(location.collection)
        }
      }
    }

    this.idToLocation.delete(id)
    this.pathToId.delete(location.relativePath)
  }

  /**
   * Repoint an existing ID at a new path; keeps the index in step with a
   * rename or move. Throws when the ID is unknown.
   */
  updatePath(id: ContentId, newRelativePath: PhysicalPath): void {
    const location = this.idToLocation.get(id)
    if (!location) {
      throw new Error(`Cannot update path for unknown ID: ${id}`)
    }

    this.pathToId.delete(location.relativePath)

    location.relativePath = newRelativePath

    if (location.type === 'entry') {
      const oldCollection = location.collection
      location.slug = extractSlugFromFilename(path.basename(newRelativePath))
      const physicalCollection = path.dirname(newRelativePath)
      location.collection = toLogicalCollectionPath(physicalCollection)

      if (oldCollection !== location.collection) {
        if (oldCollection) {
          const oldSet = this.byCollection.get(oldCollection)
          if (oldSet) {
            oldSet.delete(id)
            if (oldSet.size === 0) {
              this.byCollection.delete(oldCollection)
            }
          }
        }

        if (location.collection) {
          if (!this.byCollection.has(location.collection)) {
            this.byCollection.set(location.collection, new Set())
          }
          this.byCollection.get(location.collection)!.add(id)
        }
      }
    }

    this.pathToId.set(newRelativePath, id)
  }
}

/**
 * The ID embedded in a filename, or null when there is none.
 *
 * - entry file `type.slug.id.ext` → the second-to-last part; a dotted slug
 *   ("post.my.page.a1b2c3d4e5f6.json") still resolves, since only position
 *   from the end matters
 * - collection directory `slug.id` → the last part
 * - anything dot-prefixed → null, metadata, even `.hidden.a1b2c3d4e5f6.json`
 */
export function extractIdFromFilename(filename: string): ContentId | null {
  if (filename.startsWith('.')) {
    return null
  }

  const parts = filename.split('.')

  if (parts.length >= 3) {
    const candidate = parts[parts.length - 2]
    if (isValidId(candidate)) return candidate as ContentId
  }

  if (parts.length === 2) {
    const candidate = parts[parts.length - 1]
    if (isValidId(candidate)) return candidate as ContentId
  }

  return null
}

/**
 * Resolve a logical collection path to the filesystem path with embedded IDs,
 * one segment at a time so nested collections work: "content/docs/api" →
 * "<root>/content/docs.bChqT78gcaLd/api.meiuwxTSo7UN". Null if it is not there.
 */
export async function resolveCollectionPath(
  root: string,
  logicalPath: LogicalPath,
): Promise<string | null> {
  // Dynamic import: keep Node built-ins out of browser/edge bundles
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const segments = logicalPath.split('/').filter(Boolean)
  let currentPath = root

  for (const segment of segments) {
    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true })
      const matchingDir = entries.find((entry) => {
        if (!entry.isDirectory()) return false
        const logicalName = extractSlugFromFilename(entry.name)
        return logicalName === segment.toLowerCase()
      })

      if (matchingDir) {
        currentPath = path.join(currentPath, matchingDir.name)
      } else {
        return null
      }
    } catch (err: unknown) {
      if (isNotFoundError(err)) return null
      throw err
    }
  }

  return currentPath
}

/**
 * The entry type of an entry file: the first part of `type.slug.id.ext`, so
 * "post.my-slug.a1b2c3d4e5f6.json" → "post". Null for anything else, including
 * a collection directory ("posts.a1b2c3d4e5f6").
 */
export function extractEntryTypeFromFilename(filename: string): string | null {
  if (filename.startsWith('.')) return null

  const parts = filename.split('.')

  if (parts.length >= 4) {
    const possibleId = parts[parts.length - 2]
    if (isValidId(possibleId)) {
      return parts[0] // Entry type is first part
    }
  }

  return null
}

/**
 * The slug in a filename, lowercased: everything between the type and the ID in
 * `type.slug.id.ext`, or the part before the ID in a `slug.id` directory. A
 * dotted slug survives ("post.my.page.a1b2c3d4e5f6.json" → "my.page"). Falls
 * back to the extensionless filename when there is no ID.
 *
 * `entryTypeName`, when it matches the first part, strips that part explicitly
 * instead of relying on the 4-part auto-detection.
 */
export function extractSlugFromFilename(filename: string, entryTypeName?: string): Slug {
  const parts = filename.split('.')

  if (parts.length >= 3) {
    const possibleId = parts[parts.length - 2]
    if (isValidId(possibleId)) {
      let slugParts = parts.slice(0, parts.length - 2)

      if (entryTypeName && slugParts.length > 1 && slugParts[0] === entryTypeName) {
        slugParts = slugParts.slice(1)
      }
      // Auto-detected: 4+ parts is type.slug.id.ext, so the first part is the type.
      else if (parts.length >= 4 && slugParts.length > 1) {
        slugParts = slugParts.slice(1)
      }

      return slugParts.join('.').toLowerCase() as Slug
    }
  }

  if (parts.length === 2) {
    const possibleId = parts[parts.length - 1]
    if (isValidId(possibleId)) {
      return parts[0].toLowerCase() as Slug
    }
  }

  if (parts.length > 1) {
    return parts.slice(0, -1).join('.').toLowerCase() as Slug
  }

  return filename.toLowerCase() as Slug
}
