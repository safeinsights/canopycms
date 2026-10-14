/** A schema name read as words in sentence case: `blogPost` is "Blog post", `HTMLPage` "HTML page". */
export const humanizeName = (name: string): string => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    // An acronym ("HTML") keeps its capitals.
    .map((word) => (/^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()))
    .join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * What the editor calls a field, group or block template: its label, else its name humanised, so
 * an unlabelled schema name never shows raw (docs/ux-guidelines.md, Copy).
 */
export const schemaLabel = (item: { label?: string; name: string }): string =>
  item.label ?? humanizeName(item.name)
