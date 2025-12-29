import { describe, expect, it } from 'vitest'

import { deleteAsset, listAssets, uploadAsset } from './assets'
import type { ApiContext } from './types'
import { RESERVED_GROUPS } from '../reserved-groups'

const makeCtx = (): ApiContext => ({
  services: {
    config: { schema: [] } as any,
    checkBranchAccess: () => ({ allowed: true, reason: 'no_acl' }),
    checkContentAccess: async () => ({ allowed: true, branch: {}, path: {} }),
    bootstrapAdminIds: new Set<string>(),
  },
  getBranchState: async () => null,
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
      const res = await uploadAsset(makeCtx(), {
        user: { type: 'authenticated', userId: 'u', groups: [] },
        body: { key: 'a.png', data: Buffer.from('x') },
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(403)
      expect(res.error).toBe('Only Admins and Reviewers can upload assets')
    })

    it('allows Reviewers to upload', async () => {
      const res = await uploadAsset(makeCtx(), {
        user: { type: 'authenticated', userId: 'u', groups: [RESERVED_GROUPS.REVIEWERS] },
        body: { key: 'a.png', data: Buffer.from('x') },
      })
      expect(res.ok).toBe(true)
    })

    it('allows Admins to upload', async () => {
      const res = await uploadAsset(makeCtx(), {
        user: { type: 'authenticated', userId: 'u', groups: [RESERVED_GROUPS.ADMINS] },
        body: { key: 'a.png', data: Buffer.from('x') },
      })
      expect(res.ok).toBe(true)
    })
  })

  describe('deleteAsset', () => {
    it('returns 403 for non-admin users', async () => {
      const res = await deleteAsset(makeCtx(), {
        user: { type: 'authenticated', userId: 'u', groups: [] },
        body: { key: 'a.png' },
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(403)
      expect(res.error).toBe('Only Admins can delete assets')
    })

    it('returns 403 for Reviewers', async () => {
      const res = await deleteAsset(makeCtx(), {
        user: { type: 'authenticated', userId: 'u', groups: [RESERVED_GROUPS.REVIEWERS] },
        body: { key: 'a.png' },
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(403)
    })

    it('allows Admins to delete', async () => {
      const res = await deleteAsset(makeCtx(), {
        user: { type: 'authenticated', userId: 'u', groups: [RESERVED_GROUPS.ADMINS] },
        body: { key: 'a.png' },
      })
      expect(res.ok).toBe(true)
    })
  })
})
