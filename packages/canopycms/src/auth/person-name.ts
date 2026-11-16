/**
 * The name to show for a person, or undefined when there is none. An id is an internal name
 * (docs/ux-guidelines.md, "People"), so a name equal to the id is no name.
 */
export function personName(id: string, name: string | undefined): string | undefined {
  const trimmed = name?.trim()
  return trimmed && trimmed !== id ? trimmed : undefined
}

/** A person's initials, first and last name's ("UT"), or one for a one-word name. */
export function personInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  // By code point, so an emoji or other astral character is never cut in half.
  const first = (part: string) => Array.from(part)[0] ?? ''
  if (parts.length === 1) return first(parts[0]).toUpperCase()
  return (first(parts[0]) + first(parts[parts.length - 1])).toUpperCase()
}
