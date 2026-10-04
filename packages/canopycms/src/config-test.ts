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

// `mode` has no default on the real schema (SEC-C1: a prod deploy that omits it must fail
// validation loudly). This test-only fallback defaults it to 'dev' so test configs stay terse.
const FALLBACK_MODE = 'dev' as const

type TestConfigInput = Omit<
  CanopyConfigInput,
  'gitBotAuthorName' | 'gitBotAuthorEmail' | 'mode'
> & {
  schema: RootCollectionConfig
} & Partial<Pick<CanopyConfigInput, 'gitBotAuthorName' | 'gitBotAuthorEmail' | 'mode'>>

/**
 * Test-only: fills the required author fields and defaults `mode` (see `FALLBACK_MODE`).
 * Production config authoring goes through `defineCanopyConfig`, which has no such fallback.
 */
export const defineCanopyTestConfig = (
  config: TestConfigInput,
  overrides?: Partial<CanopyConfigInput>,
): CanopyConfig => {
  const { schema: _schema, ...configWithoutSchema } = config
  return defineCanopyConfig({
    ...FALLBACK_AUTHOR,
    mode: FALLBACK_MODE,
    ...configWithoutSchema,
    ...(overrides ?? {}),
  }).server
}

/**
 * Test-only: `CanopyServices` from an inline schema, via a mock `branchSchemaCache` that serves it
 * without any `.collection.json` files. Production code uses `createCanopyServices` with an
 * `entrySchemaRegistry`.
 */
export const createTestServices = async (
  config: TestConfigInput,
  options?: CreateCanopyServicesOptions,
): Promise<CanopyServices> => {
  const canopyConfig = defineCanopyTestConfig(config)
  const flatSchema = flattenSchema(config.schema, canopyConfig.contentRoot)

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
