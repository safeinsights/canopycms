import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

import { editorImageSrc } from '../editor/media/editor-image-src'
import { assetSrc } from './asset-src'
import { EDITOR_THUMBNAIL_WIDTHS } from './editor-thumbnail-widths'
import { finalizeAsset, finalizeStagedUpload } from './finalize'
import { ASSET_PREFIXES } from './keys'
import { resetCanopyLogger, setCanopyLogger } from '../utils/logger'
import { LocalAssetStore } from './store-local'
import * as transformModule from './transform'
import { canonicalizeTransformPath } from './transform-directives'
import type { AssetMeta, AssetStore } from './types'

// Partial mock: the real applyTransform, wrapped so one test can make a width's transform reject.
vi.mock('./transform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transform')>()
  return { ...actual, applyTransform: vi.fn(actual.applyTransform) }
})

/**
 * A real, sharp-decodable 3x5 PNG - finalize's pipeline now forces a real
 * pixel decode for raster kinds (pipeline.ts's `rasterIsDecodable`), so the
 * old hand-built, header-only (IHDR but no real IDAT) fixture this replaced
 * would be correctly rejected here. Memoized: every call site in this file
 * wants the same trivial fixture.
 */
let cachedPngBytes: Uint8Array | undefined
async function pngBytes(): Promise<Uint8Array> {
  if (!cachedPngBytes) {
    const buf = await sharp({
      create: { width: 3, height: 5, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer()
    cachedPngBytes = new Uint8Array(buf)
  }
  return cachedPngBytes
}

function makeStore(overrides: Partial<AssetStore> = {}): AssetStore {
  return {
    capabilities: { directUpload: false },
    beginUpload: vi.fn(),
    writeStaging: vi.fn(),
    readStaging: vi.fn().mockResolvedValue(null),
    deleteStaging: vi.fn().mockResolvedValue(undefined),
    putOriginal: vi.fn().mockResolvedValue('created'),
    readOriginal: vi.fn(),
    putPublicObject: vi.fn().mockResolvedValue('created'),
    copyPublicObject: vi.fn().mockResolvedValue('created'),
    readPublicObject: vi.fn(),
    hasPublicObject: vi.fn().mockResolvedValue(false),
    putMetaIfAbsent: vi.fn().mockResolvedValue('created'),
    getMeta: vi.fn().mockResolvedValue(null),
    listMeta: vi.fn(),
    hideAsset: vi.fn().mockResolvedValue('created'),
    unhideAsset: vi.fn().mockResolvedValue(false),
    ...overrides,
  }
}

describe('finalizeAsset', () => {
  it('dedups: an existing meta whose thumbnails are stored skips all writes', async () => {
    const existing: AssetMeta = {
      hash32: 'e'.repeat(32),
      filename: 'first.png',
      slug: 'first',
      ext: 'png',
      mime: 'image/png',
      size: 5,
      kind: 'raster',
      uploadedAt: '2026-01-01T00:00:00.000Z',
    }
    const store = makeStore({
      getMeta: vi.fn().mockResolvedValue(existing),
      hasPublicObject: vi.fn().mockResolvedValue(true),
    })

    const result = await finalizeAsset(store, { data: await pngBytes(), filename: 'second.png' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta).toBe(existing) // first-name-wins: existing meta returned verbatim
    expect(store.putOriginal).not.toHaveBeenCalled()
    expect(store.putPublicObject).not.toHaveBeenCalled()
    expect(store.putMetaIfAbsent).not.toHaveBeenCalled()
  })

  it('still returns the existing file when putting it back in the library fails', async () => {
    const existing: AssetMeta = {
      hash32: 'd'.repeat(32),
      filename: 'first.png',
      slug: 'first',
      ext: 'png',
      mime: 'image/png',
      size: 5,
      kind: 'raster',
      uploadedAt: '2026-01-01T00:00:00.000Z',
    }
    const store = makeStore({
      getMeta: vi.fn().mockResolvedValue(existing),
      unhideAsset: vi.fn().mockRejectedValue(new Error('AccessDenied')),
    })
    const warn = vi.fn()
    setCanopyLogger({ log: vi.fn(), warn, error: vi.fn() })
    try {
      const result = await finalizeAsset(store, { data: await pngBytes(), filename: 'again.png' })

      expect(result).toEqual({ ok: true, meta: existing })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('AccessDenied'))
    } finally {
      resetCanopyLogger()
    }
  })

  it('puts a file removed from the library back when its bytes are uploaded again', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-finalize-unhide-'))
    try {
      const store = new LocalAssetStore({ root })
      const first = await finalizeAsset(store, { data: await pngBytes(), filename: 'a.png' })
      if (!first.ok) throw new Error(first.error)
      await store.hideAsset(first.meta.hash32, { hiddenAt: '2026-01-02T00:00:00.000Z' })
      expect((await store.listMeta()).items).toEqual([])

      const again = await finalizeAsset(store, { data: await pngBytes(), filename: 'b.png' })

      expect(again.ok && again.meta.filename).toBe('a.png')
      expect((await store.listMeta()).items.map((meta) => meta.hash32)).toEqual([first.meta.hash32])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('happy path: writes original then meta last (meta is the commit point)', async () => {
    const store = makeStore()
    const calls: string[] = []
    ;(store.putOriginal as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('putOriginal')
      return 'created'
    })
    ;(store.putMetaIfAbsent as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('putMetaIfAbsent')
      return 'created'
    })
    ;(store.putPublicObject as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('putPublicObject')
      return 'created'
    })

    const result = await finalizeAsset(store, { data: await pngBytes(), filename: 'a.png' })

    expect(result.ok).toBe(true)
    // The editor thumbnails come after the commit point, one per width.
    expect(calls).toEqual([
      'putOriginal',
      'putMetaIfAbsent',
      ...Object.values(EDITOR_THUMBNAIL_WIDTHS).map(() => 'putPublicObject'),
    ])
  })

  it('writes a public object for svg/pdf before the meta commit point', async () => {
    const store = makeStore()
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')

    const result = await finalizeAsset(store, { data: svg, filename: 'a.svg' })

    expect(result.ok).toBe(true)
    expect(store.putPublicObject).toHaveBeenCalledTimes(1)
  })

  it('never writes anything for a rejected (pipeline) input', async () => {
    const store = makeStore()

    const result = await finalizeAsset(store, {
      data: new Uint8Array([0x00, 0x01, 0x02]),
      filename: 'junk.bin',
    })

    expect(result.ok).toBe(false)
    expect(store.getMeta).not.toHaveBeenCalled()
    expect(store.putOriginal).not.toHaveBeenCalled()
    expect(store.putMetaIfAbsent).not.toHaveBeenCalled()
  })

  it('resolves a lost race (putMetaIfAbsent -> already-exists) to the winner meta', async () => {
    const winner: AssetMeta = {
      hash32: 'f'.repeat(32),
      filename: 'winner.png',
      slug: 'winner',
      ext: 'png',
      mime: 'image/png',
      size: 5,
      kind: 'raster',
      uploadedAt: '2026-01-01T00:00:00.000Z',
    }
    let getMetaCalls = 0
    const store = makeStore({
      getMeta: vi.fn().mockImplementation(async () => {
        getMetaCalls += 1
        // First call (dedup check) finds nothing; second call (post-race
        // resolution) returns the winner that beat us to putMetaIfAbsent.
        return getMetaCalls === 1 ? null : winner
      }),
      putMetaIfAbsent: vi.fn().mockResolvedValue('already-exists'),
    })

    const result = await finalizeAsset(store, { data: await pngBytes(), filename: 'loser.png' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta).toBe(winner)
    expect(getMetaCalls).toBe(2)
    // The winner's own finalize stores its thumbnails.
    expect(store.putPublicObject).not.toHaveBeenCalled()
  })
})

describe('finalizeAsset editor thumbnails', () => {
  /** A 400x200 PNG, wider than every editor thumbnail width. */
  async function widePng(): Promise<Uint8Array> {
    const buf = await sharp({
      create: { width: 400, height: 200, channels: 3, background: { r: 40, g: 80, b: 120 } },
    })
      .png()
      .toBuffer()
    return new Uint8Array(buf)
  }

  /** The store key the raw route reads for the editor's request at `width`. */
  function editorRequestKey(meta: AssetMeta, width: number): string {
    const base = '/api/canopycms/assets/raw'
    const url = editorImageSrc(assetSrc(meta), base, { width })
    const transformPrefix = `/${ASSET_PREFIXES.transform}/`
    const rest = url.slice(base.length + transformPrefix.length)
    const canonical = canonicalizeTransformPath(rest.split('/'), 'any')
    if (!canonical.ok) throw new Error(canonical.error)
    return `${ASSET_PREFIXES.transform}/${canonical.canonicalPath}`
  }

  async function withLocalStore(
    run: (store: LocalAssetStore, root: string) => Promise<void>,
  ): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-finalize-thumbs-'))
    try {
      await run(new LocalAssetStore({ root }), root)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }

  it('stores each editor width of a new raster upload at the key the editor requests', async () => {
    await withLocalStore(async (store) => {
      const result = await finalizeAsset(store, { data: await widePng(), filename: 'Wide.png' })
      if (!result.ok) throw new Error(result.error)

      for (const width of Object.values(EDITOR_THUMBNAIL_WIDTHS)) {
        const stored = await store.readPublicObject(editorRequestKey(result.meta, width))
        if (!stored) throw new Error(`no thumbnail stored at width ${width}`)
        expect((await sharp(stored.data).metadata()).width).toBe(width)
      }
    })
  })

  it('stores the widths an existing asset lacks when its bytes are uploaded again', async () => {
    await withLocalStore(async (store, root) => {
      const first = await finalizeAsset(store, { data: await widePng(), filename: 'a.png' })
      if (!first.ok) throw new Error(first.error)
      const missingKey = editorRequestKey(first.meta, EDITOR_THUMBNAIL_WIDTHS.card)
      await fs.rm(path.join(root, missingKey))
      const putPublicObject = vi.spyOn(store, 'putPublicObject')

      const again = await finalizeAsset(store, { data: await widePng(), filename: 'b.png' })

      expect(again.ok).toBe(true)
      expect(putPublicObject.mock.calls.map(([input]) => input.key)).toEqual([missingKey])
      expect(await store.hasPublicObject(missingKey)).toBe(true)
    })
  })

  it('stores no thumbnails for an animated (multi-page) source', async () => {
    await withLocalStore(async (store) => {
      const frame = (r: number) =>
        sharp({ create: { width: 400, height: 200, channels: 3, background: { r, g: 0, b: 0 } } })
          .png()
          .toBuffer()
      const gif = await sharp(await Promise.all([frame(10), frame(200)]), {
        join: { animated: true },
      })
        .gif()
        .toBuffer()
      const putPublicObject = vi.spyOn(store, 'putPublicObject')

      const result = await finalizeAsset(store, { data: new Uint8Array(gif), filename: 'a.gif' })

      if (!result.ok) throw new Error(result.error)
      expect(result.meta.kind).toBe('raster')
      expect(putPublicObject).not.toHaveBeenCalled()
    })
  })

  it('stops at the first width a transform rejects, and still finalizes', async () => {
    const warn = vi.fn()
    setCanopyLogger({ log: vi.fn(), warn, error: vi.fn() })
    vi.mocked(transformModule.applyTransform).mockClear()
    vi.mocked(transformModule.applyTransform).mockResolvedValueOnce({
      ok: false,
      status: 422,
      error: 'cannot decode',
    })
    try {
      const store = makeStore()

      const result = await finalizeAsset(store, { data: await widePng(), filename: 'a.png' })

      expect(result.ok).toBe(true)
      expect(transformModule.applyTransform).toHaveBeenCalledTimes(1)
      expect(store.putPublicObject).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot decode'))
    } finally {
      resetCanopyLogger()
    }
  })

  it('stores no thumbnails when the meta it lost to cannot be read', async () => {
    const store = makeStore({ putMetaIfAbsent: vi.fn().mockResolvedValue('already-exists') })

    const result = await finalizeAsset(store, { data: await widePng(), filename: 'a.png' })

    expect(result.ok && result.meta.filename).toBe('a.png')
    expect(store.putPublicObject).not.toHaveBeenCalled()
  })

  it('still finalizes, and stops at the first width, when storing a thumbnail fails', async () => {
    const warn = vi.fn()
    setCanopyLogger({ log: vi.fn(), warn, error: vi.fn() })
    try {
      const store = makeStore({ putPublicObject: vi.fn().mockRejectedValue(new Error('SlowDown')) })

      const result = await finalizeAsset(store, { data: await widePng(), filename: 'a.png' })

      expect(result.ok).toBe(true)
      expect(store.putMetaIfAbsent).toHaveBeenCalledTimes(1)
      expect(store.putPublicObject).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('SlowDown'))
    } finally {
      resetCanopyLogger()
    }
  })
})

describe('finalizeAsset after a crash before the meta commit', () => {
  it('commits the meta when the original (and an svg public object) is already stored', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-finalize-crash-'))
    try {
      const store = new LocalAssetStore({ root })
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
      const first = await finalizeAsset(store, { data: svg, filename: 'a.svg' })
      if (!first.ok) throw new Error(first.error)
      // The state a crash between the puts and `putMetaIfAbsent` leaves behind.
      await fs.rm(path.join(root, 'asset-meta', `${first.meta.hash32}.json`))

      const putOriginal = vi.spyOn(store, 'putOriginal')
      const putPublicObject = vi.spyOn(store, 'putPublicObject')
      const retried = await finalizeAsset(store, { data: svg, filename: 'a.svg' })

      expect(retried.ok).toBe(true)
      await expect(putOriginal.mock.results[0].value).resolves.toBe('already-exists')
      await expect(putPublicObject.mock.results[0].value).resolves.toBe('already-exists')
      expect(await store.getMeta(first.meta.hash32)).toMatchObject({ filename: 'a.svg' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('finalizeStagedUpload', () => {
  it('404s when the staged bytes are missing/expired, without touching the pipeline', async () => {
    const store = makeStore({ readStaging: vi.fn().mockResolvedValue(null) })

    const result = await finalizeStagedUpload(
      store,
      'asset-staging/11111111-1111-4111-8111-111111111111',
      'a.png',
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(404)
    expect(store.deleteStaging).not.toHaveBeenCalled()
  })

  it('deletes the staging object after a successful finalize', async () => {
    const store = makeStore({ readStaging: vi.fn().mockResolvedValue(await pngBytes()) })

    const result = await finalizeStagedUpload(
      store,
      'asset-staging/22222222-2222-4222-8222-222222222222',
      'a.png',
    )

    expect(result.ok).toBe(true)
    expect(store.deleteStaging).toHaveBeenCalledWith(
      'asset-staging/22222222-2222-4222-8222-222222222222',
    )
  })

  it('deletes the staging object after a pipeline rejection too', async () => {
    const store = makeStore({
      readStaging: vi.fn().mockResolvedValue(new Uint8Array([0x00, 0x01, 0x02])),
    })

    const result = await finalizeStagedUpload(
      store,
      'asset-staging/99999999-9999-4999-8999-999999999999',
      'junk.bin',
    )

    expect(result.ok).toBe(false)
    expect(store.deleteStaging).toHaveBeenCalledWith(
      'asset-staging/99999999-9999-4999-8999-999999999999',
    )
  })

  it('best-effort: a deleteStaging failure does not fail the overall result', async () => {
    const store = makeStore({
      readStaging: vi.fn().mockResolvedValue(await pngBytes()),
      deleteStaging: vi.fn().mockRejectedValue(new Error('boom')),
    })

    const result = await finalizeStagedUpload(
      store,
      'asset-staging/22222222-2222-4222-8222-222222222222',
      'a.png',
    )

    expect(result.ok).toBe(true)
  })
})
