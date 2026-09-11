import { beforeAll, describe, expect, it } from 'vitest'

import { createAssetStore } from './factory'
import { LocalAssetStore } from './store-local'
import { S3AssetStore } from './store-s3'
import type { MediaConfig } from '../config/types'

// Needed only by the threading tests below, which call beginUpload() to observe options the
// store keeps private. createPresignedPost resolves credentials outside aws-sdk-client-mock's
// reach; dummy static ones let it run offline.
beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test-access-key-id'
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test-secret-access-key'
})

describe('createAssetStore', () => {
  it('returns undefined when media is undefined and no devAssetsDir is given', () => {
    expect(createAssetStore(undefined)).toBeUndefined()
  })

  it('falls back to a LocalAssetStore rooted at devAssetsDir when media is undefined', () => {
    const store = createAssetStore(undefined, { devAssetsDir: '/tmp/canopy-assets' })
    expect(store).toBeInstanceOf(LocalAssetStore)
  })

  it('creates an S3AssetStore for adapter: s3', () => {
    const media: MediaConfig = { adapter: 's3', bucket: 'my-bucket', region: 'us-east-1' }
    const store = createAssetStore(media)
    expect(store).toBeInstanceOf(S3AssetStore)
    expect(store?.capabilities.directUpload).toBe(true)
  })

  it('creates a LocalAssetStore for adapter: local with an explicit directory', () => {
    const media: MediaConfig = { adapter: 'local', directory: '/tmp/canopy-assets' }
    const store = createAssetStore(media)
    expect(store).toBeInstanceOf(LocalAssetStore)
    expect(store?.capabilities.directUpload).toBe(false)
  })

  it('falls back to devAssetsDir for adapter: local without a directory', () => {
    const media: MediaConfig = { adapter: 'local' }
    const store = createAssetStore(media, { devAssetsDir: '/tmp/canopy-assets' })
    expect(store).toBeInstanceOf(LocalAssetStore)
  })

  it('returns undefined for adapter: local without a directory and no devAssetsDir', () => {
    const media: MediaConfig = { adapter: 'local' }
    expect(createAssetStore(media)).toBeUndefined()
  })

  it('returns undefined for adapter: lfs (config literal kept, unimplemented)', () => {
    const media: MediaConfig = { adapter: 'lfs' }
    expect(createAssetStore(media)).toBeUndefined()
  })

  /**
   * Every optional S3 field is threaded by naming it in an object literal, and omitting a
   * property from an object literal is legal TypeScript. So a dropped line here type-checks
   * cleanly and silently reverts the setting to its default — a bug no other test in the repo
   * would notice, since the store keeps these private. Assert through observable behavior.
   */
  describe('threads s3 options through to the store', () => {
    it('threads media.uploadUrl', async () => {
      const media: MediaConfig = {
        adapter: 's3',
        bucket: 'my-bucket',
        region: 'us-east-1',
        uploadUrl: '/asset-upload/',
      }

      const target = await createAssetStore(media)!.beginUpload({
        filename: 'photo.png',
        contentType: 'image/png',
      })

      expect(target).toMatchObject({ mode: 'direct', url: '/asset-upload/' })
    })

    it('threads media.maxUploadBytes', async () => {
      const media: MediaConfig = {
        adapter: 's3',
        bucket: 'my-bucket',
        region: 'us-east-1',
        maxUploadBytes: 1234,
      }

      const target = await createAssetStore(media)!.beginUpload({
        filename: 'photo.png',
        contentType: 'image/png',
      })

      expect(target.maxBytes).toBe(1234)
    })
  })
})
