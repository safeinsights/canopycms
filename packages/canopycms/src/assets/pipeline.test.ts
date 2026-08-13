/**
 * Raster fixtures below are genuinely decodable images generated at runtime
 * with sharp itself (`sharp({ create: ... })`), following transform.test.ts's
 * `makePng` pattern - NOT hand-built "header-only" base64 constants. Finalize
 * now forces a real pixel decode for raster kinds (see pipeline.ts's
 * `rasterIsDecodable`), so a fixture that only has a valid header (no real
 * IDAT/scan data) is correctly rejected rather than accepted - the exact
 * defect this validation exists to catch. `makeCorruptPng` below builds the
 * one deliberately-undecodable fixture the new rejection test needs: a real
 * sharp-encoded PNG with a few bytes flipped well past the fixed-offset
 * header fields file-type/image-size read, so it still sniffs/measures as a
 * valid PNG but sharp's real decoder rejects it.
 *
 * PDF and SVG fixtures are unaffected by decode validation (raster-only) and
 * stay as the original hand-built/text fixtures.
 */
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { mockConsole } from '../test-utils/console-spy'
import { runFinalizePipeline, ALLOWED_UPLOAD_CONTENT_TYPES } from './pipeline'
import { applyTransform } from './transform'
import {
  MAX_ANIMATED_FRAMES,
  MAX_INPUT_PIXELS,
  type TransformDirectives,
} from './transform-directives'

/** Cheapest transform that still forces a full decode - used to prove a fixture really is undecodable. */
const IDENTITY_TRANSFORM: TransformDirectives = { identity: true }

async function makePng(
  width: number,
  height: number,
  rgb: [number, number, number] = [10, 20, 30],
): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer()
  return new Uint8Array(buf)
}

async function makeGif(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .gif()
    .toBuffer()
  return new Uint8Array(buf)
}

async function makeWebp(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .webp()
    .toBuffer()
  return new Uint8Array(buf)
}

/** A JPEG with an EXIF orientation tag baked in via sharp's own withMetadata (raw sensor dims `width` x `height`, pre-rotation) - same construction as transform.test.ts's `makeOrientedJpeg`. */
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

/**
 * A real, header-valid PNG whose pixel data cannot actually be decoded -
 * reproduces the live defect (a PNG with a valid IHDR but a corrupt IDAT).
 * Starts from a genuinely sharp-encoded PNG, then zeroes a run of bytes well
 * past the fixed-offset IHDR chunk (signature[8] + length/type[8] +
 * data[13] + crc[4] = 33 bytes) so `file-type`'s magic-byte sniff and
 * `image-size`'s header parse both still succeed - only the zlib-compressed
 * IDAT payload sharp actually decodes is damaged.
 */
async function makeCorruptPng(width: number, height: number): Promise<Uint8Array> {
  const valid = Buffer.from(await makePng(width, height))
  const corrupted = Buffer.from(valid)
  const start = 40
  const end = Math.min(64, corrupted.length)
  for (let i = start; i < end; i++) {
    corrupted[i] = 0
  }
  return new Uint8Array(corrupted)
}

const ANIMATED_SIZE = 32

/**
 * Frames for a real animated GIF. Deliberately NOISY (a per-pixel gradient
 * that differs per frame) rather than solid-color: a solid frame compresses
 * to almost nothing, and consecutive identical frames risk being merged by
 * the GIF encoder, which would leave no later-frame LZW payload to corrupt -
 * the exact thing the animated tests below need to damage.
 */
async function animatedFrames(count: number): Promise<Buffer[]> {
  const frames: Buffer[] = []
  for (let i = 0; i < count; i++) {
    const px = Buffer.alloc(ANIMATED_SIZE * ANIMATED_SIZE * 3)
    for (let p = 0; p < ANIMATED_SIZE * ANIMATED_SIZE; p++) {
      px[p * 3] = (p * 7 + i * 53) % 256
      px[p * 3 + 1] = (p * 13 + i * 91) % 256
      px[p * 3 + 2] = (p * 29 + i * 17) % 256
    }
    frames.push(
      await sharp(px, { raw: { width: ANIMATED_SIZE, height: ANIMATED_SIZE, channels: 3 } })
        .png()
        .toBuffer(),
    )
  }
  return frames
}

