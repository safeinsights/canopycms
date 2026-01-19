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
 * Root-level entry types with maxItems: 1 are rendered as navigable entries
 * (similar to how singletons used to work). Entry types within collections
 * are schema metadata and not navigable nodes.
 */
export const buildEditorCollections = (flatSchema: FlatSchemaItem[]): EditorCollection[] => {
  const flat = flatSchema

  // Determine the content root from the flat schema
  // Root-level collections have parentPath: undefined
  // Root-level entry types have parentPath: contentRoot (e.g., 'content')
  // We detect the content root by finding entry types whose parentPath isn't a collection's fullPath
  const collectionPaths = new Set(
    flat.filter(item => item.type === 'collection').map(item => item.fullPath)
  )
  let contentRoot: string | undefined
  for (const item of flat) {
    if (item.type === 'entry-type' && item.parentPath && !collectionPaths.has(item.parentPath)) {
      // This entry type's parent is not a collection - it's the content root
      contentRoot = item.parentPath
      break
    }
  }

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
      } else if (item.type === 'entry-type') {
        // Root-level entry types with maxItems: 1 are navigable entries
        // (they behave like the old singletons - direct-to-edit items)
        // Entry types within collections are NOT navigable - they're schema metadata
        const isRootLevel = item.parentPath === contentRoot
        if (isRootLevel && item.maxItems === 1) {
          results.push({
            id: item.fullPath,
            name: item.name,
            label: item.label,
            format: item.format,
            type: 'entry' as const,
            children: [], // Entry types don't have children
          })
        }
        // Entry types without maxItems: 1 or within collections are schema metadata, not navigable
      }
    }

    return results
  }

  // Start with root-level collections (parentPath: undefined) and root-level entry types (parentPath: contentRoot)
  const rootCollections = buildTree(undefined)
  const rootEntryTypes = contentRoot ? buildTree(contentRoot) : []

  return [...rootEntryTypes, ...rootCollections]
}

export const buildPreviewBaseByCollection = (
  config: Pick<CanopyConfig, 'contentRoot'>,
  flatSchema: FlatSchemaItem[]
): Record<string, string> => {
  const contentRoot = normalizeContentRoot(config.contentRoot)
  const flat = flatSchema
  const map: Record<string, string> = {}

  for (const item of flat) {
    // Special case: root-level entry types map to '/'
    if (item.type === 'entry-type' && item.parentPath === contentRoot) {
      map[item.fullPath] = '/'
      continue
    }

    // All other items: strip content root and normalize
    const base = stripContentRoot(item.fullPath, contentRoot)
    const normalizedBase = base ? `/${base}` : '/'
    map[item.fullPath] = normalizedBase
  }

  return map
}
