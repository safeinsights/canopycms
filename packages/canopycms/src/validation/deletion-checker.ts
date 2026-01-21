import type { ContentStore } from '../content-store'
import type { ContentIdIndex, IdLocation } from '../content-id-index'
import type { FieldConfig, ObjectFieldConfig, BlockFieldConfig } from '../config'

export interface ReferenceInfo {
  entryPath: string
  entryTitle?: string
  collection: string
  slug: string
  fields: string[] // Field paths where the reference was found
}

export interface DeletionCheckResult {
  canDelete: boolean
  referencedBy: ReferenceInfo[]
}

/**
 * DeletionChecker finds all references to an entry before deletion.
 *
 * This class provides referential integrity checking by:
 * - Scanning all entries for references to a target ID
 * - Identifying which entries and fields reference the target
 * - Preventing deletion of entries that are still referenced
 *
 * Usage:
 *   const checker = new DeletionChecker(store, idIndex, schema)
 *   const result = await checker.canDelete(targetId)
 *   if (!result.canDelete) {
 *     console.log('Cannot delete:', result.referencedBy)
 *   }
 */
export class DeletionChecker {
  constructor(
    private store: ContentStore,
    private idIndex: ContentIdIndex,
    private collections: Map<string, { fields: FieldConfig[] }>,
  ) {}

  /**
   * Check if an entry can be safely deleted.
   *
   * @param id - The content ID to check
   * @returns Result indicating if deletion is safe and what references exist
   */
  async canDelete(id: string): Promise<DeletionCheckResult> {
    const referencedBy = await this.findReferences(id)
    return {
      canDelete: referencedBy.length === 0,
      referencedBy,
    }
  }

  /**
   * Find all entries that reference the target ID.
   *
   * @param targetId - The content ID to search for
   * @returns Array of reference info for each referencing entry
   */
  async findReferences(targetId: string): Promise<ReferenceInfo[]> {
    const references: ReferenceInfo[] = []

    // Scan all collections for references
    for (const [collectionPath, collectionDef] of this.collections.entries()) {
      const refs = await this.scanCollection(collectionPath, collectionDef.fields, targetId)
      references.push(...refs)
    }

    return references
  }

  /**
   * Scan a single collection for references to the target ID.
   */
  private async scanCollection(
    collectionPath: string,
    fields: FieldConfig[],
    targetId: string,
  ): Promise<ReferenceInfo[]> {
    const references: ReferenceInfo[] = []

    // Get all entries in this collection from the ID index
    const entries = this.listEntriesInCollection(collectionPath)

    for (const entry of entries) {
      try {
        const doc = await this.store.read(entry.collection, entry.slug)
        const refs = this.findIdInData(doc.data, targetId, fields)

        if (refs.length > 0) {
          const id = this.idIndex.findByPath(entry.relativePath)
          references.push({
            entryPath: id || '',
            entryTitle: doc.data.title as string | undefined,
            collection: entry.collection,
            slug: entry.slug,
            fields: refs,
          })
        }
      } catch {
        // Skip entries that can't be read
        continue
      }
    }

    return references
  }

  /**
   * Find all occurrences of target ID in entry data.
   * Returns field paths where the ID was found.
   */
  private findIdInData(
    data: Record<string, unknown>,
    targetId: string,
    schema: FieldConfig[],
    pathPrefix = '',
  ): string[] {
    const found: string[] = []

    for (const field of schema) {
      const fieldPath = pathPrefix ? `${pathPrefix}.${field.name}` : field.name
      const value = data[field.name]

      if (value === undefined || value === null) continue

      if (field.type === 'reference') {
        // Check if this reference field contains the target ID
        if (Array.isArray(value)) {
          if (value.includes(targetId)) {
            found.push(fieldPath)
          }
        } else if (value === targetId) {
          found.push(fieldPath)
        }
      } else if (field.type === 'object') {
        // Recurse into object fields
        const objectField = field as ObjectFieldConfig
        if (objectField.fields && typeof value === 'object' && !Array.isArray(value)) {
          found.push(
            ...this.findIdInData(
              value as Record<string, unknown>,
              targetId,
              objectField.fields,
              fieldPath,
            ),
          )
        }
      } else if (field.type === 'block') {
        // Handle block fields
        const blockField = field as BlockFieldConfig
        if (Array.isArray(value)) {
          value.forEach((item, index) => {
            if (typeof item === 'object' && item !== null) {
              const blockType = (item as any)._type
              const blockDef = blockField.templates?.find((b: any) => b.name === blockType)
              if (blockDef && blockDef.fields) {
                found.push(
                  ...this.findIdInData(
                    item as Record<string, unknown>,
                    targetId,
                    blockDef.fields,
                    `${fieldPath}[${index}]`,
                  ),
                )
              }
            }
          })
        }
      } else if (field.type === 'array') {
        // Handle array fields
        const arrayField = field as any
        if (Array.isArray(value) && arrayField.of) {
          if (arrayField.of.type === 'object' && arrayField.of.fields) {
            value.forEach((item, index) => {
              if (typeof item === 'object' && item !== null) {
                found.push(
                  ...this.findIdInData(
                    item as Record<string, unknown>,
                    targetId,
                    arrayField.of.fields,
                    `${fieldPath}[${index}]`,
                  ),
                )
              }
            })
          }
        }
      }
    }

    return found
  }

  /**
   * Helper to list all entries in a collection from the ID index.
   */
  private listEntriesInCollection(
    collectionPath: string,
  ): Array<{ relativePath: string; collection: string; slug: string }> {
    const entries: Array<{ relativePath: string; collection: string; slug: string }> = []

    // Get all locations from the index
    const allLocations = this.idIndex.getAllLocations()

    for (const location of allLocations) {
      if (location.type === 'entry') {
        // Check if this entry is in the target collection
        if (
          location.collection === collectionPath ||
          location.collection?.startsWith(collectionPath + '/')
        ) {
          entries.push({
            relativePath: location.relativePath,
            collection: location.collection,
            slug: location.slug!,
          })
        }
      }
    }

    return entries
  }
}
