import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { imageSize } from 'image-size'
import sharp from 'sharp'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

import { ASSET_ROUTES, assetRawRoute } from './assets'
import type { ApiContext, ApiRequest } from './types'
import type { AssetMeta, AssetStore } from '../assets/types'
import { LocalAssetStore } from '../assets/store-local'
import { RESERVED_GROUPS } from '../authorization'
import { createMockApiContext, mockConsole } from '../test-utils'
import { createCanopyRequestHandler } from '../http/handler'
import type { CanopyRequest } from '../http/types'
import type { AuthPlugin } from '../auth/plugin'
import type { CanopyServices } from '../services'
import * as transformModule from '../assets/transform'

// Real request-handling test below (bodyFormat bypass) needs a full
// createCanopyRequestHandler - mirrors src/http/handler.test.ts's mocking so
// branch/permission loading never touches git or the filesystem.
vi.mock('../branch-workspace', () => ({
  BranchWorkspaceManager: vi.fn(),
  loadBranchContext: vi.fn().mockResolvedValue(null),
}))
vi.mock('../authorization/permissions', () => ({
  loadPathPermissions: vi.fn().mockResolvedValue([]),
}))
// Partial mock: wraps the real applyTransform in a spy so the lazy-transform
// tests below can assert cache hits never re-invoke sharp, while every other
// describe block in this file (which never calls the raw route's transform
// path) keeps the real implementation untouched.
vi.mock('../assets/transform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../assets/transform')>()
  return { ...actual, applyTransform: vi.fn(actual.applyTransform) }
})

/**
 * Real, sharp-decodable 3x5 PNG fixture - finalize now forces a real pixel
 * decode for raster uploads (see assets/pipeline.ts's `rasterIsDecodable`),
 * so the old hand-built, header-only (IHDR but no real IDAT) PNG_3X5_BASE64
 * constant this replaced would be correctly rejected by every success-path
 * test below. Memoized: every call site in this file wants the exact same
 * trivial fixture, and re-encoding on every call would add up across the
 * many upload-path tests here.
 *
 * Copies into a fresh, concrete `ArrayBuffer` (rather than returning
 * `sharp`'s `Buffer` directly, or a `Uint8Array` view over it) because
 * `Buffer`/`Uint8Array` are typed as backed by the wider `ArrayBufferLike`
 * (which also covers `SharedArrayBuffer`), and several call sites below pass
 * this straight into `new File([...])`, whose `BlobPart` type requires an
 * `ArrayBufferView<ArrayBuffer>` specifically - same construction the old
 * `bytesOf` helper this replaces used, for the same reason.
 */
