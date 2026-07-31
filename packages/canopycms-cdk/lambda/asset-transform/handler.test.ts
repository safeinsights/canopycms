/**
 * Handler unit tests. Mocks `@aws-sdk/client-s3` the same way
 * packages/canopycms/src/assets/store-parity.test.ts does (aws-sdk-client-mock
 * backed by a tiny in-memory object map) - this file's `handler.ts` and that
 * package's `S3AssetStore` both talk to S3 directly, so the mocking shape is
 * intentionally the same.
 *
 * `applyTransform`/`parseTransformPath`/`formatDirectives` run for REAL here
 * (imported transitively from `canopycms/server`, which resolves `sharp`
 * against packages/canopycms's own node_modules - this works precisely
 * because Node resolves bare imports relative to the file that makes them,
 * not the caller) - the "oversized output" tests and the status-pass-through
 * tests spy on `applyTransform` instead: the former to avoid needing a
 * multi-megabyte fixture image, the latter because provoking each of
 * `applyTransform`'s real 400/413/422 outcomes from raw bytes would need a
 * different bespoke fixture per status when the thing actually under test
 * here is only "does the handler forward `transformed.status` verbatim".
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

  it('caches a non-canonically-ordered directive request under its canonical key', async () => {
    // formatDirectives' fixed order is c, f, q, w - a request with `w` before
    // `f` is valid (the parser doesn't care about order) but non-canonical.
    const res = await handler(makeEvent(`/assets/t/w=160,f=webp/${HASH32}/photo.webp`))

    expect(res.statusCode).toBe(200)
    const canonicalKey = `assets/t/f=webp,w=160/${HASH32}/photo.webp`
    expect(objects.has(canonicalKey)).toBe(true)
    expect(objects.has(`assets/t/w=160,f=webp/${HASH32}/photo.webp`)).toBe(false)
  })

  it('returns 400 JSON on a parse failure', async () => {
    const res = await handler(makeEvent('/assets/t/orig/not-a-hash/photo.png'))

    expect(res.statusCode).toBe(400)
    expect(res.headers?.['content-type']).toBe('application/json')
    expect(JSON.parse(res.body ?? '{}')).toHaveProperty('error')
  })

  it('returns 404 JSON when meta is missing', async () => {
    const missingHash = 'b'.repeat(32)
    const res = await handler(makeEvent(`/assets/t/orig/${missingHash}/photo.png`))

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body ?? '{}')).toHaveProperty('error')
  })

  it('returns 400 JSON for a non-raster (svg) asset - svg/pdf are served statically, never through the transform layer', async () => {
    objects.set(`asset-meta/${HASH32}.json`, {
      body: new TextEncoder().encode(JSON.stringify(makeMeta({ kind: 'svg', ext: 'svg' }))),
    })

    const res = await handler(makeEvent(`/assets/t/orig/${HASH32}/photo.svg`))

    expect(res.statusCode).toBe(400)
  })

  it('passes a transform rejection status through unflattened - 400 (unsupported input format)', async () => {
    const spy = vi.spyOn(canopyServer, 'applyTransform').mockResolvedValue({
      ok: false,
      status: 400,
      error: "Unsupported input format for transform: 'bmp'",
    })

    const res = await handler(makeEvent(`/assets/t/orig/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      error: "Unsupported input format for transform: 'bmp'",
    })

    spy.mockRestore()
  })

  it('passes a transform rejection status through unflattened - 413 (output too large)', async () => {
    const spy = vi.spyOn(canopyServer, 'applyTransform').mockResolvedValue({
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
    const spy = vi.spyOn(canopyServer, 'applyTransform').mockResolvedValue({
      ok: false,
      status: 422,
      error: 'Transform failed: vipspng: libpng read error',
    })

    const res = await handler(makeEvent(`/assets/t/orig/${HASH32}/photo.png`))

    expect(res.statusCode).toBe(422)
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      error: 'Transform failed: vipspng: libpng read error',
    })

    spy.mockRestore()
  })

  it('returns a 302 redirect with Cache-Control: no-store when the transform output exceeds the inline size cap, after writing it to S3 first', async () => {
    const spy = vi.spyOn(canopyServer, 'applyTransform').mockResolvedValue({
      ok: true,
      data: new Uint8Array(5 * 1024 * 1024), // over the 4 MiB inline cap
      contentType: 'image/png',
      ext: 'png',
    })

    const rawPath = `/assets/t/orig/${HASH32}/photo.png`
    const res = await handler(makeEvent(rawPath))

    expect(res.statusCode).toBe(302)
    expect(res.headers?.location).toBe(rawPath)
    expect(res.headers?.['cache-control']).toBe('no-store')
    expect(objects.has(`assets/t/orig/${HASH32}/photo.png`)).toBe(true)

    spy.mockRestore()
  })

  it('redirects an oversized-output, non-canonically-ordered request to the CANONICAL path, not rawPath - a mismatch would make CloudFront miss forever and re-invoke this Lambda on every hit', async () => {
    const spy = vi.spyOn(canopyServer, 'applyTransform').mockResolvedValue({
      ok: true,
      data: new Uint8Array(5 * 1024 * 1024), // over the 4 MiB inline cap
      contentType: 'image/webp',
      ext: 'webp',
    })

    // formatDirectives' fixed order is c, f, q, w - `w` before `f` is valid
    // but non-canonical, so rawPath and the canonical key differ.
    const rawPath = `/assets/t/w=160,f=webp/${HASH32}/photo.webp`
    const canonicalPath = `/assets/t/f=webp,w=160/${HASH32}/photo.webp`
    const res = await handler(makeEvent(rawPath))

    expect(res.statusCode).toBe(302)
    expect(res.headers?.location).toBe(canonicalPath)
    expect(res.headers?.['cache-control']).toBe('no-store')
    // The canonical key (what the redirect points at) was actually written.
    expect(objects.has(canonicalPath.slice(1))).toBe(true)

    spy.mockRestore()
  })
})
