/**
 * Security regression tests added in orchestrator review of the asset API PR:
 *
 * 1. A client-supplied stagingKey outside asset-staging/ must never reach the
 *    store — otherwise finalize's best-effort cleanup becomes an
 *    arbitrary-object delete (in a shared content bucket that reaches deploy
 *    artifacts under builds/).
 * 2. SVG style attributes carrying url(...) must be stripped (external-fetch
 *    tracking beacons when the SVG is opened as a document).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { finalizeStagedUpload, isValidStagingKey } from './finalize'
import { sanitizeSvg } from './svg-sanitizer'
import { LocalAssetStore } from './store-local'
import type { AssetMeta } from './types'

const SOME_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

describe('isValidStagingKey', () => {
  it('accepts a store-generated staging key', () => {
    expect(isValidStagingKey(`asset-staging/${SOME_UUID}`)).toBe(true)
  })

  it.each([
    'asset-meta/abcdef0123456789abcdef0123456789.json',
    'asset-originals/abcdef0123456789abcdef0123456789.png',
    'builds/abc123/index.html',
    `asset-staging/../asset-meta/${SOME_UUID}`,
    'asset-staging/not-a-uuid',
    `asset-staging/${SOME_UUID}/extra`,
    '',
  ])('rejects %s', (key) => {
    expect(isValidStagingKey(key)).toBe(false)
  })
})

describe('finalizeStagedUpload staging-key enforcement', () => {
  let root: string
  let store: LocalAssetStore

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'canopy-assets-sec-'))
    store = new LocalAssetStore({ root })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('rejects a non-staging key with 400 and does not delete the target', async () => {
    const meta: AssetMeta = {
      hash32: 'abcdef0123456789abcdef0123456789',
      filename: 'victim.svg',
      slug: 'victim',
      ext: 'svg',
      mime: 'image/svg+xml',
      size: 10,
      kind: 'svg',
      uploadedAt: new Date().toISOString(),
    }
    await store.putMetaIfAbsent(meta.hash32, meta)

    const result = await finalizeStagedUpload(store, `asset-meta/${meta.hash32}.json`, 'attack.png')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(400)
    // The would-be victim object must be untouched.
    expect(await store.getMeta(meta.hash32)).toEqual(meta)
  })

  it('store staging methods refuse non-staging keys outright', async () => {
    await expect(store.readStaging('asset-meta/x.json')).rejects.toThrow(/Not a staging key/)
    await expect(store.deleteStaging('assets/x/y.svg')).rejects.toThrow(/Not a staging key/)
    await expect(store.writeStaging('builds/x', new Uint8Array([1]))).rejects.toThrow(
      /Not a staging key/,
    )
  })
})

describe('sanitizeSvg style attribute hardening', () => {
  it('drops style attributes containing url()', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:red;background:url(https://evil.example/beacon)" width="10" height="10"/></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('url(')
    expect(clean).not.toContain('evil.example')
    expect(clean).toContain('<rect')
  })

  it('keeps benign style attributes', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:red" width="10" height="10"/></svg>'
    expect(sanitizeSvg(svg)).toContain('style="fill:red"')
  })

  // A plain `url(` match is bypassable with CSS escapes (`\75rl(...)` decodes
  // to `url(...)` in the browser's CSS parser). Backslashes have no legitimate
  // use in inline SVG style, so any style value containing one is dropped.
  it('drops style attributes using CSS-escape-obfuscated url()', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect style="background:\\75rl(https://evil.example/beacon)" width="10" height="10"/></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('evil.example')
    expect(clean).not.toContain('\\75')
    expect(clean).toContain('<rect')
  })
})

describe('sanitizeSvg url() hardening on paint/filter/marker presentation attributes', () => {
  // fill/stroke/filter/mask/clip-path/marker-* are all in ALLOWED_SVG_ATTRS
  // and each accepts a url(...) funciri - the same external-fetch beacon
  // vector style's url(...) carries, just on different attributes.
  it('drops an external url() on fill', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/beacon)" width="10" height="10"/></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('evil.example')
    expect(clean).not.toContain('fill=')
    expect(clean).toContain('<rect')
  })

  it('drops an external url() on filter', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect filter="url(https://evil.example/beacon)" width="10" height="10"/></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('evil.example')
    expect(clean).not.toContain('filter=')
    expect(clean).toContain('<rect')
  })

  it('drops an external url() on marker-end', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><path marker-end="url(https://evil.example/beacon)" d="M0 0"/></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('evil.example')
    expect(clean).not.toContain('marker-end=')
    expect(clean).toContain('<path')
  })

  it('keeps a local fragment url() reference on fill (gradient defs)', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="grad"/></defs><rect fill="url(#grad)" width="10" height="10"/></svg>'
    expect(sanitizeSvg(svg)).toContain('fill="url(#grad)"')
  })

  it('keeps a local fragment url() reference on filter', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><filter id="f"/><rect filter="url(#f)" width="10" height="10"/></svg>'
    expect(sanitizeSvg(svg)).toContain('filter="url(#f)"')
  })

  it('keeps a local fragment url() reference on marker-end', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><marker id="arrow"/><path marker-end="url(#arrow)" d="M0 0"/></svg>'
    expect(sanitizeSvg(svg)).toContain('marker-end="url(#arrow)"')
  })

  it('keeps benign (non-url) values on these attributes unchanged', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="red" stroke="none" width="10" height="10"/></svg>'
    const clean = sanitizeSvg(svg)
    expect(clean).toContain('fill="red"')
    expect(clean).toContain('stroke="none"')
  })

  it('drops a CSS-escape-obfuscated (backslash-containing) url() on fill, even when it looks local', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="\\75rl(#grad)" width="10" height="10"/></svg>'
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toContain('\\75')
    expect(clean).not.toContain('fill=')
  })
})
