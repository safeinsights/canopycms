import type { ContentFormat, EntrySchema } from '../config'
import { extractEntryLinkIds } from '../entry-link-resolver'
import type { ContentId, LogicalPath } from '../paths'
import { findBodyFieldName } from '../utils/body-field'
import { collectReferenceIds, traverseFields } from './field-traversal'

/** The parts of a `listEntries` item a reference scan reads. Data must be raw (unresolved). */
export interface ReferenceScanEntry {
  entryPath: LogicalPath
  entryId: ContentId
  format: ContentFormat
  schema?: EntrySchema
  data: Record<string, unknown>
}

export interface ReferencingEntry<E extends ReferenceScanEntry = ReferenceScanEntry> {
  entry: E
  /** Where its reference fields hold the target id, as `collectReferenceIds` paths. */
  fields: string[]
  /** Markdown/mdx fields, the md/mdx body included, holding an `entry:` link to it. */
  links: string[]
}

/**
 * Every entry but the target whose reference fields or `entry:` links point at `targetId`.
 * An entry with no resolvable schema has no declared fields and is never reported.
 */
export function findReferencingEntries<E extends ReferenceScanEntry>(
  entries: Iterable<E>,
  targetId: string,
): ReferencingEntry<E>[] {
  const found: ReferencingEntry<E>[] = []
  for (const entry of entries) {
    if (entry.entryId === targetId || !entry.schema) continue
    const fields = unique(
      collectReferenceIds(entry.schema, entry.data)
        .filter((occurrence) => occurrence.id === targetId)
        .map((occurrence) => occurrence.path),
    )
    const links = findLinkingFields(entry, entry.schema, targetId)
    if (fields.length > 0 || links.length > 0) found.push({ entry, fields, links })
  }
  return found
}

function findLinkingFields(
  entry: ReferenceScanEntry,
  schema: EntrySchema,
  targetId: string,
): string[] {
  const texts = traverseFields<{ path: string; text: string }>(
    schema,
    entry.data,
    ({ field, value, path }) =>
      (field.type === 'markdown' || field.type === 'mdx') && typeof value === 'string'
        ? [{ path, text: value }]
        : [],
  )
  // The md/mdx body is in data even when the schema does not declare a body field.
  if (entry.format === 'md' || entry.format === 'mdx') {
    const bodyField = findBodyFieldName(schema)
    const body = entry.data[bodyField]
    if (typeof body === 'string') texts.push({ path: bodyField, text: body })
  }
  return unique(
    texts
      .filter(({ text }) => extractEntryLinkIds(text).some((link) => link.id === targetId))
      .map(({ path }) => path),
  )
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
