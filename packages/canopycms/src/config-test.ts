import type { CanopyConfig, CanopyConfigInput, RootCollectionConfig } from './config'
import { defineCanopyConfig } from './config'
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
 * Note: schema is NOT included in the returned config - it's loaded from .collection.json or passed separately to createTestCanopyServices.
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
 * Automatically passes the schema from config to createTestCanopyServices to avoid .collection.json files.
 * Do not use in production code; use createCanopyServices with schemaRegistry.
 */
export const createTestServices = async (
  config: TestConfigInput,
  options?: CreateCanopyServicesOptions
): Promise<CanopyServices> => {
  const canopyConfig = defineCanopyTestConfig(config)
  return createTestCanopyServices(canopyConfig, config.schema, options)
}
