/**
 * The shared transform engine: applies a parsed `TransformDirectives` to
 * source image bytes with sharp. Server-only - never import this from
 * client/editor code (this is why it lives in its own file, separate from
 * the dependency-free transform-directives.ts). Used by the dev-mode lazy
 * `/assets/t/*` emulation in api/assets.ts today, and will be reused
 * unchanged by the prod transform Lambda (PR 7).
 *
 * Pipeline: a cheap metadata-only probe (`limitInputPixels: MAX_INPUT_PIXELS`,
 * decompression-bomb defense #1) learns the real page count, so animated
 * GIF/WebP frames can be capped at `MAX_ANIMATED_FRAMES` (decompression-bomb
 * defense #2) without exceeding it and making sharp throw -> load for real
 * with `{ pages: min(totalPages, MAX_ANIMATED_FRAMES), limitInputPixels }` ->
 * `.rotate()` with no args (bakes EXIF orientation into pixels,
 * dropping the orientation tag) -> optional crop via `.extract()` -> optional
 * `.resize({ width, withoutEnlargement: true })` (never upscales) -> encode.
 *
 * Identity (`orig`) and any request that omits an explicit `f=` format
 * re-encode through the SOURCE format rather than a fixed one: this is what
 * guarantees EXIF/GPS gets stripped even when no other change is requested
 * (sharp strips metadata by default on re-encode - `withMetadata()` is never
 * called here, which would undo that).
 *
 * GIF has no EXIF segment (EXIF is a JPEG/TIFF APP1 marker; GIF has no such
 * extension block), so an identity GIF has nothing to strip - it is still
 * re-encoded through sharp's `.gif()` (verified: current sharp bundles cgif
 * and re-encodes multi-frame GIFs through the `{ animated: true }` input
 * path with no extra native dependency) purely for pipeline uniformity, not
 * because GIF needs stripping.
 */

import sharp from 'sharp'

import { getErrorMessage } from '../utils/error'
import {
  MAX_ANIMATED_FRAMES,
  MAX_INPUT_PIXELS,
  type CropRect,
  type OutputFormat,
  type TransformDirectives,
} from './transform-directives'

/**
 * `sharp`'s type declarations use `export =`, which doesn't let a default
 * import (`import sharp from 'sharp'`) reference the merged `sharp.Sharp`
 * namespace type directly under this repo's `esModuleInterop`/`Bundler`
 * module settings. `ReturnType<typeof sharp>` gets the same instance type
 * without needing a namespace import.
 */
type SharpPipeline = ReturnType<typeof sharp>

/** Raster formats the transform engine accepts as input. svg/pdf never reach here - they're served statically. */
const ALLOWED_INPUT_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

/** Defensive cap on encoded output size - prevents cache-stuffing with giant re-encodes. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024

const CONTENT_TYPE_BY_FORMAT: Record<OutputFormat, string> = {
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

export interface ApplyTransformInput {
  data: Uint8Array
  /** Source extension (lowercased file-type ext, e.g. 'png' | 'jpg' | 'webp' | 'gif'). */
  ext: string
}

export interface TransformSuccess {
  ok: true
  data: Uint8Array
  contentType: string
  ext: string
}

export interface TransformRejection {
  ok: false
  /** 400: unsupported input; 413: output too large; 422: sharp failed to process the input. */
  status: 400 | 413 | 422
  error: string
}

export type TransformResult = TransformSuccess | TransformRejection

/**
 * Dimensions AFTER `.rotate()` has auto-oriented the pixels. sharp's
 * `metadata()` reports the RAW (pre-rotation) width/height plus the EXIF
 * `orientation` tag; for orientation 5-8 (the 90-degree rotations that
 * portrait phone photos almost always carry) the visual axes are swapped.
 * The crop rect was normalized by the editor against the browser's
 * auto-oriented preview, so `.extract()` - which runs on the post-rotation
 * pipeline - must be computed against these swapped dims, NOT the raw ones.
 * Using the raw dims makes the extract region exceed the rotated image's
 * bounds and sharp throws `bad extract area`. sharp >=0.33 also exposes an
 * `autoOrient` block with the corrected dims; prefer it when present.
 */
function orientedDimensions(
  meta: Awaited<ReturnType<SharpPipeline['metadata']>>,
): { width: number; height: number } | null {
  const auto = meta.autoOrient
  if (auto && auto.width && auto.height) {
    return { width: auto.width, height: auto.height }
  }
  if (!meta.width || !meta.height) return null
  const swap =
    typeof meta.orientation === 'number' && meta.orientation >= 5 && meta.orientation <= 8
  return swap
    ? { width: meta.height, height: meta.width }
    : { width: meta.width, height: meta.height }
}

/**
 * Compute a sharp `.extract()` region from a normalized crop rect and the
 * (post-rotation) image dimensions. Rounds the left/top and right/bottom
 * edges independently, then derives width/height from their difference -
 * rounding width/height directly from `crop.w`/`crop.h` could drift the
 * region past the image bounds when combined with independently-rounded
 * left/top. Clamped defensively so float error can never produce an
 * out-of-range extract (which sharp throws on).
 */
