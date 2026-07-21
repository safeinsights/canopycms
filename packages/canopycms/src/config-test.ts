import type { CanopyConfig, CanopyConfigInput, RootCollectionConfig } from './config'
import { defineCanopyConfig, flattenSchema } from './config'
import {
  createTestCanopyServices,
  type CanopyServices,
  type CreateCanopyServicesOptions,
} from './services'

const FALLBACK_AUTHOR = {
  gitBotAuthorName: 'CanopyCMS Test Bot',
  gitBotAuthorEmail: 'canopycms-test@example.com',
}

// mode has no default on the real schema (SEC-C1: a prod deploy that omits it must fail
// validation loudly). This test-only fallback keeps existing test configs terse by
// defaulting to 'dev'; production config authoring goes through defineCanopyConfig, which
// has no such fallback.
const FALLBACK_MODE = 'dev' as const

type TestConfigInput = Omit<
  CanopyConfigInput,
  'gitBotAuthorName' | 'gitBotAuthorEmail' | 'mode'
> & {
  schema: RootCollectionConfig
} & Partial<Pick<CanopyConfigInput, 'gitBotAuthorName' | 'gitBotAuthorEmail' | 'mode'>>

/**
 * Test-only helper that fills required author fields (and defaults `mode` to 'dev') for
 * convenience. The real schema requires `mode` with no default (SEC-C1); this helper
 * intentionally defaults it so existing test configs don't all need `mode: 'dev'` added.
 * Do not use in production code; prefer defineCanopyConfig.
 */
export const defineCanopyTestConfig = (
  config: TestConfigInput,
  overrides?: Partial<CanopyConfigInput>,
): CanopyConfig => {
  // Destructure to exclude schema from being spread into defineCanopyConfig
  const { schema: _schema, ...configWithoutSchema } = config
  return defineCanopyConfig({
    ...FALLBACK_AUTHOR,
    mode: FALLBACK_MODE,
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
  options?: CreateCanopyServicesOptions,
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
  }

  return createTestCanopyServices(canopyConfig, {
    ...options,
    branchSchemaCache:
      mockBranchSchemaCache as unknown as CreateCanopyServicesOptions['branchSchemaCache'],
  })
}
