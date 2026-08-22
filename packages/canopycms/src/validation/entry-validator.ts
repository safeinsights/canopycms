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
  ImageFieldConfig,
  InlineGroupFieldConfig,
  ObjectFieldConfig,
  ReferenceFieldConfig,
  SelectFieldConfig,
} from '../config'
import { fieldTypes } from '../config'
import { isValidCropRect } from '../assets/transform-directives'
import { BLOCK_STRUCTURAL_KEYS } from './block-structural-keys'
import { resolveBlockItem, traverseFields } from './field-traversal'
import { findBodyFieldName } from '../utils/body-field'
import { flattenGroupFields } from '../utils/flatten-group-fields'
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
const STRING_FIELD_TYPES = new Set(['string', 'markdown', 'mdx', 'code'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** True when `value` is a well-formed `{ x, y, w, h }` normalized crop rect. */
function isValidImageCropValue(value: unknown): boolean {
  if (!isPlainRecord(value)) return false
  const { x, y, w, h } = value
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number'
  ) {
    return false
  }
  return isValidCropRect(x, y, w, h)
}

/**
 * Validate a structured `image` field value: `{ src, alt, width?, height?, crop? }`
 * (see `ImageFieldValue` in config/types.ts). `src` and `alt` are required
 * whenever a value is present; `alt` may be an empty string only when the
 * field config sets `altOptional: true`. `width`/`height` must be positive
 * integers when present; `crop` must satisfy the same normalized-rect
 * constraints as the transform directive parser (assets/transform-directives.ts).
 */
function validateImageValue(
  field: ImageFieldConfig,
  value: unknown,
  path: string,
): EntryFieldError[] {
  if (!isPlainRecord(value)) {
    return [{ fieldPath: path, message: 'Expected an image object with { src, alt }' }]
  }

  const errors: EntryFieldError[] = []

  if (typeof value.src !== 'string' || value.src.trim() === '') {
    errors.push({ fieldPath: `${path}.src`, message: 'Image src is required' })
  }

  if (typeof value.alt !== 'string') {
    errors.push({ fieldPath: `${path}.alt`, message: 'Image alt text is required' })
  } else if (value.alt.trim() === '' && field.altOptional !== true) {
    errors.push({ fieldPath: `${path}.alt`, message: 'Image alt text is required' })
  }

  if (value.width !== undefined && !isPositiveInt(value.width)) {
    errors.push({ fieldPath: `${path}.width`, message: 'Image width must be a positive integer' })
  }

  if (value.height !== undefined && !isPositiveInt(value.height)) {
    errors.push({
      fieldPath: `${path}.height`,
      message: 'Image height must be a positive integer',
    })
  }

  if (value.crop !== undefined && !isValidImageCropValue(value.crop)) {
    errors.push({ fieldPath: `${path}.crop`, message: 'Invalid image crop rect' })
  }

  return errors
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
    case 'image':
      return validateImageValue(field as ImageFieldConfig, value, path)
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
 * Find data keys that have no counterpart in the schema, as canonical field paths
 * (`author.nickname`, `blocks[2].headline`).
 *
 * `validateEntryData` iterates the SCHEMA, so it can only ever report fields the schema knows
 * about. Nothing reported the inverse: rename or reshape a field and the old key persists on
 * disk forever, because the editor's form state is the whole record verbatim and every save
 * posts it back. The only symptom is a component quietly receiving `undefined`.
 *
 * Pure — safe in the browser. Reports rather than rejects: a save carrying a stale key still
 * succeeds (and now the write path even preserves the key and its comments), so this feeds the
 * non-blocking `validationWarnings` channel, not the 422 path.
 *
 * Two things it deliberately does not report:
 *
 * - **A container with no fields at all.** `api/content.ts` falls back to `[]` for a collection
 *   with no configured entry type; "no schema" is not "every key is unknown".
 * - **Anything inside a `reference` value.** Reads resolve references by default, so a reference
 *   field's value is `{ ...target data, id, slug, collection, urlPath }`. The traversal only
 *   descends into `object` and `block`, so it never looks inside one.
 */
export function findUnknownKeys(fields: EntrySchema, data: Record<string, unknown>): string[] {
  return traverseFields<string>(
    fields,
    data,
    () => [],
    '',
    ({ fields: containerFields, data: record, path }) => {
      if (containerFields.length === 0) return []
      const known = new Set(flattenGroupFields(containerFields).map((field) => field.name))
      return Object.keys(record)
        .filter((key) => !known.has(key) && !BLOCK_STRUCTURAL_KEYS.has(key))
        .map((key) => (path ? `${path}.${key}` : key))
    },
  )
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
