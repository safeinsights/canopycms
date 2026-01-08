import type { ContentStore } from './content-store'
import type { ContentIdIndex, IdLocation } from './content-id-index'

export interface ResolvedReference {
  id: string
  exists: boolean
  displayValue: string
  collection?: string
  slug?: string
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
    private contentRoot: string = 'content',
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
    } catch {
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
    collections: string[],
    displayField = 'title',
    search?: string,
  ): Promise<ReferenceOption[]> {
    const options: ReferenceOption[] = []

    for (const collectionPath of collections) {
      // Get all entries in this collection
      // Note: This requires a listCollectionEntries method on ContentStore
      // which we'll need to implement or work around
      const entries = await this.listEntriesInCollection(collectionPath)

      for (const entry of entries) {
        const id = this.idIndex.findByPath(entry.relativePath)
        if (!id) continue

        try {
          const doc = await this.store.read(entry.collection, entry.slug)
          const label = String(doc.data[displayField] || doc.data.title || entry.slug)

          // Apply search filter if provided
          if (search && !label.toLowerCase().includes(search.toLowerCase())) {
            continue
          }

          options.push({
            id,
            label,
            collection: entry.collection,
          })
        } catch {
          // Skip entries that can't be read
          continue
        }
      }
    }

    return options.sort((a, b) => a.label.localeCompare(b.label))
  }

  /**
   * Helper to list all entries in a collection.
   * This is a temporary implementation until ContentStore has this method.
   */
  private async listEntriesInCollection(
    collectionPath: string,
  ): Promise<Array<{ relativePath: string; collection: string; slug: string }>> {
    // For now, we'll scan the ID index for entries in this collection
    const entries: Array<{ relativePath: string; collection: string; slug: string }> = []

    // This is inefficient but works for now
    // TODO: Add a proper listCollectionEntries method to ContentStore
    const allLocations = Array.from((this.idIndex as any).idToLocation.values()) as IdLocation[]

    // Normalize collection path - ID index stores full paths like "content/authors"
    // but schema specifies just "authors", so we need to try both
    const normalizedPaths = [collectionPath, `${this.contentRoot}/${collectionPath}`]

    for (const location of allLocations) {
      if (location.type === 'entry') {
        // Check if this entry is in the target collection (try all normalized paths)
        const matches = normalizedPaths.some(
          (normalized) =>
            location.collection === normalized || location.collection?.startsWith(normalized + '/'),
        )

        if (matches && location.slug) {
          entries.push({
            relativePath: location.relativePath,
            collection: location.collection!,
            slug: location.slug,
          })
        }
      }
    }

    return entries
  }

  /**
   * Resolve multiple IDs at once.
   * Useful for displaying lists of referenced items.
   */
  async resolveMany(ids: string[], displayField = 'title'): Promise<(ResolvedReference | null)[]> {
    return Promise.all(ids.map((id) => this.resolve(id, displayField)))
  }
}
