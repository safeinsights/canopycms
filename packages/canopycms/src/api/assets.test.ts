import { describe, expect, it } from 'vitest'

import { deleteAsset, listAssets, uploadAsset } from './assets'
import type { ApiContext } from './types'

const makeCtx = (): ApiContext => ({
  services: {
    config: { schema: [] } as any,
    checkBranchAccess: () => ({ allowed: true, reason: 'no_acl' }),
    checkContentAccess: () => ({ allowed: true, branch: {}, path: {} }),
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
    const res = await listAssets({ ...makeCtx(), assetStore: undefined }, { user: { userId: 'u' } })
    expect(res.status).toBe(501)
  })

  it('lists assets', async () => {
    const res = await listAssets(makeCtx(), { user: { userId: 'u' } })
    expect(res.ok).toBe(true)
    expect(res.data?.assets[0].key).toBe('a.png')
  })

  it('uploads and deletes assets', async () => {
    const ctx = makeCtx()
    const uploadRes = await uploadAsset(ctx, {
      user: { userId: 'u' },
      body: { key: 'a.png', data: Buffer.from('x') },
    })
    expect(uploadRes.ok).toBe(true)
    const deleteRes = await deleteAsset(ctx, { user: { userId: 'u' }, body: { key: 'a.png' } })
    expect(deleteRes.ok).toBe(true)
  })
})
