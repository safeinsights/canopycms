import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import sharp from 'sharp'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isTransientStoreError,
  materializeAssets,
  SharpUnavailableError,
  TRANSFORM_CACHE_CONTROL,
  type MaterializeTarget,
} from './materialize'
import * as sharpLoader from './sharp-loader'
import { LocalAssetStore } from './store-local'
import { S3AssetStore } from './store-s3'
import type { AssetMeta, AssetStore } from './types'

vi.mock('./sharp-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sharp-loader')>()
  return { ...actual, loadSharp: vi.fn(actual.loadSharp) }
})

const HASH = 'a'.repeat(32)
const OTHER_HASH = 'b'.repeat(32)
const noSleep = () => Promise.resolve()

const meta: AssetMeta = {
  hash32: HASH,
  filename: 'photo.png',
  slug: 'photo',
  ext: 'png',
  mime: 'image/png',
  size: 0,
  kind: 'raster',
  uploadedAt: '2026-01-01T00:00:00.000Z',
}

function target(key: string, routes: string[] = ['/'], files = ['index.html']): MaterializeTarget {
  return { key, routes, files }
}

/** An AWS SDK v3 service exception's shape, as the store sees it. */
function awsError(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } })
}

describe('materializeAssets against a local store', () => {
  let tmpDir: string
  let store: LocalAssetStore

  beforeEach(async () => {
    vi.mocked(sharpLoader.loadSharp).mockClear()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-materialize-test-'))
    store = new LocalAssetStore({ root: tmpDir })
    const png = await sharp({
      create: { width: 800, height: 400, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer()
    await store.putOriginal({ hash32: HASH, ext: 'png', data: png, contentType: 'image/png' })
    await store.putMetaIfAbsent(HASH, { ...meta, size: png.byteLength })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('creates the missing keys, then a second run creates nothing', async () => {
    const targets = [
      target(`assets/t/w=320/${HASH}/photo.png`),
      target(`assets/t/f=webp,w=640/${HASH}/photo.webp`, ['/about']),
    ]
    const first = await materializeAssets({ store, targets, sleep: noSleep })
    expect(first.summary).toMatchObject({ total: 2, created: 2, existed: 0, failed: 0 })

    const stored = await store.readPublicObject(`assets/t/w=320/${HASH}/photo.png`)
    expect(stored?.cacheControl).toBe(TRANSFORM_CACHE_CONTROL)
    expect((await sharp(stored?.data).metadata()).width).toBe(320)

    const put = vi.spyOn(store, 'putPublicObject')
    const second = await materializeAssets({ store, targets, sleep: noSleep })
    expect(second.summary).toMatchObject({ total: 2, created: 0, existed: 2, failed: 0 })
    expect(put).not.toHaveBeenCalled()
  })

  it('materializes a width off the lazy-path allowlist (the any policy)', async () => {
    const key = `assets/t/w=100/${HASH}/photo.png`
    const report = await materializeAssets({ store, targets: [target(key)], sleep: noSleep })
    expect(report.summary).toMatchObject({ created: 1, failed: 0 })
    const stored = await store.readPublicObject(key)
    expect((await sharp(stored?.data).metadata()).width).toBe(100)
  })

  it('does not load sharp when every key already exists', async () => {
    const key = `assets/t/w=320/${HASH}/photo.png`
    await materializeAssets({ store, targets: [target(key)], sleep: noSleep })
    vi.mocked(sharpLoader.loadSharp).mockClear()

    const report = await materializeAssets({ store, targets: [target(key)], sleep: noSleep })
    expect(report.summary.existed).toBe(1)
    expect(sharpLoader.loadSharp).not.toHaveBeenCalled()
  })

  it('throws SharpUnavailableError, writing nothing, when sharp cannot load and a key is missing', async () => {
    vi.mocked(sharpLoader.loadSharp).mockRejectedValueOnce(new Error('dlopen failed'))
    const put = vi.spyOn(store, 'putPublicObject')
    await expect(
      materializeAssets({
        store,
        targets: [target(`assets/t/w=320/${HASH}/photo.png`)],
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(SharpUnavailableError)
    expect(put).not.toHaveBeenCalled()
  })

  it('reports a missing meta as a content failure naming the referencing pages', async () => {
    const report = await materializeAssets({
      store,
      targets: [target(`assets/t/w=320/${OTHER_HASH}/gone.png`, ['/about', '/'], ['a.html'])],
      sleep: noSleep,
    })
    expect(report.results).toEqual([
      {
        key: `assets/t/w=320/${OTHER_HASH}/gone.png`,
        routes: ['/', '/about'],
        files: ['a.html'],
        status: 'failed',
        failure: 'content',
        error: `404: Asset ${OTHER_HASH} has no meta in the store`,
      },
    ])
  })

  it('reports a slug that is not the asset slug as a content failure', async () => {
    const report = await materializeAssets({
      store,
      targets: [target(`assets/t/w=320/${HASH}/renamed.png`)],
      sleep: noSleep,
    })
    expect(report.results[0]).toMatchObject({ status: 'failed', failure: 'content' })
    expect(report.results[0]).toHaveProperty('error', expect.stringContaining("slug 'photo'"))
  })

  it('refuses a non-canonical or malformed key without touching the store', async () => {
    const head = vi.spyOn(store, 'hasPublicObject')
    const report = await materializeAssets({
      store,
      targets: [
        target(`assets/t/w=320,f=webp/${HASH}/photo.webp`),
        target(`assets/t/w=8193/${HASH}/photo.png`),
        target(`assets/${HASH}/photo.png`),
      ],
      sleep: noSleep,
    })
    expect(report.summary).toMatchObject({ failed: 3, contentFailures: 3 })
    expect(head).not.toHaveBeenCalled()
  })

  it('merges duplicate targets for one key', async () => {
    const key = `assets/t/w=320/${HASH}/photo.png`
    const report = await materializeAssets({
      store,
      targets: [target(key, ['/b'], ['b.html']), target(key, ['/a'], ['a.html'])],
      sleep: noSleep,
    })
    expect(report.results).toHaveLength(1)
    expect(report.results[0]).toMatchObject({ routes: ['/a', '/b'], files: ['a.html', 'b.html'] })
  })

  it('retries a transient store error and succeeds', async () => {
    const realHas = store.hasPublicObject.bind(store)
    const has = vi
      .spyOn(store, 'hasPublicObject')
      .mockRejectedValueOnce(awsError('ServiceUnavailable', 503))
      .mockImplementation(realHas)
    const realPut = store.putPublicObject.bind(store)
    const put = vi
      .spyOn(store, 'putPublicObject')
      .mockRejectedValueOnce(awsError('SlowDown', 503))
      .mockImplementation(realPut)

    const report = await materializeAssets({
      store,
      targets: [target(`assets/t/w=320/${HASH}/photo.png`)],
      sleep: noSleep,
    })
    expect(report.summary.created).toBe(1)
    expect(has).toHaveBeenCalledTimes(2)
    expect(put).toHaveBeenCalledTimes(2)
  })

  it('gives up after the configured attempts and reports a store failure', async () => {
    const has = vi.spyOn(store, 'hasPublicObject').mockRejectedValue(awsError('InternalError', 500))
    const sleep = vi.fn(noSleep)
    const report = await materializeAssets({
      store,
      targets: [target(`assets/t/w=320/${HASH}/photo.png`)],
      attempts: 3,
      sleep,
    })
    expect(report.results[0]).toMatchObject({ status: 'failed', failure: 'store' })
    expect(has).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('does not retry an access-denied error', async () => {
    const has = vi.spyOn(store, 'hasPublicObject').mockRejectedValue(awsError('AccessDenied', 403))
    const report = await materializeAssets({
      store,
      targets: [target(`assets/t/w=320/${HASH}/photo.png`)],
      sleep: noSleep,
    })
    expect(report.results[0]).toMatchObject({ status: 'failed', failure: 'store' })
    expect(has).toHaveBeenCalledTimes(1)
  })

  it('does not retry a content failure', async () => {
    const getMeta = vi.spyOn(store, 'getMeta')
    await materializeAssets({
      store,
      targets: [target(`assets/t/w=320/${OTHER_HASH}/gone.png`)],
      sleep: noSleep,
    })
    expect(getMeta).toHaveBeenCalledTimes(1)
  })
})

describe('materializeAssets statics', () => {
  let tmpDir: string
  let store: LocalAssetStore

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-materialize-statics-'))
    store = new LocalAssetStore({ root: tmpDir })
    await store.putPublicObject({
      key: `assets/${HASH}/logo.svg`,
      data: new TextEncoder().encode('<svg/>'),
      contentType: 'image/svg+xml',
    })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('checks statics without transforming them, failing a missing or malformed one', async () => {
    vi.mocked(sharpLoader.loadSharp).mockClear()
    const report = await materializeAssets({
      store,
      targets: [],
      statics: [
        target(`assets/${HASH}/logo.svg`),
        target(`assets/${OTHER_HASH}/gone.pdf`, ['/docs']),
        target(`assets/${HASH}/../logo.svg`),
      ],
      sleep: noSleep,
    })
    expect(report.results.map(({ key, status }) => [key, status])).toEqual([
      [`assets/${HASH}/../logo.svg`, 'failed'],
      [`assets/${HASH}/logo.svg`, 'existed'],
      [`assets/${OTHER_HASH}/gone.pdf`, 'failed'],
    ])
    expect(report.summary).toMatchObject({ existed: 1, contentFailures: 2, storeFailures: 0 })
    expect(sharpLoader.loadSharp).not.toHaveBeenCalled()
  })
})

describe('isTransientStoreError', () => {
  it.each([
    [awsError('SlowDown', 503), true],
    [awsError('ThrottlingException', 400), true],
    [awsError('TooManyRequests', 429), true],
    [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), true],
    [awsError('AccessDenied', 403), false],
    [awsError('NoSuchBucket', 404), false],
    [new Error('bad json'), false],
    ['not an error', false],
  ])('%s -> %s', (err, expected) => {
    expect(isTransientStoreError(err)).toBe(expected)
  })
})

describe('materializeAssets existence pass against S3', () => {
  const s3 = mockClient(S3Client)

  beforeAll(() => {
    process.env.AWS_ACCESS_KEY_ID ??= 'test-access-key-id'
    process.env.AWS_SECRET_ACCESS_KEY ??= 'test-secret-access-key'
  })

  beforeEach(() => {
    s3.reset()
    vi.mocked(sharpLoader.loadSharp).mockClear()
  })

  const keysAt = (directives: string, count: number) =>
    Array.from(
      { length: count },
      (_, i) => `assets/t/${directives}/${i.toString(16).padStart(32, '0')}/photo.png`,
    )

  it('lists a directive prefix that many keys share, and HEADs the rest', async () => {
    const listed = keysAt('w=320', 4)
    s3.on(ListObjectsV2Command, { Prefix: 'assets/t/w=320/' })
      .resolvesOnce({
        Contents: listed.slice(0, 2).map((Key) => ({ Key })),
        IsTruncated: true,
        NextContinuationToken: 'page-2',
      })
      .resolvesOnce({ Contents: listed.slice(2).map((Key) => ({ Key })), IsTruncated: false })
    s3.on(HeadObjectCommand).resolves({})

    const store: AssetStore = new S3AssetStore({ bucket: 'b', region: 'us-east-1' })
    const headed = keysAt('w=640', 2)
    const report = await materializeAssets({
      store,
      targets: [...listed, ...headed].map((key) => target(key)),
      listThreshold: 3,
      sleep: noSleep,
    })

    expect(report.summary).toMatchObject({ total: 6, existed: 6 })
    expect(s3.commandCalls(ListObjectsV2Command)).toHaveLength(2)
    expect(s3.commandCalls(HeadObjectCommand).map((call) => call.args[0].input.Key)).toEqual(headed)
    expect(sharpLoader.loadSharp).not.toHaveBeenCalled()
  })

  it('reports a bucket that does not exist as a store failure, not a deleted asset', async () => {
    // A HEAD has no body, so a missing bucket and a missing key are both a bare 404.
    s3.on(HeadObjectCommand).rejects(awsError('NotFound', 404))
    s3.on(GetObjectCommand).rejects(awsError('NoSuchBucket', 404))
    const store = new S3AssetStore({ bucket: 'typo', region: 'us-east-1' })

    const report = await materializeAssets({
      store,
      targets: keysAt('w=320', 1).map((key) => target(key)),
      sleep: noSleep,
    })
    expect(report.summary).toMatchObject({ failed: 1, storeFailures: 1, contentFailures: 0 })
  })

  it('reports a missing bucket as a store failure for a static key too', async () => {
    s3.on(HeadObjectCommand).rejects(awsError('NotFound', 404))
    s3.on(GetObjectCommand).rejects(awsError('NoSuchBucket', 404))
    const store = new S3AssetStore({ bucket: 'typo', region: 'us-east-1' })

    const report = await materializeAssets({
      store,
      targets: [],
      statics: [target(`assets/${HASH}/logo.svg`)],
      sleep: noSleep,
    })
    expect(report.summary).toMatchObject({ failed: 1, storeFailures: 1, contentFailures: 0 })
  })

  it('treats a key the listing lacks as missing', async () => {
    const keys = keysAt('w=320', 3)
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: keys[0] }], IsTruncated: false })
    // Missing keys go on to the transform, whose first step is the meta read.
    s3.on(HeadObjectCommand).rejects(awsError('NotFound', 404))
    const store = new S3AssetStore({ bucket: 'b', region: 'us-east-1' })
    const getMeta = vi.spyOn(store, 'getMeta').mockResolvedValue(null)

    const report = await materializeAssets({
      store,
      targets: keys.map((key) => target(key)),
      listThreshold: 3,
      sleep: noSleep,
    })
    expect(report.summary).toMatchObject({ existed: 1, failed: 2, contentFailures: 2 })
    expect(getMeta).toHaveBeenCalledTimes(2)
    expect(s3.commandCalls(HeadObjectCommand)).toHaveLength(0)
  })
})
