import type { FieldConfig, FlatSchemaItem } from '../config'
import { titleFieldPath } from '../utils/title-field'
import type { EditorCollection, EditorEntryType } from './Editor'

/** The `titleField` an entry type contributes: absent for an unavailable type, which has no schema. */
const titleFieldFor = (
  schema: readonly FieldConfig[] | undefined,
): Pick<EditorEntryType, 'titleField'> => {
  const titleField = titleFieldPath(schema ?? [])
  return titleField ? { titleField } : {}
}

/**
 * Build hierarchical editor collections from the flattened schema.
 * Uses logicalPath as IDs to match API responses.
 * Optimized to O(n) using Map-based grouping.
 *
 * Only collections are returned - entry types are schema metadata, not navigable nodes.
 * Entry types define the schema for entries within a collection but are not themselves
 * shown as separate nodes in the navigation tree.
 */
export const buildEditorCollections = (flatSchema: FlatSchemaItem[]): EditorCollection[] => {
  const flat = flatSchema

  // Group items by parentPath for O(1) lookup - O(n) total
  const childrenByParent = new Map<string | undefined, FlatSchemaItem[]>()
  for (const item of flat) {
    const key = item.parentPath
    if (!childrenByParent.has(key)) {
      childrenByParent.set(key, [])
    }
    childrenByParent.get(key)!.push(item)
  }

  // A collection's own `entries` carry no schema on the wire; the entry-type items hold the
  // hydrated one.
  const schemaByEntryType = new Map<string, readonly FieldConfig[]>()
  for (const item of flat) {
    if (item.type === 'entry-type')
      schemaByEntryType.set(`${item.parentPath}\0${item.name}`, item.schema)
  }

  // Build tree recursively using the grouped map
  const buildTree = (parentPath?: string): EditorCollection[] => {
    const children = childrenByParent.get(parentPath) || []
    const results: EditorCollection[] = []

    for (const item of children) {
      if (item.type === 'collection') {
        // Collections are always navigable
        const defaultEntry = item.entries?.find((e) => e.default) || item.entries?.[0]
        const entryTypes: EditorEntryType[] | undefined = item.entries?.map((et) => ({
          name: et.name,
          label: et.label,
          format: et.format,
          default: et.default,
          maxItems: et.maxItems,
          ...(et.unavailable
            ? { unavailable: et.unavailable }
            : titleFieldFor(schemaByEntryType.get(`${item.logicalPath}\0${et.name}`) ?? et.schema)),
        }))
        results.push({
          path: item.logicalPath,
          contentId: item.contentId,
          name: item.name,
          label: item.label,
          format: defaultEntry?.format || 'json',
          type: 'collection' as const,
          entryTypes: entryTypes && entryTypes.length > 0 ? entryTypes : undefined,
          order: item.order,
          children: buildTree(item.logicalPath), // Recursively build children
        })
      }
      // Entry types are NOT included - they're schema metadata, not navigable nodes
    }

    return results
  }

  // Start with root-level collections (parentPath: undefined)
  // This now includes the content root collection itself
  return buildTree(undefined)
}
