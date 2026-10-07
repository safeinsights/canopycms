import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as sharpLoader from '../assets/sharp-loader'
import { LocalAssetStore } from '../assets/store-local'
import type { S3AssetStoreOptions } from '../assets/store-s3'
import type { AssetRefsFile } from '../build/asset-refs'
import { mockConsole } from '../test-utils'
import { collectAssetRefsCLI, MATERIALIZE_EXIT_CODES, materializeAssetsCLI } from './asset-refs'
import { loadConfiguredAssetStore } from './configured-asset-store'

const { s3Constructed } = vi.hoisted(() => ({ s3Constructed: [] as unknown[] }))

vi.mock('../assets/sharp-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../assets/sharp-loader')>()
  return { ...actual, loadSharp: vi.fn(actual.loadSharp) }
})

vi.mock('./configured-asset-store', () => ({ loadConfiguredAssetStore: vi.fn() }))

// Records what the CLI hands the S3 store; the real class still runs, and S3Client makes no call
// until a request is sent.
vi.mock('../assets/store-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../assets/store-s3')>()
  class RecordingS3AssetStore extends actual.S3AssetStore {
    constructor(options: S3AssetStoreOptions) {
      super(options)
      s3Constructed.push(options)
    }
  }
  return { ...actual, S3AssetStore: RecordingS3AssetStore }
})

const HASH = 'a'.repeat(32)
const GONE = 'b'.repeat(32)

let tmpDir: string
let store: LocalAssetStore
let out: ReturnType<typeof mockConsole> | undefined

