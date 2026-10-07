/**
 * Collector behavior on hand-written output. The proof that it finds what real pages emit is the
 * static export in apps/dual-build-fixture/dual-build.test.ts.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ASSET_REFS_FILENAME,
  AssetRefsError,
  collectAssetRefs,
  readAssetRefsFile,
} from './asset-refs'

const HASH = '0123456789abcdef0123456789abcdef'
const HASH2 = 'fedcba9876543210fedcba9876543210'

let outDir: string

beforeEach(async () => {
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-asset-refs-test-'))
})

afterEach(async () => {
  await fs.rm(outDir, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(outDir, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

describe('collectAssetRefs', () => {
  it('strips whatever precedes /assets/ and records each key once with its files and routes', async () => {
    await write(
      'index.html',
      `<img src="https://cdn.example.com/assets/t/w=320/${HASH}/photo.png">` +
        `<img srcset="/base/assets/t/c=0.1000:0.2000:0.5000:0.5000,w=320/${HASH}/photo.png 320w, ` +
        `/base/assets/t/c=0.1000:0.2000:0.5000:0.5000,w=640/${HASH}/photo.png 640w">`,
    )
    await write(
      'docs/intro/index.html',
      `<div style="background:url(/assets/t/w=320/${HASH}/photo.png)"></div>`,
    )
    await write('about.html', `<a href="//cdn.example.com/assets/${HASH2}/guide.pdf">x</a>`)
    await write(
      'about.txt',
      `0:["$","img",null,{"src":"\\/assets\\/t\\/orig\\/${HASH}\\/photo.png"}]`,
    )
    await write(
      '_next/static/chunks/page.js',
      `self.__next_f.push([1,"{\\"src\\":\\"/assets/t/f=webp,w=960/${HASH}/photo.webp\\"}"])`,
    )

    const { refs, filePath } = await collectAssetRefs(outDir)

    expect(filePath).toBe(path.join(outDir, ASSET_REFS_FILENAME))
    expect(refs).toEqual({
      version: 1,
      transforms: [
        {
          key: `assets/t/c=0.1000:0.2000:0.5000:0.5000,w=320/${HASH}/photo.png`,
          routes: ['/'],
          files: ['index.html'],
        },
        {
          key: `assets/t/c=0.1000:0.2000:0.5000:0.5000,w=640/${HASH}/photo.png`,
          routes: ['/'],
          files: ['index.html'],
        },
        {
          key: `assets/t/f=webp,w=960/${HASH}/photo.webp`,
          routes: [],
          files: ['_next/static/chunks/page.js'],
        },
        { key: `assets/t/orig/${HASH}/photo.png`, routes: [], files: ['about.txt'] },
        {
          key: `assets/t/w=320/${HASH}/photo.png`,
          routes: ['/', '/docs/intro'],
          files: ['docs/intro/index.html', 'index.html'],
        },
      ],
      statics: [{ key: `assets/${HASH2}/guide.pdf`, routes: ['/about'], files: ['about.html'] }],
    })
  })

  it('fails on a non-canonical transform URL, naming the file, and writes nothing', async () => {
    await write('ok.html', `<img src="/assets/t/w=320/${HASH}/photo.png">`)
    await write('bad/page.html', `<img src="/assets/t/w=320,f=webp/${HASH}/photo.webp">`)

    const error = await collectAssetRefs(outDir).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(AssetRefsError)
    expect((error as AssetRefsError).problems).toEqual([
      {
        file: 'bad/page.html',
        url: `/assets/t/w=320,f=webp/${HASH}/photo.webp`,
        error: `Not canonical; assetUrl would write /assets/t/f=webp,w=320/${HASH}/photo.webp`,
      },
    ])
    await expect(fs.stat(path.join(outDir, ASSET_REFS_FILENAME))).rejects.toThrow()
  })

  it.each([
    ['an off-allowlist width', `/assets/t/w=333/${HASH}/photo.png`],
    ['an over-precise crop', `/assets/t/c=0.12345:0:0.5:0.5/${HASH}/photo.png`],
    ['an upper-case hash', `/assets/t/w=320/${HASH.toUpperCase()}/photo.png`],
    ['an upper-case slug', `/assets/t/w=320/${HASH}/Photo.png`],
    ['a malformed static path', `/assets/${HASH}/Guide.PDF`],
  ])('fails on %s', async (_label, url) => {
    await write('index.html', `<img src="${url}">`)
    const error = await collectAssetRefs(outDir).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(AssetRefsError)
    expect((error as AssetRefsError).problems.map((p) => p.url)).toEqual([url])
  })

  it('ignores URL templates in scripts and text that only mentions the path shape', async () => {
    await write(
      'app.js',
      'const u=`/assets/t/${d}/${h}/${s}.${e}`;const v="/assets/t/"+d+"/"+h;' +
        `const w=\`/assets/t/\${d}/${HASH}/photo.png\`;` +
        '// /assets/t/{directives}/{hash32}/{slug}.{ext}',
    )
    const { refs } = await collectAssetRefs(outDir)
    expect(refs).toEqual({ version: 1, transforms: [], statics: [] })
  })

  it('skips files that are not text output', async () => {
    await write('image.png', `/assets/t/w=333/${HASH}/photo.png`)
    const { refs, scannedFiles } = await collectAssetRefs(outDir)
    expect(refs.transforms).toEqual([])
    expect(scannedFiles).toBe(0)
  })

  it('writes byte-identical output on a rerun, never reading its own refs file', async () => {
    await write('b.html', `<img src="/assets/t/w=640/${HASH}/photo.png">`)
    await write('a.html', `<img src="/assets/t/w=320/${HASH}/photo.png">`)
    const { filePath, scannedFiles } = await collectAssetRefs(outDir)
    const first = await fs.readFile(filePath, 'utf-8')

    const rerun = await collectAssetRefs(outDir)
    expect(await fs.readFile(filePath, 'utf-8')).toBe(first)
    expect(rerun.scannedFiles).toBe(scannedFiles)
    expect(first.endsWith('}\n')).toBe(true)
  })
})

describe('readAssetRefsFile', () => {
  it('round-trips what collectAssetRefs wrote', async () => {
    await write('index.html', `<img src="/assets/t/w=320/${HASH}/photo.png">`)
    const { refs, filePath } = await collectAssetRefs(outDir)
    expect(await readAssetRefsFile(filePath)).toEqual(refs)
  })

  it('rejects a file of another shape', async () => {
    const filePath = path.join(outDir, 'refs.json')
    await fs.writeFile(filePath, JSON.stringify({ version: 2, transforms: [], statics: [] }))
    await expect(readAssetRefsFile(filePath)).rejects.toThrow('not a valid asset refs file')
  })
})
