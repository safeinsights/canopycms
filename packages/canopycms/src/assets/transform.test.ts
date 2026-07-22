/**
 * Real-sharp tests over synthetic fixtures generated with sharp itself
 * (`sharp({ create: ... })`), not the hand-built "header-only" fixtures in
 * pipeline.test.ts - those are magic-byte/dimension-header valid but contain
 * no actual pixel/scan data, so they sniff correctly for file-type/image-size
 * but are NOT decodable by sharp (which needs to actually decode pixels).
 * Generating fixtures with sharp guarantees they're genuinely valid inputs.
 */
import { imageSize } from 'image-size'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

import { applyTransform } from './transform'
import type { TransformDirectives } from './transform-directives'

const IDENTITY: TransformDirectives = { identity: true }

function resize(
  fields: Omit<Extract<TransformDirectives, { identity: false }>, 'identity'>,
): TransformDirectives {
  return { identity: false, ...fields }
}

async function makePng(
  width: number,
  height: number,
  rgb: [number, number, number],
): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer()
  return new Uint8Array(buf)
}

/** A JPEG with an EXIF orientation tag baked in via sharp's own withMetadata (raw sensor dims `width` x `height`, pre-rotation). */
async function makeOrientedJpeg(
  width: number,
  height: number,
  orientation: number,
): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 200, b: 30 } },
  })
    .jpeg()
    .withMetadata({ orientation })
    .toBuffer()
  return new Uint8Array(buf)
}

/** Two-color image: left half one color, right half another - for crop-region verification. */
async function makeSplitPng(
  width: number,
  height: number,
  left: [number, number, number],
  right: [number, number, number],
): Promise<Uint8Array> {
  const half = Math.floor(width / 2)
  const leftHalf = sharp({
    create: {
      width: half,
      height,
      channels: 3,
      background: { r: left[0], g: left[1], b: left[2] },
    },
  })
    .png()
    .toBuffer()
  const rightHalf = sharp({
    create: {
      width: width - half,
      height,
      channels: 3,
      background: { r: right[0], g: right[1], b: right[2] },
    },
  })
    .png()
    .toBuffer()
  const [leftBuf, rightBuf] = await Promise.all([leftHalf, rightHalf])
  const buf = await sharp({ create: { width, height, channels: 3, background: '#000000' } })
    .composite([
      { input: leftBuf, left: 0, top: 0 },
      { input: rightBuf, left: half, top: 0 },
    ])
    .png()
    .toBuffer()
  return new Uint8Array(buf)
}

describe('applyTransform - resize', () => {
  it('resizes down to a target width, preserving aspect ratio', async () => {
    const data = await makePng(800, 400, [200, 10, 10])
    const result = await applyTransform({ data, ext: 'png' }, resize({ width: 160 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const dims = imageSize(Buffer.from(result.data))
    expect(dims.width).toBe(160)
    expect(dims.height).toBe(80)
    expect(result.contentType).toBe('image/png')
  })

  it('never upscales - withoutEnlargement keeps the source width when requested width is larger', async () => {
    const data = await makePng(10, 10, [1, 2, 3])
    const result = await applyTransform({ data, ext: 'png' }, resize({ width: 4096 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const dims = imageSize(Buffer.from(result.data))
    expect(dims.width).toBe(10)
    expect(dims.height).toBe(10)
  })
})

describe('applyTransform - format conversion', () => {
  it('converts to webp (RIFF/WEBP magic bytes) and reports the webp content type', async () => {
    const data = await makePng(20, 20, [5, 6, 7])
    const result = await applyTransform({ data, ext: 'png' }, resize({ format: 'webp' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const bytes = Buffer.from(result.data)
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP')
    expect(result.contentType).toBe('image/webp')
    expect(result.ext).toBe('webp')
  })

  it('identity on a gif stays a gif (no EXIF segment exists in GIF to strip, but re-encodes for pipeline uniformity)', async () => {
    const source = await sharp({
      create: { width: 6, height: 6, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .gif()
      .toBuffer()
    const result = await applyTransform({ data: new Uint8Array(source), ext: 'gif' }, IDENTITY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Buffer.from(result.data).subarray(0, 6).toString('ascii')).toBe('GIF89a')
    expect(result.contentType).toBe('image/gif')
    expect(result.ext).toBe('gif')
  })
})

describe('applyTransform - EXIF orientation + metadata stripping', () => {
  it('bakes orientation into pixels (dims swap) and strips EXIF entirely, even for identity', async () => {
    const data = await makeOrientedJpeg(4, 8, 6) // orientation 6: 90-degree rotation
    const preDims = imageSize(Buffer.from(data))
    expect(preDims.width).toBe(4)
    expect(preDims.height).toBe(8)
    expect(preDims.orientation).toBe(6)

    const result = await applyTransform({ data, ext: 'jpg' }, IDENTITY)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const postDims = imageSize(Buffer.from(result.data))
    // Orientation 6 is a 90-degree rotation, so baking it swaps width/height.
    expect(postDims.width).toBe(8)
    expect(postDims.height).toBe(4)
    expect(postDims.orientation).toBeUndefined()

    const postMeta = await sharp(Buffer.from(result.data)).metadata()
    expect(postMeta.exif).toBeUndefined()
  })
})

describe('applyTransform - crop', () => {
  it('extracts the requested normalized region (right half of a split-color image)', async () => {
    const data = await makeSplitPng(100, 50, [255, 0, 0], [0, 0, 255])
    const result = await applyTransform(
      { data, ext: 'png' },
      resize({ crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const dims = imageSize(Buffer.from(result.data))
    expect(dims.width).toBe(50)
    expect(dims.height).toBe(50)

    const { data: pixels, info } = await sharp(Buffer.from(result.data))
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(info.channels).toBeGreaterThanOrEqual(3)
    // Sample the top-left pixel of the cropped region - should be the right
    // (blue) half's color, not the left (red) half's.
    expect(pixels[0]).toBeLessThan(50) // r
    expect(pixels[2]).toBeGreaterThan(200) // b
  })
})

describe('applyTransform - input rejection', () => {
  it('rejects svg input (raster-only; svg is served statically)', async () => {
    const result = await applyTransform(
      { data: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), ext: 'svg' },
      IDENTITY,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
  })

  it('rejects pdf input', async () => {
    const result = await applyTransform(
      { data: new Uint8Array([0x25, 0x50, 0x44, 0x46]), ext: 'pdf' },
      IDENTITY,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
  })

  it('rejects non-raster junk that claims a raster ext but is not decodable', async () => {
    const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09])
    const result = await applyTransform({ data: junk, ext: 'png' }, IDENTITY)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
  })
})

describe('applyTransform - output size cap', () => {
  it('rejects an encoded output that exceeds the 10 MiB cap', async () => {
    const data = await makePng(20, 20, [1, 1, 1])
    const spy = vi
      .spyOn(sharp.prototype, 'toBuffer')
      .mockResolvedValueOnce(Buffer.alloc(11 * 1024 * 1024))
    const result = await applyTransform({ data, ext: 'png' }, IDENTITY)
    spy.mockRestore()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(413)
  })
})
