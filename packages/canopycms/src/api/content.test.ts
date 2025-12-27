import { describe, expect, it, vi } from 'vitest'

import { readContent, writeContent } from './content'
import type { ApiContext } from './types'

vi.mock('../content-store', () => {
  return {
    ContentStore: vi.fn().mockImplementation(() => ({
      resolveDocumentPath: vi.fn().mockReturnValue({ relativePath: 'content/posts/hello', absolutePath: '/abs/content/posts/hello' }),
      read: vi.fn().mockResolvedValue({ collection: 'posts', format: 'md', data: {}, body: 'Hello' }),
      write: vi.fn().mockResolvedValue({ collection: 'posts', format: 'md', data: {}, body: 'Hello' }),
    })),
  }
})

const allowedCtx = (): ApiContext => ({
  services: {
    config: { schema: [] } as any,
    checkBranchAccess: vi.fn(),
    checkContentAccess: vi.fn().mockReturnValue({ allowed: true, branch: {}, path: {} }),
    bootstrapAdminIds: new Set<string>(),
  },
  getBranchState: vi.fn().mockResolvedValue({
    branch: { name: 'feature/x', status: 'editing', access: {}, createdBy: 'u1', createdAt: 'now', updatedAt: 'now' },
  }),
})

describe('content api', () => {
  it('forbids when access denied', async () => {
    const ctx: ApiContext = {
      services: {
        config: { schema: [] } as any,
        checkBranchAccess: vi.fn(),
        checkContentAccess: vi.fn().mockReturnValue({ allowed: false, branch: {}, path: {} }),
        bootstrapAdminIds: new Set<string>(),
      },
      getBranchState: vi.fn().mockResolvedValue({
        branch: { name: 'feature/x', status: 'editing', access: {}, createdBy: 'u1', createdAt: 'now', updatedAt: 'now' },
      }),
    }
    const res = await readContent(ctx, { user: { userId: 'u1' } }, { branch: 'feature/x', collection: 'posts', slug: 'hello' })
    expect(res.status).toBe(403)
    expect(res.ok).toBe(false)
  })

  it('reads content when allowed', async () => {
    const ctx = allowedCtx()
    const res = await readContent(ctx, { user: { userId: 'u1' } }, { branch: 'feature/x', collection: 'posts', slug: 'hello' })
    expect(res.ok).toBe(true)
  })

  it('writes content with correct format handling', async () => {
    const ctx = allowedCtx()
    const res = await writeContent(ctx, {
      user: { userId: 'u1' },
      branch: 'feature/x',
      body: { collection: 'posts', slug: 'hello', format: 'json', data: { title: 'hi' } },
    })
    expect(res.ok).toBe(true)
  })
})
