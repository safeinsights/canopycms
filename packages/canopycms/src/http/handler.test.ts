import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createCanopyRequestHandler } from './handler'
import type { CanopyRequest } from './types'
import type { AuthPlugin } from '../auth/plugin'
import type { CanopyConfig } from '../config'
import type { CanopyServices } from '../services'
import { mockConsole } from '../test-utils/console-spy'
import { BranchMetadataCorruptError } from '../branch-metadata'
import { RemoteNotReadyError } from '../git-manager'
import { WORKER_NOT_READY_MESSAGE } from './worker-not-ready'

// Mock the BranchWorkspaceManager to avoid git operations
vi.mock('../branch-workspace', () => ({
  BranchWorkspaceManager: vi.fn().mockImplementation(function () {
    return {
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
    }
  }),
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
  // groups" (fine for these tests, none of which assert on group content).
  getSettingsBranchRoot: vi.fn().mockResolvedValue('/tmp/handler-test-mock-settings'),
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

  it('rejects anonymous requests before triggering workspace provisioning', async () => {
    const services: any = createMockServices()
    const authPlugin = createRejectingAuthPlugin('No token')
    const getBranchContext = vi.fn(async () => {
      throw new Error('provisioning should never run for anonymous callers')
    })

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext,
    })

    const req = createMockRequest({
      method: 'GET',
      url: 'http://localhost:3000/api/canopycms/branches',
    })

    const response = await handler(req, ['branches'])

    expect(response.status).toBe(401)
    expect(getBranchContext).not.toHaveBeenCalled()
  })

  it('sanitizes credentials and absolute paths out of provisioning errors', async () => {
    const services: any = createMockServices()
    const authPlugin = createMockAuthPlugin()

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext: async () => {
        throw new Error(
          `Failed to clone branch workspace 'main' into /mnt/efs/workspace/main ` +
            `from https://x-access-token:ghp_secret123@github.com/org/repo.git ` +
            `(base branch 'main'): fatal: could not read from remote`,
        )
      },
    })

    const req = createMockRequest({
      method: 'GET',
      url: 'http://localhost:3000/api/canopycms/branches',
    })

    const response = await handler(req, ['branches'])

    expect(response.status).toBe(503)
    const error = (response.body as { error?: string }).error ?? ''
    expect(error).not.toContain('ghp_secret123')
    expect(error).not.toContain('/mnt/efs')
    expect(error).toContain('***@github.com')
    expect(error).toContain('<path>')
    expect(error).toContain('could not read from remote')
  })

  it('returns 503 with context when base-branch workspace provisioning fails', async () => {
    const services: any = createMockServices()
    const authPlugin = createMockAuthPlugin()

    const handler = createCanopyRequestHandler({
      services,
      authPlugin,
      getBranchContext: async () => {
        throw new Error('clone failed: remote branch not found')
      },
    })

    const req = createMockRequest({
      method: 'GET',
      url: 'http://localhost:3000/api/canopycms/branches',
    })

    const response = await handler(req, ['branches'])

    expect(response.status).toBe(503)
    expect(response.body).toHaveProperty('ok', false)
    expect((response.body as { error?: string }).error).toContain('provisioning failed')
    expect((response.body as { error?: string }).error).toContain(
      'clone failed: remote branch not found',
    )
  })

  it('serves the request without internal groups when base-branch metadata is corrupt', async () => {
    const consoleSpy = mockConsole()
    try {
      const services: any = createMockServices()
      const authPlugin = createMockAuthPlugin()

      const handler = createCanopyRequestHandler({
        services,
        authPlugin,
        getBranchContext: async () => {
          throw new BranchMetadataCorruptError(
            '/tmp/branches/main',
            'Unexpected token i in JSON at position 2',
          )
        },
      })

      const req = createMockRequest({
        method: 'GET',
        url: 'http://localhost:3000/api/canopycms/branches',
      })

      const response = await handler(req, ['branches'])

      // Degrades (empty internal groups) instead of 503ing: the /admin
      // recovery surface must stay reachable when the base branch is the
      // corrupt one.
      expect(response.status).toBe(200)
      expect(consoleSpy).toHaveErrored(/corrupt metadata/)
    } finally {
      consoleSpy.restore()
    }
  })

  describe('settings-workspace failure', () => {
    const failingSettingsServices = (bootstrapAdminIds = new Set<string>()) => {
      const services: any = createMockServices()
      services.bootstrapAdminIds = bootstrapAdminIds
      services.getSettingsBranchRoot = vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Settings workspace at /mnt/efs/workspace/.settings is on branch 'canopycms-settings-old', expected 'canopycms-settings'",
          ),
        )
      return services
    }

    it('503s an ordinary route and names the settings branch so the operator can act', async () => {
      const consoleSpy = mockConsole()
      try {
        const handler = createCanopyRequestHandler({
          services: failingSettingsServices(),
          authPlugin: createMockAuthPlugin(),
          getBranchContext: async () => null,
        })

        const response = await handler(createMockRequest(), ['branches'])

        expect(response.status).toBe(503)
        const error = (response.body as { error?: string }).error ?? ''
        expect(error).toContain('Settings workspace unavailable')
        // The diagnostic that survives path redaction, and the one that
        // identifies a deploymentName drift: the branch the deployment
        // EXPECTS, resolved the same way the workspace resolves it.
        expect(error).toContain("settings branch 'canopycms-settings-local'")
        expect(error).not.toContain('/mnt/efs')
      } finally {
        consoleSpy.restore()
      }
    })

    // The recovery surface must survive the failure it exists to repair -
    // matching the base-branch-corruption decision made in the same function.
    it('keeps /admin reachable for a bootstrap admin instead of 503ing it', async () => {
      const consoleSpy = mockConsole()
      try {
        const handler = createCanopyRequestHandler({
          services: failingSettingsServices(new Set(['test-user'])),
          authPlugin: createMockAuthPlugin(),
          getBranchContext: async () => null,
        })

        const req = createMockRequest({
          url: 'http://localhost:3000/api/canopycms/admin/status',
        })
        const response = await handler(req, ['admin', 'status'])

        expect(response.status).not.toBe(503)
        expect(consoleSpy).toHaveErrored(/recovery endpoints stay reachable/)
      } finally {
        consoleSpy.restore()
      }
    })

    // The two below DO NOT FLIP RED against the pre-fix handler, which 503'd
    // everything unconditionally. They are guards on the new degraded path
    // staying privilege-monotonic, not coverage of the fixed defect.
    it('still 503s /admin for a user whose admin rights would have come from the unreadable groups', async () => {
      const consoleSpy = mockConsole()
      try {
        const handler = createCanopyRequestHandler({
          // No bootstrap admins: this user's privileges, if any, live in the
          // settings workspace that just failed to load, so there is nothing
          // to degrade TO and the 503 is the more useful answer than a 403.
          services: failingSettingsServices(),
          authPlugin: createMockAuthPlugin(),
          getBranchContext: async () => null,
        })

        const req = createMockRequest({
          url: 'http://localhost:3000/api/canopycms/admin/status',
        })
        const response = await handler(req, ['admin', 'status'])

        expect(response.status).toBe(503)
      } finally {
        consoleSpy.restore()
      }
    })

    it('does not let the degraded path grant a non-admin any access to /admin', async () => {
      const consoleSpy = mockConsole()
      try {
        const handler = createCanopyRequestHandler({
          services: failingSettingsServices(new Set(['someone-else'])),
          authPlugin: createMockAuthPlugin({
            type: 'authenticated',
            userId: 'test-user',
            // Claiming the reserved group externally must not work here any
            // more than it does on the normal path (SEC-H1).
            groups: [ADMINS],
          }),
          getBranchContext: async () => null,
        })

        const req = createMockRequest({
          url: 'http://localhost:3000/api/canopycms/admin/status',
        })
        const response = await handler(req, ['admin', 'status'])

        expect(response.status).toBe(503)
      } finally {
        consoleSpy.restore()
      }
    })
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

  it('calls refreshActiveBranch as a method of services', async () => {
    const services = createMockServices()
    const refresh = vi.fn().mockResolvedValue(undefined)
    services.refreshActiveBranch = refresh
    const handler = createCanopyRequestHandler({
      services: services as unknown as CanopyServices,
      authPlugin: createMockAuthPlugin(),
      getBranchContext: async () => null,
    })

    await handler(
      createMockRequest({ method: 'GET', url: 'http://localhost:3000/api/canopycms/branches' }),
      ['branches'],
    )

    expect(refresh.mock.contexts[0]).toBe(services)
  })

  it('logs one timing summary per request under CANOPYCMS_DEBUG, naming the route pattern', async () => {
    const original = process.env.CANOPYCMS_DEBUG
    process.env.CANOPYCMS_DEBUG = 'true'
    const consoleSpy = mockConsole()
    try {
      const handler = createCanopyRequestHandler({
        services: createMockServices() as unknown as CanopyServices,
        authPlugin: createMockAuthPlugin(),
        getBranchContext: async () => null,
      })
      await handler(
        createMockRequest({
          method: 'GET',
          url: 'http://localhost:3000/api/canopycms/feature-secret/comments',
        }),
        ['feature-secret', 'comments'],
      )

      const lines = consoleSpy.all().log.filter((l) => l.includes('[CanopyCMS:timing]'))
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(
        / GET :branch\/comments \d+ \d+ms \| context=\d+ refreshBranch=\d+ auth=\d+ branchContext=\d+ user=\d+ user>groups=\d+ route=\d+ route>branchContext=\d+ untimed=\d+/,
      )
      expect(lines[0]).not.toContain('feature-secret')
    } finally {
      consoleSpy.restore()
      if (original === undefined) delete process.env.CANOPYCMS_DEBUG
      else process.env.CANOPYCMS_DEBUG = original
    }
  })

  it('returns a sanitized 500 envelope when no config or services provided (API-C1)', async () => {
    const authPlugin = createMockAuthPlugin()

    expect(() =>
      createCanopyRequestHandler({
        authPlugin,
      } as any),
    ).not.toThrow() // Factory doesn't throw; buildContext() throws lazily on first request

    const handler = createCanopyRequestHandler({
      authPlugin,
    } as any)

    const req = createMockRequest()
    // The top-level error boundary (API-C1) catches this instead of letting it
    // escape as an unhandled rejection / generic framework 500.
    const response = await handler(req, ['branches'])
    expect(response.status).toBe(500)
    expect(response.body).toHaveProperty('ok', false)
    expect((response.body as { error?: string }).error).toContain('config or services is required')
  })

  describe('worker not ready (no remote yet)', () => {
    const notReady = () => new RemoteNotReadyError('/mnt/efs/workspace/remote.git')

    const expectFriendly503 = (response: {
      status: number
      body: unknown
      headers?: Record<string, string>
    }) => {
      expect(response.status).toBe(503)
      expect(response.body).toEqual({ ok: false, status: 503, error: WORKER_NOT_READY_MESSAGE })
      expect(response.headers).toEqual({ 'Retry-After': '30' })
    }

    it('503s with the friendly body when base-branch provisioning hits it', async () => {
      const consoleSpy = mockConsole()
      try {
        const handler = createCanopyRequestHandler({
          services: createMockServices() as any,
          authPlugin: createMockAuthPlugin(),
          getBranchContext: async () => {
            throw notReady()
          },
        })

        expectFriendly503(await handler(createMockRequest(), ['branches']))
        // The detailed message still reaches the server log.
        expect(consoleSpy).toHaveErrored(/CANOPYCMS_REMOTE_URL/)
      } finally {
        consoleSpy.restore()
      }
    })

    it('503s with the friendly body when resolving internal groups hits it', async () => {
      const consoleSpy = mockConsole()
      try {
        const services: any = createMockServices()
        services.getSettingsBranchRoot = vi.fn().mockRejectedValue(notReady())
        const handler = createCanopyRequestHandler({
          services,
          authPlugin: createMockAuthPlugin(),
          getBranchContext: async () => null,
        })

        expectFriendly503(await handler(createMockRequest(), ['branches']))
      } finally {
        consoleSpy.restore()
      }
    })

    it('503s a bootstrap admin on /admin too rather than serving it degraded', async () => {
      const consoleSpy = mockConsole()
      try {
        const services: any = createMockServices()
        services.bootstrapAdminIds = new Set(['test-user'])
        services.getSettingsBranchRoot = vi.fn().mockRejectedValue(notReady())
        const handler = createCanopyRequestHandler({
          services,
          authPlugin: createMockAuthPlugin(),
          getBranchContext: async () => null,
        })

        const req = createMockRequest({ url: 'http://localhost:3000/api/canopycms/admin/status' })
        expectFriendly503(await handler(req, ['admin', 'status']))
      } finally {
        consoleSpy.restore()
      }
    })

    it('maps it to the same 503 when it surfaces from a route handler (backstop)', async () => {
      const consoleSpy = mockConsole()
      try {
        const services: any = createMockServices()
        services.refreshActiveBranch = vi.fn().mockRejectedValue(notReady())
        const handler = createCanopyRequestHandler({
          services,
          authPlugin: createMockAuthPlugin(),
          getBranchContext: async () => null,
        })

        expectFriendly503(await handler(createMockRequest(), ['branches']))
      } finally {
        consoleSpy.restore()
      }
    })

    it('leaves a generic provisioning error on the existing message', async () => {
      const consoleSpy = mockConsole()
      try {
        const handler = createCanopyRequestHandler({
          services: createMockServices() as any,
          authPlugin: createMockAuthPlugin(),
          getBranchContext: async () => {
            throw new Error('clone failed: remote branch not found')
          },
        })

        const response = await handler(createMockRequest(), ['branches'])
        expect(response.status).toBe(503)
        expect((response.body as { error?: string }).error).toContain('provisioning failed')
        expect(response.headers).toBeUndefined()
      } finally {
        consoleSpy.restore()
      }
    })
  })

  describe('unguarded error boundary (API-C1)', () => {
    it('returns a sanitized 500 envelope when an unguarded call (e.g. refreshActiveBranch) throws', async () => {
      const services: any = createMockServices()
      services.refreshActiveBranch = vi
        .fn()
        .mockRejectedValue(new Error('boom: unexpected failure'))
      const authPlugin = createMockAuthPlugin()

      const handler = createCanopyRequestHandler({
        services,
        authPlugin,
        getBranchContext: async () => null,
      })

      const req = createMockRequest()
      const response = await handler(req, ['branches'])

      expect(response.status).toBe(500)
      expect(response.body).toHaveProperty('ok', false)
      expect((response.body as { error?: string }).error).toContain('boom: unexpected failure')
    })

    it('sanitizes credentials and absolute paths from an unguarded handler-level error', async () => {
      const services: any = createMockServices()
      services.refreshActiveBranch = vi
        .fn()
        .mockRejectedValue(
          new Error(
            `clone failed for /mnt/efs/workspace/main from ` +
              `https://x-access-token:ghp_secret456@github.com/org/repo.git`,
          ),
        )
      const authPlugin = createMockAuthPlugin()

      const handler = createCanopyRequestHandler({
        services,
        authPlugin,
        getBranchContext: async () => null,
      })

      const req = createMockRequest()
      const response = await handler(req, ['branches'])

      expect(response.status).toBe(500)
      const error = (response.body as { error?: string }).error ?? ''
      expect(error).not.toContain('ghp_secret456')
      expect(error).not.toContain('/mnt/efs')
      expect(error).toContain('***@github.com')
      expect(error).toContain('<path>')
    })
  })

  describe('auth plugin mode guard (SEC-C1)', () => {
    /** Same shape as DevAuthPlugin: verifyTokenOnly implemented, no verifiesCredentials marker. */
    const unmarkedDevPlugin: AuthPlugin = {
      ...createMockAuthPlugin(),
      verifyTokenOnly: async () => ({ userId: 'dev_user' }),
    }

    const prodConfig = { mode: 'prod', deployedAs: 'server' } as CanopyConfig
    const devConfig = { mode: 'dev', deployedAs: 'server' } as CanopyConfig

    it('throws at creation when an unmarked plugin is configured with mode prod', () => {
      expect(() =>
        createCanopyRequestHandler({ config: prodConfig, authPlugin: unmarkedDevPlugin }),
      ).toThrow(/mode: 'prod'.*does not affirm.*verifiesCredentials/)
    })

    it('throws when prod mode comes from pre-built services', () => {
      const base = createMockServices()
      const services = {
        ...base,
        config: { ...base.config, mode: 'prod' as const },
      } as unknown as CanopyServices
      expect(() => createCanopyRequestHandler({ services, authPlugin: unmarkedDevPlugin })).toThrow(
        /verifiesCredentials/,
      )
    })

    it('accepts the same unmarked plugin in dev mode', () => {
      expect(() =>
        createCanopyRequestHandler({ config: devConfig, authPlugin: unmarkedDevPlugin }),
      ).not.toThrow()
    })

    it('accepts a verifying plugin (verifiesCredentials: true) in prod', () => {
      const verifyingPlugin: AuthPlugin = {
        ...createMockAuthPlugin(),
        verifiesCredentials: true,
        verifyTokenOnly: async () => ({ userId: 'real_user' }),
      }
      expect(() =>
        createCanopyRequestHandler({ config: prodConfig, authPlugin: verifyingPlugin }),
      ).not.toThrow()
    })

    it('throws for an unmarked plugin without verifyTokenOnly in prod', () => {
      const plainUnmarkedPlugin: AuthPlugin = { ...createMockAuthPlugin() }
      expect(() =>
        createCanopyRequestHandler({ config: prodConfig, authPlugin: plainUnmarkedPlugin }),
      ).toThrow(/verifiesCredentials/)
    })
  })
})

