import type { CanopyConfig, FlatSchemaItem } from '../config'
import type { EditorCollection } from './Editor'

const normalizeContentRoot = (value?: string): string => {
  const trimmed = (value ?? 'content').replace(/^\/+|\/+$/g, '')
  return trimmed
}

const stripContentRoot = (fullPath: string, contentRoot: string): string => {
  const prefix = contentRoot ? `${contentRoot}/` : ''
  if (prefix && fullPath.startsWith(prefix)) {
    return fullPath.slice(prefix.length)
  }
  return fullPath
}

/**
 * Build hierarchical editor collections from the flattened schema.
 * Uses fullPath as IDs to match API responses.
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
        results.push({
          id: item.fullPath,
          name: item.name,
          label: item.label,
          format: defaultEntry?.format || 'json',
          type: 'collection' as const,
          children: buildTree(item.fullPath), // Recursively build children
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
    const base = stripContentRoot(item.fullPath, contentRoot)
    const normalizedBase = base ? `/${base}` : '/'
    map[item.fullPath] = normalizedBase
  }

  return map
}
