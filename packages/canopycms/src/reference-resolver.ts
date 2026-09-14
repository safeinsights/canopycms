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
 */
export class ReferenceResolver {
  constructor(
    private store: ContentStore,
    private idIndex: ContentIdIndex,
  ) {}

  /**
   * Resolve a content ID to a display value.
   * Returns null if the ID doesn't exist or points to a collection.
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
   * @param canAccess - Optional permission predicate, called with each candidate's
   *   relative path before it is read. Returning false skips the entry entirely --
   *   no file I/O, no label, no option -- so a caller who can't read a path never
   *   triggers a read for content they won't be allowed to see anyway.
   */
  async loadReferenceOptions(
    collections?: LogicalPath[],
    displayField = 'title',
    search?: string,
    entryTypes?: string[],
    canAccess?: (relativePath: PhysicalPath) => boolean,
  ): Promise<ReferenceOption[]> {
    const options: ReferenceOption[] = []

    // Collection-scoped queries go through getCollectionEntryPaths (it normalizes paths -- e.g.
    // 'authors' -> 'content/authors' -- and consults the schema index); an entryTypes-only query
    // has no collection scope, so it reads the ID index directly.
    type Candidate = { relativePath: PhysicalPath; collection: LogicalPath; slug: Slug }
    let candidates: Candidate[]
    if (collections && collections.length > 0) {
      const results = await Promise.all(
        collections.map((col) => this.store.getCollectionEntryPaths(col)),
      )
      candidates = results.flat()
    } else {
      candidates = this.idIndex
        .getAllEntryLocations()
        .filter(
          (loc): loc is IdLocation & { collection: LogicalPath; slug: Slug } =>
            loc.type === 'entry' && !!loc.collection && !!loc.slug,
        )
    }

    if (entryTypes && entryTypes.length > 0) {
      candidates = candidates.filter((loc) => {
        const entryType = extractEntryTypeFromFilename(nodePath.basename(loc.relativePath))
        return entryType != null && entryTypes.includes(entryType)
      })
    }

    for (const location of candidates) {
      if (!location.collection || !location.slug) continue
      // Skip denied paths before any file I/O.
      if (canAccess && !canAccess(location.relativePath)) continue

      const id = this.idIndex.findByPath(location.relativePath)
      if (!id) continue

      try {
        const filename = nodePath.basename(location.relativePath)
        const normalizedSlug = extractSlugFromFilename(filename)

        const doc = await this.store.read(location.collection, normalizedSlug as Slug)
        const label = String(doc.data[displayField] || doc.data.title || normalizedSlug)

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
