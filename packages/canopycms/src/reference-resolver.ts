import nodePath from 'node:path'

import type { ContentStore } from './content-store'
import type { ContentIdIndex, IdLocation } from './content-id-index'
import { extractSlugFromFilename, extractEntryTypeFromFilename } from './content-id-index'
import { entryLogicalPath, type LogicalPath, type PhysicalPath, type Slug } from './paths'

export interface ReferenceOption {
  id: string
  label: string
  collection: string
}

/**
 * Loads the options a reference field's picker offers. Resolving a stored reference to its
 * target is `ContentStore`'s job (`read()`, `resolveReferenceTarget`).
 */
export class ReferenceResolver {
  constructor(
    private store: ContentStore,
    private idIndex: ContentIdIndex,
  ) {}

  /**
   * Load all available reference options for a reference field.
   *
   * Scans collections (including subcollections) and/or filters by entry type.
   * At least one of `collections` or `entryTypes` should be provided.
   *
   * @param canAccess - Optional permission predicate, called with each candidate's
   *   logical path (`entryLogicalPath`) before it is read. Returning false skips the entry entirely --
   *   no file I/O, no label, no option -- so a caller who can't read a path never
   *   triggers a read for content they won't be allowed to see anyway.
   */
  async loadReferenceOptions(
    collections?: LogicalPath[],
    displayField = 'title',
    search?: string,
    entryTypes?: string[],
    canAccess?: (logicalPath: LogicalPath) => boolean,
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
      if (canAccess && !canAccess(entryLogicalPath(location.collection, location.slug))) continue

      const id = this.idIndex.findByPath(location.relativePath)
      if (!id) continue

      try {
        const filename = nodePath.basename(location.relativePath)
        const normalizedSlug = extractSlugFromFilename(filename)

        // Only the label is read, so the candidate's own references stay unresolved.
        const doc = await this.store.read(location.collection, normalizedSlug as Slug, {
          resolveReferences: false,
          allowUnavailableEntryType: true,
        })
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
}