/** A genuinely decodable multi-frame animated GIF, built the same way transform.test.ts builds its animated fixtures. */
async function makeAnimatedGif(frameCount: number): Promise<Uint8Array> {
  const buf = await sharp(await animatedFrames(frameCount), { join: { animated: true } })
    .gif()
    .toBuffer()
  return new Uint8Array(buf)
}

/**
 * A genuinely decodable multi-frame animated GIF at an arbitrary per-frame
 * size, for the frame-cap test below - which needs a large enough total pixel
 * count (frames x size x size) to actually exceed MAX_INPUT_PIXELS when read
 * uncapped. Frames are SOLID colours that differ by frame index (not
 * `animatedFrames()`'s noise) so the fixture stays tiny and fast to build at
 * hundreds of frames x hundreds of pixels - the noisy per-pixel gradient
 * exists for the *corrupt*-fixture tests, which need bytes worth damaging,
 * not for this one, which only needs frames the encoder won't merge away.
 */
async function makeLargeAnimatedGif(frameCount: number, size: number): Promise<Uint8Array> {
  const frames: Buffer[] = []
  for (let i = 0; i < frameCount; i++) {
    const buf = await sharp({
      create: {
        width: size,
        height: size,
        channels: 3,
        background: { r: (i * 37) % 256, g: (i * 91) % 256, b: (i * 53) % 256 },
      },
    })
      .png()
      .toBuffer()
    frames.push(buf)
  }
  const buf = await sharp(frames, { join: { animated: true } })
    .gif()
    .toBuffer()
  return new Uint8Array(buf)
}

/**
 * An animated GIF whose FRAME 0 decodes cleanly but whose later frames do
 * not - the animated analogue of `makeCorruptPng` above, and the fixture for
 * the decoder-parity defect: finalize used to decode only frame 0 (sharp's
 * `pages` default of 1) while the transform engine decodes
 * `min(totalPages, MAX_ANIMATED_FRAMES)`, so this file passed upload and then
 * threw `gifload_buffer: Invalid frame data` at render time.
 *
 * The damaged run starts 60% into the file, past frame 0's LZW data (swept
 * empirically across offsets/lengths - this one sits in the middle of a wide
 * band that reproduces). Nothing here is load-bearing on that exact number,
 * though: the test using this fixture ALSO asserts `applyTransform` rejects
 * it, so if a future sharp/cgif encoder ever shifted the layout enough that
 * these bytes stopped mattering, the test would fail loudly rather than
 * silently passing against a fixture that is no longer corrupt.
 */
async function makeCorruptAnimatedGif(frameCount: number): Promise<Uint8Array> {
  const valid = Buffer.from(await makeAnimatedGif(frameCount))
  const corrupted = Buffer.from(valid)
  const start = Math.floor(corrupted.length * 0.6)
  const end = Math.min(start + 64, corrupted.length - 1)
  for (let i = start; i < end; i++) {
    corrupted[i] ^= 0xff
  }
  return new Uint8Array(corrupted)
}

// Minimal but structurally real PDF (catalog/pages/page/xref/trailer).
const MINIMAL_PDF_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAyMDAgMjAwXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjAKJSVFT0Y='

const dirtySvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" onload="alert(1)">
  <script>alert('xss')</script>
  <rect width="50" height="50" onclick="alert(2)" fill="red" />
  <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">evil</div></foreignObject>
  <image href="https://evil.example.com/track.png" />
