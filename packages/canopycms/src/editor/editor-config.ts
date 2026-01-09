import type { CanopyConfig, FlatSchemaItem } from '../config'
import { flattenSchema } from '../config'
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
 */
export const buildEditorCollections = (config: Pick<CanopyConfig, 'schema' | 'contentRoot'>): EditorCollection[] => {
  const flat = flattenSchema(config.schema, config.contentRoot)

  // Build a tree from flat items
  const buildTree = (parentPath?: string): EditorCollection[] => {
    // Find all items that are direct children of this parent
    const children = flat.filter(item => item.parentPath === parentPath)

    return children.map(item => {
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
  config: Pick<CanopyConfig, 'schema' | 'contentRoot'>
): Record<string, string> => {
  const contentRoot = normalizeContentRoot(config.contentRoot)
  const flat = flattenSchema(config.schema, config.contentRoot)
  const map: Record<string, string> = {}

  for (const item of flat) {
    const base = stripContentRoot(item.fullPath, contentRoot)
    const normalizedBase = base ? `/${base}` : '/'
    map[item.fullPath] = item.type === 'singleton' ? '/' : normalizedBase
  }

  return map
}
