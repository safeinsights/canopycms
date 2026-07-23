/**
 * One shared behavior suite run against both LocalAssetStore (a real tmp
 * directory) and S3AssetStore (aws-sdk-client-mock backed by a tiny in-memory
 * fake). Anything that isn't adapter-specific belongs here so the two
 * implementations can't silently drift apart.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandInput,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from '@aws-sdk/client-s3'
import { sdkStreamMixin } from '@smithy/util-stream'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { AssetMeta, AssetStore } from './types'
import { LocalAssetStore } from './store-local'
import { S3AssetStore } from './store-s3'

// createPresignedPost (used by beginUpload) resolves AWS credentials directly
// via the S3 client's credential provider chain, bypassing the `.send()`
// method that aws-sdk-client-mock patches. Dummy static credentials let it
// resolve without touching real AWS or the network.
beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test-access-key-id'
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test-secret-access-key'
})

const textOf = (data: Uint8Array): string => Buffer.from(data).toString('utf-8')

const hash32For = (n: number): string => n.toString(16).padStart(32, '0')

const makeMeta = (overrides: Partial<AssetMeta> = {}): AssetMeta => ({
  hash32: hash32For(1),
  filename: 'photo.png',
  slug: 'photo',
  ext: 'png',
  mime: 'image/png',
  size: 5,
  kind: 'raster',
  uploadedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

/** Minimal in-memory S3 fake, driven by aws-sdk-client-mock's callsFake(). */
function installS3Fake() {
  const s3Mock = mockClient(S3Client)
  const objects = new Map<
    string,
    { body: Uint8Array; contentType?: string; contentDisposition?: string; cacheControl?: string }
  >()

  const makeAwsError = (name: string, httpStatusCode: number, message: string) =>
    Object.assign(new Error(message), { name, $metadata: { httpStatusCode } })

  const toBytes = (body: PutObjectCommandInput['Body']): Uint8Array => {
    if (body instanceof Uint8Array) return body
    if (typeof body === 'string') return new TextEncoder().encode(body)
    throw new Error('Unsupported body type in S3 test fake')
  }

  s3Mock.on(PutObjectCommand).callsFake((input: PutObjectCommandInput) => {
    const key = input.Key as string
    if (input.IfNoneMatch === '*' && objects.has(key)) {
      throw makeAwsError('PreconditionFailed', 412, 'At least one of the pre-conditions failed')
    }
    objects.set(key, {
      body: toBytes(input.Body),
      contentType: input.ContentType,
      contentDisposition: input.ContentDisposition,
      cacheControl: input.CacheControl,
    })
    return {}
  })

  s3Mock.on(GetObjectCommand).callsFake((input) => {
    const obj = objects.get(input.Key as string)
    if (!obj) throw makeAwsError('NoSuchKey', 404, 'The specified key does not exist.')
    return {
      Body: sdkStreamMixin(Readable.from(Buffer.from(obj.body))),
      ContentType: obj.contentType,
      ContentDisposition: obj.contentDisposition,
      CacheControl: obj.cacheControl,
    }
  })

  s3Mock.on(DeleteObjectCommand).callsFake((input) => {
    objects.delete(input.Key as string)
    return {}
  })

  s3Mock.on(ListObjectsV2Command).callsFake((input: ListObjectsV2CommandInput) => {
    const prefix = input.Prefix ?? ''
    const allKeys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
    const startIndex = input.ContinuationToken ? Number(input.ContinuationToken) : 0
    const maxKeys = input.MaxKeys ?? 1000
    const page = allKeys.slice(startIndex, startIndex + maxKeys)
    const isTruncated = startIndex + maxKeys < allKeys.length
    return {
      Contents: page.map((key) => ({ Key: key })),
      IsTruncated: isTruncated,
      NextContinuationToken: isTruncated ? String(startIndex + maxKeys) : undefined,
    }
  })

  return { s3Mock, objects }
}

async function collectAllViaPagination(store: AssetStore, limit: number): Promise<AssetMeta[]> {
  const seen: AssetMeta[] = []
  let cursor: string | undefined
  let guard = 0
  do {
    const { items, nextCursor } = await store.listMeta({ cursor, limit })
    seen.push(...items)
    cursor = nextCursor
    guard += 1
    if (guard > 1000) throw new Error('listMeta pagination did not terminate')
  } while (cursor)
  return seen
}

interface Harness {
  store: AssetStore
  /** Assert the store orders listMeta results newest-uploadedAt-first (local guarantees this; S3 does not). */
  assertsNewestFirst: boolean
}

