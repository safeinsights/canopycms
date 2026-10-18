/** Entry search and the detail line shared by the content tree's rows. */

/** Case-insensitive substring match over label, title and slug; an empty query matches everything. */
export function matchesEntryQuery(
  entry: {
    label: string
    /** The entry's title, when its label is something else (a singleton's type label). */
    title?: string
    slug?: string
  },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [entry.label, entry.title, entry.slug].some((text) => text?.toLowerCase().includes(needle))
}

/**
 * An entry's detail line, "type · route", with whichever of the two it has: a singleton's label
 * already names its type, and an entry with no page has no route.
 */
export const entryDetailLine = ({
  typeLabel,
  route,
}: {
  typeLabel?: string
  route?: string
}): string => [typeLabel, route].filter(Boolean).join(' · ')
