/**
 * Handler unit tests. The handler's `S3AssetStore` talks to an aws-sdk-client-mock S3 backed by an
 * in-memory object map, and `storeTransform` and sharp run for real (sharp resolves from
 * packages/canopycms's own node_modules). Only the 413 and oversized-output cases spy on
 * `storeTransform`: reaching either for real needs a multi-megabyte fixture.
 */

import { Readable } from 'node:stream'

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { sdkStreamMixin } from '@smithy/util-stream'
import { mockClient } from 'aws-sdk-client-mock'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import * as canopyServer from 'canopycms/server'
import type { AssetMeta } from 'canopycms/server'

/** A real, tiny (73-byte, 4x4) decodable PNG - hand-built via Python's zlib, not sharp, so generating this fixture needs no dependency of its own. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR42mM4wcUFRwzEcQBxow3BFUWSxAAAAABJRU5ErkJggg=='

const HASH32 = 'a'.repeat(32)
const BUCKET = 'test-asset-bucket'

process.env.ASSET_BUCKET = BUCKET
process.env.AWS_REGION ??= 'us-east-1'

const s3Mock = mockClient(S3Client)

function makeMeta(overrides: Partial<AssetMeta> = {}): AssetMeta {
  return {
    hash32: HASH32,
    filename: 'photo.png',
    slug: 'photo',
    ext: 'png',
    mime: 'image/png',
    size: 73,
    kind: 'raster',
    uploadedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

interface FakeObject {
  body: Uint8Array
  contentType?: string
}

function makeAwsError(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(`${name} (mock)`), { name, $metadata: { httpStatusCode } })
}

function seedS3Fake(objects: Map<string, FakeObject>): void {
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    const obj = objects.get(input.Key as string)
    if (!obj) throw makeAwsError('NoSuchKey', 404)
    return {
      Body: sdkStreamMixin(Readable.from(Buffer.from(obj.body))),
      ContentType: obj.contentType,
    }
  })

  s3Mock.on(ListObjectsV2Command).callsFake((input) => {
    const prefix = input.Prefix ?? ''
    const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort()
    return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false }
  })

  s3Mock.on(PutObjectCommand).callsFake((input) => {
    const body = input.Body
    const bytes =
      body instanceof Uint8Array
        ? body
        : new TextEncoder().encode(typeof body === 'string' ? body : '')
    objects.set(input.Key as string, { body: bytes, contentType: input.ContentType })
    return {}
  })
}

function makeEvent(rawPath: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: 'anonymous',
      apiId: 'test-api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: 'GET',
        path: rawPath,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: 'test-request-id',
      routeKey: '$default',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
  }
}

let handler: typeof import('./handler').handler
let objects: Map<string, FakeObject>

beforeAll(async () => {
  ;({ handler } = await import('./handler'))
})

beforeEach(() => {
  // A failed assertion skips a test's own mockRestore, which would leak its spy into the next.
  vi.restoreAllMocks()
  s3Mock.reset()
  objects = new Map()
  seedS3Fake(objects)
  objects.set(`asset-meta/${HASH32}.json`, {
    body: new TextEncoder().encode(JSON.stringify(makeMeta())),
    contentType: 'application/json',
  })
  objects.set(`asset-originals/${HASH32}.png`, {
    body: Buffer.from(TINY_PNG_BASE64, 'base64'),
    contentType: 'image/png',
  })
})

describe('asset-transform handler', () => {
  it('writes the canonical key to S3 then returns the transform inline as base64', async () => {
    const res = await handler(makeEvent(`/assets/t/w=160/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(200)
    expect(res.isBase64Encoded).toBe(true)
    expect(res.headers?.['content-type']).toBe('image/png')
    expect(res.headers?.['cache-control']).toBe('public, max-age=31536000, immutable')

    const canonicalKey = `assets/t/w=160/${HASH32}/photo.png`
    const written = objects.get(canonicalKey)
    expect(written).toBeDefined()
    expect(written?.contentType).toBe('image/png')

    const bodyBytes = Buffer.from(res.body ?? '', 'base64')
    expect(bodyBytes.equals(Buffer.from(written!.body))).toBe(true)
  })

  it('transforms without listing the bucket, so a role without s3:ListBucket still works', async () => {
    s3Mock.on(ListObjectsV2Command).rejects(makeAwsError('AccessDenied', 403))
    const res = await handler(makeEvent(`/assets/t/w=160/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(200)
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0)
  })

  it('301s a non-canonically-ordered directive request to the canonical path without touching S3', async () => {
    // formatDirectives' fixed order is c, f, q, w - `w` before `f` parses but is not canonical.
    const res = await handler(makeEvent(`/assets/t/w=160,f=webp/${HASH32}/photo.webp`))

    expect(res.statusCode).toBe(301)
    expect(res.headers?.location).toBe(`/assets/t/f=webp,w=160/${HASH32}/photo.webp`)
    expect(res.headers?.['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(s3Mock.calls()).toHaveLength(0)
  })

  it('301s a crop with more than CROP_PRECISION decimals to the rounded canonical path', async () => {
    const res = await handler(makeEvent(`/assets/t/c=0.123456:0:0.5:0.25/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(301)
    expect(res.headers?.location).toBe(
      `/assets/t/c=0.1235:0.0000:0.5000:0.2500/${HASH32}/photo.png`,
    )
    expect(s3Mock.calls()).toHaveLength(0)
  })

  it('301s a crop whose rounded extent would overflow the frame to one shrunk to fit', async () => {
    // 0.66665 and 0.33335 round to 0.6667 and 0.3334, whose sum 1.0001 the parser would refuse.
    const res = await handler(makeEvent(`/assets/t/c=0.66665:0:0.33335:1/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(301)
    expect(res.headers?.location).toBe(
      `/assets/t/c=0.6667:0.0000:0.3333:1.0000/${HASH32}/photo.png`,
    )
  })

  it('400s a crop that rounds to zero extent, without touching S3', async () => {
    const res = await handler(makeEvent(`/assets/t/c=0:0:0.00001:1/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(400)
    expect(s3Mock.calls()).toHaveLength(0)
  })

  it('serves a canonical crop path, transforming with exactly the directives in its key', async () => {
    const spy = vi.spyOn(canopyServer, 'storeTransform')
    const canonical = `c=0.1235:0.0000:0.5000:0.2500`
    const res = await handler(makeEvent(`/assets/t/${canonical}/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(200)
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        directives: {
          identity: false,
          crop: { x: 0.1235, y: 0, w: 0.5, h: 0.25 },
          format: undefined,
          quality: undefined,
          width: undefined,
        },
      }),
      `assets/t/${canonical}/${HASH32}/photo.png`,
    )
    expect(objects.has(`assets/t/${canonical}/${HASH32}/photo.png`)).toBe(true)

    spy.mockRestore()
  })

  it('returns 400 JSON on a parse failure', async () => {
    const res = await handler(makeEvent('/assets/t/orig/not-a-hash/photo.png'))

    expect(res.statusCode).toBe(400)
    expect(res.headers?.['content-type']).toBe('application/json')
    expect(JSON.parse(res.body ?? '{}')).toHaveProperty('error')
  })

  it('refuses a width off the allowlist with 400, without touching S3', async () => {
    const res = await handler(makeEvent(`/assets/t/w=100/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(400)
    expect(s3Mock.calls()).toHaveLength(0)
  })

  it('transforms a small allowlist rung', async () => {
    const res = await handler(makeEvent(`/assets/t/w=64/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(200)
    expect(objects.has(`assets/t/w=64/${HASH32}/photo.png`)).toBe(true)
  })

  it('returns a generic 404 when meta is missing, never the hash storeTransform names', async () => {
    const missingHash = 'b'.repeat(32)
    const res = await handler(makeEvent(`/assets/t/orig/${missingHash}/photo.png`))

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body ?? '{}')).toEqual({ error: 'Not found' })
  })

  it('returns a generic 404 when the original is missing, writing nothing', async () => {
    objects.delete(`asset-originals/${HASH32}.png`)
    const res = await handler(makeEvent(`/assets/t/w=160/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body ?? '{}')).toEqual({ error: 'Not found' })
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0)
  })

  it('rejects a slug that does not match the asset, without writing anything to S3', async () => {
    // The aliasing amplifier: `[a-z0-9-]+` is all the parser can enforce, so
    // every distinct slug string would otherwise mint a fresh cache key, a
    // fresh sharp invocation and a fresh permanently-stored S3 object for one
    // and the same image.
    const res = await handler(makeEvent(`/assets/t/w=160/${HASH32}/any-slug-at-all.png`))

    expect(res.statusCode).toBe(404)
    // storeTransform's own message names the real slug, which would undo the pinning.
    expect(JSON.parse(res.body ?? '{}')).toEqual({ error: 'Not found' })
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0)
  })

  it('still serves the asset under its real slug', async () => {
    // Guards the check above against being over-tight: `makeMeta` slug is
    // 'photo', which is what every Canopy-generated URL carries.
    const res = await handler(makeEvent(`/assets/t/w=160/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(200)
  })

  it('returns 400 JSON for a non-raster (svg) asset - svg/pdf are served statically, never through the transform layer', async () => {
    objects.set(`asset-meta/${HASH32}.json`, {
      body: new TextEncoder().encode(JSON.stringify(makeMeta({ kind: 'svg', ext: 'svg' }))),
    })

    const res = await handler(makeEvent(`/assets/t/orig/${HASH32}/photo.svg`))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body ?? '{}').error).toMatch(/Not a raster asset/)
  })

  it('returns 400 when the URL ext does not match the source format and no f= is given', async () => {
    const res = await handler(makeEvent(`/assets/t/w=160/${HASH32}/photo.jpg`))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body ?? '{}').error).toMatch(/Extension does not match/)
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0)
  })

  it('passes a transform rejection status through unflattened - 400 (unsupported input format)', async () => {
    // The original's real extension, found by prefix, is one sharp is not given.
    objects.set(`asset-originals/${HASH32}.bmp`, objects.get(`asset-originals/${HASH32}.png`)!)
    objects.delete(`asset-originals/${HASH32}.png`)

    const res = await handler(makeEvent(`/assets/t/orig/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      error: "Unsupported input format for transform: 'bmp'",
    })
  })

  it('passes a transform rejection status through unflattened - 413 (output too large)', async () => {
    const spy = vi.spyOn(canopyServer, 'storeTransform').mockResolvedValue({
      ok: false,
      status: 413,
      error: 'Transformed output exceeds the byte cap',
    })

    const res = await handler(makeEvent(`/assets/t/orig/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(413)
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      error: 'Transformed output exceeds the byte cap',
    })

    spy.mockRestore()
  })

  it('passes a transform rejection status through unflattened - 422 (undecodable input)', async () => {
    objects.set(`asset-originals/${HASH32}.png`, {
      body: new TextEncoder().encode('not a png at all'),
    })

    const res = await handler(makeEvent(`/assets/t/w=160/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body ?? '{}').error).toMatch(/^Transform failed: /)
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0)
  })

  it('returns a 302 redirect with Cache-Control: no-store to the key it stored when the output exceeds the inline size cap', async () => {
    const spy = vi.spyOn(canopyServer, 'storeTransform').mockResolvedValue({
      ok: true,
      data: new Uint8Array(5 * 1024 * 1024), // over the 4 MiB inline cap
      contentType: 'image/png',
    })

    const rawPath = `/assets/t/orig/${HASH32}/photo.png`
    const res = await handler(makeEvent(rawPath))

    expect(res.statusCode).toBe(302)
    expect(res.headers?.location).toBe(rawPath)
    expect(res.headers?.['cache-control']).toBe('no-store')
    expect(spy).toHaveBeenCalledWith(expect.anything(), expect.anything(), rawPath.slice(1))

    spy.mockRestore()
  })

  it('answers a path outside /assets/t/ with 400 and touches nothing', async () => {
    const res = await handler(makeEvent(`/assets/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body ?? '{}').error).toMatch(/Expected a path under \/assets\/t\//)
    expect(s3Mock.calls()).toHaveLength(0)
  })
})
