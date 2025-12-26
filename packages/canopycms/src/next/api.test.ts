import { describe, expect, it, vi } from 'vitest'

vi.mock('next/server', () => {
  return {
    NextResponse: {
      json: (data: any, init?: any) => ({ ...data, status: init?.status ?? data?.status ?? 200 }),
    },
  }
})

import { createCanopyCatchAllHandler, createCanopyHandler, canopyHandlers } from './api'
import { createMockAuthPlugin } from './test-utils'

vi.mock('../api/branch', () => ({
  createBranch: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { branch: { branch: { name: 'x' } } } }),
  listBranches: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { branches: [] } }),
}))
vi.mock('../api/branch-status', () => ({
  getBranchStatus: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { branch: { branch: { name: 'x' } } } }),
  submitBranchForMerge: vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, data: { branch: { branch: { name: 'x' } } } }),
}))
vi.mock('../api/content', () => ({
  readContent: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
  writeContent: vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} }),
}))
vi.mock('../api/assets', () => ({
  listAssets: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { assets: [] } }),
  uploadAsset: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { asset: {} } }),
  deleteAsset: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
}))

describe('Next API adapter', () => {
  const mockAuthPlugin = createMockAuthPlugin({ userId: 'test-user', role: 'admin' })

  const createMockServices = () => ({
    config: { schema: [], contentRoot: 'content' },
    checkBranchAccess: vi.fn(),
    checkPathAccess: vi.fn(),
    checkContentAccess: vi.fn(),
    pathPermissions: [],
    createGitManagerFor: vi.fn(),
    registry: {
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
    },
  })

  it('wraps handler and returns NextResponse', async () => {
    const services: any = createMockServices()
    const handler = canopyHandlers.listBranches({ services, authPlugin: mockAuthPlugin })
    const res: any = await handler({ method: 'GET', json: async () => ({}) } as any, {})
    expect(res.status).toBe(200)
  })

  it('routes catch-all requests to handlers', async () => {
    const services: any = createMockServices()

    const handler = createCanopyCatchAllHandler({ services, authPlugin: mockAuthPlugin })
    const res: any = await handler({ method: 'GET', json: async () => ({}) } as any, {
      params: { canopycms: ['branches'] },
    })
    expect(res.status).toBe(200)
  })

  it('creates handler from config', async () => {
    const handler = createCanopyHandler({
      config: {
        schema: [
          {
            type: 'collection',
            name: 'posts',
            path: 'posts',
            format: 'md',
            fields: [{ name: 'title', type: 'string' }],
          },
        ],
        contentRoot: 'content',
        gitBotAuthorName: 'Test Bot',
        gitBotAuthorEmail: 'bot@example.com',
      },
      authPlugin: mockAuthPlugin,
      getBranchState: async () => null,
    } as any)
    const res: any = await handler({ method: 'GET', json: async () => ({}) } as any, {
      params: { canopycms: ['branches'] },
    })
    expect(res.status).toBe(200)
  })

  it('handles POST requests with empty body gracefully', async () => {
    const services: any = createMockServices()

    const handler = createCanopyCatchAllHandler({
      services,
      authPlugin: mockAuthPlugin,
      getBranchState: async () =>
        ({
          branch: {
            name: 'test',
            status: 'editing',
            createdBy: 'user1',
            updatedAt: new Date().toISOString(),
          },
        }) as any,
    })

    // POST with no body (should throw on req.json())
    const res: any = await handler(
      {
        method: 'POST',
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input')
        },
      } as any,
      { params: { canopycms: ['test', 'submit'] } },
    )

    // Should not crash, should handle gracefully
    expect(res).toBeDefined()
  })

  it('handles POST requests with valid body', async () => {
    const services: any = createMockServices()

    const handler = canopyHandlers.createBranch({ services, authPlugin: mockAuthPlugin })
    const res: any = await handler(
      {
        method: 'POST',
        json: async () => ({ branch: 'new-branch', title: 'Test Branch' }),
      } as any,
      {},
    )

    expect(res.status).toBe(200)
  })
})
