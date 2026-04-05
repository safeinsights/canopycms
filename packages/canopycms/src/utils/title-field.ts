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
    // Recurse into non-list object fields (list objects can't provide a single title value)
    if (field.type === 'object' && 'fields' in field && field.fields && !field.list) {
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
 * Skips `list: true` objects since runtime title extraction cannot resolve array values.
 * Used for validation — at most one field per schema should be marked.
 */
export function countTitleFields(fields: readonly FieldConfig[]): number {
  let count = 0
  for (const field of fields) {
    if (field.isTitle) count++
    if (field.type === 'object' && 'fields' in field && field.fields && !field.list) {
      count += countTitleFields(field.fields)
    }
  }
  return count
}

/**
 * Validate that all isTitle fields in a schema are string type.
 * Skips `list: true` objects (those are caught by findTitleFieldsInLists).
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
    if (field.type === 'object' && 'fields' in field && field.fields && !field.list) {
      invalid.push(...findInvalidTitleFields(field.fields, fieldPath))
    }
  }
  return invalid
}

/**
 * Find isTitle fields inside `list: true` object fields, where they can never resolve.
 * Returns dotted paths of such fields.
 */
export function findTitleFieldsInLists(
  fields: readonly FieldConfig[],
  parentPath?: string,
): string[] {
  const found: string[] = []
  for (const field of fields) {
    const fieldPath = parentPath ? `${parentPath}.${field.name}` : field.name
    if (field.type === 'object' && 'fields' in field && field.fields) {
      if (field.list) {
        // Any isTitle inside a list object is invalid — collect them
        found.push(...collectAllTitleFields(field.fields, fieldPath))
      } else {
        found.push(...findTitleFieldsInLists(field.fields, fieldPath))
      }
    }
  }
  return found
}

/** Collect all isTitle fields recursively (used inside list context). */
function collectAllTitleFields(fields: readonly FieldConfig[], parentPath: string): string[] {
  const found: string[] = []
  for (const field of fields) {
    const fieldPath = `${parentPath}.${field.name}`
    if (field.isTitle) found.push(fieldPath)
    if (field.type === 'object' && 'fields' in field && field.fields) {
      found.push(...collectAllTitleFields(field.fields, fieldPath))
    }
  }
  return found
}
