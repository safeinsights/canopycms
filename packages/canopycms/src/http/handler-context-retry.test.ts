import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AuthPlugin } from '../auth/plugin'
import type { CanopyConfig } from '../config'
import type { CanopyRequest } from './types'
import { mockConsole } from '../test-utils/console-spy'

// Mock '../services' so buildContext()'s `await createCanopyServices(options.config)`
// path is fully controllable per-test (fail once, then succeed), without hitting
// real filesystem/git bootstrapping.
const createCanopyServicesMock = vi.fn()
vi.mock('../services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services')>()
  return {
    ...actual,
    createCanopyServices: (...args: unknown[]) => createCanopyServicesMock(...args),
  }
})

// Must import after vi.mock (hoisted automatically by vitest either way).
import { createCanopyRequestHandler } from './handler'

const createMockAuthPlugin = (): AuthPlugin => ({
  authenticate: async () => ({
    success: true,
    user: { userId: 'test-user', externalGroups: ['Admins'] },
  }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})

const createMockRequest = (overrides: Partial<CanopyRequest> = {}): CanopyRequest => ({
  method: 'GET',
  url: 'http://localhost:3000/api/canopycms/branches',
  header: () => null,
  json: async () => undefined,
  ...overrides,
})

/** Minimal CanopyServices-shaped object, mirroring http/handler.test.ts's createMockServices(). */
const minimalServices = () => ({
  config: {
    schema: [],
    contentRoot: 'content',
    gitBotAuthorName: 'Test Bot',
    gitBotAuthorEmail: 'bot@test.com',
    mode: 'dev' as const,
  },
  checkBranchAccess: vi.fn().mockReturnValue({ allowed: true, reason: '' }),
  checkContentAccess: vi.fn().mockReturnValue({ allowed: true, branch: {}, path: {} }),
  pathPermissions: [],
  createGitManagerFor: vi.fn(),
  registry: {
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
  },
  bootstrapAdminIds: new Set<string>(),
  refreshActiveBranch: vi.fn().mockResolvedValue(undefined),
  // Internal groups are resolved via resolveCanopyUser -> getSettingsBranchRoot
  // (see resolve-canopy-user.ts). The path doesn't need to exist: groups.json
  // just won't be found there, which loadInternalGroups treats as "no custom
  // groups" (fine here - this file tests context caching/retry, not groups).
  getSettingsBranchRoot: vi.fn().mockResolvedValue('/tmp/handler-context-retry-test-mock-settings'),
})

describe('createCanopyRequestHandler context retry (API-H3)', () => {
  beforeEach(() => {
    mockConsole()
    createCanopyServicesMock.mockReset()
  })

  it('retries buildContext() after a rejected first attempt instead of caching the rejection forever', async () => {
    const services = minimalServices()
    createCanopyServicesMock
      .mockRejectedValueOnce(new Error('EFS not mounted yet'))
      .mockResolvedValueOnce(services)

    const authPlugin = createMockAuthPlugin()
    const handler = createCanopyRequestHandler({
      config: { mode: 'dev' } as CanopyConfig,
      authPlugin,
      getBranchContext: async () => null,
    })

    const req = createMockRequest()

    // First request: buildContext() rejects. The top-level boundary (API-C1)
    // turns this into a sanitized 500 rather than crashing the process.
    const first = await handler(req, ['branches'])
    expect(first.status).toBe(500)

    // Second request: without the API-H3 fix, apiCtxPromise would still be the
    // cached rejected promise and this would also fail with the same error.
    const second = await handler(req, ['branches'])
    expect(second.status).toBe(200)

    // createCanopyServices (and therefore buildContext) was invoked twice -
    // proof the cache was cleared after the first rejection.
    expect(createCanopyServicesMock).toHaveBeenCalledTimes(2)
  })

  it('keeps memoizing a successful buildContext() (does not re-invoke on every request)', async () => {
    const services = minimalServices()
    createCanopyServicesMock.mockResolvedValue(services)

    const authPlugin = createMockAuthPlugin()
    const handler = createCanopyRequestHandler({
      config: { mode: 'dev' } as CanopyConfig,
      authPlugin,
      getBranchContext: async () => null,
    })

    const req = createMockRequest()
    const first = await handler(req, ['branches'])
    const second = await handler(req, ['branches'])

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(createCanopyServicesMock).toHaveBeenCalledTimes(1)
  })
})
