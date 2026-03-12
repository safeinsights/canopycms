import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import { generateId, isValidId } from './id'
import { isNotFoundError } from './utils/error'
import { type LogicalPath, type PhysicalPath, type EntrySlug, type ContentId } from './paths'

/** Logical path representing entries stored at the branch root (no parent collection). Rare in practice. */
const EMPTY_LOGICAL_PATH = '' as LogicalPath

/**
 * Strips embedded IDs from each physical path segment to produce a logical path.
 * e.g. "content/posts.a1b2c3d4e5f6" → "content/posts"
 * This is a module-private helper for internal path conversion only.
 */
function toLogicalCollectionPath(physicalPath: string): LogicalPath {
  if (physicalPath === '.') return EMPTY_LOGICAL_PATH
  // extractSlugFromFilename strips the ID (and extension) from each segment
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
  slug?: EntrySlug // e.g. 'dune' (for entries only)
}

/**
 * ContentIdIndex manages the bidirectional mapping between content IDs and file paths.
 *
 * IDs are embedded in filenames using the patterns:
 * - Entries: `{type}.{slug}.{12-char-id}.{ext}` (e.g., `post.dune.a1b2c3d4e5f6.json`)
 * - Collection directories: `{slug}.{12-char-id}/` (e.g., `posts.a1b2c3d4e5f6/`)
 *
 * This class builds an in-memory index by scanning filenames recursively, providing O(1) lookups
 * in both directions (ID→path and path→ID).
 *
 * The index is built lazily on first access to optimize Lambda cold starts.
 *
 * ## Multi-Process Consistency
 *
 * This class is NOT thread-safe. In multi-process environments (e.g., multiple Lambda
 * instances or server processes), each process maintains its own in-memory index.
 *
 * **Consistency guarantees:**
 * - Filenames on the filesystem are the source of truth
 * - Each process discovers the same filenames when building its index
 * - Write operations that change filenames are atomic (rename is atomic)
 * - Read operations always reflect current filesystem state after index rebuild
 *
 * **Race condition handling:**
 * - Multiple processes creating entries simultaneously: Each generates a unique ID,
 *   collisions detected during index build (fail fast)
 * - One process writes, another reads: Reader's stale index might miss new IDs until
 *   next rebuild. This is acceptable - eventual consistency.
 * - Index drift: Rare, but processes can rebuild index if they detect missing IDs
 *
 * For most use cases (CMS with human editors), race conditions are unlikely and
 * eventual consistency is sufficient.
 */
export class ContentIdIndex {
  private idToLocation: Map<string, IdLocation> = new Map()
  private pathToId: Map<string, string> = new Map()
  private byCollection: Map<string, Set<string>> = new Map()
  private root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  /**
   * Build index by scanning filenames recursively.
   * Throws if duplicate IDs found (collision detection).
   */
  async buildFromFilenames(startPath: string = ''): Promise<void> {
    await this.scanDirectory(startPath)
  }

