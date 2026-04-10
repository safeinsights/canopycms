import nodePath from 'node:path'

import type { ContentStore } from './content-store'
import type { ContentIdIndex, IdLocation } from './content-id-index'
import { extractSlugFromFilename, extractEntryTypeFromFilename } from './content-id-index'
import type { LogicalPath, PhysicalPath, Slug } from './paths'

export interface ResolvedReference {
  id: string
  exists: boolean
  displayValue: string
  collection?: LogicalPath
  slug?: Slug
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
   * Scans collections (including subcollections) and/or filters by entry type.
   * At least one of `collections` or `entryTypes` should be provided.
   *
   * @param collections - Collection paths to search, including subcollections (e.g., ['data-catalog'])
   * @param displayField - Field to use for option labels (default: 'title')
   * @param search - Optional search string to filter options
   * @param entryTypes - Optional entry type names to filter by (e.g., ['partner'])
   */
  async loadReferenceOptions(
    collections?: LogicalPath[],
    displayField = 'title',
    search?: string,
    entryTypes?: string[],
  ): Promise<ReferenceOption[]> {
    const options: ReferenceOption[] = []

    // Gather candidate entries. Use getCollectionEntryPaths for collection-based queries
    // (it handles path normalization and schema index lookups). Use the ID index directly
    // for entryTypes-only queries (no collection scope).
    type Candidate = { relativePath: PhysicalPath; collection: LogicalPath; slug: Slug }
    let candidates: Candidate[]
    if (collections && collections.length > 0) {
      // Search within specified collection trees (including subcollections)
      // getCollectionEntryPaths handles normalization (e.g., 'authors' → 'content/authors')
      const results = await Promise.all(
        collections.map((col) => this.store.getCollectionEntryPaths(col)),
      )
      candidates = results.flat()
    } else {
      // No collection scope — search all entries via index
      candidates = this.idIndex
        .getAllEntryLocations()
        .filter(
          (loc): loc is IdLocation & { collection: LogicalPath; slug: Slug } =>
            loc.type === 'entry' && !!loc.collection && !!loc.slug,
        )
    }

    // Filter by entry type if specified
    if (entryTypes && entryTypes.length > 0) {
      candidates = candidates.filter((loc) => {
        const entryType = extractEntryTypeFromFilename(nodePath.basename(loc.relativePath))
        return entryType != null && entryTypes.includes(entryType)
      })
    }

    for (const location of candidates) {
      if (!location.collection || !location.slug) continue

      const id = this.idIndex.findByPath(location.relativePath)
      if (!id) continue

      try {
        const filename = nodePath.basename(location.relativePath)
        const normalizedSlug = extractSlugFromFilename(filename)

        const doc = await this.store.read(location.collection, normalizedSlug as Slug)
        const label = String(doc.data[displayField] || doc.data.title || normalizedSlug)

        // Apply search filter if provided
        if (search && !label.toLowerCase().includes(search.toLowerCase())) {
          continue
        }

        options.push({
          id,
          label,
          collection: location.collection,
        })
      } catch (error) {
        console.error('Failed to read entry for reference options:', {
          collection: location.collection,
          slug: location.slug,
          error,
        })
        continue
      }
    }

    return options.sort((a, b) => a.label.localeCompare(b.label))
  }

  /**
   * Resolve multiple IDs at once.
   * Useful for displaying lists of referenced items.
   */
  async resolveMany(ids: string[], displayField = 'title'): Promise<(ResolvedReference | null)[]> {
    return Promise.all(ids.map((id) => this.resolve(id, displayField)))
  }
}
