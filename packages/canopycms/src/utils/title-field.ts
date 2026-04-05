import type { FieldConfig } from '../config'

/**
 * Find the field marked `isTitle: true` in a schema and extract its value from data.
 * Recurses into object fields to support nested title fields (e.g., hero.title).
 * Returns the string value or undefined if not found or not a string.
 */
export function extractTitleFromSchema(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
): string | undefined {
  return findTitleValue(fields, data)
}

function findTitleValue(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
): string | undefined {
  for (const field of fields) {
    if (field.isTitle) {
      const value = data[field.name]
      return typeof value === 'string' ? value : undefined
    }
    // Recurse into object fields
    if (field.type === 'object' && 'fields' in field && field.fields) {
      const nested = data[field.name]
      if (nested != null && typeof nested === 'object' && !Array.isArray(nested)) {
        const result = findTitleValue(field.fields, nested as Record<string, unknown>)
        if (result !== undefined) return result
      }
    }
  }
  return undefined
}

/** Convert a slug like "my-cool-page" to "My Cool Page". */
export function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * Resolve a display title for an entry using the full fallback chain:
 * 1. Schema-marked isTitle field (if schema provided)
 * 2. Convention: data.title or data.name
 * 3. Entry type label (if provided)
 * 4. Humanized slug (if provided)
 * 5. "Untitled"
 */
export function resolveEntryTitle(
  data: Record<string, unknown>,
  options?: {
    schema?: readonly FieldConfig[]
    entryTypeLabel?: string
    slug?: string
  },
): string {
  // 1. Schema-marked isTitle field
  if (options?.schema) {
    const schemaTitle = extractTitleFromSchema(options.schema, data)
    if (schemaTitle) return schemaTitle
  }
  // 2. Convention: data.title or data.name
  const title = data.title ?? data.name
  if (typeof title === 'string') return title
  // 3. Entry type label
  if (options?.entryTypeLabel) return options.entryTypeLabel
  // 4. Humanized slug
  return options?.slug ? humanizeSlug(options.slug) : 'Untitled'
}

/**
 * Count the number of fields marked `isTitle: true` in a schema, recursing into objects.
 * Used for validation — at most one field per schema should be marked.
 */
export function countTitleFields(fields: readonly FieldConfig[]): number {
  let count = 0
  for (const field of fields) {
    if (field.isTitle) count++
    if (field.type === 'object' && 'fields' in field && field.fields) {
      count += countTitleFields(field.fields)
    }
  }
  return count
}

/**
 * Validate that all isTitle fields in a schema are string type.
 * Returns an array of field names that have isTitle on a non-string type.
 */
export function findInvalidTitleFields(
  fields: readonly FieldConfig[],
  parentPath?: string,
): string[] {
  const invalid: string[] = []
  for (const field of fields) {
    const fieldPath = parentPath ? `${parentPath}.${field.name}` : field.name
    if (field.isTitle && field.type !== 'string') {
      invalid.push(fieldPath)
    }
    if (field.type === 'object' && 'fields' in field && field.fields) {
      invalid.push(...findInvalidTitleFields(field.fields, fieldPath))
    }
  }
  return invalid
}
