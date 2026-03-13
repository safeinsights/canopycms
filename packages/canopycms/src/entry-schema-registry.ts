import type { FieldConfig } from './config'
import type { EntrySchemaRegistry } from './schema/types'

/**
 * Creates a type-safe entry schema registry with runtime validation.
 *
 * Maps entry schema names to their field definitions. These names are
 * referenced by `.collection.json` files via the `"fields"` property.
 *
 * @example
 * ```typescript
 * import { createEntrySchemaRegistry } from 'canopycms/server'
 *
 * export const entrySchemaRegistry = createEntrySchemaRegistry({
 *   postSchema: [
 *     { type: 'string', name: 'title', label: 'Title', required: true },
 *     { type: 'markdown', name: 'body', label: 'Body' },
 *   ],
 *   authorSchema: [
 *     { type: 'string', name: 'name', label: 'Name', required: true },
 *   ],
 * })
 * ```
 */
export function createEntrySchemaRegistry<T extends Record<string, readonly FieldConfig[]>>(
  registry: T
): T {
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
  contentPath: string
): Promise<void> {
  const { loadCollectionMetaFiles } = await import('./schema')
  const { access } = await import('fs/promises')

  // Check if content directory exists
  try {
    await access(contentPath)
  } catch (err) {
    if ((err as any).code === 'ENOENT') {
      throw new Error(`Content directory not found: ${contentPath}`)
    }
    throw err
  }

  try {
    // Load all .collection.json files
    const metaFiles = await loadCollectionMetaFiles(contentPath)

    const availableSchemas = Object.keys(entrySchemaRegistry)
    const errors: string[] = []

    // Validate root entry type references
    if (metaFiles.root?.entries) {
      for (const entryType of metaFiles.root.entries) {
        if (!entrySchemaRegistry[entryType.fields]) {
          errors.push(
            `Root entry type "${entryType.name}" references entry schema "${entryType.fields}" which does not exist in registry. ` +
            `Available: ${availableSchemas.join(', ')}`
          )
        }
      }
    }

    // Validate collection entry type references
    for (const collection of metaFiles.collections) {
      if (collection.entries) {
        for (const entryType of collection.entries) {
          if (!entrySchemaRegistry[entryType.fields]) {
            errors.push(
              `Entry type "${entryType.name}" in collection "${collection.name}" (${collection.path}) references entry schema "${entryType.fields}" which does not exist in registry. ` +
              `Available: ${availableSchemas.join(', ')}`
            )
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Entry schema registry validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`
      )
    }
  } catch (err) {
    // Re-throw validation errors and other errors
    throw err
  }
}