</svg>`

const bareSvg = (): Uint8Array =>
  new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20"><rect width="10" height="20"/></svg>',
  )

function bytesOf(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

/**
 * Build a minimal (IHDR-only, no pixel/scan data) PNG header for an
 * arbitrary width/height, parametrized so the decompression-bomb test below
 * can assert on dimensions image-size actually reports without needing a
 * real, fully-encoded multi-hundred-megapixel fixture. This fixture is
 * rejected on the cheap header-based pixel-count cap BEFORE the real decode
 * check ever runs (see pipeline.ts's ordering), so it deliberately stays
 * header-only rather than becoming a real (and enormous) sharp image.
 */
function makeMinimalPngHeader(width: number, height: number): Uint8Array {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  buf[24] = 8 // bit depth
  buf[25] = 6 // color type: RGBA
  buf[26] = 0 // compression method
  buf[27] = 0 // filter method
  buf[28] = 0 // interlace method
  // bytes 29-32 (CRC) intentionally left zeroed
  return new Uint8Array(buf)
}

describe('runFinalizePipeline - raster formats', () => {
  it('accepts a PNG, sniffing the real type and extracting dimensions', async () => {
    const result = await runFinalizePipeline({ data: await makePng(3, 5), filename: 'a.png' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('raster')
    expect(result.meta.mime).toBe('image/png')
    expect(result.meta.ext).toBe('png')
    expect(result.meta.width).toBe(3)
    expect(result.meta.height).toBe(5)
    expect(result.publicObject).toBeUndefined() // rasters have no static public object
  })

  it('accepts a GIF', async () => {
    const result = await runFinalizePipeline({ data: await makeGif(4, 6), filename: 'a.gif' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('raster')
    expect(result.meta.mime).toBe('image/gif')
    expect(result.meta.width).toBe(4)
    expect(result.meta.height).toBe(6)
  })

  it('accepts a WebP', async () => {
    const result = await runFinalizePipeline({ data: await makeWebp(2, 4), filename: 'a.webp' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('raster')
    expect(result.meta.mime).toBe('image/webp')
    expect(result.meta.width).toBe(2)
    expect(result.meta.height).toBe(4)
  })

  it('accepts a JPEG and swaps width/height for EXIF orientation 6 (90-degree rotation)', async () => {
    const result = await runFinalizePipeline({
      data: await makeOrientedJpeg(4, 8, 6),
      filename: 'photo.jpg',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('raster')
    expect(result.meta.mime).toBe('image/jpeg')
    expect(result.meta.ext).toBe('jpg')
    // Raw sensor dims are 4w x 8h; orientation 6 rotates 90 degrees, so the
    // displayed/stored dims must be swapped to 8w x 4h.
    expect(result.meta.width).toBe(8)
    expect(result.meta.height).toBe(4)
  })

  it('rejects a header-valid but undecodable raster (422), the "accepted at upload, unrenderable forever" defect', async () => {
    // mockConsole even though this test doesn't assert on the log: rejecting
    // the upload deliberately warns with the real libvips reason, and the
    // suite fails any test that writes to stderr (test-output-noise guard).
    const consoleSpy = mockConsole()
    try {
      const corrupt = await makeCorruptPng(16, 16)
      const result = await runFinalizePipeline({ data: corrupt, filename: 'corrupt.png' })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(422)
      // User-facing message, not a raw libvips string like "vipspng: libpng read error".
      expect(result.error).toMatch(/could not be decoded/i)
      expect(result.error).not.toMatch(/vips|libpng/i)
    } finally {
      consoleSpy.restore()
    }
  })

  it('logs (does not throw) the real decode failure reason for the undecodable raster', async () => {
    const consoleSpy = mockConsole()
    try {
      const corrupt = await makeCorruptPng(16, 16)
      await runFinalizePipeline({ data: corrupt, filename: 'corrupt.png' })
      expect(consoleSpy).toHaveWarned(/decode/i)
    } finally {
      // restore in a finally so a failed assertion doesn't leak the spy into
      // sibling tests (and take the stderr guard down with it).
      consoleSpy.restore()
    }
  })

  it('rejects an animated GIF whose LATER frames are corrupt (422), even though frame 0 decodes cleanly', async () => {
    const consoleSpy = mockConsole()
    try {
      const corrupt = await makeCorruptAnimatedGif(5)

      // Self-validating fixture: prove the bytes really are undecodable to the
      // engine that ultimately renders them, so this test can never pass
      // vacuously against a fixture that stopped being corrupt. This assertion
      // IS the defect - the transform engine rejecting what finalize accepted
      // is precisely the "uploads fine, renders broken" state - so pinning both
      // halves in one test is what keeps the two decoders in agreement.
      const transformed = await applyTransform({ data: corrupt, ext: 'gif' }, IDENTITY_TRANSFORM)
      expect(transformed.ok).toBe(false)
      if (!transformed.ok) expect(transformed.status).toBe(422)

      const result = await runFinalizePipeline({ data: corrupt, filename: 'animated.gif' })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.status).toBe(422)
      expect(result.error).toMatch(/could not be decoded/i)
      expect(result.error).not.toMatch(/vips|gifload/i)
    } finally {
      consoleSpy.restore()
    }
  })

  it('still accepts a VALID animated GIF - decoding every frame must not over-reject', async () => {
    const gif = await makeAnimatedGif(5)
    const result = await runFinalizePipeline({ data: gif, filename: 'valid-animated.gif' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('raster')
    expect(result.meta.mime).toBe('image/gif')
    // image-size reports a single frame's dimensions, not the stacked strip.
    expect(result.meta.width).toBe(ANIMATED_SIZE)
    expect(result.meta.height).toBe(ANIMATED_SIZE)
  })

  it('accepts a valid animation with MORE frames than the cap - it is capped, not rejected', async () => {
    // The OLD version of this test used 65 frames of 32x32 (animatedFrames'
    // fixed size) - 66,560 total pixels, nowhere near MAX_INPUT_PIXELS
    // (16,777,216) even read completely uncapped. Nothing distinguished
    // "accepted because capped" from "accepted because an uncapped read fit
    // too" - the test passed identically with the Math.min cap in
    // rasterIsDecodable (pipeline.ts) deleted outright.
    //
    // This version picks a per-frame size where the arithmetic actually
    // forces the distinction:
    //   FRAMES = MAX_ANIMATED_FRAMES (60) + 5 = 65
    //   SIZE   = 512
    //   FRAMES * SIZE^2 = 65 * 512 * 512 = 17,039,360  > MAX_INPUT_PIXELS  (uncapped read: over budget)
    //   MAX_ANIMATED_FRAMES * SIZE^2 = 60 * 512 * 512  = 15,728,640 <= MAX_INPUT_PIXELS  (capped read: fits)
    //   SIZE^2 = 512 * 512 = 262,144 <= MAX_INPUT_PIXELS  (the caller's cheap single-frame header check still passes)
    // So acceptance below can only be explained by the cap actually applying
    // - an uncapped decode of these exact bytes is asserted to fail two
    // lines down, before the behavior-under-test assertion even runs.
    const FRAMES = MAX_ANIMATED_FRAMES + 5
    const SIZE = 512
    const gif = await makeLargeAnimatedGif(FRAMES, SIZE)

    // Sanity: the fixture really has the frame count and per-frame
    // dimensions the arithmetic above assumes.
    const meta = await sharp(gif).metadata()
    expect(meta.pages).toBe(FRAMES)
    expect(meta.width).toBe(SIZE)
    expect(meta.height).toBe(SIZE)

    // The vacuity guard, and what makes this fixture self-validating (same
    // idiom as the "LATER frames are corrupt" test above): decoding the SAME
    // bytes UNCAPPED must be rejected by sharp's own pixel-limit accounting.
    // If a future sharp/libvips release ever changed how it counts pixels
    // for a multi-page read such that this no longer held, this assertion
    // fails loudly here instead of the acceptance assertion below passing
    // for a reason that has nothing to do with the cap.
    await expect(
      sharp(gif, { pages: FRAMES, limitInputPixels: MAX_INPUT_PIXELS })
        .resize({ width: 8, height: 8, fit: 'fill' })
        .toBuffer(),
    ).rejects.toThrow()

    // The behavior under test: rasterIsDecodable's
    // `Math.min(probeMeta.pages ?? 1, MAX_ANIMATED_FRAMES)` is what turns the
    // same bytes from a rejection into a normal, successful acceptance.
    const result = await runFinalizePipeline({ data: gif, filename: 'long-animated.gif' })
    expect(result.ok).toBe(true)
  })

  it('rejects a raster whose declared dimensions exceed the pixel-count cap (413), a decompression-bomb defense', async () => {
    // 30000x30000 = 900,000,000 pixels, comfortably within a 50 MiB byte cap
    // for a solid-color (highly compressible) real PNG, but far past
    // MAX_INPUT_PIXELS (4096x4096 = 16,777,216). Header-only: this is
    // rejected by the cheap header-based pixel-count check before the real
    // decode check ever runs, so it never needs to be a genuine 900M-pixel
    // sharp image.
    const result = await runFinalizePipeline({
      data: makeMinimalPngHeader(30000, 30000),
      filename: 'bomb.png',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(413)
  })

  it('accepts a genuinely decodable raster right at the pixel-count cap boundary', async () => {
    const atCap = Math.sqrt(MAX_INPUT_PIXELS)
    expect(Number.isInteger(atCap)).toBe(true) // 4096x4096 - sanity-check the cap is a perfect square before relying on it below
    const result = await runFinalizePipeline({
      data: await makePng(atCap, atCap),
      filename: 'ok.png',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.width).toBe(atCap)
    expect(result.meta.height).toBe(atCap)
  })

  it('rejects a raster over the defensive 50 MiB byte cap (413), independent of dimensions', async () => {
    const header = await makePng(3, 5)
    const oversized = new Uint8Array(50 * 1024 * 1024 + 1)
    oversized.set(header, 0)
    const result = await runFinalizePipeline({ data: oversized, filename: 'huge.png' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(413)
  })

  it('rejects random bytes with no recognizable magic number (415)', async () => {
    const result = await runFinalizePipeline({
      data: new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x10, 0x20, 0x30, 0x99, 0x88]),
      filename: 'mystery.bin',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(415)
  })
})

describe('runFinalizePipeline - PDF', () => {
  it('accepts a real (magic-byte and structurally valid) PDF, no dims', async () => {
    const result = await runFinalizePipeline({
      data: bytesOf(MINIMAL_PDF_BASE64),
      filename: 'doc.pdf',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('pdf')
    expect(result.meta.mime).toBe('application/pdf')
    expect(result.meta.width).toBeUndefined()
    expect(result.meta.height).toBeUndefined()
    expect(result.publicObject).toBeDefined()
    expect(result.publicObject?.contentDisposition).toContain('attachment')
  })

  it('rejects a PDF over the 25 MiB cap (413)', async () => {
    const header = bytesOf(MINIMAL_PDF_BASE64)
    const oversized = new Uint8Array(25 * 1024 * 1024 + 1)
    oversized.set(header, 0)
    const result = await runFinalizePipeline({ data: oversized, filename: 'huge.pdf' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(413)
  })
})

describe('runFinalizePipeline - SVG', () => {
  it('sanitizes a script/onload/foreignObject-laden SVG and still accepts it', async () => {
    const result = await runFinalizePipeline({
      data: new TextEncoder().encode(dirtySvg),
      filename: 'evil.svg',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('svg')
    expect(result.meta.mime).toBe('image/svg+xml')

    const sanitized = Buffer.from(result.data).toString('utf-8')
    expect(sanitized).not.toMatch(/<script/i)
    expect(sanitized).not.toMatch(/onload/i)
    expect(sanitized).not.toMatch(/onclick/i)
    expect(sanitized).not.toMatch(/foreignobject/i)
    expect(sanitized).not.toMatch(/evil\.example\.com/i)
    // Still a parseable svg document.
    expect(sanitized.trim().toLowerCase()).toMatch(/^<svg[\s>]/)

    // Hash must be over the SANITIZED bytes, not the original dirty input -
    // otherwise two different original payloads that sanitize to the same
    // output could get two different hashes (or vice versa).
    const { hashBytes } = await import('./keys')
    expect(result.meta.hash32).toBe(hashBytes(result.data))
    expect(result.meta.hash32).not.toBe(hashBytes(new TextEncoder().encode(dirtySvg)))

    expect(result.publicObject).toBeDefined()
    expect(result.publicObject?.contentDisposition).toContain('inline')
  })

  it('accepts a bare (no XML prolog) SVG and extracts viewBox dimensions', async () => {
    const result = await runFinalizePipeline({ data: bareSvg(), filename: 'plain.svg' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('svg')
    expect(result.meta.width).toBe(10)
    expect(result.meta.height).toBe(20)
  })

  it('accepts an XML-prolog SVG even though file-type positively sniffs it as application/xml', async () => {
    // Documented discovery (see pipeline.ts doc comment): file-type does NOT
    // return `undefined` for every SVG - one with an XML prolog is sniffed as
    // generic `application/xml`, which is not in the raster/pdf allowlist.
    // The pipeline must still recognize this as an SVG rather than reject it.
    const result = await runFinalizePipeline({
      data: new TextEncoder().encode(
        '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
      ),
      filename: 'prolog.svg',
    })
    expect(result.ok).toBe(true)
  })

  it('rejects SVG-disguised junk that decodes as text but has no <svg> root (415)', async () => {
    const result = await runFinalizePipeline({
      data: new TextEncoder().encode('this is not an svg file at all, just junk text pretending'),
      filename: 'fake.svg',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(415)
  })
})

describe('runFinalizePipeline - filenames and Content-Disposition safety', () => {
  it('safely encodes a filename containing header-injection characters (no literal CRLF)', async () => {
    const evilFilename = 'evil"; injected\r\nX-Injected: true.pdf'
    const result = await runFinalizePipeline({
      data: bytesOf(MINIMAL_PDF_BASE64),
      filename: evilFilename,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The exact original filename is preserved in meta...
    expect(result.meta.filename).toBe(evilFilename)
    // ...but never interpolated raw into the Content-Disposition header value.
    const disposition = result.publicObject?.contentDisposition ?? ''
    expect(disposition).not.toMatch(/\r|\n/)
  })

  it("encodes a unicode filename via RFC 5987 (filename*=UTF-8'')", async () => {
    const unicodeFilename = 'café résumé 日本語.pdf'
    const result = await runFinalizePipeline({
      data: bytesOf(MINIMAL_PDF_BASE64),
      filename: unicodeFilename,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.filename).toBe(unicodeFilename)
    expect(result.publicObject?.contentDisposition).toMatch(/filename\*=UTF-8''/)
  })

  it('slugifies a unicode filename into a safe ASCII slug', async () => {
    const result = await runFinalizePipeline({
      data: await makePng(4, 4),
      filename: 'café photo.png',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.slug).toMatch(/^[a-z0-9-]+$/)
  })
})

describe('ALLOWED_UPLOAD_CONTENT_TYPES', () => {
  it('includes every pipeline-supported mime type', () => {
    expect(ALLOWED_UPLOAD_CONTENT_TYPES.has('image/png')).toBe(true)
    expect(ALLOWED_UPLOAD_CONTENT_TYPES.has('image/jpeg')).toBe(true)
    expect(ALLOWED_UPLOAD_CONTENT_TYPES.has('image/webp')).toBe(true)
    expect(ALLOWED_UPLOAD_CONTENT_TYPES.has('image/gif')).toBe(true)
    expect(ALLOWED_UPLOAD_CONTENT_TYPES.has('image/svg+xml')).toBe(true)
    expect(ALLOWED_UPLOAD_CONTENT_TYPES.has('application/pdf')).toBe(true)
    expect(ALLOWED_UPLOAD_CONTENT_TYPES.has('application/octet-stream')).toBe(false)
  })
})
