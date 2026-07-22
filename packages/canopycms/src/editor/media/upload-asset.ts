/**
 * Shared upload state machine: presign -> transport -> finalize. Used by
 * every asset-upload entry point in the editor (MediaLibrary's dropzone,
 * ImageField's empty-state dropzone, the MDX image dialog's Upload tab, and
 * MDXEditor's own drag/drop/paste `imageUploadHandler`) so the flow (and its
 * 415/413 pipeline-rejection error surfacing) lives in exactly one place.
 *
 * Framework-agnostic (no React) so `MarkdownField`'s `imageUploadHandler`
 * prop - a plain `(file: File) => Promise<string>` function required by
 * MDXEditor's `imagePlugin`, called outside of any component render - can
 * call it directly. `useAssetUpload.ts` wraps this with React state for
 * callers that want progress/error UI.
 */

import type { ApiClient } from '../context'
import type { AssetRecord } from '../../api'
import { uploadToPresignedPost } from './xhr-upload'

/**
 * Upload `file` through the asset pipeline and return the finalized
 * `AssetRecord`. `onProgress` receives a 0..1 fraction while the transport is
 * underway for direct-upload stores (S3 presigned POST); it is never called
 * for proxied stores (no XHR involved - `client.assets.uploadProxied` uses
 * `fetch`, which exposes no upload progress) or during the (fast) finalize
 * step, so callers should show an indeterminate indicator whenever they
 * aren't actively receiving progress calls.
 *
 * Throws an `Error` (message = the server's `error` string when available)
 * on any failure - a rejected presign (415 unsupported type, 413 too large),
 * a failed transport, or a rejected finalize (e.g. a magic-byte sniff
 * mismatch or SVG sanitization failure).
 */
export async function uploadAsset(
  client: ApiClient,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<AssetRecord> {
  const presignResult = await client.assets.presign({
    filename: file.name,
    contentType: file.type || 'application/octet-stream',
    size: file.size,
  })
  if (!presignResult.ok || !presignResult.data) {
    throw new Error(presignResult.error || 'Failed to start upload')
  }

  const { upload } = presignResult.data

  if (upload.mode === 'direct') {
    await uploadToPresignedPost(upload, file, onProgress)
    const finalizeResult = await client.assets.finalize({
      stagingKey: upload.stagingKey,
      filename: file.name,
    })
    if (!finalizeResult.ok || !finalizeResult.data) {
      throw new Error(finalizeResult.error || 'Failed to finalize upload')
    }
    return finalizeResult.data.asset
  }

  const uploadResult = await client.assets.uploadProxied(file)
  if (!uploadResult.ok || !uploadResult.data) {
    throw new Error(uploadResult.error || 'Failed to upload')
  }
  return uploadResult.data.asset
}
