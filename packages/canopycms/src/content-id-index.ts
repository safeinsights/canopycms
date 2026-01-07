import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'

import { generateId, isValidId } from './id'

export interface IdLocation {
  id: string
  type: 'entry' | 'collection'
  relativePath: string // e.g. 'content/books/scifi/dune.json'
  symlinkPath: string // e.g. '/content/books/scifi/abc123DEF456ghi789'
  collection?: string // e.g. 'books/scifi' (for entries only)
  slug?: string // e.g. 'dune' (for entries only)
}

/**
 * ContentIdIndex manages the bidirectional mapping between content IDs and file paths.
 *
 * IDs are stored as filesystem symlinks in a centralized `content/_ids_/` directory
 * (e.g., `content/_ids_/abc123 → ../posts/hello.json`).
 * This class builds an in-memory index by scanning these symlinks, providing O(1) lookups
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
 * - Symlinks on the filesystem are the source of truth
 * - Each process discovers the same symlinks when building its index
 * - Write operations create symlinks atomically (fs.symlink is atomic)
 * - Read operations always reflect current filesystem state after index rebuild
 *
 * **Race condition handling:**
 * - Multiple processes creating entries simultaneously: Each generates a unique ID,
 *   no collisions possible (globally unique IDs)
 * - One process writes, another reads: Reader's stale index might miss new IDs until
 *   next rebuild. This is acceptable - eventual consistency.
 * - Index drift: Rare, but processes can rebuild index if they detect missing IDs
 *   (e.g., entry exists on disk but not in index)
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
   * Build both indexes by scanning symlinks in the _ids_ directory.
   * This is lazy - only called when first needed.
   */
  async buildFromSymlinks(startPath: string = ''): Promise<void> {
    const idsDir = path.join(this.root, startPath, '_ids_')

    try {
      const entries = await fs.readdir(idsDir, { withFileTypes: true })

      for (const entry of entries) {
        // Symlink IDs are 22-char alphanumeric strings (short UUIDs)
        if (entry.isSymbolicLink() && isValidId(entry.name)) {
          await this.processSymlink(entry)
        }
      }
    } catch (err) {
      // _ids_ directory might not exist yet, skip
    }
  }

  private async processSymlink(entry: Dirent): Promise<void> {
    const id = entry.name // The symlink name IS the ID
    const symlinkPath = path.join(this.root, 'content/_ids_', entry.name)
    const target = await fs.readlink(symlinkPath)
    const absoluteTarget = path.resolve(path.dirname(symlinkPath), target)
    const relativePath = path.relative(this.root, absoluteTarget)

    // Determine if target is entry or collection
    const stat = await fs.stat(absoluteTarget)
    const isCollection = stat.isDirectory()

    const location: IdLocation = {
      id,
      type: isCollection ? 'collection' : 'entry',
      relativePath,
      symlinkPath,
    }

    // For entries, extract collection and slug
    if (!isCollection) {
      const parts = relativePath.split(path.sep)
      const filename = parts[parts.length - 1]
      location.slug = path.basename(filename, path.extname(filename))
      location.collection = parts.slice(1, -1).join('/') // Remove 'content/' prefix
    }

    // Update BOTH maps (keep in sync)
    this.idToLocation.set(id, location)
    this.pathToId.set(relativePath, id)
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
   * Add a new entry or collection.
   * Generates a new ID, creates the symlink in content/_ids_/, and updates the index.
   * Returns the generated ID.
   */
  async add(location: Omit<IdLocation, 'id' | 'symlinkPath'>): Promise<string> {
    // Check if this path already has an ID
    const existingId = this.pathToId.get(location.relativePath)
    if (existingId) {
      return existingId // Already has an ID, return it
    }

    // Generate new ID
    const id = generateId()

    // Ensure _ids_ directory exists
    const idsDir = path.join(this.root, 'content/_ids_')
    await fs.mkdir(idsDir, { recursive: true })

    // Create symlink in _ids_ directory
    // Target is relative path from _ids_ to the actual file
    const symlinkPath = path.join(idsDir, id)
    const absoluteTarget = path.join(this.root, location.relativePath)
    const target = path.relative(idsDir, absoluteTarget)

    const symlinkType = location.type === 'collection' ? 'dir' : 'file'
    await fs.symlink(target, symlinkPath, symlinkType)

    // Update both maps
    const fullLocation: IdLocation = {
      ...location,
      id,
      symlinkPath,
    }
    this.idToLocation.set(id, fullLocation)
    this.pathToId.set(location.relativePath, id)

    return id
  }

  /**
   * Remove an entry or collection by ID.
   */
  async remove(id: string): Promise<void> {
    const location = this.idToLocation.get(id)
    if (!location) return

    // Delete symlink
    try {
      await fs.unlink(location.symlinkPath)
    } catch {
      // Symlink might already be gone
    }

    // Update both maps
    this.idToLocation.delete(id)
    this.pathToId.delete(location.relativePath)
  }
}
