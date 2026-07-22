import { describe, expect, it } from 'vitest'

import { ASSET_ROUTES } from './assets'
import type { ApiContext } from './types'
import type { AssetMeta, AssetStore } from '../assets/types'
import { RESERVED_GROUPS } from '../authorization'
import { createMockApiContext } from '../test-utils'

// Extract handlers for testing
const listAssets = ASSET_ROUTES.list.handler
const uploadAsset = ASSET_ROUTES.upload.handler
const deleteAsset = ASSET_ROUTES.delete.handler

const sampleMeta: AssetMeta = {
  hash32: 'a'.repeat(32),
  filename: 'a.png',
  slug: 'a',
  ext: 'png',
  mime: 'image/png',
  size: 5,
  kind: 'raster',
  uploadedAt: '2026-01-01T00:00:00.000Z',
}

const makeAssetStore = (): AssetStore => ({
  capabilities: { directUpload: false },
  beginUpload: async () => ({ mode: 'proxied', stagingKey: 'asset-staging/x', maxBytes: 1 }),
  writeStaging: async () => {},
  readStaging: async () => null,
  deleteStaging: async () => {},
  putOriginal: async () => {},
  readOriginal: async () => null,
  putPublicObject: async () => {},
  readPublicObject: async () => null,
  putMetaIfAbsent: async () => 'created',
  getMeta: async () => null,
  listMeta: async () => ({ items: [sampleMeta] }),
  deleteMeta: async () => {},
})

// Default mock services already allow branch + content access; only the asset store
// and a branch-not-found getBranchContext are asset-specific.
const makeCtx = (): ApiContext => ({
  ...createMockApiContext({ branchContext: null }),
  assetStore: makeAssetStore(),
})

describe('asset api endpoint params schemas (API-H4)', () => {
  it('declares a params schema for list so the client generator emits cursor/limit', () => {
    // Without a declared params schema, scripts/generate-client.ts emits a
    // no-arg client method that can never forward cursor/limit.
    expect(ASSET_ROUTES.list.params).toBeDefined()
    const parsed = ASSET_ROUTES.list.params?.safeParse({ cursor: 'abc', limit: '10' })
    expect(parsed?.success).toBe(true)
    if (parsed?.success) {
      expect(parsed.data).toEqual({ cursor: 'abc', limit: 10 })
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
    expect(res.data?.assets[0].hash32).toBe(sampleMeta.hash32)
  })

  it('forwards cursor/limit query params to the store', async () => {
    let receivedInput: { cursor?: string; limit?: number } | undefined
    const ctx: ApiContext = {
      ...makeCtx(),
      assetStore: {
        ...makeAssetStore(),
        listMeta: async (input) => {
          receivedInput = input
          return { items: [] }
        },
      },
    }
    await listAssets(
      ctx,
      {
        user: { type: 'authenticated', userId: 'u', groups: [] },
        query: { cursor: 'xyz', limit: '5' },
      },
      { cursor: 'xyz', limit: 5 },
    )
    expect(receivedInput).toEqual({ cursor: 'xyz', limit: 5 })
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

    it('returns 501 for Reviewers (guard passes, endpoint not yet implemented)', async () => {
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
      expect(res.ok).toBe(false)
      expect(res.status).toBe(501)
    })

    it('returns 501 for Admins (guard passes, endpoint not yet implemented)', async () => {
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
      expect(res.ok).toBe(false)
      expect(res.status).toBe(501)
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

    it('allows Admins to delete, forwarding the key as the hash32 to deleteMeta', async () => {
      let deletedHash32: string | undefined
      const ctx: ApiContext = {
        ...makeCtx(),
        assetStore: {
          ...makeAssetStore(),
          deleteMeta: async (hash32) => {
            deletedHash32 = hash32
          },
        },
      }
      const res = await deleteAsset(
        ctx,
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
      expect(deletedHash32).toBe('a.png')
    })
  })
})
