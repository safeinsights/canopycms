import path from 'node:path'

import type { ContentStore } from './content-store'
import type { ContentIdIndex } from './content-id-index'
import { extractSlugFromFilename } from './content-id-index'
import type { LogicalPath, PhysicalPath, EntrySlug } from './paths'

export interface ResolvedReference {
  id: string
  exists: boolean
  displayValue: string
  collection?: LogicalPath
  slug?: EntrySlug
}

export interface ReferenceOption {
  id: string
  label: string
  collection: string
}

/**
 * ReferenceResolver resolves content IDs to display values for reference fields.
 *
 * This class provides utilities for:
 * - Resolving a single ID to its display value (e.g., title)
 * - Loading all available options for a reference field
 * - Filtering options by collection constraints
 * - Searching options by display value
 */
export class ReferenceResolver {
  constructor(
    private store: ContentStore,
    private idIndex: ContentIdIndex,
  ) {}

  /**
   * Resolve a content ID to a display value.
   * Returns null if the ID doesn't exist or points to a collection.
   *
   * @param id - The content ID to resolve
   * @param displayField - The field to use for display value (default: 'title')
   */
  async resolve(id: string, displayField = 'title'): Promise<ResolvedReference | null> {
    const location = this.idIndex.findById(id)

    if (!location || location.type !== 'entry') {
      return {
        id,
        exists: false,
        displayValue: id, // Fallback to showing the ID itself
      }
    }

    try {
      const doc = await this.store.read(location.collection!, location.slug!)
      const displayValue = String(doc.data[displayField] || doc.data.title || location.slug)

      return {
        id,
        exists: true,
        displayValue,
        collection: location.collection,
        slug: location.slug,
      }
    } catch (error) {
      console.error('Failed to resolve reference:', { id, error })
      return {
        id,
        exists: false,
        displayValue: id,
      }
    }
  }

  /**
   * Load all available reference options for a reference field.
   *
   * This method scans the specified collections and returns options
   * suitable for a dropdown/select field.
   *
   * @param collections - Collection paths to search (e.g., ['posts', 'docs'])
   * @param displayField - Field to use for option labels (default: 'title')
   * @param search - Optional search string to filter options
   */
  async loadReferenceOptions(
    collections: LogicalPath[],
    displayField = 'title',
    search?: string,
  ): Promise<ReferenceOption[]> {
    const options: ReferenceOption[] = []

    for (const collectionPath of collections) {
      // Get all entries in this collection
      const entries = await this.listEntriesInCollection(collectionPath)

      for (const entry of entries) {
        const id = this.idIndex.findByPath(entry.relativePath)
        if (!id) continue

        try {
          // The slug from the index may include the entry type prefix for new-format files
          // (e.g., "author.alice" instead of just "alice"). We need to strip the type prefix
          // before passing to store.read() to avoid double-prefixing.
          // Use extractSlugFromFilename to properly extract just the slug part.
          const filename = path.basename(entry.relativePath)
          const normalizedSlug = extractSlugFromFilename(filename).toLowerCase()

          const doc = await this.store.read(entry.collection, normalizedSlug as EntrySlug)
          const label = String(doc.data[displayField] || doc.data.title || normalizedSlug)

          // Apply search filter if provided
          if (search && !label.toLowerCase().includes(search.toLowerCase())) {
            continue
          }

          options.push({
            id,
            label,
            collection: entry.collection,
          })
        } catch (error) {
          // Skip entries that can't be read
          console.error('Failed to read entry for reference options:', {
            collection: entry.collection,
            slug: entry.slug,
            error,
          })
          continue
        }
      }
    }

    return options.sort((a, b) => a.label.localeCompare(b.label))
  }

  /**
   * Helper to list all entries in a collection.
   */
  private async listEntriesInCollection(collectionPath: LogicalPath): Promise<
    Array<{
      relativePath: PhysicalPath
      collection: LogicalPath
      slug: EntrySlug
    }>
  > {
    return this.store.listCollectionEntries(collectionPath)
  }

  /**
   * Resolve multiple IDs at once.
   * Useful for displaying lists of referenced items.
   */
  async resolveMany(ids: string[], displayField = 'title'): Promise<(ResolvedReference | null)[]> {
    return Promise.all(ids.map((id) => this.resolve(id, displayField)))
  }
}
