import type { EntrySchema } from '../config'
import { extractEntryLinkIds } from '../entry-link-resolver'
import type { ContentId, LogicalPath } from '../paths'
import { collectReferenceIds } from './field-traversal'

/** The parts of a `listEntries` item a reference scan reads. Data must be raw (unresolved). */
export interface ReferenceScanEntry {
  entryPath: LogicalPath
  entryId: ContentId
  schema?: EntrySchema
  data: Record<string, unknown>
}

export interface ReferencingEntry<E extends ReferenceScanEntry = ReferenceScanEntry> {
  entry: E
  /** Where its reference fields hold the target id, as `collectReferenceIds` paths. */
  fields: string[]
  /** Raw data paths of the strings, the md/mdx body included, holding an `entry:` link to it. */
  links: string[]
}

/** Entries but the target whose schema's reference fields or `entry:` links hold `targetId`. */
export function findReferencingEntries<E extends ReferenceScanEntry>(
  entries: Iterable<E>,
  targetId: string,
): ReferencingEntry<E>[] {
  const found: ReferencingEntry<E>[] = []
  for (const entry of entries) {
    if (entry.entryId === targetId) continue
    const fields = entry.schema
      ? collectReferenceIds(entry.schema, entry.data)
          .filter((occurrence) => occurrence.id === targetId)
          .map((occurrence) => occurrence.path)
      : []
    const links = findLinkingPaths(entry.data, '', targetId)
    if (fields.length > 0 || links.length > 0) found.push({ entry, fields, links })
  }
  return found
}

/** Mirrors `resolveEntryLinksInData`, which rewrites a link in any string of an entry's data. */
function findLinkingPaths(value: unknown, path: string, targetId: string): string[] {
  if (typeof value === 'string') {
    return extractEntryLinkIds(value).some((link) => link.id === targetId) ? [path] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findLinkingPaths(item, `${path}[${index}]`, targetId))
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      findLinkingPaths(item, path ? `${path}.${key}` : key, targetId),
    )
  }
  return []
}
