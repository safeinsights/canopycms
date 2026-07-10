/**
 * Pure, isomorphic schema validation for entry data.
 *
 * This module is the single source of the schema-driven validation rules that
 * run BOTH client-side (pre-save UX in the editor) and server-side (the
 * authoritative write boundary in api/content.ts). It therefore must stay free
 * of server-only imports (node:fs, ContentStore, ContentIdIndex, ...) — it may
 * only depend on config types and other pure modules.
 *
 * What it checks (pure rules — no filesystem access):
 * - required fields are present and non-empty
 * - values match their field type (string/number/boolean/datetime/select/...)
 * - `list` fields hold arrays; non-list fields hold single values
 * - select values are one of the configured options
 * - reference values are well-formed (id string or resolved `{ id }` object)
 *   and non-empty when required
 * - block items resolve to a known template (via the shared `resolveBlockItem`
 *   from field-traversal, so `{ template, value }`-nested fields are validated)
 *
 * Reference EXISTENCE is intentionally NOT checked here: it requires the
 * content ID index (filesystem) and is enforced server-side only, by running
 * `ReferenceValidator` at the write boundary.
 */

import type {
  BlockFieldConfig,
  ContentFormat,
  EntrySchema,
  FieldConfig,
  InlineGroupFieldConfig,
  ObjectFieldConfig,
  ReferenceFieldConfig,
  SelectFieldConfig,
} from '../config'
import { fieldTypes } from '../config'
import { resolveBlockItem } from './field-traversal'
import { findBodyFieldName } from '../utils/body-field'
import { isDataOnlyFormat } from '../utils/format'

/**
 * One per-field validation error. `fieldPath` uses the canonical CanopyCMS
 * path format shared with field-traversal and the editor's canopy-path
 * helpers: dot notation with bracketed indices (e.g. `blocks[0].title`).
 */
export interface EntryFieldError {
  fieldPath: string
  message: string
}

const KNOWN_FIELD_TYPES = new Set<string>(fieldTypes)

/** Field types whose value is a plain string. */
const STRING_FIELD_TYPES = new Set(['string', 'rich-text', 'markdown', 'mdx', 'image', 'code'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Extract the id from a reference value. The editor holds references either
 * as an id string or as a resolved object `{ id, slug, collection, ... }`
 * (content reads resolve references by default). Returns undefined for any
 * other shape.
 */
export function referenceValueId(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (isPlainRecord(value) && typeof value.id === 'string') return value.id
  return undefined
}

const selectOptionValues = (field: SelectFieldConfig): string[] =>
  (field.options ?? []).map((opt) => (typeof opt === 'string' ? opt : opt.value))

/**
 * Merge an md/mdx body string into the data record under the schema's body
 * field name (`isBody: true`, defaulting to `'body'`), so required/type checks
 * apply to the body like any other field.
 */
export function mergeBodyIntoData(
  fields: EntrySchema,
  data: Record<string, unknown>,
  body: string | undefined,
): Record<string, unknown> {
  if (body === undefined) return data
  return { ...data, [findBodyFieldName(fields)]: body }
}

/** Validate a single scalar (non-object, non-block) value against its field type. */
function validateScalar(field: FieldConfig, value: unknown, path: string): EntryFieldError[] {
  switch (field.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return [{ fieldPath: path, message: 'Expected a number' }]
      }
      return []
    case 'boolean':
      if (typeof value !== 'boolean') {
        return [{ fieldPath: path, message: 'Expected true or false' }]
      }
      return []
    case 'datetime':
      if (typeof value !== 'string' || (value !== '' && Number.isNaN(Date.parse(value)))) {
        return [{ fieldPath: path, message: 'Expected a valid date/time string' }]
      }
      return []
    case 'select': {
      if (typeof value !== 'string') {
        return [{ fieldPath: path, message: 'Expected a selection' }]
      }
      const options = selectOptionValues(field as SelectFieldConfig)
      if (value !== '' && !options.includes(value)) {
        return [{ fieldPath: path, message: `Must be one of: ${options.join(', ')}` }]
      }
      return []
    }
    case 'reference':
      if (referenceValueId(value) === undefined) {
        return [{ fieldPath: path, message: 'Expected a reference id' }]
      }
      return []
    default:
      if (STRING_FIELD_TYPES.has(field.type)) {
        if (typeof value !== 'string') {
          return [{ fieldPath: path, message: 'Expected text' }]
        }
      }
      // Custom (adopter-defined) field types: semantics unknown, skip type checks.
      return []
  }
}

/** True when a required field should be considered missing/empty. */
function isEmptyForRequired(field: FieldConfig, value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'string') {
    // Strings, selects, references, datetimes: empty string means "not filled in".
    return value.trim() === ''
  }
  return false
}

/**
 * Validate entry data against an entry schema. Pure — safe to run in the
 * browser. Returns one error per offending field path; an empty array means
 * the data is structurally valid.
 */