  private async scanDirectory(relativePath: string): Promise<void> {
    const absoluteDir = path.join(this.root, relativePath)

    try {
      const entries = await fs.readdir(absoluteDir, { withFileTypes: true })

      for (const entry of entries) {
        // Skip hidden files and directories (including _ids_)
        if (entry.name.startsWith('.') || entry.name === '_ids_') {
          continue
        }

        const fullRelativePath = path.join(relativePath, entry.name)
        const id = extractIdFromFilename(entry.name)

        if (id) {
          // Collision detection
          if (this.idToLocation.has(id)) {
            const existing = this.idToLocation.get(id)!
            throw new Error(
              `ID collision detected: ${id}\n` +
                `  File 1: ${existing.relativePath}\n` +
                `  File 2: ${fullRelativePath}`,
            )
          }

          const location: IdLocation = {
            id, // already ContentId from extractIdFromFilename
            type: entry.isDirectory() ? 'collection' : 'entry',
            relativePath: fullRelativePath as PhysicalPath, // filesystem path with embedded IDs
          }

          // Extract slug and collection for entries
          if (!entry.isDirectory()) {
            const slug = extractSlugFromFilename(entry.name)
            // Convert physical collection path to logical by stripping embedded IDs from each segment
            // e.g., "content/posts.a1b2c3d4e5f6" → "content/posts"
            const physicalCollection = path.dirname(fullRelativePath)
            const collectionPath = toLogicalCollectionPath(physicalCollection)
            location.slug = slug as EntrySlug // slug extracted from validated filename
            location.collection = collectionPath

            // Add to collection index
            if (!this.byCollection.has(collectionPath)) {
              this.byCollection.set(collectionPath, new Set())
            }
            this.byCollection.get(collectionPath)!.add(id)
          }

          this.idToLocation.set(id, location)
          this.pathToId.set(fullRelativePath, id)
        }

        // Recurse into directories
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
   * Forward lookup: ID → location (O(1))
   */
  findById(id: string): IdLocation | null {
    return this.idToLocation.get(id) || null
  }

  /**
   * Reverse lookup: path → ID (O(1))
   */
  findByPath(relativePath: PhysicalPath): ContentId | null {
    return (this.pathToId.get(relativePath) as ContentId | undefined) || null
  }

  /**
   * Get all ID locations in the index.
   * Useful for validation and checking references.
   */
  getAllLocations(): IdLocation[] {
    return Array.from(this.idToLocation.values())
  }

  /**
   * Get all entries in a collection by collection path.
   *
   * Performance: O(1) + O(m) where m is the number of entries in the collection.
   *
   * @param collectionPath - The collection path (e.g., "content/posts")
   * @returns Array of IdLocation objects for entries in the collection
   */
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
   * Add a new entry or collection to the index.
   * Note: This only updates the in-memory index. The file with embedded ID
   * must already exist on disk (created by ContentStore).
   */
  add(location: Omit<IdLocation, 'id'>): void {
    const id = extractIdFromFilename(path.basename(location.relativePath))
    if (!id) {
      throw new Error(`Cannot add location without ID in filename: ${location.relativePath}`)
    }

    // Collision detection
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

    // Add to collection index if it's an entry
    if (fullLocation.type === 'entry' && fullLocation.collection) {
      if (!this.byCollection.has(fullLocation.collection)) {
        this.byCollection.set(fullLocation.collection, new Set())
      }
      this.byCollection.get(fullLocation.collection)!.add(id)
    }
  }

  /**
   * Remove an entry or collection from the index by ID.
   * Note: This only updates the in-memory index. The file must be deleted separately.
   */
  remove(id: ContentId): void {
    const location = this.idToLocation.get(id)
    if (!location) return

    // Remove from collection index if it's an entry
    if (location.type === 'entry' && location.collection) {
      const idSet = this.byCollection.get(location.collection)
      if (idSet) {
        idSet.delete(id)
        // Clean up empty Sets to prevent memory leaks
        if (idSet.size === 0) {
          this.byCollection.delete(location.collection)
        }
      }
    }

    this.idToLocation.delete(id)
    this.pathToId.delete(location.relativePath)
  }

  /**
   * Update the path for an existing ID (e.g., after file rename/move).
   * This is used to keep the index in sync when files are renamed.
   */
  updatePath(id: ContentId, newRelativePath: PhysicalPath): void {
    const location = this.idToLocation.get(id)
    if (!location) {
      throw new Error(`Cannot update path for unknown ID: ${id}`)
    }

    // Remove old path mapping
    this.pathToId.delete(location.relativePath)

    // Update location
    location.relativePath = newRelativePath

    // Update slug and collection for entries
    if (location.type === 'entry') {
      const oldCollection = location.collection
      location.slug = extractSlugFromFilename(path.basename(newRelativePath)) as EntrySlug // from validated filename
      const physicalCollection = path.dirname(newRelativePath)
      location.collection = toLogicalCollectionPath(physicalCollection)

      // Update collection index if collection changed
      if (oldCollection !== location.collection) {
        // Remove from old collection
        if (oldCollection) {
          const oldSet = this.byCollection.get(oldCollection)
          if (oldSet) {
            oldSet.delete(id)
            if (oldSet.size === 0) {
              this.byCollection.delete(oldCollection)
            }
          }
        }

        // Add to new collection
        if (location.collection) {
          if (!this.byCollection.has(location.collection)) {
            this.byCollection.set(location.collection, new Set())
          }
          this.byCollection.get(location.collection)!.add(id)
        }
      }
    }

    // Add new path mapping
    this.pathToId.set(newRelativePath, id)
  }
}

/**
 * Extract ID from filename.
 * Returns null if filename doesn't contain an ID or is a metadata file.
 *
 * Pattern:
 * - Collection entry files: type.slug.id.ext → ID is parts[parts.length - 2] (e.g., "post.dune.a1b2c3d4e5f6.json")
 * - Collection directories: slug.id → ID is parts[1] (e.g., "posts.a1b2c3d4e5f6")
 * - Metadata files: .collection.json, .gitignore, etc. → null
 *
 * Edge cases:
 * - Slugs with dots: "post.my.page.a1b2c3d4e5f6.json" → extracts "a1b2c3d4e5f6"
 * - Hidden files with IDs: ".hidden.a1b2c3d4e5f6.json" → returns null (metadata)
 * - No ID present: "file.json" → returns null
 */
export function extractIdFromFilename(filename: string): ContentId | null {
  // Skip metadata files (no IDs) - anything starting with dot is metadata
  // This includes .collection.json, .gitignore, and even .hidden.id.json
  if (filename.startsWith('.')) {
    return null
  }

  const parts = filename.split('.')

  // Files: type.slug.id.ext → need at least 3 parts
  // The ID is always the second-to-last part before the extension
  if (parts.length >= 3) {
    const candidate = parts[parts.length - 2]
    if (isValidId(candidate)) return candidate as ContentId
  }

  // Directories: slug.id → exactly 2 parts (slug and ID, no extension)
  if (parts.length === 2) {
    const candidate = parts[parts.length - 1]
    if (isValidId(candidate)) return candidate as ContentId
  }

  return null
}

/**
 * Resolve a logical collection path to its actual filesystem path with embedded IDs.
 * Recursively resolves each path segment to handle nested collections.
 *
 * Example:
 *   Input: resolveCollectionPath(root, "content/docs/api")
 *   Output: "/abs/path/to/content/docs.bChqT78gcaLd/api.meiuwxTSo7UN"
 *
 * @param root - Absolute path to the workspace root
 * @param logicalPath - Logical path from schema (e.g., "content/docs/api")
 * @returns Absolute filesystem path with embedded IDs, or null if path doesn't exist
 */
export async function resolveCollectionPath(
  root: string,
  logicalPath: LogicalPath,
): Promise<string | null> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')

  const segments = logicalPath.split('/').filter(Boolean)
  let currentPath = root

  for (const segment of segments) {
    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true })
      const matchingDir = entries.find((entry) => {
        if (!entry.isDirectory()) return false
        // Extract logical name from directory (strips embedded ID)
        const logicalName = extractSlugFromFilename(entry.name)
        return logicalName === segment
      })

      if (matchingDir) {
        currentPath = path.join(currentPath, matchingDir.name)
      } else {
        // Directory not found - might not exist yet
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
 * Extract entry type name from filename.
 * For collection entry files with pattern type.slug.id.ext, returns the type (first part).
 *
 * Examples:
 * - "post.my-slug.a1b2c3d4e5f6.json" → "post"
 * - "article.test.a1b2c3d4e5f6.md" → "article"
 * - "posts.a1b2c3d4e5f6" → null (directory, not an entry file)
 *
 * @param filename - The filename to parse
 * @returns Entry type name or null if not a valid entry file
 */
export function extractEntryTypeFromFilename(filename: string): string | null {
  if (filename.startsWith('.')) return null

  const parts = filename.split('.')

  // Need at least 4 parts for type.slug.id.ext
  if (parts.length >= 4) {
    const possibleId = parts[parts.length - 2]
    if (isValidId(possibleId)) {
      return parts[0] // Entry type is first part
    }
  }

  return null
}

/**
 * Extract slug from filename.
 *
 * Collection entries: type.slug.id.ext → slug is parts[1...-2] (between type and ID)
 * Directories: slug.id → slug is parts[0] (before ID)
 *
 * For collection entry files (4+ parts), automatically strips the first part (type) to extract just the slug.
 *
 * Examples:
 * - "post.my-slug.a1b2c3d4e5f6.json" → "my-slug" (4 parts)
 * - "post.my.page.a1b2c3d4e5f6.json" → "my.page" (dotted slug, 5 parts)
 * - "posts.a1b2c3d4e5f6" → "posts" (directory, 2 parts)
 *
 * @param filename - The filename to parse
 * @param entryTypeName - Optional entry type name for explicit type matching (e.g., "post")
 *                        If provided and matches first part, strips it from slug
 */
export function extractSlugFromFilename(filename: string, entryTypeName?: string): string {
  const parts = filename.split('.')

  // Files: type.slug.id.ext (at least 3 parts)
  if (parts.length >= 3) {
    const possibleId = parts[parts.length - 2]
    if (isValidId(possibleId)) {
      // Get all parts before ID (excluding extension)
      let slugParts = parts.slice(0, parts.length - 2)

      // If entryTypeName is provided and matches the first part, strip it
      if (entryTypeName && slugParts.length > 1 && slugParts[0] === entryTypeName) {
        slugParts = slugParts.slice(1)
      }
      // Auto-detect: 4+ parts means type.slug.id.ext format
      else if (parts.length >= 4 && slugParts.length > 1) {
        // Strip first part (the type) to get just the slug
        slugParts = slugParts.slice(1)
      }

      return slugParts.join('.')
    }
  }

  // Directories: slug.id (exactly 2 parts)
  if (parts.length === 2) {
    const possibleId = parts[parts.length - 1]
    if (isValidId(possibleId)) {
      return parts[0]
    }
  }

  // No ID found, remove extension and return filename without extension
  if (parts.length > 1) {
    return parts.slice(0, -1).join('.')
  }

  return filename
}
