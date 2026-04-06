import type { FieldConfig } from '../config'

const BODY_FIELD_TYPES = new Set(['markdown', 'mdx'])

/**
 * Count the number of top-level fields marked `isBody: true` in a schema.
 * Does NOT recurse into objects — isBody only makes sense at the top level
 * because it maps to the file's markdown content.
 */
export function countBodyFields(fields: readonly FieldConfig[]): number {
  let count = 0
  for (const field of fields) {
    if ('isBody' in field && field.isBody) count++
  }
  return count
}

/**
 * Find isBody fields that have an invalid type (not 'markdown' or 'mdx').
 * Returns field names that fail validation.
 */
export function findInvalidBodyFields(fields: readonly FieldConfig[]): string[] {
  const invalid: string[] = []
  for (const field of fields) {
    if ('isBody' in field && field.isBody && !BODY_FIELD_TYPES.has(field.type)) {
      invalid.push(field.name)
    }
  }
  return invalid
}
