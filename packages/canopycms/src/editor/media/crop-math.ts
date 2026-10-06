/**
 * Pure math for the ImageField crop step: converting between react-easy-crop's
 * percentage-based `Area` shape and CanopyCMS's normalized 0..1 `CropRect`
 * (the same shape stored in `ImageFieldValue.crop` and accepted by the `c=`
 * transform directive - see assets/transform-directives.ts). Kept dependency-free
 * (no react-easy-crop import) so it's trivially unit-testable and reusable
 * without pulling in the cropper UI library.
 */

import { isValidCropRect, roundCropRect, type CropRect } from '../../assets/transform-directives'

/** react-easy-crop's `Area` shape, expressed in percentages (0..100). */
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
 * Convert react-easy-crop's `onCropComplete(croppedArea, croppedAreaPixels)`
 * percentage area into a normalized `CropRect`, clamped to [0,1] and then
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
 * Inverse of `cropAreaPercentToRect` - seeds react-easy-crop's
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
