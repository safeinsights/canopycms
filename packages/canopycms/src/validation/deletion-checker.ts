import type { ContentStore } from '../content-store'
import type { ContentIdIndex } from '../content-id-index'
import type {
  FieldConfig,
  InlineGroupFieldConfig,
  ObjectFieldConfig,
  BlockFieldConfig,
} from '../config'
import { type LogicalPath, type Slug, type PhysicalPath } from '../paths'
import { resolveBlockItem } from './field-traversal'

export interface ReferenceInfo {
  entryPath: string
  entryTitle?: string
  collection: LogicalPath
  slug: Slug
  fields: string[] // Field paths where the reference was found
}

export interface DeletionCheckResult {
  canDelete: boolean
  referencedBy: ReferenceInfo[]
}

/**
 * DeletionChecker finds all references to an entry before deletion.
 */
export class DeletionChecker {
  constructor(
    private store: ContentStore,
    private idIndex: ContentIdIndex,
    private collections: Map<LogicalPath, { fields: FieldConfig[] }>,
  ) {}

  async canDelete(id: string): Promise<DeletionCheckResult> {
    const referencedBy = await this.findReferences(id)
    return {
      canDelete: referencedBy.length === 0,
      referencedBy,
    }
  }

  async findReferences(targetId: string): Promise<ReferenceInfo[]> {
    const references: ReferenceInfo[] = []

    for (const [collectionPath, collectionDef] of this.collections.entries()) {
      const refs = await this.scanCollection(collectionPath, collectionDef.fields, targetId)
      references.push(...refs)
    }

    return references
  }

  private async scanCollection(
    collectionPath: LogicalPath,
    fields: FieldConfig[],
    targetId: string,
  ): Promise<ReferenceInfo[]> {
    const references: ReferenceInfo[] = []

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
        continue
      }
    }

    return references
  }

  private findIdInData(
    data: Record<string, unknown>,
    targetId: string,
    schema: FieldConfig[],
    pathPrefix = '',
  ): string[] {
    const found: string[] = []

    for (const field of schema) {
      // Inline groups are transparent (walkFields, ./field-traversal) — recurse at the same level.
      if (field.type === 'group') {
        found.push(
          ...this.findIdInData(
            data,
            targetId,
            (field as InlineGroupFieldConfig).fields,
            pathPrefix,
          ),
        )
        continue
      }

      const fieldPath = pathPrefix ? `${pathPrefix}.${field.name}` : field.name
      const value = data[field.name]

      if (value === undefined || value === null) continue

      if (field.type === 'reference') {
        if (Array.isArray(value)) {
          if (value.includes(targetId)) {
            found.push(fieldPath)
          }
        } else if (value === targetId) {
          found.push(fieldPath)
        }
      } else if (field.type === 'object') {
        // Recurse into object fields — handles both single objects and list:true (array of objects)
        const objectField = field as ObjectFieldConfig
        if (objectField.fields) {
          if (Array.isArray(value)) {
            // list: true — value is an array of objects
            value.forEach((item, index) => {
              if (typeof item === 'object' && item !== null) {
                found.push(
                  ...this.findIdInData(
                    item as Record<string, unknown>,
                    targetId,
                    objectField.fields!,
                    `${fieldPath}[${index}]`,
                  ),
                )
              }
            })
          } else if (typeof value === 'object' && value !== null) {
            found.push(
              ...this.findIdInData(
                value as Record<string, unknown>,
                targetId,
                objectField.fields,
                fieldPath,
              ),
            )
          }
        }
      } else if (field.type === 'block') {
        const blockField = field as BlockFieldConfig
        if (Array.isArray(value)) {
          value.forEach((item, index) => {
            if (typeof item === 'object' && item !== null) {
              const resolved = resolveBlockItem(blockField, item as Record<string, unknown>)
              if (resolved) {
                found.push(
                  ...this.findIdInData(
                    resolved.data,
                    targetId,
                    resolved.fields,
                    `${fieldPath}[${index}]`,
                  ),
                )
              }
            }
          })
        }
      }
    }

    return found
  }

  private listEntriesInCollection(collectionPath: LogicalPath): Array<{
    relativePath: PhysicalPath
    collection: LogicalPath
    slug: Slug
  }> {
    const entries: Array<{
      relativePath: PhysicalPath
      collection: LogicalPath
      slug: Slug
    }> = []

    const allLocations = this.idIndex.getAllLocations()

    for (const location of allLocations) {
      if (location.type === 'entry') {
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
