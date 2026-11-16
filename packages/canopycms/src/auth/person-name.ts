/**
 * The name to show for a person, or undefined when there is none. An id is an internal name
 * (docs/ux-guidelines.md, "People"), so a name equal to the id is no name.
 */
export function personName(id: string, name: string | undefined): string | undefined {
  const trimmed = name?.trim()
  return trimmed && trimmed !== id ? trimmed : undefined
}

/** A person's initials, first and last name's, as every avatar without a picture shows them: "UT". */
export function personInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
}
