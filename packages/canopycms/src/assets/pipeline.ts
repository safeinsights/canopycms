/**
 * Finalize pipeline: turns raw uploaded bytes into a validated AssetMeta
 * (+ optional public object for svg/pdf), or a typed rejection. Pure
 * transform - no store I/O here (see finalize.ts for the store orchestration
 * that dedups, writes, and calls this).
 *
 * Server-only - never import this module from client/editor code. It pulls
 * in `file-type`, `image-size`, and the SVG sanitizer, none of which belong
 * in a browser bundle. `sharp` is loaded dynamically (see
 * `rasterIsDecodable` below) rather than statically imported, but is just as
 * server-only - it is never reachable from a browser bundle either way.
 */

import { fileTypeFromBuffer } from 'file-type'
import { imageSize } from 'image-size'
import { create as createContentDisposition } from 'content-disposition'

import { getErrorMessage } from '../utils/error'
import { hashBytes, publicKey, slugifyFilename } from './keys'
import { sanitizeSvg } from './svg-sanitizer'
import { MAX_ANIMATED_FRAMES, MAX_INPUT_PIXELS } from './transform-directives'
import type { AssetMeta } from './types'

const RASTER_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const PDF_MIME_TYPE = 'application/pdf'
const SVG_MIME_TYPE = 'image/svg+xml'

/** Client-declared content types accepted at presign time (UX only - never trusted at finalize). */
export const ALLOWED_UPLOAD_CONTENT_TYPES = new Set<string>([
  ...RASTER_MIME_TYPES,
  PDF_MIME_TYPE,
  SVG_MIME_TYPE,
])

const PDF_MAX_BYTES = 25 * 1024 * 1024

/**
 * Defensive raster byte cap, independent of whatever the configured
 * AssetStore's own upload-size limit happens to be (that limit lives at the
 * store/API boundary, not here) - mirrors PDF_MAX_BYTES's role as a
 * pipeline-level backstop rather than the sole enforcement point.
 */
const RASTER_MAX_BYTES = 50 * 1024 * 1024

/** EXIF orientation values 5-8 are 90-degree rotations, which swap width/height. */
const isRotated90 = (orientation: number | undefined): boolean =>
  orientation !== undefined && orientation >= 5 && orientation <= 8

const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable'

export interface FinalizeInput {
  data: Uint8Array
  filename: string
  uploadedBy?: string
}

export interface FinalizePublicObject {
  key: string
  data: Uint8Array
  contentType: string
  contentDisposition: string
  cacheControl: string
}

export interface FinalizeSuccess {
  ok: true
  meta: AssetMeta
  /** Canonical bytes to persist as the original - sanitized bytes for svg, untouched otherwise. */
  data: Uint8Array
  publicObject?: FinalizePublicObject
}

export interface FinalizeRejection {
  ok: false
  /**
   * 413: over a size/pixel cap. 415: unrecognized/unsupported file type.
   * 422: recognized, in-limits raster whose bytes do not actually decode -
   * the same status `applyTransform` (transform.ts) uses for a decode
   * failure, so a client sees one consistent status for "this file's bytes
   * don't decode" regardless of which half of the pipeline caught it.
   */
  status: 413 | 415 | 422
  error: string
}

export type FinalizeResult = FinalizeSuccess | FinalizeRejection

/** U+FEFF (byte-order mark). Built from a char code, not a literal, so this file's source stays pure ASCII. */
const BOM = String.fromCharCode(0xfeff)

/**
 * Strip anything that may legally precede the root `<svg>` element: a BOM,
 * whitespace, XML comments, the `<?xml ... ?>` prolog, and a `<!DOCTYPE ...>`
 * declaration - in any order, any number of times (some tools emit more than
 * one comment). Loops until a pass makes no further change.
 */
function stripSvgPreamble(text: string): string {
  let stripped = text.startsWith(BOM) ? text.slice(BOM.length) : text
  let previous: string
  do {
    previous = stripped
    stripped = stripped.replace(/^\s+/, '')
    stripped = stripped.replace(/^<!--[\s\S]*?-->/, '')
    stripped = stripped.replace(/^<\?xml[\s\S]*?\?>/i, '')
    stripped = stripped.replace(/^<!DOCTYPE[\s\S]*?>/i, '')
  } while (stripped !== previous)
  return stripped
}