let cachedRasterPng: Uint8Array<ArrayBuffer> | undefined
async function rasterPngBytes(): Promise<Uint8Array<ArrayBuffer>> {
  if (!cachedRasterPng) {
    const buf = await sharp({
      create: { width: 3, height: 5, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer()
    const arrayBuffer = new ArrayBuffer(buf.byteLength)
    new Uint8Array(arrayBuffer).set(buf)
    cachedRasterPng = new Uint8Array(arrayBuffer)
  }
  return cachedRasterPng
}

const sampleMeta: AssetMeta = {
  hash32: 'a'.repeat(32),
  filename: 'a.png',
  slug: 'a',
  ext: 'png',
  mime: 'image/png',
  size: 5,
  kind: 'raster',
  uploadedAt: '2026-01-01T00:00:00.000Z',
}

const makeAssetStore = (): AssetStore => ({
  capabilities: { directUpload: false },
  beginUpload: async () => ({
    mode: 'proxied',
    stagingKey: 'asset-staging/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    maxBytes: 1_000_000,
  }),
  writeStaging: async () => {},
  readStaging: async () => null,
  deleteStaging: async () => {},
  putOriginal: async () => {},
  readOriginal: async () => null,
  putPublicObject: async () => {},
  readPublicObject: async () => null,
  hasPublicObject: async () => false,
  putMetaIfAbsent: async () => 'created',
  getMeta: async () => null,
  listMeta: async () => ({ items: [sampleMeta] }),
  deleteMeta: async () => {},
})

const ctxWith = (assetStore: AssetStore | undefined): ApiContext => ({
  ...createMockApiContext({ branchContext: null }),
  assetStore,
})

const authedReq = (overrides: Partial<ApiRequest> = {}): ApiRequest => ({
  user: { type: 'authenticated', userId: 'u1', groups: [] },
  ...overrides,
})

describe('asset api params schemas', () => {
  it('declares a params schema for list so the client generator emits cursor/limit', () => {
    expect(ASSET_ROUTES.list.params).toBeDefined()
    const parsed = ASSET_ROUTES.list.params?.safeParse({ cursor: 'abc', limit: '10' })
    expect(parsed?.success).toBe(true)
    if (parsed?.success) {
      expect(parsed.data).toEqual({ cursor: 'abc', limit: 10 })
    }
  })

  it('validates delete key as a 32-char lowercase hex string (400 on anything else)', () => {
    const bad = ASSET_ROUTES.delete.validate({ params: { key: 'not-a-hash.png' } })
    expect(bad.ok).toBe(false)

    const good = ASSET_ROUTES.delete.validate({ params: { key: 'a'.repeat(32) } })
    expect(good.ok).toBe(true)
  })
})

describe('presign', () => {
  it('returns 501 when asset store missing', async () => {
    const res = await ASSET_ROUTES.presign.handler(ctxWith(undefined), authedReq(), {
      filename: 'a.png',
      contentType: 'image/png',
    })
    expect(res.status).toBe(501)
  })

  it('returns a StagedUploadTarget for an allowed content type', async () => {
    const res = await ASSET_ROUTES.presign.handler(ctxWith(makeAssetStore()), authedReq(), {
      filename: 'a.png',
      contentType: 'image/png',
    })
    expect(res.ok).toBe(true)
    expect(res.data?.upload.stagingKey).toBe('asset-staging/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  })

  it('rejects an unsupported content type (415)', async () => {
    const res = await ASSET_ROUTES.presign.handler(ctxWith(makeAssetStore()), authedReq(), {
      filename: 'a.exe',
      contentType: 'application/x-msdownload',
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(415)
  })

  it('rejects a declared size over the store max up front (413)', async () => {
    const store: AssetStore = {
      ...makeAssetStore(),
      beginUpload: async () => ({
        mode: 'proxied',
        stagingKey: 'asset-staging/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        maxBytes: 100,
      }),
    }
    const res = await ASSET_ROUTES.presign.handler(ctxWith(store), authedReq(), {
      filename: 'a.png',
      contentType: 'image/png',
      size: 200,
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(413)
  })
})

describe('finalize + uploadProxied (real LocalAssetStore in a tmp dir)', () => {
  let tmpDir: string
  let store: LocalAssetStore

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-assets-api-test-'))
    store = new LocalAssetStore({ root: tmpDir })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('finalizes a staged raster upload end to end, returning an AssetRecord with src', async () => {
    const stagingKey = 'asset-staging/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await store.writeStaging(stagingKey, await rasterPngBytes(), 'image/png')

    const res = await ASSET_ROUTES.finalize.handler(ctxWith(store), authedReq(), {
      stagingKey,
      filename: 'a.png',
    })
    expect(res.ok).toBe(true)
    expect(res.data?.asset.kind).toBe('raster')
    expect(res.data?.asset.src).toMatch(/^\/assets\/t\/orig\//)

    // Staging object deleted after success.
    expect(await store.readStaging(stagingKey)).toBeNull()
  })

  it('finalizes a staged svg upload, writing a public object and sanitizing on the way', async () => {
    const stagingKey = 'asset-staging/cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const dirtySvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>'
    await store.writeStaging(stagingKey, new TextEncoder().encode(dirtySvg), 'image/svg+xml')

    const res = await ASSET_ROUTES.finalize.handler(ctxWith(store), authedReq(), {
      stagingKey,
      filename: 'evil.svg',
    })
    expect(res.ok).toBe(true)
    expect(res.data?.asset.kind).toBe('svg')
    expect(res.data?.asset.src).toMatch(/^\/assets\//)

    if (!res.data) return
    const publicObject = await store.readPublicObject(
      `assets/${res.data.asset.hash32}/${res.data.asset.slug}.svg`,
    )
    expect(publicObject).not.toBeNull()
    expect(Buffer.from(publicObject!.data).toString('utf-8')).not.toMatch(/<script/i)
  })

  it('returns 404 for a missing/expired staging key', async () => {
    const res = await ASSET_ROUTES.finalize.handler(ctxWith(store), authedReq(), {
      stagingKey: 'asset-staging/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      filename: 'a.png',
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })

  it('dedups identical bytes: second finalize returns the first upload winner meta, no rewrite', async () => {
    const stagingKey1 = 'asset-staging/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const stagingKey2 = 'asset-staging/ffffffff-ffff-4fff-8fff-ffffffffffff'
    await store.writeStaging(stagingKey1, await rasterPngBytes(), 'image/png')
    await store.writeStaging(stagingKey2, await rasterPngBytes(), 'image/png')

    const first = await ASSET_ROUTES.finalize.handler(ctxWith(store), authedReq(), {
      stagingKey: stagingKey1,
      filename: 'first-name.png',
    })
    const second = await ASSET_ROUTES.finalize.handler(ctxWith(store), authedReq(), {
      stagingKey: stagingKey2,
      filename: 'second-name.png',
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.data || !second.data) return
    expect(second.data.asset.hash32).toBe(first.data.asset.hash32)
    expect(second.data.asset.filename).toBe('first-name.png') // first-name-wins
  })

  it('deletes the staging object after a pipeline rejection too', async () => {
    const stagingKey = 'asset-staging/99999999-9999-4999-8999-999999999999'
    await store.writeStaging(
      stagingKey,
      new TextEncoder().encode('just some junk text'),
      'text/plain',
    )

    const res = await ASSET_ROUTES.finalize.handler(ctxWith(store), authedReq(), {
      stagingKey,
      filename: 'junk.bin',
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(415)
    expect(await store.readStaging(stagingKey)).toBeNull()
  })

  it('uploadProxied: accepts a multipart file through a proxied-mode store', async () => {
    const file = new File([await rasterPngBytes()], 'upload.png', { type: 'image/png' })
    const formData = new FormData()
    formData.append('file', file)

    const req: ApiRequest = authedReq({
      rawRequest: {
        method: 'POST',
        url: 'http://localhost/assets/upload',
        header: () => null,
        json: async () => undefined,
        formData: async () => formData,
      } as CanopyRequest,
    })

    const res = await ASSET_ROUTES.uploadProxied.handler(ctxWith(store), req)
    expect(res.ok).toBe(true)
    expect(res.data?.asset.kind).toBe('raster')
    expect(res.data?.asset.filename).toBe('upload.png')
  })

  it('uploadProxied: an explicit filename field overrides file.name', async () => {
    const file = new File([await rasterPngBytes()], 'original.png', { type: 'image/png' })
    const formData = new FormData()
    formData.append('file', file)
    formData.append('filename', 'renamed.png')

    const req: ApiRequest = authedReq({
      rawRequest: {
        method: 'POST',
        url: 'http://localhost/assets/upload',
        header: () => null,
        json: async () => undefined,
        formData: async () => formData,
      } as CanopyRequest,
    })

    const res = await ASSET_ROUTES.uploadProxied.handler(ctxWith(store), req)
    expect(res.ok).toBe(true)
    expect(res.data?.asset.filename).toBe('renamed.png')
  })

  it('uploadProxied: rejects (400) when the store is direct-upload mode', async () => {
    const directStore: AssetStore = { ...makeAssetStore(), capabilities: { directUpload: true } }
    const req: ApiRequest = authedReq({
      rawRequest: {
        method: 'POST',
        url: 'http://localhost/assets/upload',
        header: () => null,
        json: async () => undefined,
        formData: async () => new FormData(),
      } as CanopyRequest,
    })

    const res = await ASSET_ROUTES.uploadProxied.handler(ctxWith(directStore), req)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  })

  it('uploadProxied: rejects (413) an over-cap Content-Length before ever reading the multipart body', async () => {
    let formDataCalled = false
    const req: ApiRequest = authedReq({
      rawRequest: {
        method: 'POST',
        url: 'http://localhost/assets/upload',
        header: (name) =>
          name.toLowerCase() === 'content-length' ? String(200 * 1024 * 1024) : null,
        json: async () => undefined,
        formData: async () => {
          formDataCalled = true
          return new FormData()
        },
      } as CanopyRequest,
    })

    const res = await ASSET_ROUTES.uploadProxied.handler(ctxWith(store), req)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(413)
    expect(formDataCalled).toBe(false)
  })

  it('uploadProxied: an absent Content-Length header falls through to the post-read size check', async () => {
    // No Content-Length header at all - the early guard is a no-op (header
    // returns null), and the request proceeds to the real (small) body,
    // which passes the post-read check normally.
    const file = new File([await rasterPngBytes()], 'a.png', { type: 'image/png' })
    const formData = new FormData()
    formData.append('file', file)

    const req: ApiRequest = authedReq({
      rawRequest: {
        method: 'POST',
        url: 'http://localhost/assets/upload',
        header: () => null,
        json: async () => undefined,
        formData: async () => formData,
      } as CanopyRequest,
    })

    const res = await ASSET_ROUTES.uploadProxied.handler(ctxWith(store), req)
    expect(res.ok).toBe(true)
  })

  it('uploadProxied: rejects (400) when the adapter never wired formData()', async () => {
    const req: ApiRequest = authedReq({
      rawRequest: {
        method: 'POST',
        url: 'http://localhost/assets/upload',
        header: () => null,
        json: async () => undefined,
        // formData intentionally omitted
      } as CanopyRequest,
    })

    const res = await ASSET_ROUTES.uploadProxied.handler(ctxWith(store), req)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  })
})

describe('list', () => {
  it('returns 501 when asset store missing', async () => {
    const res = await ASSET_ROUTES.list.handler(ctxWith(undefined), authedReq(), {})
    expect(res.status).toBe(501)
  })

  it('lists assets for any user, each with a computed src', async () => {
    const res = await ASSET_ROUTES.list.handler(ctxWith(makeAssetStore()), authedReq(), {})
    expect(res.ok).toBe(true)
    expect(res.data?.assets[0].hash32).toBe(sampleMeta.hash32)
    expect(res.data?.assets[0].src).toBeTruthy()
  })

  it('forwards cursor/limit params to the store', async () => {
    let receivedInput: { cursor?: string; limit?: number } | undefined
    const store: AssetStore = {
      ...makeAssetStore(),
      listMeta: async (input) => {
        receivedInput = input
        return { items: [] }
      },
    }
    await ASSET_ROUTES.list.handler(ctxWith(store), authedReq(), { cursor: 'xyz', limit: 5 })
    expect(receivedInput).toEqual({ cursor: 'xyz', limit: 5 })
  })
})

describe('delete', () => {
  const key = 'a'.repeat(32)

  it('returns 403 for non-privileged users', async () => {
    const res = await ASSET_ROUTES.delete.handler(ctxWith(makeAssetStore()), authedReq(), { key })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
  })

  it('returns 403 for reviewers who did not upload the asset', async () => {
    const req = authedReq({
      user: { type: 'authenticated', userId: 'u', groups: [RESERVED_GROUPS.REVIEWERS] },
    })
    const res = await ASSET_ROUTES.delete.handler(ctxWith(makeAssetStore()), req, { key })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
  })

  /** Store whose getMeta returns sampleMeta with the given uploader. */
  const storeOwnedBy = (uploadedBy: string | undefined, onDelete?: (h: string) => void) => ({
    ...makeAssetStore(),
    getMeta: async () => ({ ...sampleMeta, ...(uploadedBy && { uploadedBy }) }),
    deleteMeta: async (hash32: string) => {
      onDelete?.(hash32)
    },
  })

  it('allows a non-admin to delete an asset they uploaded', async () => {
    let deletedHash32: string | undefined
    const store = storeOwnedBy('u1', (h) => {
      deletedHash32 = h
    })
    // authedReq()'s default user is u1, matching the asset's uploadedBy.
    const res = await ASSET_ROUTES.delete.handler(ctxWith(store), authedReq(), { key })
    expect(res.ok).toBe(true)
    expect(deletedHash32).toBe(key)
  })

  it("returns 403 when a non-admin targets another user's asset, and does not delete", async () => {
    let deleteCalled = false
    const store = storeOwnedBy('someone-else', () => {
      deleteCalled = true
    })
    const res = await ASSET_ROUTES.delete.handler(ctxWith(store), authedReq(), { key })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(deleteCalled).toBe(false)
  })

  it('falls back to admin-only when the asset records no uploadedBy (must not default open)', async () => {
    let deleteCalled = false
    const store = storeOwnedBy(undefined, () => {
      deleteCalled = true
    })
    const res = await ASSET_ROUTES.delete.handler(ctxWith(store), authedReq(), { key })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(deleteCalled).toBe(false)
  })

  it('lets an admin delete an asset uploaded by someone else', async () => {
    let deletedHash32: string | undefined
    const store = storeOwnedBy('someone-else', (h) => {
      deletedHash32 = h
    })
    const req = authedReq({
      user: { type: 'authenticated', userId: 'u1', groups: [RESERVED_GROUPS.ADMINS] },
    })
    const res = await ASSET_ROUTES.delete.handler(ctxWith(store), req, { key })
    expect(res.ok).toBe(true)
    expect(deletedHash32).toBe(key)
  })

  it('allows admins to delete, forwarding the key as the hash32 to deleteMeta', async () => {
    let deletedHash32: string | undefined
    const store: AssetStore = {
      ...makeAssetStore(),
      deleteMeta: async (hash32) => {
        deletedHash32 = hash32
      },
    }
    const req = authedReq({
      user: { type: 'authenticated', userId: 'u', groups: [RESERVED_GROUPS.ADMINS] },
    })
    const res = await ASSET_ROUTES.delete.handler(ctxWith(store), req, { key })
    expect(res.ok).toBe(true)
    expect(deletedHash32).toBe(key)
  })
})

describe('assetRawRoute (GET /assets/raw/{key...})', () => {
  let tmpDir: string
  let store: LocalAssetStore

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-assets-raw-test-'))
    store = new LocalAssetStore({ root: tmpDir })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('serves a stored public object as a CanopyBinaryResponse with the right headers', async () => {
    const key = `assets/${'a'.repeat(32)}/slug.svg`
    await store.putPublicObject({
      key,
      data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      contentType: 'image/svg+xml',
      contentDisposition: 'inline',
      cacheControl: 'public, max-age=31536000, immutable',
    })

    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), { key })
    expect(res).toMatchObject({
      kind: 'binary',
      status: 200,
      headers: {
        contentType: 'image/svg+xml',
        contentDisposition: 'inline',
        cacheControl: 'public, max-age=31536000, immutable',
      },
    })
  })

  it('404s when the public object does not exist', async () => {
    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: `assets/${'b'.repeat(32)}/missing.svg`,
    })
    expect(res).toMatchObject({ ok: false, status: 404 })
  })

  it('rejects (404) a key outside the public prefix', async () => {
    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: 'asset-originals/x.png',
    })
    expect(res).toMatchObject({ ok: false, status: 404 })
  })

  it('rejects (404) a key containing ".." (path traversal defense-in-depth)', async () => {
    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: 'assets/../asset-originals/x.png',
    })
    expect(res).toMatchObject({ ok: false, status: 404 })
  })

  it('returns 501 when asset store missing', async () => {
    const res = await assetRawRoute.handler(ctxWith(undefined), authedReq(), {
      key: `assets/${'a'.repeat(32)}/slug.svg`,
    })
    expect(res).toMatchObject({ ok: false, status: 501 })
  })
})

describe('assetRawRoute - lazy transform (GET /assets/t/{directives}/{hash32}/{slug}.{ext})', () => {
  let tmpDir: string
  let store: LocalAssetStore
  let rasterBytes: Uint8Array
  const rasterHash32 = 'b'.repeat(32)
  const svgHash32 = 'c'.repeat(32)

  const rasterMeta: AssetMeta = {
    hash32: rasterHash32,
    filename: 'photo.png',
    slug: 'photo',
    ext: 'png',
    mime: 'image/png',
    size: 0,
    kind: 'raster',
    uploadedAt: '2026-01-01T00:00:00.000Z',
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-assets-transform-test-'))
    store = new LocalAssetStore({ root: tmpDir })

    const buf = await sharp({
      create: { width: 800, height: 400, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer()
    rasterBytes = new Uint8Array(buf)

    await store.putOriginal({
      hash32: rasterHash32,
      ext: 'png',
      data: rasterBytes,
      contentType: 'image/png',
    })
    await store.putMetaIfAbsent(rasterHash32, { ...rasterMeta, size: rasterBytes.byteLength })

    await store.putMetaIfAbsent(svgHash32, {
      hash32: svgHash32,
      filename: 'logo.svg',
      slug: 'logo',
      ext: 'svg',
      mime: 'image/svg+xml',
      size: 42,
      kind: 'svg',
      uploadedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('computes and caches a transform on first miss, resizing correctly', async () => {
    const key = `assets/t/w=160/${rasterHash32}/photo.png`
    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), { key })
    expect(res).toMatchObject({
      kind: 'binary',
      status: 200,
      headers: { contentType: 'image/png' },
    })
    expect(transformModule.applyTransform).toHaveBeenCalledTimes(1)

    if (!('body' in res)) return
    const dims = imageSize(Buffer.from(res.body as Uint8Array))
    expect(dims.width).toBe(160)
    expect(dims.height).toBe(80)

    const cached = await store.readPublicObject(key)
    expect(cached).not.toBeNull()
  })

  it('rejects a slug that is not the asset’s own, without transforming or caching', async () => {
    // Parity with the prod transform Lambda (canopycms-cdk's handler.ts): the
    // slug is load-bearing in the stored key, and `[a-z0-9-]+` is all the
    // parser can enforce, so every distinct string would otherwise alias the
    // same image into a new cache entry and a new transform.
    const key = `assets/t/w=160/${rasterHash32}/any-slug-at-all.png`
    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), { key })

    expect(res).toMatchObject({ ok: false, status: 404 })
    expect(transformModule.applyTransform).not.toHaveBeenCalled()
    expect(await store.readPublicObject(key)).toBeNull()
  })

  it('serves the second identical request from the store without invoking the transform engine again', async () => {
    const key = `assets/t/w=160/${rasterHash32}/photo.png`
    await assetRawRoute.handler(ctxWith(store), authedReq(), { key })
    expect(transformModule.applyTransform).toHaveBeenCalledTimes(1)

    const second = await assetRawRoute.handler(ctxWith(store), authedReq(), { key })
    expect(second).toMatchObject({ kind: 'binary', status: 200 })
    expect(transformModule.applyTransform).toHaveBeenCalledTimes(1)
  })

  it('caches a non-canonically-ordered directive request under its canonical key only', async () => {
    const nonCanonicalKey = `assets/t/w=160,q=80/${rasterHash32}/photo.png`
    const canonicalKey = `assets/t/q=80,w=160/${rasterHash32}/photo.png`

    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), { key: nonCanonicalKey })
    expect(res).toMatchObject({ kind: 'binary', status: 200 })

    expect(await store.readPublicObject(canonicalKey)).not.toBeNull()
    expect(await store.readPublicObject(nonCanonicalKey)).toBeNull()
  })

  it('serves a non-canonical request the bytes already stored under its canonical key, without redirecting or transforming', async () => {
    const canonicalKey = `assets/t/q=80,w=160/${rasterHash32}/photo.png`
    const stored = new Uint8Array([1, 2, 3, 4])
    await store.putPublicObject({ key: canonicalKey, data: stored, contentType: 'image/png' })

    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: `assets/t/w=160,q=80/${rasterHash32}/photo.png`,
    })

    expect(res).toMatchObject({ kind: 'binary', status: 200 })
    if (!('body' in res)) throw new Error('expected a binary response')
    expect(Buffer.from(res.body as Uint8Array).equals(Buffer.from(stored))).toBe(true)
    expect(transformModule.applyTransform).not.toHaveBeenCalled()
  })

  it('transforms an over-precision crop with its rounded directives and stores it under the rounded key', async () => {
    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: `assets/t/c=0.123456:0:0.5:0.25/${rasterHash32}/photo.png`,
    })

    expect(res).toMatchObject({ kind: 'binary', status: 200 })
    expect(transformModule.applyTransform).toHaveBeenCalledWith(expect.anything(), {
      identity: false,
      crop: { x: 0.1235, y: 0, w: 0.5, h: 0.25 },
      format: undefined,
      quality: undefined,
      width: undefined,
    })
    expect(
      await store.readPublicObject(
        `assets/t/c=0.1235:0.0000:0.5000:0.2500/${rasterHash32}/photo.png`,
      ),
    ).not.toBeNull()
  })

  it('returns 400 for a crop that rounds to zero extent, without transforming', async () => {
    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: `assets/t/c=0:0:0.00001:1/${rasterHash32}/photo.png`,
    })

    expect(res).toMatchObject({ ok: false, status: 400 })
    expect(transformModule.applyTransform).not.toHaveBeenCalled()
  })

  it('returns 400 on a directive parse failure', async () => {
    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: `assets/t/not-a-directive/${rasterHash32}/photo.png`,
    })
    expect(res).toMatchObject({ ok: false, status: 400 })
    expect(transformModule.applyTransform).not.toHaveBeenCalled()
  })

  it('returns 404 when the hash32 has no meta', async () => {
    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: `assets/t/orig/${'d'.repeat(32)}/photo.png`,
    })
    expect(res).toMatchObject({ ok: false, status: 404 })
  })

  it('returns 400 when the meta kind is not raster (svg is served statically)', async () => {
    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: `assets/t/orig/${svgHash32}/logo.svg`,
    })
    expect(res).toMatchObject({ ok: false, status: 400 })
    expect(transformModule.applyTransform).not.toHaveBeenCalled()
  })

  it('returns 400 when the requested ext does not match the source ext and no format is given', async () => {
    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: `assets/t/orig/${rasterHash32}/photo.webp`,
    })
    expect(res).toMatchObject({ ok: false, status: 400 })
    expect(transformModule.applyTransform).not.toHaveBeenCalled()
  })

  it('returns 404 when meta exists but the original blob is missing', async () => {
    const orphanHash32 = 'e'.repeat(32)
    await store.putMetaIfAbsent(orphanHash32, { ...rasterMeta, hash32: orphanHash32 })
    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: `assets/t/orig/${orphanHash32}/photo.png`,
    })
    expect(res).toMatchObject({ ok: false, status: 404 })
  })

  it('passes the transform engine real rejection status through (422 for undecodable input), not a generic 502', async () => {
    const junkHash32 = 'f'.repeat(32)
    await store.putOriginal({
      hash32: junkHash32,
      ext: 'png',
      data: new Uint8Array([0, 1, 2, 3]),
      contentType: 'image/png',
    })
    await store.putMetaIfAbsent(junkHash32, { ...rasterMeta, hash32: junkHash32 })

    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: `assets/t/orig/${junkHash32}/photo.png`,
    })
    // Real applyTransform (spied, not stubbed) rejects undecodable bytes with
    // 422 - the dev route must forward that real status, not flatten every
    // rejection to 502 (which would mislabel a client-input problem as a
    // server failure).
    expect(res).toMatchObject({ ok: false, status: 422 })
  })

  it('passes a 400 transform rejection (unsupported input format) through unflattened', async () => {
    const spy = vi.spyOn(transformModule, 'applyTransform').mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: "Unsupported input format for transform: 'bmp'",
    })

    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: `assets/t/orig/${rasterHash32}/photo.png`,
    })
    expect(res).toMatchObject({ ok: false, status: 400 })
    spy.mockRestore()
  })

  it('passes a 413 transform rejection (oversized output) through unflattened', async () => {
    const spy = vi.spyOn(transformModule, 'applyTransform').mockResolvedValueOnce({
      ok: false,
      status: 413,
      error: 'Transformed output exceeds the byte cap',
    })

    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), {
      key: `assets/t/orig/${rasterHash32}/photo.png`,
    })
    expect(res).toMatchObject({ ok: false, status: 413 })
    spy.mockRestore()
  })
})

