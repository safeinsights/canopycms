import { describe, expect, it, vi, beforeEach } from 'vitest'

import type { ApiClient } from '../context'
import { uploadAsset } from './upload-asset'
import { uploadToPresignedPost } from './xhr-upload'

vi.mock('./xhr-upload', () => ({
  uploadToPresignedPost: vi.fn(),
}))

const mockAssetRecord = {
  hash32: 'a'.repeat(32),
  filename: 'sample.png',
  slug: 'sample',
  ext: 'png',
  mime: 'image/png',
  size: 1024,
  width: 100,
  height: 100,
  kind: 'raster' as const,
  uploadedAt: '2024-01-01T00:00:00.000Z',
  src: '/assets/t/orig/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sample.png',
}

function makeFile(): File {
  return new File(['x'.repeat(10)], 'sample.png', { type: 'image/png' })
}

describe('uploadAsset', () => {
  beforeEach(() => {
    vi.mocked(uploadToPresignedPost).mockReset()
  })

  it('direct mode: presigns, uploads via XHR, then finalizes', async () => {
    const presign = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        upload: {
          mode: 'direct',
          url: 'https://bucket.s3.example.com/',
          fields: { key: 'asset-staging/abc', policy: 'p', signature: 's' },
          stagingKey: 'asset-staging/abc',
          maxBytes: 50 * 1024 * 1024,
        },
      },
    })
    const finalize = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { asset: mockAssetRecord },
    })
    const client = { assets: { presign, finalize, uploadProxied: vi.fn() } } as unknown as ApiClient

    vi.mocked(uploadToPresignedPost).mockImplementation(async (_target, _file, onProgress) => {
      onProgress?.(0.5)
      onProgress?.(1)
    })

    const progressCalls: number[] = []
    const asset = await uploadAsset(client, makeFile(), (fraction) => progressCalls.push(fraction))

    expect(presign).toHaveBeenCalledWith({
      filename: 'sample.png',
      contentType: 'image/png',
      size: 10,
    })
    expect(uploadToPresignedPost).toHaveBeenCalledTimes(1)
    const [target] = vi.mocked(uploadToPresignedPost).mock.calls[0]
    expect(target).toEqual({
      mode: 'direct',
      url: 'https://bucket.s3.example.com/',
      fields: { key: 'asset-staging/abc', policy: 'p', signature: 's' },
      stagingKey: 'asset-staging/abc',
      maxBytes: 50 * 1024 * 1024,
    })
    expect(finalize).toHaveBeenCalledWith({
      stagingKey: 'asset-staging/abc',
      filename: 'sample.png',
    })
    expect(asset).toEqual(mockAssetRecord)
    expect(progressCalls).toEqual([0.5, 1])
  })

  it('proxied mode: uploads via client.assets.uploadProxied, skipping presign/finalize', async () => {
    const presign = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { upload: { mode: 'proxied', stagingKey: 'asset-staging/abc', maxBytes: 1024 } },
    })
    const uploadProxied = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      data: { asset: mockAssetRecord },
    })
    const finalize = vi.fn()
    const client = {
      assets: { presign, finalize, uploadProxied },
    } as unknown as ApiClient

    const asset = await uploadAsset(client, makeFile())

    expect(uploadToPresignedPost).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
    expect(uploadProxied).toHaveBeenCalledTimes(1)
    expect(asset).toEqual(mockAssetRecord)
  })

  it('throws with the server error message when presign is rejected (e.g. 415)', async () => {
    const client = {
      assets: {
        presign: vi.fn().mockResolvedValue({
          ok: false,
          status: 415,
          error: 'Unsupported content type: text/plain',
        }),
        finalize: vi.fn(),
        uploadProxied: vi.fn(),
      },
    } as unknown as ApiClient

    await expect(uploadAsset(client, makeFile())).rejects.toThrow(
      'Unsupported content type: text/plain',
    )
  })

  it('throws with the server error message when finalize is rejected', async () => {
    const client = {
      assets: {
        presign: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          data: {
            upload: {
              mode: 'direct',
              url: 'https://bucket.s3.example.com/',
              fields: {},
              stagingKey: 'asset-staging/abc',
              maxBytes: 1024,
            },
          },
        }),
        finalize: vi.fn().mockResolvedValue({
          ok: false,
          status: 422,
          error: 'File does not look like a valid image',
        }),
        uploadProxied: vi.fn(),
      },
    } as unknown as ApiClient

    await expect(uploadAsset(client, makeFile())).rejects.toThrow(
      'File does not look like a valid image',
    )
  })

  it('propagates a transport (XHR) failure without calling finalize', async () => {
    const finalize = vi.fn()
    const client = {
      assets: {
        presign: vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          data: {
            upload: {
              mode: 'direct',
              url: 'https://bucket.s3.example.com/',
              fields: {},
              stagingKey: 'asset-staging/abc',
              maxBytes: 1024,
            },
          },
        }),
        finalize,
        uploadProxied: vi.fn(),
      },
    } as unknown as ApiClient

    vi.mocked(uploadToPresignedPost).mockRejectedValue(new Error('Upload failed (HTTP 403)'))

    await expect(uploadAsset(client, makeFile())).rejects.toThrow('Upload failed (HTTP 403)')
    expect(finalize).not.toHaveBeenCalled()
  })
})
