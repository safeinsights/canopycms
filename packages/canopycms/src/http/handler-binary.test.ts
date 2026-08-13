import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AuthPlugin } from '../auth/plugin'
import { mockConsole } from '../test-utils/console-spy'
import type { CanopyRequest, CanopyBinaryResponse } from './types'

// vi.mock factories are hoisted above the top of the file, so the fixture
// and spy they reference must be created via vi.hoisted (mirrors the
// pattern in ../branch-registry.test.ts) rather than plain top-level consts.
const { binaryResponse, binaryHandler } = vi.hoisted(() => {
  const binaryResponse: CanopyBinaryResponse = {
    kind: 'binary',
    status: 200,
    body: new Uint8Array([1, 2, 3, 4]),
    headers: {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    },
  }
  return { binaryResponse, binaryHandler: vi.fn(async () => binaryResponse) }
})

/**
 * Mock the real asset routes module so `GET /assets` resolves to a synthetic
 * binary-returning handler. This keeps the test focused purely on the core
 * handler's binary-response passthrough (isCanopyBinaryResponse routing),
 * decoupled from the real asset store/pipeline - that endpoint-level
 * behavior (the real `GET /assets/raw/{key...}` route) is covered in
 * ../api/assets.test.ts. `assetRawRoute` is a required export of the real
 * module (imported directly by router.ts) - stubbed here so the mock stays
 * a valid substitute even though this file doesn't exercise it.
 */
vi.mock('../api/assets', () => ({
  ASSET_ROUTES: {
    list: {
      method: 'GET',
      pattern: ['assets'],
      handler: binaryHandler,
      validate: () => ({ ok: true as const, params: {} }),
    },
  },
  assetRawRoute: {
    method: 'GET',
    pattern: ['assets', 'raw', '...key'],
    handler: vi.fn(),
  },
}))

// Mock the BranchWorkspaceManager to avoid git operations (mirrors handler.test.ts).
vi.mock('../branch-workspace', () => ({
  BranchWorkspaceManager: vi.fn(),
  loadBranchContext: vi.fn().mockResolvedValue(null),
}))

// Mock the permissions loader to avoid file system operations (mirrors handler.test.ts).
vi.mock('../authorization/permissions', () => ({
  loadPathPermissions: vi.fn().mockResolvedValue([]),
}))

import { createCanopyRequestHandler } from './handler'

const ADMINS = 'Admins'

const createMockAuthPlugin = (
  user = { type: 'authenticated' as const, userId: 'test-user', groups: [ADMINS] },
): AuthPlugin => ({
  authenticate: async () => ({
    success: true,
    user: { userId: user.userId, externalGroups: user.groups },
  }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})

const createRejectingAuthPlugin = (error = 'Unauthorized'): AuthPlugin => ({
  authenticate: async () => ({ success: false, error }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})

const createMockRequest = (overrides: Partial<CanopyRequest> = {}): CanopyRequest => ({
  method: 'GET',
  url: 'http://localhost:3000/api/canopycms/assets',
  header: () => null,
  json: async () => undefined,
  ...overrides,
})

const createMockServices = () => ({
  config: {
    schema: [],
    contentRoot: 'content',
    gitBotAuthorName: 'Test Bot',
    gitBotAuthorEmail: 'bot@test.com',
    mode: 'dev' as const,
  },
  checkBranchAccess: vi.fn().mockReturnValue({ allowed: true, reason: '' }),
  checkPathAccess: vi.fn().mockReturnValue({ allowed: true }),
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
  // groups" (fine here - this file tests binary-response plumbing, not groups).
  getSettingsBranchRoot: vi.fn().mockResolvedValue('/tmp/handler-binary-test-mock-settings'),
})

describe('createCanopyRequestHandler - binary responses (M2 plumbing)', () => {
  beforeEach(() => {
    mockConsole()
    binaryHandler.mockClear()
  })

  it('passes a binary route result through untouched (status/body/headers), not wrapped in a JSON envelope', async () => {
    const services: any = createMockServices()
    const authPlugin = createMockAuthPlugin()

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext: async () => null,
    })

    const req = createMockRequest()
    const response = await handler(req, ['assets'])

    expect(response).toEqual(binaryResponse)
    expect(binaryHandler).toHaveBeenCalledTimes(1)
  })

  it('still enforces auth for a route that would return a binary response - handler never runs for a rejected caller', async () => {
    const services: any = createMockServices()
    const authPlugin = createRejectingAuthPlugin('No token')

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext: async () => null,
    })

    const req = createMockRequest()
    const response = await handler(req, ['assets'])

    expect(response.status).toBe(401)
    expect(binaryHandler).not.toHaveBeenCalled()
  })

  it('leaves ordinary JSON routes wrapped in the standard { ok, status, ... } envelope (regression)', async () => {
    const services: any = createMockServices()
    const authPlugin = createMockAuthPlugin()

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext: async () => null,
    })

    const req = createMockRequest({ url: 'http://localhost:3000/api/canopycms/branches' })
    const response = await handler(req, ['branches'])

    expect(response.status).toBe(200)
    expect(response.body).toHaveProperty('ok', true)
  })
})
