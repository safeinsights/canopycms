/**
 * Raw XHR POST for S3 presigned-POST direct uploads. Deliberately bypasses
 * the API client's `request()` (which always does `fetch` + `response.json()`)
 * for two reasons: this posts to the presigned `upload.url` (not our own API),
 * and XHR is the only fetch-adjacent browser API that exposes upload progress
 * events.
 */

export interface PresignedPostTarget {
  url: string
  fields: Record<string, string>
}

/**
 * POST `file` to a presigned-POST target. S3 requires the `file` field to be
 * the LAST field in the multipart body - fields from the presign response
 * are appended first, `file` last. Resolves on any 2xx response; rejects with
 * a descriptive Error otherwise (S3 error bodies are XML and not parsed here -
 * the status code is enough to surface a "something went wrong" message).
 */
export function uploadToPresignedPost(
  target: PresignedPostTarget,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const formData = new FormData()
    for (const [key, value] of Object.entries(target.fields)) {
      formData.append(key, value)
    }
    formData.append('file', file)

    const xhr = new XMLHttpRequest()
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total)
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        reject(new Error(`Upload failed (HTTP ${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('Upload failed: network error'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))
    xhr.open('POST', target.url)
    xhr.send(formData)
  })
}
