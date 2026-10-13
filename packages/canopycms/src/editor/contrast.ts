import { darken, lighten, luminance, toRgba } from '@mantine/core'

/** WCAG 2's minimum for body text. */
const TEXT_CONTRAST = 4.5

/** @internal Exported for tests. The WCAG 2 contrast ratio of two opaque colours. */
export const contrastRatio = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

/** `color` at `opacity` over the opaque `background`, as one opaque colour. */
export const composite = (color: string, opacity: number, background: string): string => {
  const fg = toRgba(color)
  const bg = toRgba(background)
  const mix = (f: number, b: number) => Math.round(f * opacity + b * (1 - opacity))
  return `rgb(${mix(fg.r, bg.r)}, ${mix(fg.g, bg.g)}, ${mix(fg.b, bg.b)})`
}

/**
 * The first step from `from` toward the scale's dark or light end reaching `minimum` on
 * `background`, else the end shade darkened or lightened until it does (`shade` unset).
 */
export const readableOnScale = (
  scale: readonly string[],
  options: { from: number; toward: 'darker' | 'lighter'; background: string; minimum?: number },
): { shade?: number; value: string } => {
  const { from, toward, background, minimum = TEXT_CONTRAST } = options
  const step = toward === 'darker' ? 1 : -1
  const end = toward === 'darker' ? scale.length - 1 : 0
  for (let shade = from; step > 0 ? shade <= end : shade >= end; shade += step) {
    if (contrastRatio(scale[shade], background) >= minimum) return { shade, value: scale[shade] }
  }
  for (let amount = 0.05; amount < 1; amount += 0.05) {
    const value = toward === 'darker' ? darken(scale[end], amount) : lighten(scale[end], amount)
    if (contrastRatio(value, background) >= minimum) return { value }
  }
  return { value: toward === 'darker' ? '#000000' : '#ffffff' }
}