beforeEach(async () => {
  s3Constructed.length = 0
  vi.mocked(loadConfiguredAssetStore).mockReset()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-asset-refs-cli-test-'))
  store = new LocalAssetStore({ root: path.join(tmpDir, 'store') })
  const png = await sharp({
    create: { width: 400, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .png()
    .toBuffer()
  await store.putOriginal({ hash32: HASH, ext: 'png', data: png, contentType: 'image/png' })
  await store.putMetaIfAbsent(HASH, {
    hash32: HASH,
    filename: 'photo.png',
    slug: 'photo',
    ext: 'png',
    mime: 'image/png',
    size: png.byteLength,
    kind: 'raster',
    uploadedAt: '2026-01-01T00:00:00.000Z',
  })
})

afterEach(async () => {
  out?.restore()
  out = undefined
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function writeRefs(keys: string[]): Promise<string> {
  const refs: AssetRefsFile = {
    version: 1,
    transforms: keys.map((key) => ({ key, routes: ['/news'], files: ['news.html'] })),
    statics: [],
  }
  const refsPath = path.join(tmpDir, 'canopy-asset-refs.json')
  await fs.writeFile(refsPath, JSON.stringify(refs))
  return refsPath
}

describe('materializeAssetsCLI', () => {
  const ok = `assets/t/w=160/${HASH}/photo.png`
  const gone = `assets/t/w=160/${GONE}/gone.png`

  it('exits 0 when every key exists or was created, and writes the JSON report', async () => {
    out = mockConsole()
    const refsPath = await writeRefs([ok])
    const reportPath = path.join(tmpDir, 'report.json')
    const code = await materializeAssetsCLI({
      projectDir: tmpDir,
      refsPath,
      reportPath,
      allowFailures: false,
      store,
    })
    expect(code).toBe(MATERIALIZE_EXIT_CODES.ok)
    const report = JSON.parse(await fs.readFile(reportPath, 'utf-8'))
    expect(report.schemaVersion).toBe(1)
    expect(report.summary).toMatchObject({ total: 1, created: 1, copied: 0, failed: 0 })
    expect(out?.all().log.join('\n')).toContain('1 created')
  })

  it('exits 2 on a content failure, naming the page', async () => {
    out = mockConsole()
    const code = await materializeAssetsCLI({
      projectDir: tmpDir,
      refsPath: await writeRefs([ok, gone]),
      allowFailures: false,
      store,
    })
    expect(code).toBe(MATERIALIZE_EXIT_CODES.contentFailures)
    expect(out?.all().error).toEqual(
      expect.arrayContaining([`  FAILED (content) /${gone}`, '    pages: /news']),
    )
  })

  it('exits 0 with --allow-failures on a content failure, warning loudly', async () => {
    out = mockConsole()
    const code = await materializeAssetsCLI({
      projectDir: tmpDir,
      refsPath: await writeRefs([ok, gone]),
      allowFailures: true,
      store,
    })
    expect(code).toBe(MATERIALIZE_EXIT_CODES.ok)
    expect(out?.all().warn.join('\n')).toContain('will be MISSING')
  })

  it('exits 3 on a store failure even with --allow-failures', async () => {
    out = mockConsole()
    vi.spyOn(store, 'hasPublicObject').mockRejectedValue(
      Object.assign(new Error('AccessDenied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    )
    const code = await materializeAssetsCLI({
      projectDir: tmpDir,
      refsPath: await writeRefs([ok]),
      allowFailures: true,
      store,
    })
    expect(code).toBe(MATERIALIZE_EXIT_CODES.storeFailures)
    expect(out?.all().error).toContain(
      '--allow-failures does not cover store failures; fix access or rerun.',
    )
  })

  it('exits 3 on a store failure without --allow-failures too', async () => {
    out = mockConsole()
    vi.spyOn(store, 'hasPublicObject').mockRejectedValue(
      Object.assign(new Error('AccessDenied'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    )
    const code = await materializeAssetsCLI({
      projectDir: tmpDir,
      refsPath: await writeRefs([ok, gone]),
      allowFailures: false,
      store,
    })
    expect(code).toBe(MATERIALIZE_EXIT_CODES.storeFailures)
  })

  it('exits 1 when sharp cannot load and a key is missing', async () => {
    out = mockConsole()
    vi.mocked(sharpLoader.loadSharp).mockRejectedValueOnce(new Error('no libvips'))
    const code = await materializeAssetsCLI({
      projectDir: tmpDir,
      refsPath: await writeRefs([ok]),
      allowFailures: true,
      store,
    })
    expect(code).toBe(MATERIALIZE_EXIT_CODES.error)
    expect(out?.all().error.join('\n')).toContain('sharp failed to load')
  })

  it('exits 1 when the refs file is missing or invalid', async () => {
    out = mockConsole()
    const missing = await materializeAssetsCLI({
      projectDir: tmpDir,
      refsPath: path.join(tmpDir, 'nope.json'),
      allowFailures: false,
      store,
    })
    expect(missing).toBe(MATERIALIZE_EXIT_CODES.error)

    const invalid = path.join(tmpDir, 'invalid.json')
    await fs.writeFile(invalid, JSON.stringify({ version: 2 }))
    const code = await materializeAssetsCLI({
      projectDir: tmpDir,
      refsPath: invalid,
      allowFailures: true,
      store,
    })
    expect(code).toBe(MATERIALIZE_EXIT_CODES.error)
    expect(out?.all().error.join('\n')).toContain('canopycms materialize-assets:')
  })

  it.each([undefined, '0', 'x'])('refuses a bad invocation (concurrency %s)', async (value) => {
    out = mockConsole()
    const code = await materializeAssetsCLI({
      projectDir: tmpDir,
      refsPath: value === undefined ? undefined : await writeRefs([ok]),
      concurrency: value,
      allowFailures: false,
      store,
    })
    expect(code).toBe(1)
  })

  it.each(['0', 'x'])('refuses a bad --transform-concurrency (%s)', async (value) => {
    out = mockConsole()
    const code = await materializeAssetsCLI({
      projectDir: tmpDir,
      refsPath: await writeRefs([ok]),
      transformConcurrency: value,
      allowFailures: false,
      store,
    })
    expect(code).toBe(1)
    expect(out?.all().error).toContain(
      `--transform-concurrency must be a positive integer, got "${value}"`,
    )
  })
})

describe('materializeAssetsCLI store selection', () => {
  const ok = `assets/t/w=160/${HASH}/photo.png`

  const run = async (options: Partial<Parameters<typeof materializeAssetsCLI>[0]>) =>
    materializeAssetsCLI({
      projectDir: tmpDir,
      allowFailures: false,
      ...options,
      refsPath: options.refsPath ?? (await writeRefs([])),
    })

  it('builds the S3 store from --bucket and --region and never loads the config', async () => {
    out = mockConsole()
    const code = await run({ projectDir: undefined, bucket: 'release-bucket', region: 'us-east-2' })
    expect(code).toBe(MATERIALIZE_EXIT_CODES.ok)
    expect(s3Constructed).toEqual([{ bucket: 'release-bucket', region: 'us-east-2' }])
    expect(loadConfiguredAssetStore).not.toHaveBeenCalled()
  })

  it.each([
    { bucket: 'b', region: undefined },
    { bucket: undefined, region: 'us-east-2' },
    { bucket: '', region: 'us-east-2' },
    { bucket: 'b', region: '' },
  ])(
    'exits 1 when --bucket and --region are not both given, with a value ($bucket, $region)',
    async (flags) => {
      out = mockConsole()
      expect(await run(flags)).toBe(MATERIALIZE_EXIT_CODES.error)
      expect(s3Constructed).toEqual([])
      expect(loadConfiguredAssetStore).not.toHaveBeenCalled()
    },
  )

  it('exits 1 for --allow-local with --bucket', async () => {
    out = mockConsole()
    const code = await run({ bucket: 'b', region: 'r', allowLocal: true })
    expect(code).toBe(MATERIALIZE_EXIT_CODES.error)
    expect(s3Constructed).toEqual([])
  })

  it('refuses a local store resolved from the config, naming the likely causes', async () => {
    out = mockConsole()
    vi.mocked(loadConfiguredAssetStore).mockResolvedValue(store)
    const code = await run({ refsPath: await writeRefs([ok]) })
    expect(code).toBe(MATERIALIZE_EXIT_CODES.error)
    expect(out?.all().error.join('\n')).toMatch(/local asset store.*`media` is unset.*mode: 'dev'/s)
    expect(await store.hasPublicObject(ok)).toBe(false)
  })

  it('runs against a local store from the config under --allow-local', async () => {
    out = mockConsole()
    vi.mocked(loadConfiguredAssetStore).mockResolvedValue(store)
    const code = await run({ refsPath: await writeRefs([ok]), allowLocal: true })
    expect(code).toBe(MATERIALIZE_EXIT_CODES.ok)
    expect(await store.hasPublicObject(ok)).toBe(true)
  })

  it('exits 1 when the config fails to load', async () => {
    out = mockConsole()
    vi.mocked(loadConfiguredAssetStore).mockRejectedValue(new Error('Invalid CanopyCMS config'))
    expect(await run({})).toBe(MATERIALIZE_EXIT_CODES.error)
    expect(out?.all().error.join('\n')).toContain('Invalid CanopyCMS config')
  })
})

describe('collectAssetRefsCLI', () => {
  it('exits 1 on a non-canonical URL and 0 once it is canonical', async () => {
    out = mockConsole()
    const outDir = path.join(tmpDir, 'out')
    await fs.mkdir(outDir)
    await fs.writeFile(path.join(outDir, 'index.html'), `/assets/t/w=160,q=80/${HASH}/photo.png`)
    expect(await collectAssetRefsCLI({ outDir })).toBe(1)
    expect(out?.all().error.join('\n')).toContain('index.html: /assets/t/w=160,q=80/')

    await fs.writeFile(path.join(outDir, 'index.html'), `/assets/t/q=80,w=160/${HASH}/photo.png`)
    expect(await collectAssetRefsCLI({ outDir })).toBe(0)
  })

  it('exits 1 when the output directory is missing or not given', async () => {
    out = mockConsole()
    expect(await collectAssetRefsCLI({ outDir: path.join(tmpDir, 'nope') })).toBe(1)
    expect(await collectAssetRefsCLI({ outDir: undefined })).toBe(1)
  })
})
