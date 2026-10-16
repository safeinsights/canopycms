/**
 * Collector behavior on hand-written output. The proof that it finds what real pages emit is the
 * static export in apps/dual-build-fixture/dual-build.test.ts.
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

  it('ends a URL before prose punctuation and decodes escaped or percent-encoded URLs', async () => {
    await write(
      'index.html',
      `<p>See /assets/t/w=320/${HASH}/photo.png. Or /assets/${HASH2}/guide.pdf: it is long!</p>` +
        `<img src="/_next/image?url=%2Fassets%2Ft%2Fq%3D80%2Cw%3D640%2F${HASH}%2Fphoto.png&amp;w=640">`,
    )
    await write(
      'data.json',
      `{"src":"\\u002Fassets\\u002Ft\\u002Forig\\u002F${HASH}\\u002Fphoto.png"}`,
    )

    const { refs } = await collectAssetRefs(outDir)
    expect(refs.transforms.map((entry) => entry.key)).toEqual([
      `assets/t/orig/${HASH}/photo.png`,
      `assets/t/q=80,w=640/${HASH}/photo.png`,
      `assets/t/w=320/${HASH}/photo.png`,
    ])
    expect(refs.statics.map((entry) => entry.key)).toEqual([`assets/${HASH2}/guide.pdf`])
  })

  it('ends a percent-encoded URL where an encoded space or query begins', async () => {
    await write(
      'share.html',
      `<a href="mailto:?body=See%20https%3A%2F%2Fex.com%2Fassets%2Ft%2Forig%2F${HASH}%2Fphoto.png%20now">` +
        `<a href="/share?u=https%3A%2F%2Fex.com%2Fassets%2Ft%2Fw%3D320%2F${HASH}%2Fphoto.png%3Fv%3D1">`,
    )
    const { refs } = await collectAssetRefs(outDir)
    expect(refs.transforms.map((entry) => entry.key)).toEqual([
      `assets/t/orig/${HASH}/photo.png`,
      `assets/t/w=320/${HASH}/photo.png`,
    ])
  })

  it('still finds an encoded URL whose run holds a malformed escape, or an encoded directive', async () => {
    await write(
      'style.css',
      `.h{width:100%;background:url(/img?u=%2Fassets%2Ft%2Fw%3D320%2F${HASH}%2Fphoto.png&w=640)}`,
    )
    await write('loader.html', `<img src="/assets/t/q%3D80%2Cw%3D640/${HASH}/photo.png">`)
    const { refs } = await collectAssetRefs(outDir)
    expect(refs.transforms.map((entry) => entry.key)).toEqual([
      `assets/t/q=80,w=640/${HASH}/photo.png`,
      `assets/t/w=320/${HASH}/photo.png`,
    ])
  })

  it('ends a URL at typographic punctuation', async () => {
    await write(
      'quote.md',
      `\u201C/assets/t/w=320/${HASH}/photo.png\u201D and /assets/${HASH2}/guide.pdf\u2026`,
    )
    const { refs } = await collectAssetRefs(outDir)
    expect(refs.transforms.map((entry) => entry.key)).toEqual([`assets/t/w=320/${HASH}/photo.png`])
    expect(refs.statics.map((entry) => entry.key)).toEqual([`assets/${HASH2}/guide.pdf`])
  })

  it('scans extensionless text files and skips binary ones', async () => {
    await write('feed', `<item><enclosure url="/assets/t/w=320/${HASH}/photo.png"/></item>`)
    await write('blob', `\0binary /assets/t/w=333/${HASH}/photo.png`)
    const { refs, scannedFiles } = await collectAssetRefs(outDir)
    expect(refs.transforms).toEqual([
      { key: `assets/t/w=320/${HASH}/photo.png`, routes: [], files: ['feed'] },
    ])
    expect(scannedFiles).toBe(1)
  })

  it('stays linear on a long run with no stop character', async () => {
    // A long run with no encoded `/assets/` in it is where a backtracking scan goes quadratic.
    await write('big.js', `${'a%2F'.repeat(250_000)} %2Fassets%2Ft%2Fw%3D320%2F${HASH}%2Fphoto.png`)
    const started = Date.now()
    const { refs } = await collectAssetRefs(outDir)
    expect(refs.transforms.map((entry) => entry.key)).toEqual([`assets/t/w=320/${HASH}/photo.png`])
    expect(Date.now() - started).toBeLessThan(5000)
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
    ['a width past 8192', `/assets/t/w=8193/${HASH}/photo.png`],
    ['an off-allowlist quality', `/assets/t/q=72/${HASH}/photo.png`],
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

  it('records a width off the lazy-path allowlist: any integer in [1, 8192]', async () => {
    await write(
      'index.html',
      `<img src="/assets/t/w=100/${HASH}/photo.png" srcset="/assets/t/w=8192/${HASH}/photo.png 8192w">`,
    )
    const { refs } = await collectAssetRefs(outDir)
    expect(refs.transforms.map((entry) => entry.key)).toEqual([
      `assets/t/w=100/${HASH}/photo.png`,
      `assets/t/w=8192/${HASH}/photo.png`,
    ])
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

/** A script exactly as Next's `writeFlightDataInstruction` writes it: a string is `[1]`, bytes `[3]`. */
function pushScript(chunk: string | Buffer | unknown[]): string {
  const segment =
    typeof chunk === 'string'
      ? [1, chunk]
      : Buffer.isBuffer(chunk)
        ? [3, chunk.toString('base64')]
        : chunk
  const escaped = JSON.stringify(segment).replace(
    /[&<>\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
  return `<script>self.__next_f.push(${escaped})</script>`
}

const BOOTSTRAP = '<script>(self.__next_f=self.__next_f||[]).push([0])</script>'

function flightPage(chunks: (string | Buffer)[], markup = '<main></main>'): string {
  return `<!DOCTYPE html><html><body>${markup}${BOOTSTRAP}${chunks.map(pushScript).join('')}</body></html>`
}

/** `text` cut at each offset, in order. */
function splitAt(text: string, ...offsets: number[]): string[] {
  return [0, ...offsets].map((from, i) => text.slice(from, offsets[i]))
}

async function collectKeys(): Promise<string[]> {
  const { refs } = await collectAssetRefs(outDir)
  return [...refs.transforms, ...refs.statics].map((entry) => entry.key)
}

describe('collectAssetRefs on a page with an inline RSC payload', () => {
  const ADOPTER_URL = `/assets/t/f=webp,w=2970/${HASH}/contact-platform.webp`
  const ROW = `:HL["${ADOPTER_URL}","image",{"imageSrcSet":"${ADOPTER_URL} 2970w"}]\n`

  it('joins a URL that Next split across two scripts mid-filename', async () => {
    const cut = ROW.indexOf('platfo') + 'platfo'.length
    await write(
      'solutions/index.html',
      flightPage(splitAt(ROW, cut), `<img srcset="${ADOPTER_URL} 2970w">`),
    )
    const { refs } = await collectAssetRefs(outDir)
    expect(refs.transforms).toEqual([
      {
        key: ADOPTER_URL.slice(1),
        routes: ['/solutions'],
        files: ['solutions/index.html'],
      },
    ])
  })

  it('records the whole key when the split falls inside an extension', async () => {
    // Each truncation alone passes validation (`logo.sv`, `photo.p`), so it would be recorded.
    const svg = `"/assets/${HASH2}/logo.svg"`
    const png = `"/assets/t/w=320/${HASH}/photo.png"`
    await write(
      'index.html',
      flightPage([...splitAt(svg, svg.indexOf('.sv') + 3), ...splitAt(png, png.indexOf('.p') + 2)]),
    )
    expect(await collectKeys()).toEqual([
      `assets/t/w=320/${HASH}/photo.png`,
      `assets/${HASH2}/logo.svg`,
    ])
  })

  const CROP_URL = `/assets/t/c=0.1235:0.1000:0.5000:0.3333,w=640/${HASH}/photo.jpg`
  it.each([
    ['before /assets/', CROP_URL.indexOf('/assets/')],
    ['inside /assets/', CROP_URL.indexOf('ets/')],
    ['between /assets/ and t/', CROP_URL.indexOf('t/')],
    ['at the directive segment', CROP_URL.indexOf('c=')],
    ['inside a crop number', CROP_URL.indexOf('235:')],
    ['before the width', CROP_URL.indexOf('w=640')],
    ['at the hash', CROP_URL.indexOf(HASH)],
    ['inside the hash', CROP_URL.indexOf(HASH) + 16],
    ['before the filename', CROP_URL.lastIndexOf('/') + 1],
  ])('joins a split %s', async (_label, offset) => {
    const row = `{"src":"https://cdn.example.com${CROP_URL}"}`
    const cut = 'https://cdn.example.com'.length + offset + '{"src":"'.length
    await write('index.html', flightPage(splitAt(row, cut)))
    expect(await collectKeys()).toEqual([CROP_URL.slice(1)])
  })

  it('joins a URL cut into one-character chunks, next to URLs cut elsewhere', async () => {
    const one = `/assets/t/orig/${HASH}/photo.png`
    const two = `/assets/${HASH2}/guide.pdf`
    const stream = `0:{"a":"${one}","b":"${two}","c":"${CROP_URL}"}\n`
    const cuts = [...Array(one.length + 1).keys()].map((i) => stream.indexOf(one) + i)
    cuts.push(
      stream.indexOf(two) + 20,
      stream.indexOf(CROP_URL) + 30,
      stream.indexOf(CROP_URL) + 60,
    )
    await write('index.html', flightPage(splitAt(stream, ...cuts)))
    expect(await collectKeys()).toEqual([
      CROP_URL.slice(1),
      `assets/t/orig/${HASH}/photo.png`,
      `assets/${HASH2}/guide.pdf`,
    ])
  })

  it('joins a URL that straddles a text chunk and a binary chunk', async () => {
    const stream = `0:{"src":"/assets/t/w=320/${HASH}/photo.png"}\n`
    const cut = stream.indexOf('pho')
    await write(
      'index.html',
      flightPage([
        stream.slice(0, cut),
        Buffer.from(stream.slice(cut, cut + 4)),
        stream.slice(cut + 4),
      ]),
    )
    expect(await collectKeys()).toEqual([`assets/t/w=320/${HASH}/photo.png`])
  })

  it('reads a payload holding </script> and markup after the flight scripts', async () => {
    const payload = `0:"</script><img src=\\"/assets/t/w=320/${HASH}/photo.png\\">"\n1:"/assets/${HASH2}/gui`
    await write(
      'index.html',
      flightPage(
        [payload, 'de.pdf"\n'],
        `<a href="/assets/t/w=640/${HASH}/photo.png">x</a>`,
      ).replace('</body>', `<img src="/assets/t/orig/${HASH}/photo.png"></body>`),
    )
    expect(await collectKeys()).toEqual([
      `assets/t/orig/${HASH}/photo.png`,
      `assets/t/w=320/${HASH}/photo.png`,
      `assets/t/w=640/${HASH}/photo.png`,
      `assets/${HASH2}/guide.pdf`,
    ])
  })

  it('reads form state and a script with a nonce', async () => {
    const formState = pushScript([2, [{ image: `/assets/${HASH2}/guide.pdf` }, 'k']])
    const html = flightPage([`0:"/assets/t/w=320/${HASH}/pho`, 'to.png"\n'])
      .replace(BOOTSTRAP, BOOTSTRAP.replace('</script>', `;${formState.slice(8, -9)}</script>`))
      .replaceAll('<script>', '<script nonce="abc123">')
    await write('index.html', html)
    expect(await collectKeys()).toEqual([
      `assets/t/w=320/${HASH}/photo.png`,
      `assets/${HASH2}/guide.pdf`,
    ])
  })

  it('scans a page with no flight scripts as before, other inline scripts included', async () => {
    await write(
      'index.html',
      `<script type="application/ld+json">{"image":"\\/assets\\/t\\/w=320\\/${HASH}\\/photo.png"}</script>` +
        `<script>window.x="/assets/${HASH2}/guide.pdf"</script><img src="/assets/t/orig/${HASH}/photo.png">`,
    )
    expect(await collectKeys()).toEqual([
      `assets/t/orig/${HASH}/photo.png`,
      `assets/t/w=320/${HASH}/photo.png`,
      `assets/${HASH2}/guide.pdf`,
    ])
  })

  it.each([
    ['an unterminated push', '<script>self.__next_f.push([1,"0:\\"/assets/t/w=320/</script>'],
    ['code after the push', '<script>self.__next_f.push([1,"x"]);fetch("/a")</script>'],
    ['an unknown segment kind', '<script>self.__next_f.push([4,"x"])</script>'],
    ['a non-string text chunk', '<script>self.__next_f.push([1,5])</script>'],
    ['a binary chunk that is not base64', '<script>self.__next_f.push([3,"a-b_"])</script>'],
    ['spacing Next never writes', '<script>self.__next_f.push( [1,"x"] )</script>'],
    ['another receiver', '<script>self.__next_f.push.call(null,[1,"x"])</script>'],
  ])('fails closed on %s, naming the file and script, and writes nothing', async (_label, bad) => {
    await write('ok.html', flightPage([`"/assets/t/w=320/${HASH}/photo.png"`]))
    const page = flightPage(['"a"'])
    const offset = page.indexOf('</body>')
    await write('bad/page.html', page.replace('</body>', `${bad}</body>`))

    const error = await collectAssetRefs(outDir).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(AssetRefsError)
    const problems = (error as AssetRefsError).problems
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({
      file: 'bad/page.html',
      url: `<script> at offset ${offset}`,
      error: expect.stringContaining('its RSC payload cannot be scanned'),
    })
    await expect(fs.stat(path.join(outDir, ASSET_REFS_FILENAME))).rejects.toThrow()
  })

  it('collects the same refs from a real static export however its stream is chunked', async () => {
    // apps/dual-build-fixture's /images page from Next 15.5.21's static export; `orig/…/banner.png`
    // appears only in its flight payload.
    const fixture = await fs.readFile(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '__fixtures__/next-15-static-export.html',
      ),
      'utf-8',
    )
    const pushes = [...fixture.matchAll(/<script>self\.__next_f\.push\((.*?)\)<\/script>/g)]
    expect(pushes.length).toBeGreaterThan(1)
    const stream = pushes.map((push) => (JSON.parse(push[1]) as [1, string])[1]).join('')
    const last = pushes[pushes.length - 1]
    const before = fixture.slice(0, pushes[0].index)
    const after = fixture.slice(last.index + last[0].length)
    const page = (chunks: (string | Buffer)[]) => before + chunks.map(pushScript).join('') + after

    await write('images.html', fixture)
    const baseline = (await collectAssetRefs(outDir)).refs
    expect(baseline.transforms.map((entry) => entry.key)).toContain(
      'assets/t/orig/fedcba9876543210fedcba9876543210/banner.png',
    )

    const urls = [...stream.matchAll(/\/assets\/[^"\s]+/g)]
    expect(urls.length).toBeGreaterThan(5)
    let variants = 0
    for (const url of urls) {
      for (let cut = url.index; cut <= url.index + url[0].length; cut++) {
        const [head, tail] = splitAt(stream, cut)
        for (const chunks of [
          [head, tail],
          [head, Buffer.from(tail.slice(0, 3)), tail.slice(3)],
        ]) {
          await write('images.html', page(chunks))
          expect((await collectAssetRefs(outDir)).refs, `cut at ${cut}`).toEqual(baseline)
          variants++
        }
      }
    }
    expect(variants).toBe(1126)
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
