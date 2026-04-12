import type { FieldConfig } from '../config'
import { flattenGroupFields } from './flatten-group-fields'

const BODY_FIELD_TYPES = new Set(['markdown', 'mdx'])

/**
 * Count the number of top-level fields marked `isBody: true` in a schema.
 * Does NOT recurse into objects — isBody only makes sense at the top level
 * because it maps to the file's markdown content.
 */
export function countBodyFields(fields: readonly FieldConfig[]): number {
  let count = 0
  for (const field of flattenGroupFields(fields)) {
    if ('isBody' in field && field.isBody) count++
  }
  return count
}

/**
 * Find the name of the field marked `isBody: true`, or `'body'` as the default.
 * Used at read time to map the markdown file's content to the correct data field.
 */
export function findBodyFieldName(fields: readonly FieldConfig[]): string {
  for (const field of flattenGroupFields(fields)) {
    if ('isBody' in field && field.isBody) return field.name
  }
  return 'body'
}

/**
 * Find isBody fields that have an invalid type (not 'markdown' or 'mdx').
 * Returns field names that fail validation.
 */
export function findInvalidBodyFields(fields: readonly FieldConfig[]): string[] {
  const invalid: string[] = []
  for (const field of flattenGroupFields(fields)) {
    if ('isBody' in field && field.isBody && !BODY_FIELD_TYPES.has(field.type)) {
      invalid.push(field.name)
    }
  }
  return invalid
}
