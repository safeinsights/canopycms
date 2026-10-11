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

/**
 * Groups entries under their collection's display heading, in first-seen order. The heading is
 * `labelFor(collectionPath)`, else the collection name or path, else `Root`.
 */
export function groupEntriesByCollection<T extends SearchableEntry>(
  entries: readonly T[],
  labelFor?: (collectionPath: string) => string | undefined,
): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const entry of entries) {
    const heading =
      (entry.collectionPath ? labelFor?.(entry.collectionPath) : undefined) ??
      entry.collectionName ??
      entry.collectionPath ??
      'Root'
    const group = groups.get(heading)
    if (group) group.push(entry)
    else groups.set(heading, [entry])
  }
  return groups
}