describe('buildContext: the settings branch is never a content branch', () => {
  // Uses buildContext's own default getBranchContext (no override), where the
  // auto-create lives.
  const request = async (
    branch: string,
    configure?: (config: { deploymentName?: string; settingsBranch?: string }) => void,
  ) => {
    const { BranchWorkspaceManager, loadBranchContext } = await import('../branch-workspace')
    const services: any = createMockServices()
    configure?.(services.config)
    const handler = createCanopyRequestHandler({ services, authPlugin: createMockAuthPlugin() })
    vi.mocked(BranchWorkspaceManager).mockClear()
    vi.mocked(loadBranchContext).mockClear()
    const response = await handler(
      createMockRequest({
        method: 'GET',
        url: `http://localhost:3000/api/canopycms/${branch}/status`,
      }),
      [branch, 'status'],
    )
    const created = vi
      .mocked(BranchWorkspaceManager)
      .mock.results.flatMap(
        (r) =>
          (r.value as { openOrCreateBranch: ReturnType<typeof vi.fn> }).openOrCreateBranch.mock
            .calls,
      )
      .map(([opts]) => (opts as { branchName: string }).branchName)
    const loaded = vi.mocked(loadBranchContext).mock.calls.map(([opts]) => opts.branchName)
    return { response, created, loaded }
  }

  it('answers 404 for the deployment-namespaced settings branch, provisioning and loading nothing', async () => {
    const { response, created, loaded } = await request('canopycms-settings-acme', (config) => {
      config.deploymentName = 'acme'
    })

    expect(response.status).toBe(404)
    expect(created).not.toContain('canopycms-settings-acme')
    expect(loaded).not.toContain('canopycms-settings-acme')
  })

  it("answers 404 for an adopter's configured settings branch outside the reserved prefix", async () => {
    const { response, created, loaded } = await request('site-settings', (config) => {
      config.settingsBranch = 'site-settings'
    })

    expect(response.status).toBe(404)
    expect(created).not.toContain('site-settings')
    expect(loaded).not.toContain('site-settings')
  })

  it("answers 404 for another deployment's settings branch", async () => {
    const { response, created, loaded } = await request('canopycms-settings-other')

    expect(response.status).toBe(404)
    expect(created).not.toContain('canopycms-settings-other')
    expect(loaded).not.toContain('canopycms-settings-other')
  })

  it('records the base branch it provisions on every request (so the spies above can see a call)', async () => {
    const { created } = await request('main')

    expect(created).toContain('main')
  })
})
