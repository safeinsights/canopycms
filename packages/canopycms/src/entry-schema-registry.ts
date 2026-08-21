import type { EntrySchema, FieldConfig } from './config'
import type { EntrySchemaRegistry } from './schema/types'
import {
  countTitleFields,
  findInvalidTitleFields,
  findTitleFieldsInLists,
} from './utils/title-field'
import {
  countBodyFields,
  findInvalidBodyFields,
  findReservedBodyFieldName,
} from './utils/body-field'
import { RESOLVED_REFERENCE_KEYS } from './entry-schema'
import { flattenGroupFields } from './utils/flatten-group-fields'
import {
  ensureSelectFieldsHaveOptions,
  ensureReferenceFieldsHaveScope,
  ensureNoFlattenedFieldNameCollisions,
  ensureNoGroupsInsideComplexFields,
} from './config/validation'

/** Look up a field's type by dotted path (e.g., "meta.order").
 * Groups are transparent — their children are searched at the same path level. */
function findFieldType(fields: readonly FieldConfig[], dottedPath: string): string {
  const parts = dottedPath.split('.')
  let current: readonly FieldConfig[] = fields
  for (let i = 0; i < parts.length; i++) {
    const field = flattenGroupFields(current).find((f) => f.name === parts[i])
    if (!field) return 'unknown'
    if (i === parts.length - 1) return field.type
    if (field.type === 'object' && 'fields' in field && field.fields) {
      current = field.fields
    } else {
      return 'unknown'
    }
  }
  return 'unknown'
}

/**
 * Create a type-safe entry schema registry with runtime validation.
 *
 * The KEYS in the registry are the strings that `.collection.json` files (and
 * the editor wire format) use to look up each schema via the `entry.schema`
 * property. You can pick any string — but the **recommended convention is to
 * key by the entry-type name** (the filename token, the same string that
 * appears in `meta.entryType` in `buildContentTree` callbacks). When you do
 * that, `EntryTypesFromRegistry<typeof yourRegistry>` derives the
 * discriminated-union map for `buildContentTree`'s `TEntryTypes` parameter
 * automatically — no parallel interface to maintain.
 *
 * @example
 * Recommended — keys are entry-type names:
 * ```typescript
 * import { createEntrySchemaRegistry } from 'canopycms/server'
 * import { type EntryTypesFromRegistry, defineEntrySchema } from 'canopycms'
 *
 * export const partnerSchema = defineEntrySchema([
 *   { name: 'name', type: 'string', label: 'Name', isTitle: true },
 *   { name: 'isFictional', type: 'boolean', label: 'Fictional?' },
 * ])
 * export const docSchema = defineEntrySchema([
 *   { name: 'title', type: 'string', label: 'Title' },
 * ])
 *
 * export const entrySchemaRegistry = createEntrySchemaRegistry({
 *   partner: partnerSchema,
 *   doc: docSchema,
 * })
 *
 * // Then in .collection.json:
 * //   { "name": "partner", "format": "yaml", "schema": "partner" }
 *
 * // Derive entry-type map for typed narrowing:
 * export type EntryTypes = EntryTypesFromRegistry<typeof entrySchemaRegistry>
 *
 * // Per-schema aliases stay one line each, anchored to the registry:
 * export type PartnerContent = EntryTypes['partner']
 * ```
 *
 * @example
 * Also valid — keys are schema-variable names (prior convention):
 * ```typescript
 * export const entrySchemaRegistry = createEntrySchemaRegistry({
 *   partnerSchema,  // JS shorthand — key is the string "partnerSchema"
 *   docSchema,
 * })
 *
 * // .collection.json must then say:
 * //   { "name": "partner", "schema": "partnerSchema" }
 * //
 * // EntryTypesFromRegistry produces a map keyed by "partnerSchema" rather than
 * // by "partner", so it can't plug straight into buildContentTree's TEntryTypes.
 * // Either rekey the registry to the recommended convention, or declare the
 * // entry-type map manually using TypeFromEntrySchema<typeof partnerSchema>.
 * ```
 *
 * Runtime validation: registry must be non-empty, each schema must be a
 * non-empty `EntrySchema` array, at most one `isTitle` per schema (string
 * fields only), at most one `isBody` per schema (markdown/mdx only). Field-
 * shape checks: select fields must have options, reference fields must have
 * `collections` or `entryTypes`, no inline groups inside object/block fields,
 * no field-name collisions after group flattening.
 */
