import type { CanopyConfig, CanopyConfigInput, RootCollectionConfig, CollectionConfig, SingletonConfig } from './config'
import { defineCanopyConfig } from './config'

const FALLBACK_AUTHOR = {
  gitBotAuthorName: 'CanopyCMS Test Bot',
  gitBotAuthorEmail: 'canopycms-test@example.com',
}

// Legacy schema types for backward compatibility in tests
type LegacySchemaItem = {
  type: 'collection' | 'entry'
  name: string
  path: string
  format: 'json' | 'md' | 'mdx'
  fields: any[]
  label?: string
  children?: LegacySchemaItem[]
}

/**
 * Migrates legacy schema format to new unified format
 */
function migrateLegacySchema(items: LegacySchemaItem[]): RootCollectionConfig {
  const collections: CollectionConfig[] = []
  const singletons: SingletonConfig[] = []

  const migrateCollection = (item: LegacySchemaItem & { type: 'collection' }): CollectionConfig => ({
    name: item.name,
    path: item.path,
    label: item.label,
    entries: {
      format: item.format,
      fields: item.fields,
    },
    collections: item.children?.filter(c => c.type === 'collection').map(c => migrateCollection(c as any)),
    singletons: item.children?.filter(c => c.type === 'entry').map(c => migrateSingleton(c as any)),
  })

  const migrateSingleton = (item: LegacySchemaItem & { type: 'entry' }): SingletonConfig => ({
    name: item.name,
    path: item.path,
    format: item.format,
    fields: item.fields,
    label: item.label,
  })

  for (const item of items) {
    if (item.type === 'collection') {
      collections.push(migrateCollection(item as any))
    } else if (item.type === 'entry') {
      singletons.push(migrateSingleton(item as any))
    }
  }

  return {
    collections: collections.length > 0 ? collections : undefined,
    singletons: singletons.length > 0 ? singletons : undefined,
  }
}

type TestConfigInput = Omit<CanopyConfigInput, 'gitBotAuthorName' | 'gitBotAuthorEmail' | 'schema'> & {
  schema: RootCollectionConfig | LegacySchemaItem[]  // Accept both formats
} & Partial<Pick<CanopyConfigInput, 'gitBotAuthorName' | 'gitBotAuthorEmail'>>

/**
 * Test-only helper that fills required author fields for convenience.
 * Also handles legacy schema format for backward compatibility.
 * Do not use in production code; prefer defineCanopyConfig.
 */
export const defineCanopyTestConfig = (config: TestConfigInput, overrides?: Partial<CanopyConfigInput>): CanopyConfig => {
  // Migrate legacy schema format if needed
  const schema = Array.isArray(config.schema) ? migrateLegacySchema(config.schema) : config.schema

  return defineCanopyConfig({
    ...FALLBACK_AUTHOR,
    ...config,
    schema,
    ...(overrides ?? {}),
  }).server
}