/**
 * Detect whether `data` is an SVG document. `file-type` cannot do this (SVG is
 * a text format, not magic-byte-detectable) - and, discovered empirically,
 * `file-type` does NOT simply return `undefined` for all SVGs either: an SVG
 * with an `<?xml ?>` prolog gets positively sniffed as generic `application/xml`.
 * So the pipeline's real branch condition is "not a recognized raster/pdf mime"
 * (which covers both file-type returning undefined AND returning some other
 * non-allowlisted guess like application/xml), and within that branch this
 * function does the actual SVG determination: decode as UTF-8 (reject on
 * failure), strip anything that may precede the root element, and require the
 * first element to be `<svg` (case-insensitive).
 *
 * Returns the decoded text on success (so the caller doesn't have to decode
 * twice), or `null` if this is not a decodable SVG document.
 */
function sniffSvg(data: Uint8Array): string | null {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return null
  }
  const stripped = stripSvgPreamble(text)
  return /^<svg[\s>/]/i.test(stripped) ? text : null
}

/**
 * Extract width/height (rasters and svg only - PDFs have no pixel dims).
 * Non-fatal on failure: a corrupt-but-magic-byte-valid file still finalizes,
 * just without dimensions (AssetMeta.width/height are optional).
 */
function computeDimensions(data: Uint8Array): { width?: number; height?: number } {
  try {
    const result = imageSize(data)
    let { width, height } = result
    if (isRotated90(result.orientation)) {
      ;[width, height] = [height, width]
    }
    return { width, height }
  } catch {
    return {}
  }
}

/** Output dims for the throwaway decode-validation resize below - tiny enough that the encode side costs nothing; what has to be bounded is the mandatory decode, not this. */
const DECODE_CHECK_SIZE = 8

/**
 * User-facing rejection message for an undecodable raster - deliberately
 * generic (never the raw libvips string, e.g. "vipspng: libpng read error"),
 * matching how the sniff/size rejections above also speak in terms an editor
 * can act on rather than surfacing library internals.
 */
const UNDECODABLE_RASTER_ERROR =
  'This image could not be decoded - it may be corrupt or truncated. Try re-exporting it and uploading again.'