function computeExtractRegion(
  crop: CropRect,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const left = Math.min(Math.max(Math.round(crop.x * width), 0), Math.max(width - 1, 0))
  const top = Math.min(Math.max(Math.round(crop.y * height), 0), Math.max(height - 1, 0))
  const right = Math.min(Math.round((crop.x + crop.w) * width), width)
  const bottom = Math.min(Math.round((crop.y + crop.h) * height), height)
  const extractWidth = Math.max(1, right - left)
  const extractHeight = Math.max(1, bottom - top)
  return { left, top, width: extractWidth, height: extractHeight }
}

function encode(pipeline: SharpPipeline, format: OutputFormat, quality: number | undefined) {
  const options = quality !== undefined ? { quality } : undefined
  switch (format) {
    case 'webp':
      return pipeline.webp(options)
    case 'jpeg':
      return pipeline.jpeg(options)
    case 'png':
      return pipeline.png(options)
  }
}

/**
 * Re-encode through the source container format - used for identity and for
 * requests that omit `f=`. `quality` (C3) is honoured here exactly like
 * `encode()` does for an explicit `f=`, so a `q=` directive without `f=` is
 * never silently dropped - the cache key (`formatDirectives` in
 * transform-directives.ts) already includes `q=` unconditionally, so the
 * actual encode must agree with it. GIF has no quality knob in sharp
 * (`GifOptions` carries no `quality` field - palette-based encoders are
 * tuned via `colours`/`effort` instead), so `q=` remains a no-op there, same
 * as `encode()` above (GIF is never a valid `f=` target either).
 */
function encodeSourceFormat(
  pipeline: SharpPipeline,
  sourceExt: string,
  quality: number | undefined,
) {
  const options = quality !== undefined ? { quality } : undefined
  switch (sourceExt) {
    case 'gif':
      return pipeline.gif()
    case 'webp':
      return pipeline.webp(options)
    case 'jpg':
    case 'jpeg':
      return pipeline.jpeg(options)
    case 'png':
    default:
      return pipeline.png(options)
  }
}

export async function applyTransform(
  input: ApplyTransformInput,
  directives: TransformDirectives,
): Promise<TransformResult> {
  const sourceExt = input.ext.toLowerCase()
  if (!ALLOWED_INPUT_EXTS.has(sourceExt)) {
    return {
      ok: false,
      status: 400,
      error: `Unsupported input format for transform: '${sourceExt}'`,
    }
  }

  const resize = directives.identity ? undefined : directives
  const format = resize?.format
  const quality = resize?.quality

  try {
    // A cheap header/metadata-only probe (no pixel decode - verified this
    // costs effectively nothing even for a several-hundred-frame source) to
    // learn the source's real page count before deciding whether to cap it.
    // This has to happen before constructing the real pipeline: sharp's
    // `pages` constructor option is a fixed request, not an upper bound - a
    // `pages` value that EXCEEDS the source's actual page count makes sharp
    // throw ("bad page number") rather than clamping, so `MAX_ANIMATED_FRAMES`
    // can only be applied as `Math.min(totalPages, MAX_ANIMATED_FRAMES)`.
    // `limitInputPixels` gates this probe exactly like it gates the real
    // pipeline below - an oversized source throws here already, before any
    // pixel buffer is ever allocated.
    const probeMeta = await sharp(input.data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
    const totalPages = probeMeta.pages ?? 1
    const pagesToRead = Math.min(totalPages, MAX_ANIMATED_FRAMES)

    let pipeline = sharp(input.data, {
      pages: pagesToRead,
      limitInputPixels: MAX_INPUT_PIXELS,
    }).rotate()

    if (resize?.crop) {
      const oriented = orientedDimensions(await pipeline.metadata())
      if (!oriented) {
        return { ok: false, status: 422, error: 'Could not read image dimensions for crop' }
      }
      pipeline = pipeline.extract(
        computeExtractRegion(resize.crop, oriented.width, oriented.height),
      )
    }

    if (resize?.width) {
      pipeline = pipeline.resize({ width: resize.width, withoutEnlargement: true })
    }

    pipeline = format
      ? encode(pipeline, format, quality)
      : encodeSourceFormat(pipeline, sourceExt, quality)

    const data = await pipeline.toBuffer()
    if (data.byteLength > MAX_OUTPUT_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `Transformed output (${data.byteLength} bytes) exceeds the ${MAX_OUTPUT_BYTES}-byte cap`,
      }
    }

    const outExt = format ?? sourceExt
    const contentType = format ? CONTENT_TYPE_BY_FORMAT[format] : CONTENT_TYPE_BY_EXT[sourceExt]

    return {
      ok: true,
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      contentType,
      ext: outExt,
    }
  } catch (err: unknown) {
    return { ok: false, status: 422, error: `Transform failed: ${getErrorMessage(err)}` }
  }
}
