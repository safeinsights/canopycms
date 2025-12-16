import { describe, expect, it, vi } from 'vitest'

vi.mock('next/server', () => {
  return {
    NextResponse: {
      json: (data: any, init?: any) => ({ ...data, status: init?.status ?? data?.status ?? 200 }),
    },
  }
})

import { createCanopyCatchAllHandler, createCanopyHandler, canopyHandlers } from './api'

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
  it('wraps handler and returns NextResponse', async () => {
    const services: any = {
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
    }
    const handler = canopyHandlers.listBranches({ services })
    const res: any = await handler({ method: 'GET', json: async () => ({}) } as any, {})
    expect(res.status).toBe(200)
  })

  it('routes catch-all requests to handlers', async () => {
    const services: any = {
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
    }

    const handler = createCanopyCatchAllHandler({ services })
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
      getUser: async () => ({ userId: 'u', role: 'admin' }),
      getBranchState: async () => null,
    } as any)
    const res: any = await handler({ method: 'GET', json: async () => ({}) } as any, {
      params: { canopycms: ['branches'] },
    })
    expect(res.status).toBe(200)
  })
})
