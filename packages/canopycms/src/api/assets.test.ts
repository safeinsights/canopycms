import { describe, expect, it, vi } from 'vitest'

import { ASSET_ROUTES } from './assets'
import type { ApiContext } from './types'
import { RESERVED_GROUPS } from '../authorization'

// Extract handlers for testing
const listAssets = ASSET_ROUTES.list.handler
const uploadAsset = ASSET_ROUTES.upload.handler
const deleteAsset = ASSET_ROUTES.delete.handler

const makeCtx = (): ApiContext => ({
  services: {
    config: { schema: [] } as any,
    schemaRegistry: {},
    schemaCacheRegistry: {
      getSchema: vi.fn().mockResolvedValue({ schema: { collections: [] }, flatSchema: [] }),
      invalidate: vi.fn().mockResolvedValue(undefined),
      clearAll: vi.fn().mockResolvedValue(undefined),
    } as any,
    checkBranchAccess: () => ({ allowed: true, reason: 'no_acl' }),
    checkPathAccess: undefined as any,
    checkContentAccess: async () => ({
      allowed: true,
      branch: { allowed: true, reason: 'no_acl' },
      path: { allowed: true, reason: 'no_acl' },
    }),
    createGitManagerFor: undefined as any,
    bootstrapAdminIds: new Set<string>(),
    registry: undefined as any,
    commitFiles: vi.fn(),
    submitBranch: vi.fn(),
    commitToSettingsBranch: vi.fn().mockResolvedValue({ committed: true, pushed: true }),
    getSettingsBranchRoot: vi.fn().mockResolvedValue('/mock/settings'),
  },
  getBranchContext: async () => null,
  assetStore: {
    list: async () => [{ key: 'a.png', url: 'http://cdn/a.png' }],
    upload: async (key) => ({ key }),
    delete: async () => {},
  },
})

describe('asset api', () => {
  it('returns 501 when asset store missing', async () => {
    const res = await listAssets(
      { ...makeCtx(), assetStore: undefined },
      { user: { type: 'authenticated', userId: 'u', groups: [] } },
    )
    expect(res.status).toBe(501)
  })

  it('lists assets for any user', async () => {
    const res = await listAssets(makeCtx(), {
      user: { type: 'authenticated', userId: 'u', groups: [] },
    })
    expect(res.ok).toBe(true)
    expect(res.data?.assets[0].key).toBe('a.png')
  })

  describe('uploadAsset', () => {
    it('returns 403 for non-privileged users', async () => {
      const res = await uploadAsset(
        makeCtx(),
        { user: { type: 'authenticated', userId: 'u', groups: [] } },
        { key: 'a.png', data: Buffer.from('x') },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(403)
      expect(res.error).toBe('Only Admins and Reviewers can upload assets')
    })

    it('allows Reviewers to upload', async () => {
      const res = await uploadAsset(
        makeCtx(),
        { user: { type: 'authenticated', userId: 'u', groups: [RESERVED_GROUPS.REVIEWERS] } },
        { key: 'a.png', data: Buffer.from('x') },
      )
      expect(res.ok).toBe(true)
    })

    it('allows Admins to upload', async () => {
      const res = await uploadAsset(
        makeCtx(),
        { user: { type: 'authenticated', userId: 'u', groups: [RESERVED_GROUPS.ADMINS] } },
        { key: 'a.png', data: Buffer.from('x') },
      )
      expect(res.ok).toBe(true)
    })
  })

  describe('deleteAsset', () => {
    it('returns 403 for non-admin users', async () => {
      const res = await deleteAsset(makeCtx(), {
        user: { type: 'authenticated', userId: 'u', groups: [] },
        query: { key: 'a.png' },
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(403)
      expect(res.error).toBe('Only Admins can delete assets')
    })

    it('returns 403 for Reviewers', async () => {
      const res = await deleteAsset(makeCtx(), {
        user: { type: 'authenticated', userId: 'u', groups: [RESERVED_GROUPS.REVIEWERS] },
        query: { key: 'a.png' },
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(403)
    })

    it('allows Admins to delete', async () => {
      const res = await deleteAsset(makeCtx(), {
        user: { type: 'authenticated', userId: 'u', groups: [RESERVED_GROUPS.ADMINS] },
        query: { key: 'a.png' },
      })
      expect(res.ok).toBe(true)
    })
  })
})
