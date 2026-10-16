import type { PreviewWidth } from './hooks/useEditorLayout'

/** The CSS width each fixed preview width renders the site at. */
export const PREVIEW_DEVICE_WIDTHS = {
  desktop: 1280,
  tablet: 768,
  mobile: 390,
} as const satisfies Record<Exclude<PreviewWidth, 'fit'>, number>

/** Where and how large the preview iframe renders inside a pane of a given size. */
export interface PreviewViewport {
  /** The iframe's CSS width: the width the site's breakpoints see. */
  frameWidth: number
  /** The iframe's CSS height, before scaling; scaled, it fills the pane's height. */
  frameHeight: number
  /** The factor the iframe is scaled by, at most 1. */
  scale: number
  /** The left offset that centres the scaled iframe in the pane. */
  offsetX: number
}

const positiveOr = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? value : fallback

/**
 * Fits the preview into a pane. "fit" renders at the pane's width. A fixed width renders at
 * exactly that CSS width and, when the pane is narrower, scales down so the whole width shows,
 * stretching the CSS height by the same factor so the scaled frame still fills the pane's height.
 * An unmeasured pane (zero or non-finite) renders unscaled.
 */
export function computePreviewViewport(
  previewWidth: PreviewWidth,
  paneWidth: number,
  paneHeight: number,
): PreviewViewport {
  const width = positiveOr(paneWidth, 0)
  const height = positiveOr(paneHeight, 0)
  if (previewWidth === 'fit') {
    return { frameWidth: width, frameHeight: height, scale: 1, offsetX: 0 }
  }
  const frameWidth = PREVIEW_DEVICE_WIDTHS[previewWidth]
  const scale = width > 0 ? Math.min(1, width / frameWidth) : 1
  return {
    frameWidth,
    frameHeight: height / scale,
    scale,
    offsetX: width > 0 ? Math.max(0, (width - frameWidth * scale) / 2) : 0,
  }
}

/** The readout beside the width selector: the CSS width, plus the scale when it rounds below 100%. */
export function formatPreviewWidthReadout({ frameWidth, scale }: PreviewViewport): string {
  const px = `${Math.round(frameWidth)} px`
  const percent = Math.round(scale * 100)
  return percent < 100 ? `${px} at ${percent}%` : px
}
