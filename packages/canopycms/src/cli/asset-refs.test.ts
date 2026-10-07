import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LocalAssetStore } from '../assets/store-local'
import type { AssetRefsFile } from '../build/asset-refs'
import { mockConsole } from '../test-utils'
import { collectAssetRefsCLI, materializeAssetsCLI } from './asset-refs'

const HASH = 'a'.repeat(32)
const GONE = 'b'.repeat(32)

let tmpDir: string
let store: LocalAssetStore
let out: ReturnType<typeof mockConsole> | undefined

beforeEach(async () => {
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
    expect(code).toBe(0)
    const report = JSON.parse(await fs.readFile(reportPath, 'utf-8'))
    expect(report.summary).toMatchObject({ total: 1, created: 1, failed: 0 })
    expect(out?.all().log.join('\n')).toContain('1 created')
  })

  it('exits 1 on a content failure, naming the page', async () => {
    out = mockConsole()
    const code = await materializeAssetsCLI({
      projectDir: tmpDir,
      refsPath: await writeRefs([ok, gone]),
      allowFailures: false,
      store,
    })
    expect(code).toBe(1)
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
    expect(code).toBe(0)
    expect(out?.all().warn.join('\n')).toContain('will be MISSING')
  })

  it('exits 1 on a store failure even with --allow-failures', async () => {
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
    expect(code).toBe(1)
    expect(out?.all().error).toContain(
      '--allow-failures does not cover store failures; fix access or rerun.',
    )
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
