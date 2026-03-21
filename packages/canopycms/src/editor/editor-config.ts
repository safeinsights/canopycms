import type { CanopyConfig, FlatSchemaItem } from '../config'
import type { EditorCollection, EditorEntryType } from './Editor'

const normalizeContentRoot = (value?: string): string => {
  const trimmed = (value ?? 'content').replace(/^\/+|\/+$/g, '')
  return trimmed
}

const stripContentRoot = (logicalPath: string, contentRoot: string): string => {
  const prefix = contentRoot ? `${contentRoot}/` : ''
  if (prefix && logicalPath.startsWith(prefix)) {
    return logicalPath.slice(prefix.length)
  }
  return logicalPath
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

  // Build tree recursively using the grouped map
  const buildTree = (parentPath?: string): EditorCollection[] => {
    const children = childrenByParent.get(parentPath) || []
    const results: EditorCollection[] = []

    for (const item of children) {
      if (item.type === 'collection') {
        // Collections are always navigable
        const defaultEntry = item.entries?.find(e => e.default) || item.entries?.[0]
        const entryTypes: EditorEntryType[] | undefined = item.entries?.map(et => ({
          name: et.name,
          label: et.label,
          format: et.format,
          default: et.default,
          maxItems: et.maxItems,
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

export const buildPreviewBaseByCollection = (
  config: Pick<CanopyConfig, 'contentRoot'>,
  flatSchema: FlatSchemaItem[]
): Record<string, string> => {
  const contentRoot = normalizeContentRoot(config.contentRoot)
  const flat = flatSchema
  const map: Record<string, string> = {}

  for (const item of flat) {
    // Strip content root from all items and normalize to preview URL
    const base = stripContentRoot(item.logicalPath, contentRoot)
    const normalizedBase = base ? `/${base}` : '/'
    map[item.logicalPath] = normalizedBase
  }

  return map
}