/**
 * Force a REAL pixel decode of a raster upload, catching the defect
 * `computeDimensions` above (header-only, explicitly non-fatal) cannot: a
 * corrupt PNG IDAT / truncated JPEG scan / etc. still carries a perfectly
 * valid IHDR/SOF, so `file-type`/`image-size` both accept bytes that the
 * transform engine's real sharp/libvips decoder (transform.ts's
 * `applyTransform`) later refuses - with a raw "vipspng: libpng read error"
 * - by which point the asset has already "uploaded successfully" and renders
 * broken everywhere it's shown. This makes finalize use the same decoder
 * transform.ts does, before the bytes are ever persisted, instead of only
 * discovering the mismatch at render time.
 *
 * `.resize()` to a tiny output - NOT `.metadata()` - is what makes this a
 * real test: `metadata()` only reads header fields, exactly what
 * `computeDimensions` above already does and exactly what fails to catch
 * this class of bug. libvips cannot compute a resized pixel buffer without
 * fully decoding the source, so a corrupt IDAT/scan still throws here even
 * though it would not throw from a header-only read. The output itself is
 * immediately discarded - decode is the expensive, unavoidable part of this
 * check; encoding an 8x8 buffer is not.
 *
 * ANIMATION: sharp defaults to `pages: 1`, i.e. frame 0 only. That is not
 * enough to mirror `applyTransform`, which reads
 * `min(totalPages, MAX_ANIMATED_FRAMES)` frames - a GIF/WebP whose frame 0 is
 * clean but whose frame 3 is corrupt passed this check and then threw
 * `gifload_buffer: Invalid frame data` at transform time, which is the very
 * "accepted at upload, unrenderable at render" state this function exists to
 * prevent, just moved from single-frame to animated sources. So the page
 * count is probed and passed through, with the SAME cap constant transform.ts
 * uses (both import it from transform-directives.ts) - which also means the
 * two sides ignore the same frames past the cap, so a many-hundred-frame
 * source cannot produce a disagreement either.
 *
 * The probe is a separate, deliberate step rather than a guess: sharp's
 * `pages` is a fixed request, not an upper bound, so a value EXCEEDING the
 * source's real page count makes it throw "bad page number" (transform.ts
 * documents the same constraint at its own call site). A metadata-only probe
 * costs effectively nothing - it is a header read, not a decode.
 *
 * `limitInputPixels: MAX_INPUT_PIXELS` reuses transform.ts's own
 * decompression-bomb cap (imported above, not redefined) so this validation
 * step cannot itself become a bomb vector on a header that lied about its
 * dimensions - in practice the pixel-count check in the caller below already
 * rejects those before this function is ever reached, but the cap is cheap
 * insurance against relying on that ordering. Note the caller's check reads
 * single-frame dimensions from `image-size`, so for animated sources it is
 * `limitInputPixels` here (which sees the full multi-page strip) that bounds
 * total decoded pixels - exactly as it does in transform.ts.
 *
 * Fails OPEN vs. fails CLOSED, deliberately different failure modes:
 * - sharp itself cannot be loaded (native binary missing for this
 *   platform/architecture, e.g. a cross-arch build) - there is no decoder
 *   available in this environment at all, which is an environment problem,
 *   not a fact about the uploaded file. Log it and let the upload through
 *   unvalidated (the pre-fix behavior) rather than failing every raster
 *   upload because of a deployment issue.
 * - sharp loads fine but its decoder REJECTS the bytes - that IS a fact
 *   about this specific file, and an actionable one. Return false so the
 *   caller rejects the upload. A throw from the page-count probe counts as
 *   this case, not the one above: the module loaded, so an unreadable header
 *   is again a fact about the file, and `applyTransform` would reject the
 *   same bytes from its own probe with the same 422.
 */
async function rasterIsDecodable(data: Uint8Array): Promise<boolean> {
  // Typed as the whole module (not just its callable default export) and
  // dereferenced via `.default` below - sharp's own types ship an
  // `export const sharp: SharpConstructor; export default sharp;` pair for
  // the ESM entry point resolved by `import()`, so `typeof import('sharp')`
  // is the two-property namespace object, not the callable itself.
  let sharpModule: typeof import('sharp')
  try {
    sharpModule = await import('sharp')
  } catch (err: unknown) {
    console.warn(
      `[canopycms] sharp could not be loaded - skipping raster decode validation at finalize: ${getErrorMessage(err)}`,
    )
    return true
  }

  try {
    const probeMeta = await sharpModule
      .default(data, { limitInputPixels: MAX_INPUT_PIXELS })
      .metadata()
    const pagesToRead = Math.min(probeMeta.pages ?? 1, MAX_ANIMATED_FRAMES)

    await sharpModule
      .default(data, { pages: pagesToRead, limitInputPixels: MAX_INPUT_PIXELS })
      .resize({ width: DECODE_CHECK_SIZE, height: DECODE_CHECK_SIZE, fit: 'fill' })
      .toBuffer()
    return true
  } catch (err: unknown) {
    console.warn(
      `[canopycms] raster upload failed real pixel decode at finalize: ${getErrorMessage(err)}`,
    )
    return false
  }
}

/**
 * Run the finalize pipeline over freshly-uploaded bytes: sniff the real file
 * type (never trust the client-declared contentType beyond presign-time UX),
 * sanitize if svg, hash, extract dimensions, and build the AssetMeta + any
 * public object (svg/pdf only) the caller should persist.
 *
 * Order matters: for SVG, sanitization happens BEFORE hashing - the sanitized
 * bytes are what get hashed and stored, so a later re-sanitization (e.g. a
 * stricter sanitizer version) cannot desync a stored hash from its content.
 */
