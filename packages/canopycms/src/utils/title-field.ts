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
