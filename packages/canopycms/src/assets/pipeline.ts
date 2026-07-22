/**
 * Finalize pipeline: turns raw uploaded bytes into a validated AssetMeta
 * (+ optional public object for svg/pdf), or a typed rejection. Pure
 * transform - no store I/O here (see finalize.ts for the store orchestration
 * that dedups, writes, and calls this).
 *
 * Server-only - never import this module from client/editor code. It pulls
 * in `file-type`, `image-size`, and the SVG sanitizer, none of which belong
 * in a browser bundle.
 */

import { fileTypeFromBuffer } from 'file-type'
import { imageSize } from 'image-size'
import { create as createContentDisposition } from 'content-disposition'

import { hashBytes, publicKey, slugifyFilename } from './keys'
import { sanitizeSvg } from './svg-sanitizer'
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
  status: 413 | 415
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
