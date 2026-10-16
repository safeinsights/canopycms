import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_THEME } from '@mantine/core'
import { contrastRatio } from '../contrast'
import { CanopyCMSProvider, createCanopyTheme } from '../theme'
import { UnsavedMark } from './UnsavedMark'

afterEach(() => {
  cleanup()
})

describe('UnsavedMark', () => {
  it('is an 8px round dot in the focus-ring colour, the brand colour with a contrast floor', () => {
    const { container } = render(
      <CanopyCMSProvider>
        <UnsavedMark data-testid="mark" />
      </CanopyCMSProvider>,
    )
    const style = container.querySelector('[data-testid="mark"]')?.getAttribute('style') ?? ''
    expect(style).toContain('width: 8px')
    expect(style).toContain('border-radius: 50%')
    expect(style).toContain('var(--canopy-focus-ring, var(--mantine-color-brand-6))')
  })

  it('passes its name and role through, for the tree, where it is the only signal', () => {
    const { getByRole } = render(
      <CanopyCMSProvider>
        <UnsavedMark role="img" aria-label="Unsaved changes" />
      </CanopyCMSProvider>,
    )
    expect(getByRole('img', { name: 'Unsaved changes' })).toBeTruthy()
  })

  it('reaches 3:1 on the top bar surface in both schemes', () => {
    // The ring is brand.7 in light mode and brand.5 in dark (theme.test.tsx); the top bar is the
    // body colour, white and dark.7.
    const brand = createCanopyTheme().colors?.brand
    if (!brand) throw new Error('the theme has no brand scale')
    expect(contrastRatio(brand[7], '#ffffff')).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(brand[5], DEFAULT_THEME.colors.dark[7])).toBeGreaterThanOrEqual(3)
  })
})
