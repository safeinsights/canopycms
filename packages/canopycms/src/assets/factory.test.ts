import { describe, expect, it } from 'vitest'

import { createAssetStore } from './factory'
import { LocalAssetStore } from './store-local'
import { S3AssetStore } from './store-s3'
import type { MediaConfig } from '../config/types'

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
})
