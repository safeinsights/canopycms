/**
 * The name to show for a person, or undefined when there is none. An id is an internal name
 * (docs/ux-guidelines.md, "People"), so a name equal to the id is no name.
 */
export function personName(id: string, name: string | undefined): string | undefined {
  const trimmed = name?.trim()
  return trimmed && trimmed !== id ? trimmed : undefined
}