export function validateEntryData(
  fields: EntrySchema,
  data: Record<string, unknown>,
  pathPrefix = '',
): EntryFieldError[] {
  const errors: EntryFieldError[] = []

  for (const field of fields) {
    // Inline groups are transparent to the data — children live at this level.
    if (field.type === 'group') {
      errors.push(...validateEntryData((field as InlineGroupFieldConfig).fields, data, pathPrefix))
      continue
    }

    const path = pathPrefix ? `${pathPrefix}.${field.name}` : field.name
    const value = data[field.name]

    const isRequired = 'required' in field && field.required === true
    if (isRequired && isEmptyForRequired(field, value)) {
      const message = Array.isArray(value)
        ? 'At least one item is required'
        : 'This field is required'
      errors.push({ fieldPath: path, message })
      continue
    }

    // Optional and absent: nothing further to check.
    if (value === undefined || value === null) continue

    if (field.type === 'block') {
      const blockField = field as BlockFieldConfig
      if (!Array.isArray(value)) {
        errors.push({ fieldPath: path, message: 'Expected a list of blocks' })
        continue
      }
      value.forEach((item, index) => {
        const itemPath = `${path}[${index}]`
        if (!isPlainRecord(item)) {
          errors.push({ fieldPath: itemPath, message: 'Expected a block object' })
          return
        }
        const resolved = resolveBlockItem(blockField, item)
        if (!resolved) {
          const template = typeof item.template === 'string' ? item.template : undefined
          errors.push({
            fieldPath: itemPath,
            message: template ? `Unknown block template "${template}"` : 'Missing block template',
          })
          return
        }
        errors.push(...validateEntryData(resolved.fields, resolved.data, itemPath))
      })
      continue
    }

    if (field.type === 'object') {
      const objectField = field as ObjectFieldConfig
      if (objectField.list) {
        if (!Array.isArray(value)) {
          errors.push({ fieldPath: path, message: 'Expected a list of items' })
          continue
        }
        value.forEach((item, index) => {
          const itemPath = `${path}[${index}]`
          if (!isPlainRecord(item)) {
            errors.push({ fieldPath: itemPath, message: 'Expected an object' })
            return
          }
          if (objectField.fields) {
            errors.push(...validateEntryData(objectField.fields, item, itemPath))
          }
        })
      } else if (!isPlainRecord(value)) {
        errors.push({ fieldPath: path, message: 'Expected an object' })
      } else if (objectField.fields) {
        errors.push(...validateEntryData(objectField.fields, value, path))
      }
      continue
    }

    // Scalar (and list-of-scalar) fields.
    if ('list' in field && field.list) {
      if (!Array.isArray(value)) {
        errors.push({ fieldPath: path, message: 'Expected a list of values' })
        continue
      }
      value.forEach((item, index) => {
        errors.push(...validateScalar(field, item, `${path}[${index}]`))
      })
      continue
    }

    if (Array.isArray(value) && KNOWN_FIELD_TYPES.has(field.type)) {
      errors.push({ fieldPath: path, message: 'Expected a single value, not a list' })
      continue
    }

    errors.push(...validateScalar(field, value, path))
  }

  return errors
}

/**
 * Validate an editor FormValue (client-side entry point). For md/mdx formats
 * the editor keeps the body under the literal `body` key; remap it to the
 * schema's body field before validating so required/type checks see it.
 */
export function validateEntryFormValue(
  fields: EntrySchema,
  format: ContentFormat | undefined,
  value: Record<string, unknown>,
): EntryFieldError[] {
  if (format && !isDataOnlyFormat(format)) {
    const { body, ...rest } = value
    return validateEntryData(
      fields,
      mergeBodyIntoData(fields, rest, typeof body === 'string' ? body : ''),
    )
  }
  return validateEntryData(fields, value)
}

/**
 * Return a copy of `data` with resolved reference objects (`{ id, ... }`)
 * collapsed back to their id strings, recursing through objects, lists, and
 * block `{ template, value }` items. Used server-side so `ReferenceValidator`
 * (which expects id strings) can check reference existence on editor payloads
 * that may still carry resolved objects from a prior read.
 */
export function normalizeReferenceValues(
  fields: EntrySchema,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...data }

  for (const field of fields) {
    if (field.type === 'group') {
      Object.assign(
        result,
        normalizeReferenceValues((field as InlineGroupFieldConfig).fields, result),
      )
      continue
    }

    const value = result[field.name]
    if (value === undefined || value === null) continue

    if (field.type === 'reference') {
      const refField = field as ReferenceFieldConfig
      if (refField.list && Array.isArray(value)) {
        result[field.name] = value.map((item) => referenceValueId(item) ?? item)
      } else {
        result[field.name] = referenceValueId(value) ?? value
      }
      continue
    }

    if (field.type === 'object') {
      const objectField = field as ObjectFieldConfig
      if (!objectField.fields) continue
      if (objectField.list && Array.isArray(value)) {
        result[field.name] = value.map((item) =>
          isPlainRecord(item) ? normalizeReferenceValues(objectField.fields, item) : item,
        )
      } else if (isPlainRecord(value)) {
        result[field.name] = normalizeReferenceValues(objectField.fields, value)
      }
      continue
    }

    if (field.type === 'block' && Array.isArray(value)) {
      const blockField = field as BlockFieldConfig
      result[field.name] = value.map((item) => {
        if (!isPlainRecord(item)) return item
        const resolved = resolveBlockItem(blockField, item)
        if (!resolved) return item
        const normalized = normalizeReferenceValues(resolved.fields, resolved.data)
        // Canonical `{ template, value }` shape keeps nested values under `value`;
        // the inline `_type` shape keeps them on the item itself.
        return isPlainRecord(item.value) ? { ...item, value: normalized } : normalized
      })
    }
  }

  return result
}
