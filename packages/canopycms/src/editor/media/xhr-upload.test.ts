/**
 * First tests for xhr-upload.ts. Until now its only consumer (upload-asset.test.ts) vi.mock'd
 * it out, so nothing pinned the two properties an S3 presigned POST actually depends on: that
 * `file` is the LAST multipart field, and that the POST goes to the presign's `url` verbatim.
 *
 * The second one became load-bearing with `media.uploadUrl`, which routes uploads at an
 * adopter's own CDN: the whole feature rests on this function not touching the URL it is given.
 *
 * XMLHttpRequest is stubbed rather than using jsdom's. jsdom would resolve a site-relative URL
 * against location.href (hiding exactly the rewriting this file must not do) and would attempt
 * a real request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { uploadToPresignedPost } from './xhr-upload'

interface ProgressLike {
  lengthComputable: boolean
  loaded: number
  total: number
}

class FakeXhr {
  static last: FakeXhr

  openArgs: [string, string] | undefined
  sent: FormData | undefined
  status = 0
  upload: { onprogress?: (event: ProgressLike) => void } = {}
  onload?: () => void
  onerror?: () => void
  onabort?: () => void

  constructor() {
    FakeXhr.last = this
  }

  open(method: string, url: string) {
    this.openArgs = [method, url]
  }

  send(body: FormData) {
    this.sent = body
  }

  /** Drive the handlers the way a browser would, after send(). */
  respond(status: number) {
    this.status = status
    this.onload?.()
  }
}

const FIELDS = {
  'Content-Type': 'image/png',
  key: 'asset-staging/00000000-0000-4000-8000-000000000000',
  Policy: 'base64-policy',
  'X-Amz-Signature': 'deadbeef',
}

const file = () => new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' })

beforeEach(() => {
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadToPresignedPost', () => {
  it.each([
    ['an S3 REST endpoint', 'https://my-bucket.s3.us-east-1.amazonaws.com/'],
    ['an adopter CDN host', 'https://cdn.example.com/asset-upload/'],
    ['a site-relative path', '/asset-upload/'],
    ['a path with no trailing slash', '/asset-upload'],
  ])('POSTs to %s exactly as given, with no rewriting', async (_label, url) => {
    const promise = uploadToPresignedPost({ url, fields: FIELDS }, file())
    FakeXhr.last.respond(204)
    await promise

    // Strict equality, not a match: joinUrlPrefix, new URL(url, location.href), or a
    // trailing-slash normalization would each produce a *similar* string, and a CloudFront
    // path pattern distinguishes them.
    expect(FakeXhr.last.openArgs).toEqual(['POST', url])
    expect(FakeXhr.last.openArgs?.[1]).toBe(url)
  })

  it('appends every presign field first and `file` LAST', async () => {
    const promise = uploadToPresignedPost({ url: '/asset-upload/', fields: FIELDS }, file())
    FakeXhr.last.respond(204)
    await promise

    // S3 rejects a POST whose `file` part is not last with
    // `400 InvalidArgument - Bucket POST must contain a field named 'key'...`.
    expect([...(FakeXhr.last.sent as FormData).keys()]).toEqual([...Object.keys(FIELDS), 'file'])
  })

  it.each([200, 201, 204, 299])('resolves on %i', async (status) => {
    const promise = uploadToPresignedPost({ url: '/u/', fields: FIELDS }, file())
    FakeXhr.last.respond(status)
    await expect(promise).resolves.toBeUndefined()
  })

  it.each([199, 300, 400, 403])('rejects on %i, naming the status', async (status) => {
    const promise = uploadToPresignedPost({ url: '/u/', fields: FIELDS }, file())
    FakeXhr.last.respond(status)
    await expect(promise).rejects.toThrow(`Upload failed (HTTP ${status})`)
  })

  it('distinguishes a network error from an abort', async () => {
    const networkFailure = uploadToPresignedPost({ url: '/u/', fields: FIELDS }, file())
    FakeXhr.last.onerror?.()
    await expect(networkFailure).rejects.toThrow('Upload failed: network error')

    const aborted = uploadToPresignedPost({ url: '/u/', fields: FIELDS }, file())
    FakeXhr.last.onabort?.()
    await expect(aborted).rejects.toThrow('Upload cancelled')
  })

  describe('progress', () => {
    it('reports a fraction of bytes uploaded', async () => {
      const onProgress = vi.fn()
      const promise = uploadToPresignedPost({ url: '/u/', fields: FIELDS }, file(), onProgress)

      FakeXhr.last.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 200 })
      FakeXhr.last.respond(204)
      await promise

      expect(onProgress).toHaveBeenCalledWith(0.25)
    })

    it.each([
      ['the length is not computable', { lengthComputable: false, loaded: 50, total: 200 }],
      ['total is 0, which would report Infinity', { lengthComputable: true, loaded: 50, total: 0 }],
    ])('ignores an event where %s', async (_label, event) => {
      const onProgress = vi.fn()
      const promise = uploadToPresignedPost({ url: '/u/', fields: FIELDS }, file(), onProgress)

      FakeXhr.last.upload.onprogress?.(event)
      FakeXhr.last.respond(204)
      await promise

      expect(onProgress).not.toHaveBeenCalled()
    })
  })
})
