/**
 * Fixtures below are tiny, hand-built, real (magic-byte- and header-valid)
 * files, generated once and verified against the real `file-type`/`image-size`
 * packages before being embedded here as base64 constants - see the module
 * doc comment in pipeline.ts for the file-type/SVG discovery this suite
 * exercises (an SVG with an XML prolog sniffs as `application/xml`, not
 * `undefined`).
 */
import { describe, expect, it } from 'vitest'

import { runFinalizePipeline, ALLOWED_UPLOAD_CONTENT_TYPES } from './pipeline'

// 1x1-scale raster fixtures. Each only contains the minimal header fields
// file-type/image-size actually read (no real pixel/entropy data) - both
// libraries only inspect fixed-offset header bytes for these tiny synthetic
// files, so they sniff/measure identically to a "real" encoder's output.

// PNG, 3x5, IHDR only (CRC bytes zeroed - neither file-type nor image-size
// validates chunk CRCs).
const PNG_3X5_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAYAAAAAAAAA'

// GIF89a, 4x6 logical screen descriptor.
const GIF_4X6_BASE64 = 'R0lGODlhBAAGAAAAADs='

// WEBP VP8X (extended header only, no VP8/VP8L bitstream), canvas 2x4.
const WEBP_2X4_BASE64 = 'UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAAQAAAwAA'

// Baseline JPEG: SOI + APP1/Exif (orientation=6, big-endian TIFF) + SOF0
// (raw/pre-rotation 4w x 8h). No scan data - image-size's JPG decoder returns
// as soon as it hits the first SOFn marker, so none is needed.
const JPEG_RAW_4X8_ORIENTATION_6_BASE64 =
  '/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/wAALCAAIAAQBAREA'

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
 * arbitrary width/height - same construction as PNG_3X5_BASE64 above (CRC
 * zeroed; file-type/image-size only read the fixed-offset header fields),
 * parametrized so the decompression-bomb test below can assert on dimensions
 * image-size actually reports without needing a real, fully-encoded
 * multi-megapixel fixture.
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
    const result = await runFinalizePipeline({ data: bytesOf(PNG_3X5_BASE64), filename: 'a.png' })
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
    const result = await runFinalizePipeline({ data: bytesOf(GIF_4X6_BASE64), filename: 'a.gif' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('raster')
    expect(result.meta.mime).toBe('image/gif')
    expect(result.meta.width).toBe(4)
    expect(result.meta.height).toBe(6)
  })

  it('accepts a WebP', async () => {
    const result = await runFinalizePipeline({ data: bytesOf(WEBP_2X4_BASE64), filename: 'a.webp' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.meta.kind).toBe('raster')
    expect(result.meta.mime).toBe('image/webp')
    expect(result.meta.width).toBe(2)
    expect(result.meta.height).toBe(4)
  })

  it('accepts a JPEG and swaps width/height for EXIF orientation 6 (90-degree rotation)', async () => {
    const result = await runFinalizePipeline({
      data: bytesOf(JPEG_RAW_4X8_ORIENTATION_6_BASE64),
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

  it('rejects a raster whose declared dimensions exceed the pixel-count cap (413), a decompression-bomb defense', async () => {
    // 30000x30000 = 900,000,000 pixels, comfortably within a 50 MiB byte cap
    // for a solid-color (highly compressible) real PNG, but far past
    // MAX_INPUT_PIXELS (4096x4096 = 16,777,216).
    const result = await runFinalizePipeline({
      data: makeMinimalPngHeader(30000, 30000),
      filename: 'bomb.png',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(413)
  })

  it('accepts a raster right at the pixel-count cap boundary', async () => {
    const result = await runFinalizePipeline({
      data: makeMinimalPngHeader(4096, 4096),
      filename: 'ok.png',
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a raster over the defensive 50 MiB byte cap (413), independent of dimensions', async () => {
    const header = bytesOf(PNG_3X5_BASE64)
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
      data: bytesOf(PNG_3X5_BASE64),
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
