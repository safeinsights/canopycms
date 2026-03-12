import type { CanopyConfig, CanopyConfigInput, RootCollectionConfig } from './config'
import { defineCanopyConfig, flattenSchema } from './config'
import { createTestCanopyServices, type CanopyServices, type CreateCanopyServicesOptions } from './services'

const FALLBACK_AUTHOR = {
  gitBotAuthorName: 'CanopyCMS Test Bot',
  gitBotAuthorEmail: 'canopycms-test@example.com',
}

type TestConfigInput = Omit<CanopyConfigInput, 'gitBotAuthorName' | 'gitBotAuthorEmail' | 'schema'> & {
  schema: RootCollectionConfig
} & Partial<Pick<CanopyConfigInput, 'gitBotAuthorName' | 'gitBotAuthorEmail'>>

/**
 * Test-only helper that fills required author fields for convenience.
 * Do not use in production code; prefer defineCanopyConfig.
 */
export const defineCanopyTestConfig = (config: TestConfigInput, overrides?: Partial<CanopyConfigInput>): CanopyConfig => {
  // Destructure to exclude schema from being spread into defineCanopyConfig
  const { schema: _schema, ...configWithoutSchema } = config
  return defineCanopyConfig({
    ...FALLBACK_AUTHOR,
    ...configWithoutSchema,
    ...(overrides ?? {}),
  }).server
}

/**
 * Test-only helper that creates CanopyServices with inline schema.
 * Creates a mock branchSchemaCache that returns the test schema without requiring .collection.json files.
 * Do not use in production code; use createCanopyServices with entrySchemaRegistry.
 */
export const createTestServices = async (
  config: TestConfigInput,
  options?: CreateCanopyServicesOptions
): Promise<CanopyServices> => {
  const canopyConfig = defineCanopyTestConfig(config)
  const flatSchema = flattenSchema(config.schema, canopyConfig.contentRoot)

  // Create a mock branchSchemaCache that returns the test schema
  const mockBranchSchemaCache = {
    getSchema: async () => ({
      schema: config.schema,
      flatSchema,
    }),
    invalidate: async () => {},
    clearAll: async () => {},
  }

  return createTestCanopyServices(canopyConfig, {
    ...options,
    branchSchemaCache: mockBranchSchemaCache as any,
  })
}