function runParitySuite(label: string, setup: () => Harness | Promise<Harness>) {
  describe(`AssetStore parity: ${label}`, () => {
    let harness: Harness

    beforeEach(async () => {
      harness = await setup()
    })

    it('round-trips staging write/read/delete', async () => {
      const { store } = harness
      const key = (await store.beginUpload({ filename: 'a.png', contentType: 'image/png' }))
        .stagingKey
      await store.writeStaging(key, new TextEncoder().encode('staged-bytes'), 'image/png')
      const read = await store.readStaging(key)
      expect(read && textOf(read)).toBe('staged-bytes')

      await store.deleteStaging(key)
      expect(await store.readStaging(key)).toBeNull()
    })

    it('returns null for readStaging of a missing key', async () => {
      expect(
        await harness.store.readStaging('asset-staging/dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
      ).toBeNull()
    })

    it('round-trips putOriginal/readOriginal, including contentType and ext', async () => {
      const { store } = harness
      const hash32 = hash32For(42)
      await store.putOriginal({
        hash32,
        ext: 'png',
        data: new TextEncoder().encode('original-bytes'),
        contentType: 'image/png',
      })
      const result = await store.readOriginal(hash32)
      expect(result).not.toBeNull()
      expect(result && textOf(result.data)).toBe('original-bytes')
      expect(result?.ext).toBe('png')
      expect(result?.contentType).toBe('image/png')
    })

    it('returns null for readOriginal of a missing hash', async () => {
      expect(await harness.store.readOriginal(hash32For(999))).toBeNull()
    })

    it('putMetaIfAbsent: first call creates, second call reports already-exists', async () => {
      const { store } = harness
      const meta = makeMeta({ hash32: hash32For(7) })
      expect(await store.putMetaIfAbsent(meta.hash32, meta)).toBe('created')
      expect(await store.putMetaIfAbsent(meta.hash32, { ...meta, filename: 'other.png' })).toBe(
        'already-exists',
      )
      // The loser must not have clobbered the winner's meta.
      const stored = await store.getMeta(meta.hash32)
      expect(stored?.filename).toBe('photo.png')
    })

    it('getMeta returns null for a missing hash', async () => {
      expect(await harness.store.getMeta(hash32For(12345))).toBeNull()
    })

    it('deleteMeta removes the meta sidecar', async () => {
      const { store } = harness
      const meta = makeMeta({ hash32: hash32For(9) })
      await store.putMetaIfAbsent(meta.hash32, meta)
      await store.deleteMeta(meta.hash32)
      expect(await store.getMeta(meta.hash32)).toBeNull()
    })

    it('deleteMeta on a missing hash is a no-op', async () => {
      await expect(harness.store.deleteMeta(hash32For(54321))).resolves.toBeUndefined()
    })

    it('preserves contentType and contentDisposition on putPublicObject/readPublicObject', async () => {
      const { store } = harness
      const key = 'assets/abcdef/photo.png'
      await store.putPublicObject({
        key,
        data: new TextEncoder().encode('public-bytes'),
        contentType: 'image/png',
        contentDisposition: 'inline; filename="photo.png"',
        cacheControl: 'public, max-age=31536000, immutable',
      })
      const result = await store.readPublicObject(key)
      expect(result).not.toBeNull()
      expect(result && textOf(result.data)).toBe('public-bytes')
      expect(result?.contentType).toBe('image/png')
      expect(result?.contentDisposition).toBe('inline; filename="photo.png"')
      expect(result?.cacheControl).toBe('public, max-age=31536000, immutable')
    })

    it('returns null for readPublicObject of a missing key', async () => {
      expect(await harness.store.readPublicObject('assets/missing/none.png')).toBeNull()
    })

    it('paginates listMeta to exhaustion with no duplicates', async () => {
      const { store } = harness
      const total = 7
      const limit = 3
      for (let i = 0; i < total; i++) {
        await store.putMetaIfAbsent(
          hash32For(i),
          makeMeta({
            hash32: hash32For(i),
            uploadedAt: new Date(2026, 0, 1 + i).toISOString(),
          }),
        )
      }

      const all = await collectAllViaPagination(store, limit)
      expect(all).toHaveLength(total)
      expect(new Set(all.map((m) => m.hash32)).size).toBe(total)
    })

    it('orders listMeta newest-first when the adapter guarantees it', async () => {
      const { store, assertsNewestFirst } = harness
      if (!assertsNewestFirst) return

      const total = 4
      for (let i = 0; i < total; i++) {
        await store.putMetaIfAbsent(
          hash32For(i),
          makeMeta({
            hash32: hash32For(i),
            uploadedAt: new Date(2026, 0, 1 + i).toISOString(),
          }),
        )
      }

      const { items } = await store.listMeta({ limit: total })
      const uploadedAtDescending = items.map((m) => m.uploadedAt)
      const sorted = [...uploadedAtDescending].sort().reverse()
      expect(uploadedAtDescending).toEqual(sorted)
      // The most recently seeded item (i = total - 1) must come first.
      expect(items[0].hash32).toBe(hash32For(total - 1))
    })
  })
}

describe('store-parity', () => {
  let tmpDirs: string[] = []

  runParitySuite('LocalAssetStore', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-assets-parity-'))
    tmpDirs.push(root)
    return { store: new LocalAssetStore({ root }), assertsNewestFirst: true }
  })

  afterEach(async () => {
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
    tmpDirs = []
  })

  describe('s3 fake lifecycle', () => {
    let fake: ReturnType<typeof installS3Fake> | undefined

    runParitySuite('S3AssetStore', () => {
      fake?.s3Mock.restore()
      fake = installS3Fake()
      return {
        store: new S3AssetStore({ bucket: 'test-bucket', region: 'us-east-1' }),
        assertsNewestFirst: false,
      }
    })

    afterEach(() => {
      fake?.s3Mock.restore()
      fake = undefined
    })
  })
})

describe('LocalAssetStore path-traversal guard', () => {
  it('rejects a staging key that escapes the root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-assets-traversal-'))
    const store = new LocalAssetStore({ root })
    // The escape is routed inside the staging prefix so it passes the
    // staging-key assertion and exercises resolveKey's traversal guard.
    await expect(
      store.writeStaging('asset-staging/../../escape', new TextEncoder().encode('x')),
    ).rejects.toThrow('Path traversal detected')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('rejects a sibling-directory bypass via prefix-only startsWith check', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-assets-sibling-'))
    const root = path.join(parent, 'assets')
    const sibling = path.join(parent, 'assets-sibling')
    await fs.mkdir(root)
    await fs.mkdir(sibling)
    await fs.writeFile(path.join(sibling, 'secret.txt'), 'secret content')

    const store = new LocalAssetStore({ root })
    await expect(
      store.readStaging('asset-staging/../../assets-sibling/secret.txt'),
    ).rejects.toThrow('Path traversal detected')

    await fs.rm(parent, { recursive: true, force: true })
  })
})
