import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createCanopyRequestHandler } from './handler'
import type { CanopyRequest } from './types'
import type { AuthPlugin } from '../auth/plugin'
import { mockConsole } from '../test-utils/console-spy'

// Mock the BranchWorkspaceManager to avoid git operations
vi.mock('../branch-workspace', () => ({
  BranchWorkspaceManager: vi.fn().mockImplementation(() => ({
    openOrCreateBranch: vi.fn().mockResolvedValue({
      branch: {
        name: 'new-branch',
        status: 'editing',
        createdBy: 'test-user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        access: {},
      },
      branchRoot: '/tmp/test',
      baseRoot: '/tmp/base',
    }),
  })),
  loadBranchContext: vi.fn().mockResolvedValue(null),
}))

// Mock the permissions loader to avoid file system operations
vi.mock('../authorization/permissions', () => ({
  loadPathPermissions: vi.fn().mockResolvedValue([]),
}))

const ADMINS = 'Admins'

/**
 * Create a mock AuthPlugin for testing.
 */
const createMockAuthPlugin = (
  user = {
    type: 'authenticated' as const,
    userId: 'test-user',
    groups: [ADMINS],
  },
): AuthPlugin => ({
  authenticate: async () => ({
    success: true,
    user: {
      userId: user.userId,
      externalGroups: user.groups,
    },
  }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})

/**
 * Create a mock AuthPlugin that rejects all authentication.
 */
const createRejectingAuthPlugin = (error = 'Unauthorized'): AuthPlugin => ({
  authenticate: async () => ({ success: false, error }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})

/**
 * Create a mock CanopyRequest for testing.
 */
const createMockRequest = (overrides: Partial<CanopyRequest> = {}): CanopyRequest => ({
  method: 'GET',
  url: 'http://localhost:3000/api/canopycms/branches',
  header: () => null,
  json: async () => undefined,
  ...overrides,
})

/**
 * Create mock services for testing.
 */
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
})

describe('createCanopyRequestHandler', () => {
  beforeEach(() => {
    mockConsole()
  })

  it('routes requests to handlers and returns response', async () => {
    const services: any = createMockServices()
    const authPlugin = createMockAuthPlugin()

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext: async () => null,
    })

    const req = createMockRequest({
      method: 'GET',
      url: 'http://localhost:3000/api/canopycms/branches',
    })

    const response = await handler(req, ['branches'])

    expect(response.status).toBe(200)
    expect(response.body).toHaveProperty('ok', true)
  })

  it('returns 404 for unknown routes', async () => {
    const services: any = createMockServices()
    const authPlugin = createMockAuthPlugin()

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext: async () => null,
    })

    const req = createMockRequest()
    const response = await handler(req, ['unknown', 'route'])

    expect(response.status).toBe(404)
    expect(response.body).toHaveProperty('error', 'Not found')
  })

  it('returns 401 for unauthenticated requests', async () => {
    const services: any = createMockServices()
    const authPlugin = createRejectingAuthPlugin('No token')

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext: async () => null,
    })

    const req = createMockRequest()
    const response = await handler(req, ['branches'])

    expect(response.status).toBe(401)
    expect(response.body).toHaveProperty('error', 'No token')
  })

  it('handles POST requests with empty body gracefully', async () => {
    const services: any = createMockServices()
    const authPlugin = createMockAuthPlugin()

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext: async () => ({
        baseRoot: '/tmp/base',
        branchRoot: '/tmp/base/test',
        branch: {
          name: 'test',
          status: 'editing',
          access: {},
          createdBy: 'user1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }),
    })

    const req = createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/canopycms/test/submit',
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input')
      },
    })

    // Should not crash, should handle gracefully
    const response = await handler(req, ['test', 'submit'])
    expect(response).toBeDefined()
  })

  it('handles POST requests with valid body', async () => {
    const services: any = createMockServices()
    const authPlugin = createMockAuthPlugin()

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext: async () => null,
    })

    const req = createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/canopycms/branches',
      json: async () => ({ branch: 'new-branch', title: 'Test Branch' }),
    })

    const response = await handler(req, ['branches'])
    expect(response.status).toBe(200)
  })

  it('parses query parameters from URL', async () => {
    const services: any = createMockServices()
    const authPlugin = createMockAuthPlugin()

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext: async () => null,
    })

    const req = createMockRequest({
      method: 'GET',
      url: 'http://localhost:3000/api/canopycms/users/search?query=test&limit=5',
    })

    const response = await handler(req, ['users', 'search'])
    // The handler should parse the query params - we're just verifying it doesn't crash
    expect(response).toBeDefined()
  })

  it('applies bootstrap admin groups to user', async () => {
    const services: any = createMockServices()
    services.bootstrapAdminIds = new Set(['test-user'])

    // User without Admins group
    const authPlugin = createMockAuthPlugin({
      type: 'authenticated',
      userId: 'test-user',
      groups: [],
    })

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext: async () => null,
    })

    const req = createMockRequest()
    const response = await handler(req, ['branches'])

    // Should succeed because bootstrap admin gets Admins group added
    expect(response.status).toBe(200)
  })

  it('throws error when no config or services provided', async () => {
    const authPlugin = createMockAuthPlugin()

    expect(() =>
      createCanopyRequestHandler({
        authPlugin,
      } as any),
    ).not.toThrow() // Factory doesn't throw, handler will throw on first request

    const handler = createCanopyRequestHandler({
      authPlugin,
    } as any)

    const req = createMockRequest()
    await expect(handler(req, ['branches'])).rejects.toThrow('config or services is required')
  })
})
