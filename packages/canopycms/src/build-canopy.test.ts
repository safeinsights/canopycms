import { describe, expect, it, vi } from 'vitest'
import type { CanopyConfig } from './config'
import type { CanopyServices } from './services'
import type { CanopyContext, CanopyContextOptions } from './context'
import { STATIC_DEPLOY_USER } from './build-mode'

const fakeServices = { config: { mode: 'dev' } } as unknown as CanopyServices

const createCanopyServicesMock = vi.fn(
  async (_config: CanopyConfig, _options?: { entrySchemaRegistry?: unknown }) => fakeServices,
)
vi.mock('./services', () => ({
  createCanopyServices: (config: CanopyConfig, options?: { entrySchemaRegistry?: unknown }) =>
    createCanopyServicesMock(config, options),
}))

let capturedContextOptions: CanopyContextOptions | undefined
const createCanopyContextMock = vi.fn((options: CanopyContextOptions) => {
  capturedContextOptions = options
  return {
    services: options.services,
    getContext: async (): Promise<CanopyContext> => ({
      buildContentTree: vi.fn(),
      listEntries: vi.fn(),
      read: vi.fn(),
      readByUrlPath: vi.fn(),
      services: options.services,
      user: await options.extractUser(),
    }),
  }
})
vi.mock('./context', () => ({
  createCanopyContext: (options: CanopyContextOptions) => createCanopyContextMock(options),
}))

// Imported after the mocks so the module under test picks up the mocked deps.
// Imported through the public `./server` barrel (not `./build-canopy` directly)
// so these tests also guard the entrypoint re-export itself.
const { createBuildCanopy } = await import('./server')

function config(): CanopyConfig {
  return { mode: 'dev', deployedAs: 'server' } as CanopyConfig
}

describe('createBuildCanopy', () => {
  it('creates services with the given config and entrySchemaRegistry', async () => {
    const cfg = config()
    const registry = { post: [] }
    await createBuildCanopy(cfg, { entrySchemaRegistry: registry })

    expect(createCanopyServicesMock).toHaveBeenCalledWith(cfg, { entrySchemaRegistry: registry })
  })

  it('creates the context with an extractUser that resolves to STATIC_DEPLOY_USER', async () => {
    await createBuildCanopy(config())

    expect(capturedContextOptions).toBeDefined()
    await expect(capturedContextOptions!.extractUser()).resolves.toBe(STATIC_DEPLOY_USER)
    expect(capturedContextOptions!.services).toBe(fakeServices)
  })

  it('returns a build context — no user field, but the read/list/build/services surface', async () => {
    const result = await createBuildCanopy(config())

    expect(result).not.toHaveProperty('user')
    expect(result.services).toBe(fakeServices)
    expect(result.buildContentTree).toBeTypeOf('function')
    expect(result.listEntries).toBeTypeOf('function')
    expect(result.read).toBeTypeOf('function')
    expect(result.readByUrlPath).toBeTypeOf('function')
  })

  it('works with no options at all (entrySchemaRegistry is optional)', async () => {
    await expect(createBuildCanopy(config())).resolves.toBeDefined()
    expect(createCanopyServicesMock).toHaveBeenCalledWith(config(), {
      entrySchemaRegistry: undefined,
    })
  })
})
