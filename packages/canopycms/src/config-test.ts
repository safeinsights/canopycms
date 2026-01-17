import type { CanopyConfig, CanopyConfigInput, RootCollectionConfig } from './config'
import { defineCanopyConfig } from './config'
import { createCanopyServices, type CanopyServices, type CreateCanopyServicesOptions } from './services'

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
  return defineCanopyConfig({
    ...FALLBACK_AUTHOR,
    ...config,
    ...(overrides ?? {}),
  }).server
}

/**
 * Test-only helper that creates CanopyServices with inline schema.
 * Automatically passes the schema from config to avoid .collection.json files.
 * Do not use in production code; use createCanopyServices with schemaRegistry.
 */
export const createTestServices = async (
  config: TestConfigInput,
  options?: Omit<CreateCanopyServicesOptions, 'schema'>
): Promise<CanopyServices> => {
  const canopyConfig = defineCanopyTestConfig(config)
  return createCanopyServices(canopyConfig, { ...options, schema: config.schema })
}