export function createEntrySchemaRegistry<T extends Record<string, EntrySchema>>(registry: T): T {
  // Validate that registry is not empty
  if (!registry || typeof registry !== 'object') {
    throw new Error('Entry schema registry must be an object')
  }

  const keys = Object.keys(registry)
  if (keys.length === 0) {
    throw new Error('Entry schema registry cannot be empty')
  }

  // Validate each entry schema
  for (const [key, schema] of Object.entries(registry)) {
    if (!Array.isArray(schema)) {
      throw new Error(`Entry schema registry entry "${key}" must be an array of FieldConfig`)
    }
    if (schema.length === 0) {
      throw new Error(`Entry schema registry entry "${key}" cannot be empty`)
    }
    const titleCount = countTitleFields(schema)
    if (titleCount > 1) {
      throw new Error(
        `Entry schema registry entry "${key}" has ${titleCount} fields with isTitle: true, but at most one is allowed`,
      )
    }
    const invalidTitleFields = findInvalidTitleFields(schema)
    if (invalidTitleFields.length > 0) {
      throw new Error(
        `Entry schema registry entry "${key}": field "${invalidTitleFields[0]}" has isTitle: true but is type "${findFieldType(schema, invalidTitleFields[0])}" — isTitle is only valid on string fields`,
      )
    }
    const listTitleFields = findTitleFieldsInLists(schema)
    if (listTitleFields.length > 0) {
      throw new Error(
        `Entry schema registry entry "${key}": field "${listTitleFields[0]}" has isTitle: true but is inside a list field — isTitle cannot resolve inside list fields`,
      )
    }
    const bodyCount = countBodyFields(schema)
    if (bodyCount > 1) {
      throw new Error(
        `Entry schema registry entry "${key}" has ${bodyCount} fields with isBody: true, but at most one is allowed`,
      )
    }
    const invalidBodyFields = findInvalidBodyFields(schema)
    if (invalidBodyFields.length > 0) {
      throw new Error(
        `Entry schema registry entry "${key}": field "${invalidBodyFields[0]}" has isBody: true but is type "${findFieldType(schema, invalidBodyFields[0])}" — isBody is only valid on markdown or mdx fields`,
      )
    }
    const reservedBodyField = findReservedBodyFieldName(schema, RESOLVED_REFERENCE_KEYS)
    if (reservedBodyField) {
      throw new Error(
        `Entry schema registry entry "${key}": field "${reservedBodyField}" has isBody: true but "${reservedBodyField}" is reserved — reference resolution sets ${RESOLVED_REFERENCE_KEYS.map((k) => `"${k}"`).join(', ')} on a resolved reference, and a body field with one of those names would overwrite it. Rename the field (the body's field name is yours to choose; only these four are reserved).`,
      )
    }
    // Field-shape checks moved here from validateCanopyConfig — these used to walk
    // the (now-removed) inline-config schema; the registry is now the canonical
    // entry point for entry schemas, so they run here.
    ensureSelectFieldsHaveOptions(schema)
    ensureReferenceFieldsHaveScope(schema)
    ensureNoGroupsInsideComplexFields(schema)
    ensureNoFlattenedFieldNameCollisions(schema, `entry schema "${key}"`)
  }

  return registry
}

/**
 * Validates that entry schema references in .collection.json files exist in the registry.
 *
 * Useful for build-time validation to catch schema reference errors early
 * rather than at runtime on first request.
 *
 * @param entrySchemaRegistry - The entry schema registry mapping names to field definitions
 * @param contentPath - Path to the content directory containing .collection.json files
 * @returns Promise that resolves if validation passes, rejects with descriptive error if not
 *
 * @example
 * ```typescript
 * import { validateEntrySchemaRegistry } from 'canopycms/server'
 * import { entrySchemaRegistry } from './schemas'
 *
 * await validateEntrySchemaRegistry(entrySchemaRegistry, './content')
 * ```
 */
export async function validateEntrySchemaRegistry(
  entrySchemaRegistry: EntrySchemaRegistry,
  contentPath: string,
): Promise<void> {
  const { loadCollectionMetaFiles } = await import('./schema')
  const { access } = await import('fs/promises')

  // Check if content directory exists
  try {
    await access(contentPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Content directory not found: ${contentPath}`)
    }
    throw err
  }

  // Load all .collection.json files
  const metaFiles = await loadCollectionMetaFiles(contentPath)

  const availableSchemas = Object.keys(entrySchemaRegistry)
  const errors: string[] = []

  // Validate root entry type references
  if (metaFiles.root?.entries) {
    for (const entryType of metaFiles.root.entries) {
      if (!entrySchemaRegistry[entryType.schema]) {
        errors.push(
          `Root entry type "${entryType.name}" references entry schema "${entryType.schema}" which does not exist in registry. ` +
            `Available: ${availableSchemas.join(', ')}`,
        )
      }
    }
  }

  // Validate collection entry type references
  for (const collection of metaFiles.collections) {
    if (collection.entries) {
      for (const entryType of collection.entries) {
        if (!entrySchemaRegistry[entryType.schema]) {
          errors.push(
            `Entry type "${entryType.name}" in collection "${collection.name}" (${collection.path}) references entry schema "${entryType.schema}" which does not exist in registry. ` +
              `Available: ${availableSchemas.join(', ')}`,
          )
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Entry schema registry validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    )
  }
}
