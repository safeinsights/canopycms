import type { EntryListItem, ListEntriesResponse } from '../api/entries'
import type { ContentFormat, FieldConfig } from '../config'
import type { FormValue } from './FormRenderer'
import type { EditorEntry } from './Editor'

export interface PreviewContext {
  branchName?: string
  previewBaseByCollection?: Record<string, string>
}

export const encodeSlug = (value?: string): string =>
  (value ?? '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')

export const buildPreviewSrc = (
  entry: {
    collectionId?: string
    collectionName?: string
    slug?: string
    type?: string
    previewSrc?: string
  },
  { branchName, previewBaseByCollection }: PreviewContext,
): string => {
  if (entry.previewSrc) return entry.previewSrc
  const appendBranch = (url: string) => {
    if (!branchName) return url
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}branch=${encodeURIComponent(branchName)}`
  }
  const base =
    (entry.collectionId && previewBaseByCollection?.[entry.collectionId]) ??
    (entry.collectionName && previewBaseByCollection?.[entry.collectionName])
  if (!base) {
    if (entry.type === 'standalone') return '/'
    const encoded = encodeSlug(entry.slug)
    const url = encoded ? `/${encoded}` : '/'
    return appendBranch(url)
  }
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base
  if (entry.type === 'standalone') return appendBranch(trimmed || '/')
  const encoded = encodeSlug(entry.slug)
  const url = encoded ? `${trimmed}/${encoded}` : trimmed || '/'
  return appendBranch(url)
}

export const normalizeContentPayload = (raw: unknown): FormValue => {
  const candidate = raw as Record<string, unknown> | undefined
  const data = (candidate?.data as Record<string, unknown> | undefined) ?? candidate
  if (data && typeof data === 'object' && 'format' in data && 'data' in data) {
    const format = data.format as ContentFormat
    const payloadData = (data.data as Record<string, unknown>) ?? {}
    if (format === 'json') return payloadData
    return {
      ...payloadData,
      body: typeof (data as any).body === 'string' ? (data as any).body : '',
    }
  }
  return (data as FormValue) ?? {}
}

export const buildWritePayload = (
  entry: { collectionId?: string; slug?: string; format?: ContentFormat },
  value: FormValue,
) => {
  if (!entry.format) return value
  if (entry.format === 'json') {
    return {
      format: 'json' as const,
      data: value,
    }
  }
  const { body, ...rest } = value
  return {
    format: entry.format,
    data: rest,
    body: typeof body === 'string' ? body : '',
  }
}

interface BuildEntriesFromListParams {
  response: ListEntriesResponse
  branchName: string
  resolvePreviewSrc: (
    entry: Pick<EntryListItem, 'collectionId' | 'collectionName' | 'slug' | 'type'>,
  ) => string
  existingEntries: EditorEntry[]
  initialEntries: EditorEntry[]
  currentEntry?: EditorEntry
}

export const buildEntriesFromListResponse = ({
  response,
  branchName,
  resolvePreviewSrc,
  existingEntries,
  currentEntry,
  initialEntries,
}: BuildEntriesFromListParams): EditorEntry[] => {
  const schemaByCollection = new Map<string, FieldConfig[]>()
  const collectSchemas = (nodes: ListEntriesResponse['collections']) => {
    nodes.forEach((node) => {
      schemaByCollection.set(node.id, node.schema)
      if (node.children) collectSchemas(node.children)
    })
  }
  collectSchemas(response.collections)
  return response.entries.map((entry) => {
    const schema =
      schemaByCollection.get(entry.collectionId) ??
      existingEntries.find((e) => e.collectionId === entry.collectionId)?.schema ??
      currentEntry?.schema ??
      initialEntries.find((e) => e.collectionId === entry.collectionId)?.schema ??
      []
    return {
      id: entry.id,
      label: entry.title || entry.slug || entry.collectionName || entry.collectionId,
      status: entry.exists === false ? 'missing' : (entry.type ?? 'entry'),
      schema,
      apiPath:
        entry.type === 'standalone'
          ? `/api/canopycms/${branchName}/content/${encodeURIComponent(entry.collectionId)}`
          : `/api/canopycms/${branchName}/content/${encodeURIComponent(entry.collectionId)}/${encodeURIComponent(entry.slug)}`,
      previewSrc: resolvePreviewSrc(entry),
      collectionId: entry.collectionId,
      collectionName: entry.collectionName,
      slug: entry.type === 'standalone' ? '' : entry.slug,
      format: entry.format,
      type: entry.type,
    }
  })
}
