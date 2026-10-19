import type { ContentFormat, FieldConfig } from '../config'
import { flattenGroupFields } from './flatten-group-fields'
import { isDataOnlyFormat } from './format'

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
  return findExplicitBodyFieldName(fields) ?? 'body'
}

/** Name of the `isBody: true` field, or `undefined`: no `'body'` fallback. */
export function findExplicitBodyFieldName(fields: readonly FieldConfig[]): string | undefined {
  for (const field of flattenGroupFields(fields)) {
    if ('isBody' in field && field.isBody) return field.name
  }
  return undefined
}

/**
 * The data a link-only reference (`includeBody` unset) carries for its target. A json/yaml
 * entry's `isBody` field is its prose, so it is left out, as an md/mdx target's body is. Only an
 * explicit `isBody` counts: a field merely named `body` is ordinary data.
 */
export function linkOnlyReferenceData(
  data: Record<string, unknown>,
  format: ContentFormat,
  fields: readonly FieldConfig[] | undefined,
): Record<string, unknown> {
  const bodyFieldName =
    isDataOnlyFormat(format) && fields ? findExplicitBodyFieldName(fields) : undefined
  if (bodyFieldName === undefined || !(bodyFieldName in data)) return data
  const { [bodyFieldName]: _body, ...rest } = data
  return rest
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
