import type { CanopyConfig, ResolvedSchemaItem } from '../config'
import { resolveSchema } from '../config'
import type { EditorCollection } from './Editor'

const toEditorCollection = (node: ResolvedSchemaItem): EditorCollection => ({
  id: node.fullPath,
  name: node.name,
  label: node.label,
  format: node.format,
  type: node.type,
  children: node.children?.map(toEditorCollection),
})

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

export const buildEditorCollections = (
  config: Pick<CanopyConfig, 'schema' | 'contentRoot'>,
): EditorCollection[] => {
  const resolved = resolveSchema(config.schema, config.contentRoot)
  return resolved.map(toEditorCollection)
}

export const buildPreviewBaseByCollection = (
  config: Pick<CanopyConfig, 'schema' | 'contentRoot'>,
): Record<string, string> => {
  const contentRoot = normalizeContentRoot(config.contentRoot)
  const resolved = resolveSchema(config.schema, config.contentRoot)
  const map: Record<string, string> = {}
  const walk = (nodes: ResolvedSchemaItem[]) => {
    nodes.forEach((node) => {
      const base = stripContentRoot(node.fullPath, contentRoot)
      const normalizedBase = base ? `/${base}` : '/'
      map[node.fullPath] = node.type === 'entry' ? '/' : normalizedBase
      if (node.children) walk(node.children)
    })
  }
  walk(resolved)
  return map
}
