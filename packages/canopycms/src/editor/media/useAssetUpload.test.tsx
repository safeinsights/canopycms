import React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiClientProvider, type ApiClient } from '../context'
import { useAssetUpload } from './useAssetUpload'
import { uploadAsset } from './upload-asset'

vi.mock('./upload-asset', () => ({
  uploadAsset: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
})

const mockAssetRecord = {
  hash32: 'a'.repeat(32),
  filename: 'sample.png',
  slug: 'sample',
  ext: 'png',
  mime: 'image/png',
  size: 1024,
  kind: 'raster' as const,
  uploadedAt: '2024-01-01T00:00:00.000Z',
  src: '/assets/t/orig/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/sample.png',
}

function makeFile(): File {
  return new File(['x'], 'sample.png', { type: 'image/png' })
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <ApiClientProvider client={{} as unknown as ApiClient}>{children}</ApiClientProvider>
}

describe('useAssetUpload', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useAssetUpload(), { wrapper })
    expect(result.current.uploading).toBe(false)
    expect(result.current.progress).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('tracks progress while uploading and returns the asset on success', async () => {
    let resolveUpload!: (asset: typeof mockAssetRecord) => void
    let progressCb: ((fraction: number) => void) | undefined
    vi.mocked(uploadAsset).mockImplementation((_client, _file, onProgress) => {
      progressCb = onProgress
      return new Promise((resolve) => {
        resolveUpload = resolve
      })
    })

    const { result } = renderHook(() => useAssetUpload(), { wrapper })

    let uploadPromise!: ReturnType<typeof result.current.upload>
    act(() => {
      uploadPromise = result.current.upload(makeFile())
    })

    await waitFor(() => expect(result.current.uploading).toBe(true))
    expect(result.current.progress).toBe(0)

    act(() => {
      progressCb?.(0.42)
    })
    await waitFor(() => expect(result.current.progress).toBe(0.42))

    act(() => {
      resolveUpload(mockAssetRecord)
    })

    const asset = await uploadPromise
    expect(asset).toEqual(mockAssetRecord)

    await waitFor(() => expect(result.current.uploading).toBe(false))
    expect(result.current.progress).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('surfaces the error message and returns null on failure', async () => {
    vi.mocked(uploadAsset).mockRejectedValue(new Error('Unsupported content type: text/plain'))

    const { result } = renderHook(() => useAssetUpload(), { wrapper })

    let asset: unknown
    await act(async () => {
      asset = await result.current.upload(makeFile())
    })

    expect(asset).toBeNull()
    expect(result.current.uploading).toBe(false)
    expect(result.current.error).toBe('Unsupported content type: text/plain')
  })

  it('reset() clears a previous error', async () => {
    vi.mocked(uploadAsset).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useAssetUpload(), { wrapper })

    await act(async () => {
      await result.current.upload(makeFile())
    })
    expect(result.current.error).toBe('boom')

    act(() => {
      result.current.reset()
    })
    expect(result.current.error).toBeNull()
  })

  it('ignores a stale progress/error update from an upload superseded by a newer one', async () => {
    const deferred: Array<{
      resolve: (asset: typeof mockAssetRecord) => void
      reject: (err: Error) => void
    }> = []
    vi.mocked(uploadAsset).mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          deferred.push({ resolve, reject })
        }),
    )

    const { result } = renderHook(() => useAssetUpload(), { wrapper })

    let firstUpload!: ReturnType<typeof result.current.upload>
    act(() => {
      firstUpload = result.current.upload(makeFile())
    })
    await waitFor(() => expect(deferred).toHaveLength(1))

    let secondUpload!: ReturnType<typeof result.current.upload>
    act(() => {
      secondUpload = result.current.upload(makeFile())
    })
    await waitFor(() => expect(deferred).toHaveLength(2))

    // The stale (first) upload fails after the second has already started -
    // its error must not clobber the second upload's in-flight state.
    act(() => {
      deferred[0].reject(new Error('stale failure'))
    })
    await firstUpload
    expect(result.current.error).toBeNull()
    expect(result.current.uploading).toBe(true)

    act(() => {
      deferred[1].resolve(mockAssetRecord)
    })
    await secondUpload
    await waitFor(() => expect(result.current.uploading).toBe(false))
    expect(result.current.error).toBeNull()
  })
})
