import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import sharp from 'sharp'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assertValidOutputPrefix,
  InvalidOutputPrefixError,
  isTransientStoreError,
  MATERIALIZE_REPORT_SCHEMA_VERSION,
  materializeAssets,
  SharpUnavailableError,
  storeTransform,
  TRANSFORM_CACHE_CONTROL,
  type MaterializeTarget,
} from './materialize'
import * as sharpLoader from './sharp-loader'
import { LocalAssetStore } from './store-local'
import { S3AssetStore } from './store-s3'
import { canonicalizeTransformPath } from './transform-directives'
import type { AssetMeta, AssetStore, CreateOnlyResult } from './types'

vi.mock('./sharp-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sharp-loader')>()
  return { ...actual, loadSharp: vi.fn(actual.loadSharp) }
})

const HASH = 'a'.repeat(32)
const OTHER_HASH = 'b'.repeat(32)
const noSleep = () => Promise.resolve()
const textOf = (data: Uint8Array | undefined) => (data ? Buffer.from(data).toString('utf-8') : '')

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

  it('reports schemaVersion 1 and a copied count of 0', async () => {
    const report = await materializeAssets({
      store,
      targets: [target(`assets/t/w=320/${HASH}/photo.png`)],
      sleep: noSleep,
    })
    expect(MATERIALIZE_REPORT_SCHEMA_VERSION).toBe(1)
    expect(report.schemaVersion).toBe(1)
    expect(report.summary.copied).toBe(0)
  })

  it('writes untagged, so the lazy expiry never deletes a materialized key', async () => {
    const put = vi.spyOn(store, 'putPublicObject')
    const key = `assets/t/w=100/${HASH}/photo.png`
    await materializeAssets({ store, targets: [target(key)], sleep: noSleep })
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0][0]).toMatchObject({ key })
    expect(put.mock.calls[0][0].tags).toBeUndefined()
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

  it('bounds transforms in flight separately from store requests', async () => {
    const widths = [160, 320, 480, 640, 800, 960]
    const targets = widths.map((w) => target(`assets/t/w=${w}/${HASH}/photo.png`))
    const readOriginal = store.readOriginal.bind(store)
    let inFlight = 0
    let peak = 0
    vi.spyOn(store, 'readOriginal').mockImplementation(async (...args) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      try {
        return await readOriginal(...args)
      } finally {
        inFlight--
      }
    })

    const report = await materializeAssets({ store, targets, concurrency: 8 })

    expect(report.summary.created).toBe(widths.length)
    expect(peak).toBe(2)
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

  it('counts a key another writer stored after the existence check as existed, keeping its bytes', async () => {
    const key = `assets/t/w=320/${HASH}/photo.png`
    const theirs = new TextEncoder().encode('stored by another writer')
    await store.putPublicObject({ key, data: theirs, contentType: 'image/png' })
    vi.spyOn(store, 'hasPublicObject').mockResolvedValue(false)

    const report = await materializeAssets({ store, targets: [target(key)], sleep: noSleep })
    expect(report.results[0]).toMatchObject({ key, status: 'existed' })
    expect(report.summary).toMatchObject({ existed: 1, created: 0, failed: 0 })
    expect(textOf((await store.readPublicObject(key))?.data)).toBe('stored by another writer')
  })

  it('counts a key it stored before a lost response as created, not existed', async () => {
    const key = `assets/t/w=320/${HASH}/photo.png`
    vi.spyOn(store, 'hasPublicObject').mockResolvedValue(false)
    const realPut = store.putPublicObject.bind(store)
    vi.spyOn(store, 'putPublicObject').mockImplementationOnce(async (input) => {
      await realPut(input)
      throw awsError('ServiceUnavailable', 503)
    })

    const report = await materializeAssets({ store, targets: [target(key)], sleep: noSleep })
    expect(report.results[0]).toMatchObject({ key, status: 'created' })
    expect(report.summary).toMatchObject({ existed: 0, created: 1, failed: 0 })
  })

  it('counts only the literal already-exists as existed', async () => {
    vi.spyOn(store, 'putPublicObject').mockResolvedValue(undefined as unknown as CreateOnlyResult)
    const report = await materializeAssets({
      store,
      targets: [target(`assets/t/w=320/${HASH}/photo.png`)],
      sleep: noSleep,
    })
    expect(report.summary).toMatchObject({ existed: 0, created: 1, failed: 0 })
  })

  it('two racing storeTransforms on one key both serve bytes; one creates, one finds it stored', async () => {
    const segments = ['w=320', HASH, 'photo.png']
    const parsed = canonicalizeTransformPath(segments, 'any')
    if (!parsed.ok) throw new Error(parsed.error)
    const key = `assets/t/${segments.join('/')}`

    const results = await Promise.all([
      storeTransform(store, parsed, key),
      storeTransform(store, parsed, key),
    ])
    const stored: string[] = []
    for (const result of results) {
      if (!result.ok) throw new Error(result.error)
      expect((await sharp(result.data).metadata()).width).toBe(320)
      stored.push(result.stored)
    }
    expect(stored.sort()).toEqual(['already-exists', 'created'])
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

describe('materializeAssets with an output prefix', () => {
  const PREFIX = 'previews/7/'
  const atProduction = `assets/t/w=320/${HASH}/photo.png`
  const notStored = `assets/t/w=160/${HASH}/photo.png`
  const logo = `assets/${HASH}/logo.svg`
  const gonePdf = `assets/${OTHER_HASH}/gone.pdf`
  let tmpDir: string
  let store: LocalAssetStore

  /** Every file under the store's canonical `assets/` tree, with its bytes. */
  const canonicalTree = async () => {
    const entries = await fs.readdir(path.join(tmpDir, 'assets'), { recursive: true })
    const files: Record<string, string> = {}
    for (const entry of entries.sort()) {
      const file = path.join(tmpDir, 'assets', entry)
      if ((await fs.stat(file)).isFile()) files[entry] = await fs.readFile(file, 'utf-8')
    }
    return files
  }

  beforeEach(async () => {
    vi.mocked(sharpLoader.loadSharp).mockClear()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-materialize-prefix-'))
    store = new LocalAssetStore({ root: tmpDir })
    const png = await sharp({
      create: { width: 800, height: 400, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer()
    await store.putOriginal({ hash32: HASH, ext: 'png', data: png, contentType: 'image/png' })
    await store.putMetaIfAbsent(HASH, { ...meta, size: png.byteLength })
    await store.putPublicObject({
      key: atProduction,
      data: new TextEncoder().encode('production bytes'),
      contentType: 'image/png',
      cacheControl: TRANSFORM_CACHE_CONTROL,
    })
    await store.putPublicObject({
      key: logo,
      data: new TextEncoder().encode('<svg/>'),
      contentType: 'image/svg+xml',
      contentDisposition: 'inline; filename="logo.svg"',
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  const run = (overrides: Partial<Parameters<typeof materializeAssets>[0]> = {}) =>
    materializeAssets({
      store,
      targets: [target(atProduction), target(notStored)],
      statics: [target(logo), target(gonePdf, ['/docs'])],
      outputPrefix: PREFIX,
      sleep: noSleep,
      ...overrides,
    })

  it('copies what production stores, transforms the rest, and writes all of it under the prefix', async () => {
    const report = await run()
    expect(report.outputPrefix).toBe(PREFIX)
    expect(report.results.map(({ key, status }) => [key, status])).toEqual([
      [logo, 'copied'],
      [gonePdf, 'failed'],
      [notStored, 'created'],
      [atProduction, 'copied'],
    ])
    expect(report.summary).toMatchObject({ copied: 2, created: 1, contentFailures: 1 })

    expect(textOf((await store.readPublicObject(`${PREFIX}${atProduction}`))?.data)).toBe(
      'production bytes',
    )
    expect(await store.readPublicObject(`${PREFIX}${logo}`)).toMatchObject({
      contentType: 'image/svg+xml',
      contentDisposition: 'inline; filename="logo.svg"',
    })
    const transformed = await store.readPublicObject(`${PREFIX}${notStored}`)
    expect((await sharp(transformed?.data).metadata()).width).toBe(160)
    expect(await store.hasPublicObject(notStored)).toBe(false)
  })

  it('never writes or copies outside the prefix, and leaves the canonical tree untouched', async () => {
    const before = await canonicalTree()
    const writes = {
      put: vi.spyOn(store, 'putPublicObject'),
      original: vi.spyOn(store, 'putOriginal'),
      meta: vi.spyOn(store, 'putMetaIfAbsent'),
      copy: vi.spyOn(store, 'copyPublicObject'),
    }

    await run()

    expect(writes.put).toHaveBeenCalled()
    expect(writes.copy).toHaveBeenCalled()
    for (const [input] of writes.put.mock.calls) expect(input.key.startsWith(PREFIX)).toBe(true)
    for (const [source, dest] of writes.copy.mock.calls) {
      expect(dest).toBe(`${PREFIX}${source}`)
      expect(source.startsWith('assets/')).toBe(true)
    }
    expect(writes.original).not.toHaveBeenCalled()
    expect(writes.meta).not.toHaveBeenCalled()
    expect(await canonicalTree()).toEqual(before)
  })

  it('a second run finds every key under the prefix and writes nothing', async () => {
    await run()
    vi.mocked(sharpLoader.loadSharp).mockClear()
    const put = vi.spyOn(store, 'putPublicObject')
    const copy = vi.spyOn(store, 'copyPublicObject')

    const report = await run()
    expect(report.summary).toMatchObject({ existed: 3, copied: 0, created: 0, contentFailures: 1 })
    expect(put).not.toHaveBeenCalled()
    expect(copy).not.toHaveBeenCalled()
    expect(sharpLoader.loadSharp).not.toHaveBeenCalled()
  })

  it('does not load sharp when every key is copied', async () => {
    const report = await run({ targets: [target(atProduction)], statics: [target(logo)] })
    expect(report.summary).toMatchObject({ copied: 2, failed: 0 })
    expect(sharpLoader.loadSharp).not.toHaveBeenCalled()
  })

  it("production's run never reads the prefix, so bytes planted there are never served", async () => {
    const key = `assets/t/w=640/${HASH}/photo.png`
    await store.putPublicObject({
      key: `${PREFIX}${key}`,
      data: new TextEncoder().encode('planted'),
      contentType: 'image/png',
    })
    const has = vi.spyOn(store, 'hasPublicObject')
    const read = vi.spyOn(store, 'readPublicObject')
    const copy = vi.spyOn(store, 'copyPublicObject')

    const report = await materializeAssets({ store, targets: [target(key)], sleep: noSleep })

    expect(report.results[0]).toMatchObject({ key, status: 'created' })
    expect(report).not.toHaveProperty('outputPrefix')
    expect((await sharp((await store.readPublicObject(key))?.data).metadata()).width).toBe(640)
    expect(has.mock.calls).toEqual([[key]])
    expect(read.mock.calls.filter(([k]) => k.startsWith(PREFIX))).toEqual([])
    expect(copy).not.toHaveBeenCalled()
  })

  it('counts a copy that finds the key taken as existed, but as copied after a failed attempt', async () => {
    const realCopy = store.copyPublicObject.bind(store)
    const copy = vi.spyOn(store, 'copyPublicObject').mockResolvedValueOnce('already-exists')
    const first = await run({ targets: [target(atProduction)], statics: [] })
    expect(first.results[0]).toMatchObject({ status: 'existed' })

    copy.mockReset()
    copy.mockImplementationOnce(async (source, dest) => {
      await realCopy(source, dest)
      throw awsError('ServiceUnavailable', 503)
    })
    copy.mockImplementation(realCopy)
    const second = await run({ targets: [target(atProduction)], statics: [] })
    expect(copy).toHaveBeenCalledTimes(2)
    expect(second.results[0]).toMatchObject({ status: 'copied' })
  })

  it('counts only the literal already-exists as existed', async () => {
    vi.spyOn(store, 'copyPublicObject').mockResolvedValue(undefined as unknown as CreateOnlyResult)
    const report = await run({ targets: [target(atProduction)], statics: [] })
    expect(report.results[0]).toMatchObject({ status: 'copied' })
  })

  it('transforms a key whose source vanished before the copy, and fails such a static', async () => {
    vi.spyOn(store, 'copyPublicObject').mockResolvedValue('source-missing')
    const report = await run({ targets: [target(atProduction)], statics: [target(logo)] })
    expect(report.results.map(({ key, status }) => [key, status])).toEqual([
      [logo, 'failed'],
      [atProduction, 'created'],
    ])
    expect(report.results[0]).toMatchObject({ failure: 'content' })
    const stored = await store.readPublicObject(`${PREFIX}${atProduction}`)
    expect((await sharp(stored?.data).metadata()).width).toBe(320)
  })

  it('retries a transient copy failure, and reports one that persists as a store failure', async () => {
    const realCopy = store.copyPublicObject.bind(store)
    const copy = vi
      .spyOn(store, 'copyPublicObject')
      .mockRejectedValueOnce(awsError('SlowDown', 503))
      .mockImplementation(realCopy)
    const retried = await run({ targets: [target(atProduction)], statics: [] })
    expect(retried.results[0]).toMatchObject({ status: 'copied' })
    expect(copy).toHaveBeenCalledTimes(2)

    copy.mockReset()
    copy.mockRejectedValue(awsError('AccessDenied', 403))
    const denied = await run({ targets: [], statics: [target(logo)] })
    expect(denied.results[0]).toMatchObject({ status: 'failed', failure: 'store' })
    expect(copy).toHaveBeenCalledTimes(1)
  })

  it('bounds copies by concurrency, not by transformConcurrency', async () => {
    const widths = [160, 320, 480, 640, 800, 960]
    const keys = widths.map((w) => `assets/t/w=${w}/${HASH}/photo.png`)
    for (const key of keys) {
      await store.putPublicObject({ key, data: new Uint8Array([1]), contentType: 'image/png' })
    }
    const realCopy = store.copyPublicObject.bind(store)
    let inFlight = 0
    let peak = 0
    vi.spyOn(store, 'copyPublicObject').mockImplementation(async (source, dest) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      try {
        return await realCopy(source, dest)
      } finally {
        inFlight--
      }
    })
    const report = await run({
      targets: keys.map((key) => target(key)),
      statics: [],
      concurrency: 4,
      transformConcurrency: 1,
    })
    expect(report.summary.copied).toBe(widths.length)
    expect(peak).toBe(4)
  })

  it.each([
    '/previews/7/',
    'previews/7',
    '',
    '/',
    'previews//7/',
    'previews/./',
    'previews/../',
    '../previews/',
    'previews/a b/',
    'previews/7?/',
    'assets/',
    'assets/t/x/',
    'assets/x/',
    'asset-meta/',
    'asset-originals/x/',
    'asset-staging/',
  ])('refuses the output prefix %j before touching the store', async (outputPrefix) => {
    const has = vi.spyOn(store, 'hasPublicObject')
    await expect(run({ outputPrefix })).rejects.toBeInstanceOf(InvalidOutputPrefixError)
    expect(has).not.toHaveBeenCalled()
  })

  it.each(['previews/7/', 'assets-x/', 'previews/pr-12.3_A/', 'x/assets/'])(
    'accepts the output prefix %j',
    (outputPrefix) => {
      expect(() => assertValidOutputPrefix(outputPrefix)).not.toThrow()
    },
  )
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

  it('without an output prefix: one listing per large group, one HEAD per other key, no copy', async () => {
    const grouped = keysAt('w=320', 3)
    const [present, absent] = keysAt('w=640', 2)
    s3.on(ListObjectsV2Command).resolves({
      Contents: grouped.slice(0, 2).map((Key) => ({ Key })),
      IsTruncated: false,
    })
    s3.on(HeadObjectCommand).rejects(awsError('NotFound', 404))
    s3.on(HeadObjectCommand, { Key: present }).resolves({})
    const store = new S3AssetStore({ bucket: 'b', region: 'us-east-1' })
    const getMeta = vi.spyOn(store, 'getMeta').mockResolvedValue(null)
    const copy = vi.spyOn(store, 'copyPublicObject')

    const report = await materializeAssets({
      store,
      targets: [...grouped, present, absent].map((key) => target(key)),
      listThreshold: 3,
      sleep: noSleep,
    })

    expect(s3.calls().map((call) => call.args[0].input)).toEqual([
      { Bucket: 'b', Prefix: 'assets/t/w=320/' },
      { Bucket: 'b', Key: present },
      { Bucket: 'b', Key: absent },
    ])
    expect(copy).not.toHaveBeenCalled()
    expect(getMeta.mock.calls.map(([hash]) => hash)).toEqual([
      grouped[2].split('/')[3],
      absent.split('/')[3],
    ])
    expect(report.summary).toMatchObject({ existed: 3, copied: 0, contentFailures: 2 })
  })

  it('with an output prefix: lists both prefixes once and copies what only production has', async () => {
    const keys = keysAt('w=320', 3)
    s3.on(ListObjectsV2Command, { Prefix: 'previews/7/assets/t/w=320/' }).resolves({
      Contents: [{ Key: `previews/7/${keys[0]}` }],
    })
    s3.on(ListObjectsV2Command, { Prefix: 'assets/t/w=320/' }).resolves({
      Contents: [{ Key: keys[0] }, { Key: keys[1] }],
    })
    s3.on(CopyObjectCommand).resolves({})
    const store = new S3AssetStore({ bucket: 'b', region: 'us-east-1' })
    vi.spyOn(store, 'getMeta').mockResolvedValue(null)

    const report = await materializeAssets({
      store,
      targets: keys.map((key) => target(key)),
      outputPrefix: 'previews/7/',
      listThreshold: 3,
      sleep: noSleep,
    })

    expect(report.results.map((r) => r.status)).toEqual(['existed', 'copied', 'failed'])
    expect(s3.commandCalls(ListObjectsV2Command)).toHaveLength(2)
    expect(s3.commandCalls(HeadObjectCommand)).toHaveLength(0)
    expect(s3.commandCalls(CopyObjectCommand).map((call) => call.args[0].input)).toEqual([
      expect.objectContaining({
        Key: `previews/7/${keys[1]}`,
        CopySource: `b/${keys[1].replace('=', '%3D')}`,
      }),
    ])
  })

  it('with an output prefix: skips the canonical listing when every key is already under the prefix', async () => {
    const keys = keysAt('w=320', 3)
    s3.on(ListObjectsV2Command).resolves({
      Contents: keys.map((key) => ({ Key: `previews/7/${key}` })),
    })
    const store = new S3AssetStore({ bucket: 'b', region: 'us-east-1' })

    const report = await materializeAssets({
      store,
      targets: keys.map((key) => target(key)),
      outputPrefix: 'previews/7/',
      listThreshold: 3,
      sleep: noSleep,
    })
    expect(report.summary.existed).toBe(3)
    expect(s3.commandCalls(ListObjectsV2Command).map((call) => call.args[0].input.Prefix)).toEqual([
      'previews/7/assets/t/w=320/',
    ])
  })

  it('with an output prefix: HEADs the destination, then the canonical key, when listing fails', async () => {
    const keys = keysAt('w=320', 2)
    s3.on(ListObjectsV2Command).rejects(awsError('AccessDenied', 403))
    s3.on(HeadObjectCommand).rejects(awsError('NotFound', 404))
    s3.on(HeadObjectCommand, { Key: keys[1] }).resolves({})
    s3.on(CopyObjectCommand).resolves({})
    const store = new S3AssetStore({ bucket: 'b', region: 'us-east-1' })
    vi.spyOn(store, 'getMeta').mockResolvedValue(null)

    const report = await materializeAssets({
      store,
      targets: keys.map((key) => target(key)),
      outputPrefix: 'previews/7/',
      listThreshold: 2,
      concurrency: 1,
      sleep: noSleep,
    })
    expect(report.results.map((r) => r.status)).toEqual(['failed', 'copied'])
    expect(s3.commandCalls(HeadObjectCommand).map((call) => call.args[0].input.Key)).toEqual([
      `previews/7/${keys[0]}`,
      keys[0],
      `previews/7/${keys[1]}`,
      keys[1],
    ])
  })

  it('with an output prefix: still reports a missing bucket as a store failure for a static key', async () => {
    s3.on(HeadObjectCommand).rejects(awsError('NotFound', 404))
    s3.on(GetObjectCommand).rejects(awsError('NoSuchBucket', 404))
    const store = new S3AssetStore({ bucket: 'typo', region: 'us-east-1' })

    const report = await materializeAssets({
      store,
      targets: [],
      statics: [target(`assets/${HASH}/logo.svg`)],
      outputPrefix: 'previews/7/',
      sleep: noSleep,
    })
    expect(report.summary).toMatchObject({ failed: 1, storeFailures: 1, contentFailures: 0 })
    expect(s3.commandCalls(GetObjectCommand)[0].args[0].input.Key).toBe(`assets/${HASH}/logo.svg`)
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
