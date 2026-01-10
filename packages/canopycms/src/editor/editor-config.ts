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
 * Uses fullPath as IDs to match API responses. Includes both collections and singletons.
 * Optimized to O(n) using Map-based grouping.
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

    return children.map((item) => {
      if (item.type === 'collection') {
        return {
          id: item.fullPath,
          name: item.name,
          label: item.label,
          format: item.entries?.format || 'json',
          type: 'collection' as const,
          children: buildTree(item.fullPath), // Recursively build children
        }
      } else {
        // Singleton
        return {
          id: item.fullPath,
          name: item.name,
          label: item.label,
          format: item.format,
          type: 'entry' as const,
          children: [], // Singletons have no children
        }
      }
    })
  }

  return buildTree(undefined) // Start with root-level items
}

export const buildPreviewBaseByCollection = (
  config: Pick<CanopyConfig, 'contentRoot'>,
  flatSchema: FlatSchemaItem[],
): Record<string, string> => {
  const contentRoot = normalizeContentRoot(config.contentRoot)
  const flat = flatSchema
  const map: Record<string, string> = {}

  for (const item of flat) {
    const base = stripContentRoot(item.fullPath, contentRoot)
    const normalizedBase = base ? `/${base}` : '/'
    map[item.fullPath] = item.type === 'singleton' ? '/' : normalizedBase
  }

  return map
}
