import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import { generateId, isValidId } from './id'

export interface IdLocation {
  id: string
  type: 'entry' | 'collection'
  relativePath: string // e.g. 'content/posts/dune.a1b2c3d4e5f6.json'
  collection?: string // e.g. 'content/posts' (for entries only)
  slug?: string // e.g. 'dune' (for entries only)
}

/**
 * ContentIdIndex manages the bidirectional mapping between content IDs and file paths.
 *
 * IDs are embedded in filenames using the pattern `{slug}.{12-char-id}.{ext}` for files
 * and `{slug}.{12-char-id}/` for directories (e.g., `dune.a1b2c3d4e5f6.json`).
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
                `  File 2: ${fullRelativePath}`
            )
          }

          const location: IdLocation = {
            id,
            type: entry.isDirectory() ? 'collection' : 'entry',
            relativePath: fullRelativePath,
          }

          // Extract slug and collection for entries
          if (!entry.isDirectory()) {
            const slug = extractSlugFromFilename(entry.name)
            const collectionPath = path.dirname(fullRelativePath)
            location.slug = slug
            location.collection = collectionPath
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
  findByPath(relativePath: string): string | null {
    return this.pathToId.get(relativePath) || null
  }

  /**
   * Get all ID locations in the index.
   * Useful for validation and checking references.
   */
  getAllLocations(): IdLocation[] {
    return Array.from(this.idToLocation.values())
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
          `  File 2: ${location.relativePath}`
      )
    }

    const fullLocation: IdLocation = {
      ...location,
      id,
    }
    this.idToLocation.set(id, fullLocation)
    this.pathToId.set(location.relativePath, id)
  }

  /**
   * Remove an entry or collection from the index by ID.
   * Note: This only updates the in-memory index. The file must be deleted separately.
   */
  remove(id: string): void {
    const location = this.idToLocation.get(id)
    if (!location) return

    this.idToLocation.delete(id)
    this.pathToId.delete(location.relativePath)
  }

  /**
   * Update the path for an existing ID (e.g., after file rename/move).
   * This is used to keep the index in sync when files are renamed.
   */
  updatePath(id: string, newRelativePath: string): void {
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
      location.slug = extractSlugFromFilename(path.basename(newRelativePath))
      location.collection = path.dirname(newRelativePath)
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
 * - Files: slug.id.ext → parts[1] is ID (e.g., "dune.a1b2c3d4e5f6.json")
 * - Directories: slug.id → parts[1] is ID (e.g., "posts.a1b2c3d4e5f6")
 * - Metadata: .collection.json, .gitignore, etc. → null
 *
 * Edge cases:
 * - Slugs with dots: "my.page.a1b2c3d4e5f6.json" → extracts "a1b2c3d4e5f6"
 * - Hidden files with IDs: ".hidden.a1b2c3d4e5f6.json" → returns null (metadata)
 * - No ID present: "legacy-file.json" → returns null
 */
export function extractIdFromFilename(filename: string): string | null {
  // Skip metadata files (no IDs) - anything starting with dot is metadata
  // This includes .collection.json, .gitignore, and even .hidden.id.json
  if (filename.startsWith('.')) {
    return null
  }

  const parts = filename.split('.')

  // Files: slug.id.ext → need at least 3 parts
  // The ID is always the second-to-last part before the extension
  if (parts.length >= 3) {
    const candidate = parts[parts.length - 2]
    if (isValidId(candidate)) return candidate
  }

  // Directories: slug.id → exactly 2 parts (slug and ID, no extension)
  if (parts.length === 2) {
    const candidate = parts[parts.length - 1]
    if (isValidId(candidate)) return candidate
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
export async function resolveCollectionPath(root: string, logicalPath: string): Promise<string | null> {
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
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null
      throw err
    }
  }

  return currentPath
}

/**
 * Extract slug from filename (the part before the ID).
 * Works for both files (slug.id.ext) and directories (slug.id).
 * Handles slugs with dots (e.g., "my.page.a1b2c3d4e5f6.json" → "my.page")
 */
export function extractSlugFromFilename(filename: string): string {
  const parts = filename.split('.')

  // Try to find the ID in the parts
  // Files: slug.id.ext (at least 3 parts)
  if (parts.length >= 3) {
    const possibleId = parts[parts.length - 2]
    if (isValidId(possibleId)) {
      // Everything before the ID is the slug
      return parts.slice(0, parts.length - 2).join('.')
    }
  }

  // Directories: slug.id (exactly 2 parts)
  if (parts.length === 2) {
    const possibleId = parts[parts.length - 1]
    if (isValidId(possibleId)) {
      // Everything before the ID is the slug
      return parts[0]
    }
  }

  // No ID found, remove extension and return the rest
  // This handles legacy files without IDs
  if (parts.length > 1) {
    return parts.slice(0, -1).join('.')
  }

  // No extension, return as-is
  return filename
}
