/**
 * Pure math for the ImageField crop step: converting between react-image-crop's
 * percentage-based crop shape and CanopyCMS's normalized 0..1 `CropRect`
 * (the same shape stored in `ImageFieldValue.crop` and accepted by the `c=`
 * transform directive - see assets/transform-directives.ts). Kept dependency-free
 * (no react-image-crop import) so it's trivially unit-testable and reusable
 * without pulling in the cropper UI library.
 */

import { isValidCropRect, roundCropRect, type CropRect } from '../../assets/transform-directives'

/** A crop box in percentages (0..100) of the image, the shape react-image-crop reports for `unit: '%'`. */
export interface CropAreaPercent {
  x: number
  y: number
  width: number
  height: number
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Convert a percentage crop box into a normalized `CropRect`, clamped to [0,1] and then
 * rounded by `roundCropRect` — the same rounding the transform URL's canonical
 * form applies, so the stored crop is already canonical.
 *
 * Returns `null` if the input can't be coerced into a valid rect (e.g. a
 * zero-area selection).
 */
export function cropAreaPercentToRect(area: CropAreaPercent): CropRect | null {
  const rect = roundCropRect({
    x: clamp01(area.x / 100),
    y: clamp01(area.y / 100),
    w: clamp01(area.width / 100),
    h: clamp01(area.height / 100),
  })
  return isValidCropRect(rect.x, rect.y, rect.w, rect.h) ? rect : null
}

/**
 * Inverse of `cropAreaPercentToRect` - seeds the crop box when re-opening
 * the crop step for an already-cropped image, so the user sees their previous
 * selection instead of starting over.
 */
function cropRectToAreaPercent(rect: CropRect): CropAreaPercent {
  return { x: rect.x * 100, y: rect.y * 100, width: rect.w * 100, height: rect.h * 100 }
}

/** "W:H" -> the numeric aspect ratio react-image-crop's `aspect` prop expects. Mirrors config/schemas/field.ts's ASPECT_RATIO_RE; returns undefined for anything malformed rather than throwing (defensive - the field config was already validated at schema-parse time). */
export function parseAspectRatio(aspect: string | undefined): number | undefined {
  if (!aspect) return undefined
  const match = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(aspect)
  if (!match) return undefined
  return Number(match[1]) / Number(match[2])
}

const INITIAL_BOX_FRACTION = 0.9
const FREE_BOX: CropAreaPercent = { x: 0, y: 0, width: 100, height: 100 }
/** How far a stored crop's pixel ratio may sit from the field's `aspect` before it is replaced by a fresh box. */
const ASPECT_TOLERANCE = 0.02

/**
 * The crop box the crop step opens with, once the image's displayed size is known.
 * A stored crop is kept as it was drawn, unless the field has an `aspect` it no longer
 * matches (the config changed since); then, like a first crop of a locked field, a box of that
 * ratio centred on the image. A free field's first box is the whole frame, so Apply with no change trims nothing.
 */
export function initialCropBox(opts: {
  imageWidth: number
  imageHeight: number
  aspect?: number
  existing?: CropRect
}): CropAreaPercent {
  const { imageWidth, imageHeight, aspect, existing } = opts
  const sized = imageWidth > 0 && imageHeight > 0

  if (existing) {
    const box = cropRectToAreaPercent(existing)
    if (aspect === undefined || !sized) return box
    const storedRatio = (existing.w * imageWidth) / (existing.h * imageHeight)
    if (Math.abs(storedRatio - aspect) / aspect <= ASPECT_TOLERANCE) return box
  }

  if (aspect === undefined || !sized) return { ...FREE_BOX }
  const wide = aspect >= imageWidth / imageHeight
  const width = wide
    ? imageWidth * INITIAL_BOX_FRACTION
    : imageHeight * INITIAL_BOX_FRACTION * aspect
  const height = wide ? width / aspect : imageHeight * INITIAL_BOX_FRACTION
  const widthPct = (width / imageWidth) * 100
  const heightPct = (height / imageHeight) * 100
  return {
    x: (100 - widthPct) / 2,
    y: (100 - heightPct) / 2,
    width: widthPct,
    height: heightPct,
  }
}

/** True for a rectangle covering the whole frame, which renders the image unchanged. */
export function isFullFrameCrop(rect: CropRect): boolean {
  return rect.x === 0 && rect.y === 0 && rect.w === 1 && rect.h === 1
}
