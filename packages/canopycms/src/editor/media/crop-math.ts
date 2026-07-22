/**
 * Pure math for the ImageField crop step: converting between react-easy-crop's
 * percentage-based `Area` shape and CanopyCMS's normalized 0..1 `CropRect`
 * (the same shape stored in `ImageFieldValue.crop` and accepted by the `c=`
 * transform directive - see assets/transform-directives.ts). Kept dependency-free
 * (no react-easy-crop import) so it's trivially unit-testable and reusable
 * without pulling in the cropper UI library.
 */

import { isValidCropRect, type CropRect } from '../../assets/transform-directives'

/** react-easy-crop's `Area` shape, expressed in percentages (0..100). */
export interface CropAreaPercent {
  x: number
  y: number
  width: number
  height: number
}

/** Matches transform-directives.ts's CROP_PRECISION so a crop rect round-trips through the URL directive unchanged. */
const CROP_PRECISION = 4

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Convert react-easy-crop's `onCropComplete(croppedArea, croppedAreaPixels)`
 * percentage area into a normalized `CropRect`, rounded to 4 decimals and
 * clamped to fit within bounds. Rounding can push `x+w`/`y+h` a hair over 1
 * (e.g. x=0.6667, w=0.3334 -> 1.0001) - shrink the extent to the remaining
 * space rather than reject a rect that was valid before rounding.
 *
 * Returns `null` if the input can't be coerced into a valid rect (e.g. a
 * zero-area selection).
 */
export function cropAreaPercentToRect(area: CropAreaPercent): CropRect | null {
  const x = roundTo(clamp01(area.x / 100), CROP_PRECISION)
  const y = roundTo(clamp01(area.y / 100), CROP_PRECISION)
  let w = roundTo(clamp01(area.width / 100), CROP_PRECISION)
  let h = roundTo(clamp01(area.height / 100), CROP_PRECISION)

  if (x + w > 1) w = roundTo(1 - x, CROP_PRECISION)
  if (y + h > 1) h = roundTo(1 - y, CROP_PRECISION)

  if (!isValidCropRect(x, y, w, h)) return null
  return { x, y, w, h }
}

/**
 * Inverse of `cropAreaPercentToRect` - used to seed react-easy-crop's
 * `initialCroppedAreaPercentages` when re-opening the crop step for an
 * already-cropped image, so the user sees their previous selection instead
 * of starting over.
 */
export function cropRectToAreaPercent(rect: CropRect): CropAreaPercent {
  return { x: rect.x * 100, y: rect.y * 100, width: rect.w * 100, height: rect.h * 100 }
}

/** "W:H" -> the numeric aspect ratio react-easy-crop's `aspect` prop expects. Mirrors config/schemas/field.ts's ASPECT_RATIO_RE; returns undefined for anything malformed rather than throwing (defensive - the field config was already validated at schema-parse time). */
export function parseAspectRatio(aspect: string | undefined): number | undefined {
  if (!aspect) return undefined
  const match = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(aspect)
  if (!match) return undefined
  return Number(match[1]) / Number(match[2])
}
