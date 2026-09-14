import type { FieldConfig } from '../config'
import { flattenGroupFields } from './flatten-group-fields'

const BODY_FIELD_TYPES = new Set(['markdown', 'mdx'])

/**
 * Count top-level fields marked `isBody: true`. Does NOT recurse into objects — `isBody` maps
 * to the file's markdown content, which exists only at the top level.
 */
export function countBodyFields(fields: readonly FieldConfig[]): number {
  let count = 0
  for (const field of flattenGroupFields(fields)) {
    if ('isBody' in field && field.isBody) count++
  }
  return count
}

/** Name of the `isBody: true` field, or `'body'`; maps the file's markdown onto a data field. */
export function findBodyFieldName(fields: readonly FieldConfig[]): string {
  for (const field of flattenGroupFields(fields)) {
    if ('isBody' in field && field.isBody) return field.name
  }
  return 'body'
}

/**
 * Find an isBody field whose NAME is reserved by reference resolution.
 *
 * A resolved reference reserves `id`/`slug`/`collection`/`urlPath` by applying them after the
 * target's data. The body is the one value assigned by key rather than spread, so a body field
 * named e.g. `id` is the one way around that — and the write boundary recovers a reference's id
 * from `value.id`, so re-saving would persist the prose as the reference. Rejected at
 * registry-validation time, so the schema fails loudly instead of the body being silently
 * dropped at resolution.
 */
export function findReservedBodyFieldName(
  fields: readonly FieldConfig[],
  reserved: readonly string[],
): string | undefined {
  for (const field of flattenGroupFields(fields)) {
    if ('isBody' in field && field.isBody && reserved.includes(field.name)) return field.name
  }
  return undefined
}

/** Names of isBody fields whose type is neither 'markdown' nor 'mdx'. */
export function findInvalidBodyFields(fields: readonly FieldConfig[]): string[] {
  const invalid: string[] = []
  for (const field of flattenGroupFields(fields)) {
    if ('isBody' in field && field.isBody && !BODY_FIELD_TYPES.has(field.type)) {
      invalid.push(field.name)
    }
  }
  return invalid
}