export async function runFinalizePipeline(input: FinalizeInput): Promise<FinalizeResult> {
  const sniffed = await fileTypeFromBuffer(input.data)

  let kind: AssetMeta['kind']
  let mime: string
  let ext: string
  let canonicalData: Uint8Array = input.data

  if (sniffed && RASTER_MIME_TYPES.has(sniffed.mime)) {
    if (input.data.byteLength > RASTER_MAX_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `Raster image exceeds the ${RASTER_MAX_BYTES}-byte limit`,
      }
    }
    kind = 'raster'
    mime = sniffed.mime
    ext = sniffed.ext
  } else if (sniffed && sniffed.mime === PDF_MIME_TYPE) {
    if (input.data.byteLength > PDF_MAX_BYTES) {
      return { ok: false, status: 413, error: `PDF exceeds the ${PDF_MAX_BYTES}-byte limit` }
    }
    kind = 'pdf'
    mime = PDF_MIME_TYPE
    ext = sniffed.ext
  } else {
    // Not a recognized raster/pdf - could be a bare/prolog'd SVG, or genuine junk.
    const svgText = sniffSvg(input.data)
    if (!svgText) {
      return { ok: false, status: 415, error: 'Unsupported or unrecognized file type' }
    }
    kind = 'svg'
    mime = SVG_MIME_TYPE
    ext = 'svg'
    canonicalData = new TextEncoder().encode(sanitizeSvg(svgText))
  }

  const hash32 = hashBytes(canonicalData)
  const { slug } = slugifyFilename(input.filename)
  const dims = kind === 'pdf' ? {} : computeDimensions(canonicalData)

  // Decompression-bomb defense: a raster's on-disk size says nothing about
  // its decoded pixel count (a solid-color 30000x30000 PNG compresses to a
  // few KB) - reject on width*height before this asset is ever finalized, so
  // the transform engine (transform.ts's own `limitInputPixels`) is never the
  // only thing standing between an attacker and a huge decode. SVG is exempt:
  // `computeDimensions` reads its declared viewBox/width/height attributes,
  // not a decoded raster, so there is no analogous decode-time memory cost.
  if (kind === 'raster' && dims.width !== undefined && dims.height !== undefined) {
    const pixelCount = dims.width * dims.height
    if (pixelCount > MAX_INPUT_PIXELS) {
      return {
        ok: false,
        status: 413,
        error: `Image dimensions ${dims.width}x${dims.height} (${pixelCount} pixels) exceed the ${MAX_INPUT_PIXELS}-pixel limit`,
      }
    }
  }

  // Only rasters ever reach sharp downstream (svg/pdf are served statically,
  // never transformed) - checked AFTER the cheap header-based pixel cap
  // above, so an oversized/bomb-shaped input is rejected without ever
  // spending a real decode on it.
  if (kind === 'raster' && !(await rasterIsDecodable(canonicalData))) {
    return { ok: false, status: 422, error: UNDECODABLE_RASTER_ERROR }
  }

  const meta: AssetMeta = {
    hash32,
    filename: input.filename,
    slug,
    ext,
    mime,
    size: canonicalData.byteLength,
    ...(dims.width !== undefined && { width: dims.width }),
    ...(dims.height !== undefined && { height: dims.height }),
    kind,
    ...(input.uploadedBy && { uploadedBy: input.uploadedBy }),
    uploadedAt: new Date().toISOString(),
  }

  let publicObject: FinalizePublicObject | undefined
  if (kind === 'svg' || kind === 'pdf') {
    // svg: rendered inline by the browser. pdf: downloaded under its real
    // original filename (never the slug) via Content-Disposition, built with
    // the content-disposition package (RFC 5987) rather than string
    // interpolation, so header-injection characters in the filename can never
    // reach a raw HTTP header value.
    const contentDisposition = createContentDisposition(input.filename, {
      type: kind === 'svg' ? 'inline' : 'attachment',
    })
    publicObject = {
      key: publicKey(hash32, slug, ext),
      data: canonicalData,
      contentType: mime,
      contentDisposition,
      cacheControl: PUBLIC_CACHE_CONTROL,
    }
  }

  return { ok: true, meta, data: canonicalData, publicObject }
}
