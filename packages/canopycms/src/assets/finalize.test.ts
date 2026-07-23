import { describe, expect, it, vi } from 'vitest'

import { finalizeAsset, finalizeStagedUpload } from './finalize'
import type { AssetMeta, AssetStore } from './types'

// Same PNG fixture as pipeline.test.ts (IHDR-only, 3x5, no pixel data).
const PNG_3X5_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAYAAAAAAAAA'
const pngBytes = (): Uint8Array => new Uint8Array(Buffer.from(PNG_3X5_BASE64, 'base64'))

function makeStore(overrides: Partial<AssetStore> = {}): AssetStore {
  return {
    capabilities: { directUpload: false },
    beginUpload: vi.fn(),
    writeStaging: vi.fn(),
    readStaging: vi.fn().mockResolvedValue(null),
    deleteStaging: vi.fn().mockResolvedValue(undefined),
    putOriginal: vi.fn().mockResolvedValue(undefined),
    readOriginal: vi.fn(),
    putPublicObject: vi.fn().mockResolvedValue(undefined),
    readPublicObject: vi.fn(),
    putMetaIfAbsent: vi.fn().mockResolvedValue('created'),
    getMeta: vi.fn().mockResolvedValue(null),
    listMeta: vi.fn(),
    deleteMeta: vi.fn(),
    ...overrides,
  }
}

describe('finalizeAsset', () => {
  it('dedups: an existing meta for the same hash skips all writes', async () => {
    const existing: AssetMeta = {
      hash32: 'x'.repeat(32),
      filename: 'first.png',
      slug: 'first',
      ext: 'png',
      mime: 'image/png',
      size: 5,
      kind: 'raster',
      uploadedAt: '2026-01-01T00:00:00.000Z',
    }
    const store = makeStore({ getMeta: vi.fn().mockResolvedValue(existing) })

    const result = await finalizeAsset(store, { data: pngBytes(), filename: 'second.png' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta).toBe(existing) // first-name-wins: existing meta returned verbatim
    expect(store.putOriginal).not.toHaveBeenCalled()
    expect(store.putPublicObject).not.toHaveBeenCalled()
    expect(store.putMetaIfAbsent).not.toHaveBeenCalled()
  })

  it('happy path: writes original then meta last (meta is the commit point)', async () => {
    const store = makeStore()
    const calls: string[] = []
    ;(store.putOriginal as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('putOriginal')
    })
    ;(store.putMetaIfAbsent as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls.push('putMetaIfAbsent')
      return 'created'
    })

    const result = await finalizeAsset(store, { data: pngBytes(), filename: 'a.png' })

    expect(result.ok).toBe(true)
    expect(calls).toEqual(['putOriginal', 'putMetaIfAbsent'])
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
      hash32: 'y'.repeat(32),
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

    const result = await finalizeAsset(store, { data: pngBytes(), filename: 'loser.png' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta).toBe(winner)
    expect(getMetaCalls).toBe(2)
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
    const store = makeStore({ readStaging: vi.fn().mockResolvedValue(pngBytes()) })

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
      readStaging: vi.fn().mockResolvedValue(pngBytes()),
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
