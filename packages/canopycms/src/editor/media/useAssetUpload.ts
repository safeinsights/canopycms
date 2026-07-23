'use client'

import { useCallback, useRef, useState } from 'react'

import type { AssetRecord } from '../../api'
import { getErrorMessage } from '../../utils/error'
import { useApiClient } from '../context'
import { uploadAsset } from './upload-asset'

export interface UseAssetUploadResult {
  uploading: boolean
  /** 0..1 fraction while a direct-upload transport is in flight; `null` when indeterminate (proxied stores, or the finalize step). */
  progress: number | null
  error: string | null
  /** Upload `file`, returning the finalized AssetRecord, or `null` if the upload failed (see `error`). */
  upload: (file: File) => Promise<AssetRecord | null>
  reset: () => void
}

/**
 * React state wrapper around `uploadAsset` for UI that shows upload
 * progress/errors (MediaLibrary's dropzone, ImageField's empty state, the MDX
 * image dialog's Upload tab). Uses `useApiClient()` (context DI) rather than
 * `createApiClient()` so tests can inject a mock client via
 * `ApiClientProvider`.
 */
export function useAssetUpload(): UseAssetUploadResult {
  const client = useApiClient()
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Guards against a progress/state update landing after the component that
  // owns this hook has moved on to a different upload (or unmounted) -
  // avoids a stale "uploading" flicker if a slow upload resolves after a
  // newer one already started.
  const uploadIdRef = useRef(0)

  const upload = useCallback(
    async (file: File): Promise<AssetRecord | null> => {
      const uploadId = ++uploadIdRef.current
      setUploading(true)
      setProgress(0)
      setError(null)
      try {
        const asset = await uploadAsset(client, file, (fraction) => {
          if (uploadIdRef.current === uploadId) setProgress(fraction)
        })
        return asset
      } catch (err) {
        if (uploadIdRef.current === uploadId) setError(getErrorMessage(err))
        return null
      } finally {
        if (uploadIdRef.current === uploadId) {
          setUploading(false)
          setProgress(null)
        }
      }
    },
    [client],
  )

  const reset = useCallback(() => {
    setError(null)
    setProgress(null)
  }, [])

  return { uploading, progress, error, upload, reset }
}
