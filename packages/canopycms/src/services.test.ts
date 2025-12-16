import { describe, expect, it, vi } from 'vitest'

import { defineCanopyTestConfig } from './config-test'
import { createCanopyServices } from './services'

vi.mock('simple-git', () => {
  const stub = vi.fn(() => ({
    status: vi.fn().mockResolvedValue({ files: [], ahead: 0, behind: 0, current: 'main' }),
    branch: vi.fn().mockResolvedValue({ all: ['main'] }),
    checkout: vi.fn(),
    checkoutBranch: vi.fn(),
    fetch: vi.fn(),
    merge: vi.fn(),
    rebase: vi.fn(),
    add: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    revparse: vi.fn().mockResolvedValue('main'),
  }))
  return { simpleGit: stub }
})

describe('createCanopyServices', () => {
  it('creates helpers with defaults and reuses config', () => {
    const cfg = defineCanopyTestConfig({
      schema: [
        { type: 'collection', name: 'pages', path: 'pages', format: 'md', fields: [{ name: 'title', type: 'string' }] },
      ],
      pathPermissions: [{ path: 'content/admin/**', managerOrAdminAllowed: true }],
      defaultBranchAccess: 'deny',
    })

    const services = createCanopyServices(cfg)
    expect(services.pathPermissions.length).toBe(1)

    const branchAllowed = services.checkBranchAccess(
      {
        branch: {
          name: 'feature/x',
          status: 'editing',
          access: {},
          createdBy: 'u1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      { userId: 'u1', role: 'editor' }
    )
    expect(branchAllowed.allowed).toBe(false) // default deny, no ACL
  })

  it('creates git manager using defaults', async () => {
    const cfg = defineCanopyTestConfig({
      schema: [
        { type: 'collection', name: 'pages', path: 'pages', format: 'md', fields: [{ name: 'title', type: 'string' }] },
      ],
      defaultBaseBranch: 'main',
      defaultRemoteName: 'origin',
    })
    const services = createCanopyServices(cfg)
    const gm = services.createGitManagerFor('/tmp/repo')
    const status = await gm.status()
    expect(status.current).toBe('main')
  })
})