const createMockAuthPlugin = (): AuthPlugin => ({
  authenticate: async () => ({
    success: true,
    user: { userId: 'u1', externalGroups: [] },
  }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
})

const createMockServices = () => ({
  config: {
    schema: [],
    contentRoot: 'content',
    gitBotAuthorName: 'Test Bot',
    gitBotAuthorEmail: 'bot@test.com',
    mode: 'dev' as const,
  },
  checkBranchAccess: vi.fn().mockReturnValue({ allowed: true, reason: '' }),
  checkContentAccess: vi.fn().mockReturnValue({ allowed: true, branch: {}, path: {} }),
  pathPermissions: [],
  createGitManagerFor: vi.fn(),
  registry: { get: vi.fn().mockResolvedValue(null), list: vi.fn().mockResolvedValue([]) },
  bootstrapAdminIds: new Set<string>(),
  refreshActiveBranch: vi.fn().mockResolvedValue(undefined),
  // Internal groups are resolved via resolveCanopyUser -> getSettingsBranchRoot
  // (see resolve-canopy-user.ts). The path doesn't need to exist: groups.json
  // just won't be found there, which loadInternalGroups treats as "no custom
  // groups" (fine here - this suite tests multipart upload routing, not groups).
  getSettingsBranchRoot: vi.fn().mockResolvedValue('/tmp/assets-test-mock-settings'),
})

describe('assetRawRoute - redirects, on a store that presigns reads and on one that does not', () => {
  const PRESIGNED_ORIGIN = 'https://bucket.s3.example.com'
  const hash32 = '1'.repeat(32)
  const transformKey = `assets/t/w=160/${hash32}/photo.png`
  const oversized = () => new Uint8Array(4 * 1024 * 1024 + 1)

  let tmpDir: string
  let local: LocalAssetStore

  /** The local store plus S3's presign capability, answering from the same files. */
  const presigningStore = (): AssetStore => {
    const store: AssetStore = Object.create(local)
    store.presignPublicObjectRead = async (key) =>
      (await local.readPublicObject(key)) ? `${PRESIGNED_ORIGIN}/${key}?X-Amz-Signature=sig` : null
    return store
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-assets-redirect-test-'))
    local = new LocalAssetStore({ root: tmpDir })
    const png = await sharp({
      create: { width: 320, height: 160, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer()
    await local.putOriginal({
      hash32,
      ext: 'png',
      data: new Uint8Array(png),
      contentType: 'image/png',
    })
    await local.putMetaIfAbsent(hash32, {
      hash32,
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
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('redirects a stored transform to a no-store presigned GET without reading its bytes', async () => {
    await local.putPublicObject({ key: transformKey, data: oversized(), contentType: 'image/png' })
    const store = presigningStore()
    const readSpy = vi.spyOn(store, 'readPublicObject')

    const res = await assetRawRoute.handler(ctxWith(store), authedReq(), { key: transformKey })

    expect(res).toEqual({
      kind: 'binary',
      status: 302,
      body: new Uint8Array(),
      headers: {
        location: `${PRESIGNED_ORIGIN}/${transformKey}?X-Amz-Signature=sig`,
        cacheControl: 'no-store',
      },
    })
    expect(readSpy).not.toHaveBeenCalled()
    expect(transformModule.applyTransform).not.toHaveBeenCalled()
  })

  it('redirects a stored static object (svg/pdf) the same way', async () => {
    const key = `assets/${hash32}/doc.pdf`
    await local.putPublicObject({ key, data: oversized(), contentType: 'application/pdf' })

    const res = await assetRawRoute.handler(ctxWith(presigningStore()), authedReq(), { key })

    expect(res).toMatchObject({
      status: 302,
      headers: { location: `${PRESIGNED_ORIGIN}/${key}?X-Amz-Signature=sig` },
    })
  })

  it('redirects a non-canonical spelling to the presigned canonical key', async () => {
    const canonicalKey = `assets/t/q=80,w=160/${hash32}/photo.png`
    await local.putPublicObject({
      key: canonicalKey,
      data: new Uint8Array([1]),
      contentType: 'image/png',
    })

    const res = await assetRawRoute.handler(ctxWith(presigningStore()), authedReq(), {
      key: `assets/t/w=160,q=80/${hash32}/photo.png`,
    })

    expect(res).toMatchObject({
      status: 302,
      headers: { location: `${PRESIGNED_ORIGIN}/${canonicalKey}?X-Amz-Signature=sig` },
    })
  })

  it('transforms a miss and returns a small result inline, even on a store that presigns', async () => {
    const res = await assetRawRoute.handler(ctxWith(presigningStore()), authedReq(), {
      key: transformKey,
    })

    expect(res).toMatchObject({
      kind: 'binary',
      status: 200,
      headers: { contentType: 'image/png' },
    })
    expect(transformModule.applyTransform).toHaveBeenCalledTimes(1)
    expect(await local.readPublicObject(transformKey)).not.toBeNull()
  })

  it('stores a transformed miss over 4 MiB, then redirects to its presigned GET', async () => {
    vi.mocked(transformModule.applyTransform).mockResolvedValueOnce({
      ok: true,
      data: oversized(),
      contentType: 'image/png',
      ext: 'png',
    })

    const res = await assetRawRoute.handler(ctxWith(presigningStore()), authedReq(), {
      key: transformKey,
    })

    expect(res).toMatchObject({
      status: 302,
      body: new Uint8Array(),
      headers: {
        location: `${PRESIGNED_ORIGIN}/${transformKey}?X-Amz-Signature=sig`,
        cacheControl: 'no-store',
      },
    })
    expect((await local.readPublicObject(transformKey))?.data.byteLength).toBe(4 * 1024 * 1024 + 1)
  })

  it('returns a transformed miss of exactly 4 MiB inline', async () => {
    vi.mocked(transformModule.applyTransform).mockResolvedValueOnce({
      ok: true,
      data: new Uint8Array(4 * 1024 * 1024),
      contentType: 'image/png',
      ext: 'png',
    })

    const res = await assetRawRoute.handler(ctxWith(presigningStore()), authedReq(), {
      key: transformKey,
    })

    expect(res).toMatchObject({ kind: 'binary', status: 200 })
  })

  it('streams bytes from a store that cannot presign, hit or oversized miss alike', async () => {
    vi.mocked(transformModule.applyTransform).mockResolvedValueOnce({
      ok: true,
      data: oversized(),
      contentType: 'image/png',
      ext: 'png',
    })

    const miss = await assetRawRoute.handler(ctxWith(local), authedReq(), { key: transformKey })
    const hit = await assetRawRoute.handler(ctxWith(local), authedReq(), { key: transformKey })

    for (const res of [miss, hit]) {
      expect(res).toMatchObject({ kind: 'binary', status: 200 })
      if (!('body' in res)) throw new Error('expected a binary response')
      expect((res.body as Uint8Array).byteLength).toBe(4 * 1024 * 1024 + 1)
    }
  })

  /**
   * The loop: `withCanopy` rewrites `/assets/:path*` onto this route, so a redirect to a
   * same-origin `/assets/...` URL comes straight back here. Driven through the real router and
   * handler at the rewrite's destination path, for both stores, hit and miss.
   */
  describe('never redirects back onto a same-origin path (withCanopy rewrite)', () => {
    /** What Next hands the catch-all route for `GET /assets/t/w=160/{hash}/photo.png`. */
    const rewrittenRequest = (): CanopyRequest => ({
      method: 'GET',
      url: `http://localhost/api/canopycms/assets/raw/${transformKey}`,
      header: () => null,
      json: async () => undefined,
    })

    const viaRewrite = async (store: AssetStore) => {
      const handler = createCanopyRequestHandler({
        services: createMockServices() as unknown as CanopyServices,
        assetStore: store,
        authPlugin: createMockAuthPlugin(),
        getBranchContext: async () => null,
      })
      return handler(rewrittenRequest(), ['assets', 'raw', ...transformKey.split('/')])
    }

    it.each([
      ['a store that presigns', presigningStore],
      ['a store that streams', () => local],
    ])('on %s, for a miss and then a hit', async (_label, makeStore) => {
      for (const attempt of ['miss', 'hit']) {
        const res = await viaRewrite(makeStore())
        expect(res, attempt).toHaveProperty('kind', 'binary')
        if (!('kind' in res)) throw new Error('expected a binary response')
        const location = res.headers.location
        if (location !== undefined) {
          expect(new URL(location).origin, attempt).toBe(PRESIGNED_ORIGIN)
        } else {
          expect(res.status, attempt).toBe(200)
        }
      }
    })
  })
})

describe('full request pipeline - bodyFormat: multipart bypass (regression for the core handler change)', () => {
  const createRejectingAuthPlugin = (): AuthPlugin => ({
    authenticate: async () => ({ success: false, error: 'No token' }),
    searchUsers: async () => [],
    getUserMetadata: async () => null,
    getGroupMetadata: async () => null,
    listGroups: async () => [],
  })

  let tmpDir: string
  let store: LocalAssetStore

  beforeEach(async () => {
    mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-assets-pipeline-test-'))
    store = new LocalAssetStore({ root: tmpDir })
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('routes POST /assets/upload through the real router+handler without ever calling req.json()', async () => {
    const services: any = createMockServices()
    const handler = createCanopyRequestHandler({
      services,
      assetStore: store,
      authPlugin: createMockAuthPlugin(),
      getBranchContext: async () => null,
    })

    const file = new File([await rasterPngBytes()], 'a.png', { type: 'image/png' })
    const formData = new FormData()
    formData.append('file', file)

    const req: CanopyRequest = {
      method: 'POST',
      url: 'http://localhost/api/canopycms/assets/upload',
      header: () => null,
      json: async () => {
        throw new Error('req.json() must never be called for a bodyFormat: multipart route')
      },
      formData: async () => formData,
    }

    const response = await handler(req, ['assets', 'upload'])
    expect(response.status).toBe(200)
    expect((response.body as { ok: boolean }).ok).toBe(true)
  })

  it('still enforces auth for the multipart upload route - handler never reads the body for a rejected caller', async () => {
    const services: any = createMockServices()
    const handler = createCanopyRequestHandler({
      services,
      assetStore: store,
      authPlugin: createRejectingAuthPlugin(),
      getBranchContext: async () => null,
    })

    let formDataCalled = false
    const req: CanopyRequest = {
      method: 'POST',
      url: 'http://localhost/api/canopycms/assets/upload',
      header: () => null,
      json: async () => undefined,
      formData: async () => {
        formDataCalled = true
        return new FormData()
      },
    }

    const response = await handler(req, ['assets', 'upload'])
    expect(response.status).toBe(401)
    expect(formDataCalled).toBe(false)
  })
})
