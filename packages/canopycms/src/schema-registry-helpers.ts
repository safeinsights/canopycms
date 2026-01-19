import type { FieldConfig } from './config'

/**
 * Creates a type-safe schema registry with runtime validation.
 *
 * This helper ensures that schema registry objects are properly typed
 * and provides better IDE support when working with schema references.
 *
 * @example
 * ```typescript
 * import { createSchemaRegistry } from 'canopycms/server'
 *
 * export const schemaRegistry = createSchemaRegistry({
 *   postSchema: [
 *     { type: 'text', name: 'title', label: 'Title', required: true },
 *     { type: 'markdown', name: 'body', label: 'Body' },
 *   ],
 *   authorSchema: [
 *     { type: 'text', name: 'name', label: 'Name', required: true },
 *   ],
 * })
 * ```
 */
export function createSchemaRegistry<T extends Record<string, readonly FieldConfig[]>>(
  registry: T,
): T {
  // Validate that registry is not empty
  if (!registry || typeof registry !== 'object') {
    throw new Error('Schema registry must be an object')
  }

  const keys = Object.keys(registry)
  if (keys.length === 0) {
    throw new Error('Schema registry cannot be empty')
  }

  // Validate each schema entry
  for (const [key, schema] of Object.entries(registry)) {
    if (!Array.isArray(schema)) {
      throw new Error(`Schema registry entry "${key}" must be an array of FieldConfig`)
    }
    if (schema.length === 0) {
      throw new Error(`Schema registry entry "${key}" cannot be empty`)
    }
  }

  return registry
}

/**
 * Validates that schema references in .collection.json files exist in the registry.
 *
 * This is useful for build-time validation to catch schema reference errors early
 * rather than at runtime on first request.
 *
 * @param schemaRegistry - The schema registry object containing field definitions
 * @param contentPath - Path to the content directory containing .collection.json files
 * @returns Promise that resolves if validation passes, rejects with descriptive error if not
 *
 * @example
 * ```typescript
 * import { validateSchemaRegistry } from 'canopycms/server'
 * import { schemaRegistry } from './schema-registry'
 *
 * // In a build script or test
 * await validateSchemaRegistry(schemaRegistry, './content')
 *   .then(() => console.log('Schema registry valid!'))
 *   .catch(err => {
 *     console.error('Schema validation failed:', err.message)
 *     process.exit(1)
 *   })
 * ```
 */
export async function validateSchemaRegistry(
  schemaRegistry: Record<string, readonly FieldConfig[]>,
  contentPath: string,
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

    const availableSchemas = Object.keys(schemaRegistry)
    const errors: string[] = []

    // Validate root collection schema references (entry types)
    if (metaFiles.root?.entries) {
      for (const entryType of metaFiles.root.entries) {
        if (!schemaRegistry[entryType.fields]) {
          errors.push(
            `Root entry type "${entryType.name}" references schema "${entryType.fields}" which does not exist in registry. ` +
              `Available: ${availableSchemas.join(', ')}`,
          )
        }
      }
    }

    // Validate collection schema references (entry types)
    for (const collection of metaFiles.collections) {
      if (collection.entries) {
        for (const entryType of collection.entries) {
          if (!schemaRegistry[entryType.fields]) {
            errors.push(
              `Entry type "${entryType.name}" in collection "${collection.name}" (${collection.path}) references schema "${entryType.fields}" which does not exist in registry. ` +
                `Available: ${availableSchemas.join(', ')}`,
            )
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Schema registry validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
      )
    }
  } catch (err) {
    // Re-throw validation errors and other errors
    throw err
  }
}
