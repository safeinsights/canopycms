import { describe, expect, it, vi } from 'vitest'

import { CONTENT_ROUTES } from './content'
import type { ApiContext } from './types'

// Extract handlers for testing
const readContent = CONTENT_ROUTES.read.handler
const writeContent = CONTENT_ROUTES.write.handler

vi.mock('../content-store', () => {
  return {
    ContentStore: vi.fn().mockImplementation(() => ({
      resolvePath: vi.fn().mockReturnValue({
        schemaItem: { logicalPath: 'content/posts', type: 'collection' },
        slug: 'hello',
      }),
      resolveDocumentPath: vi
        .fn()
        .mockReturnValue({
          relativePath: 'content/posts/hello',
          absolutePath: '/abs/content/posts/hello',
        }),
      read: vi
        .fn()
        .mockResolvedValue({ collection: 'posts', format: 'md', data: {}, body: 'Hello' }),
      write: vi
        .fn()
        .mockResolvedValue({ collection: 'posts', format: 'md', data: {}, body: 'Hello' }),
    })),
  }
})

const allowedCtx = (): ApiContext => ({
  services: {
    config: { schema: [] } as any,
    flatSchema: [],
    schemaRegistry: {},
    checkBranchAccess: vi.fn(),
    checkPathAccess: undefined as any,
    checkContentAccess: vi.fn().mockReturnValue({ allowed: true, branch: {}, path: {} }),
    createGitManagerFor: undefined as any,
    bootstrapAdminIds: new Set<string>(),
    registry: undefined as any,
    commitFiles: vi.fn(),
    submitBranch: vi.fn(),
    commitToSettingsBranch: vi.fn().mockResolvedValue({ committed: true, pushed: true }),
    getSettingsBranchRoot: vi.fn().mockResolvedValue('/mock/settings'),
  },
  getBranchContext: vi.fn().mockResolvedValue({
    baseRoot: '/tmp/base',
    branchRoot: '/tmp/base/feature-x',
    branch: {
      name: 'feature/x',
      status: 'editing',
      access: {},
      createdBy: 'u1',
      createdAt: 'now',
      updatedAt: 'now',
    },
  }),
})

describe('content api', () => {
  it('forbids when access denied', async () => {
    const ctx: ApiContext = {
      services: {
        config: { schema: [] } as any,
        flatSchema: [],
        schemaRegistry: {},
        checkBranchAccess: vi.fn(),
        checkPathAccess: undefined as any,
        checkContentAccess: vi.fn().mockReturnValue({ allowed: false, branch: {}, path: {} }),
        createGitManagerFor: undefined as any,
        bootstrapAdminIds: new Set<string>(),
        registry: undefined as any,
        commitFiles: vi.fn(),
        submitBranch: vi.fn(),
        commitToSettingsBranch: vi.fn().mockResolvedValue({ committed: true, pushed: true }),
        getSettingsBranchRoot: vi.fn().mockResolvedValue('/tmp/settings'),
      },
      getBranchContext: vi.fn().mockResolvedValue({
        baseRoot: '/tmp/base',
        branchRoot: '/tmp/base/feature-x',
        branch: {
          name: 'feature/x',
          status: 'editing',
          access: {},
          createdBy: 'u1',
          createdAt: 'now',
          updatedAt: 'now',
        },
      }),
    }
    const res = await readContent(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x', path: 'posts/hello' },
    )
    expect(res.status).toBe(403)
    expect(res.ok).toBe(false)
  })

  it('reads content when allowed', async () => {
    const ctx = allowedCtx()
    const res = await readContent(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x', path: 'posts/hello' },
    )
    expect(res.ok).toBe(true)
  })

  it('writes content with correct format handling', async () => {
    const ctx = allowedCtx()
    const res = await writeContent(
      ctx,
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x', path: 'posts/hello' },
      { format: 'json', data: { title: 'hi' } },
    )
    expect(res.ok).toBe(true)
  })
})
