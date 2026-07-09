import { describe, expect, it } from 'vitest'

import { ASSET_ROUTES } from './assets'
import type { ApiContext } from './types'
import { RESERVED_GROUPS } from '../authorization'
import { createMockApiContext } from '../test-utils'

// Extract handlers for testing
const listAssets = ASSET_ROUTES.list.handler
const uploadAsset = ASSET_ROUTES.upload.handler
const deleteAsset = ASSET_ROUTES.delete.handler

// Default mock services already allow branch + content access; only the asset store
// and a branch-not-found getBranchContext are asset-specific.
const makeCtx = (): ApiContext => ({
  ...createMockApiContext({ branchContext: null }),
  assetStore: {
    list: async () => [{ key: 'a.png', url: 'http://cdn/a.png' }],
    upload: async (key) => ({ key }),
    delete: async () => {},
  },
})

describe('asset api endpoint params schemas (API-H4)', () => {
  it('declares a params schema for list so the client generator emits prefix', () => {
    // Without a declared params schema, scripts/generate-client.ts emits a
    // no-arg client method that can never forward `prefix`.
    expect(ASSET_ROUTES.list.params).toBeDefined()
    const parsed = ASSET_ROUTES.list.params?.safeParse({ prefix: 'images/' })
    expect(parsed?.success).toBe(true)
    if (parsed?.success) {
      expect(parsed.data).toEqual({ prefix: 'images/' })
    }
  })

  it('declares a params schema for delete so the client generator emits key', () => {
    expect(ASSET_ROUTES.delete.params).toBeDefined()
    const missing = ASSET_ROUTES.delete.params?.safeParse({})
    expect(missing?.success).toBe(false)
    const present = ASSET_ROUTES.delete.params?.safeParse({ key: 'a.png' })
    expect(present?.success).toBe(true)
    if (present?.success) {
      expect(present.data).toEqual({ key: 'a.png' })
    }
  })
})

describe('asset api', () => {
  it('returns 501 when asset store missing', async () => {
    const res = await listAssets(
      { ...makeCtx(), assetStore: undefined },
      { user: { type: 'authenticated', userId: 'u', groups: [] } },
      {},
    )
    expect(res.status).toBe(501)
  })

  it('lists assets for any user', async () => {
    const res = await listAssets(
      makeCtx(),
      {
        user: { type: 'authenticated', userId: 'u', groups: [] },
      },
      {},
    )
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
      expect(res.error).toBe('Privileged access required')
    })

    it('allows Reviewers to upload', async () => {
      const res = await uploadAsset(
        makeCtx(),
        {
          user: {
            type: 'authenticated',
            userId: 'u',
            groups: [RESERVED_GROUPS.REVIEWERS],
          },
        },
        { key: 'a.png', data: Buffer.from('x') },
      )
      expect(res.ok).toBe(true)
    })

    it('allows Admins to upload', async () => {
      const res = await uploadAsset(
        makeCtx(),
        {
          user: {
            type: 'authenticated',
            userId: 'u',
            groups: [RESERVED_GROUPS.ADMINS],
          },
        },
        { key: 'a.png', data: Buffer.from('x') },
      )
      expect(res.ok).toBe(true)
    })
  })

  describe('deleteAsset', () => {
    it('returns 403 for non-admin users', async () => {
      const res = await deleteAsset(
        makeCtx(),
        {
          user: { type: 'authenticated', userId: 'u', groups: [] },
          query: { key: 'a.png' },
        },
        { key: 'a.png' },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(403)
      expect(res.error).toBe('Admin access required')
    })

    it('returns 403 for Reviewers', async () => {
      const res = await deleteAsset(
        makeCtx(),
        {
          user: {
            type: 'authenticated',
            userId: 'u',
            groups: [RESERVED_GROUPS.REVIEWERS],
          },
          query: { key: 'a.png' },
        },
        { key: 'a.png' },
      )
      expect(res.ok).toBe(false)
      expect(res.status).toBe(403)
    })

    it('allows Admins to delete', async () => {
      const res = await deleteAsset(
        makeCtx(),
        {
          user: {
            type: 'authenticated',
            userId: 'u',
            groups: [RESERVED_GROUPS.ADMINS],
          },
          query: { key: 'a.png' },
        },
        { key: 'a.png' },
      )
      expect(res.ok).toBe(true)
    })
  })
})
