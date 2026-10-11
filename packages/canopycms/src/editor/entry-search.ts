/** Entry search shared by the navigator filter and the quick-open palette. */

export interface SearchableEntry {
  label: string
  slug?: string
  collectionPath?: string
  collectionName?: string
}

/** Case-insensitive substring match over label and slug; an empty query matches everything. */
export function matchesEntryQuery(
  entry: Pick<SearchableEntry, 'label' | 'slug'>,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return (
    entry.label.toLowerCase().includes(needle) ||
    (entry.slug?.toLowerCase().includes(needle) ?? false)
  )
}

export function filterEntries<T extends SearchableEntry>(
  entries: readonly T[],
  query: string,
): T[] {
  return entries.filter((entry) => matchesEntryQuery(entry, query))
}

export interface EntryGroup<T> {
  heading: string
  entries: T[]
}

/**
 * Groups entries by collection, in first-seen order, each under its display heading:
 * `labelFor(collectionPath)`, else the collection name or path, else `Root`. Two collections
 * that share a heading stay separate groups.
 */
export function groupEntriesByCollection<T extends SearchableEntry>(
  entries: readonly T[],
  labelFor?: (collectionPath: string) => string | undefined,
): EntryGroup<T>[] {
  const groups = new Map<string, EntryGroup<T>>()
  for (const entry of entries) {
    const key = entry.collectionPath ?? entry.collectionName ?? ''
    const group = groups.get(key)
    if (group) {
      group.entries.push(entry)
      continue
    }
    const heading =
      (entry.collectionPath ? labelFor?.(entry.collectionPath) : undefined) ??
      entry.collectionName ??
      entry.collectionPath ??
      'Root'
    groups.set(key, { heading, entries: [entry] })
  }
  return [...groups.values()]
}
