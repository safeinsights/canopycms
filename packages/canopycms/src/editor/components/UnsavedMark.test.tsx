import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_THEME, mergeMantineTheme } from '@mantine/core'
import { contrastRatio } from '../contrast'
import { CanopyCMSProvider, createCanopyTheme } from '../theme'
import { UnsavedMark } from './UnsavedMark'

afterEach(() => {
  cleanup()
})

describe('UnsavedMark', () => {
  it('is an 8px round dot in the unsaved-mark colour', () => {
    const { container } = render(
      <CanopyCMSProvider>
        <UnsavedMark data-testid="mark" />
      </CanopyCMSProvider>,
    )
    const style = container.querySelector('[data-testid="mark"]')?.getAttribute('style') ?? ''
    expect(style).toContain('width: 8px')
    expect(style).toContain('border-radius: 50%')
    expect(style).toContain('var(--canopy-unsaved-mark, var(--mantine-color-brand-6))')
  })

  it('passes its name and role through, for the tree, where it is the only signal', () => {
    const { getByRole } = render(
      <CanopyCMSProvider>
        <UnsavedMark role="img" aria-label="Unsaved changes" />
      </CanopyCMSProvider>,
    )
    expect(getByRole('img', { name: 'Unsaved changes' })).toBeTruthy()
  })

  it("is the theme's focus-ring colour, at 3:1 on the top bar surface in both schemes", () => {
    render(
      <CanopyCMSProvider>
        <span>text</span>
      </CanopyCMSProvider>,
    )
    const theme = mergeMantineTheme(DEFAULT_THEME, createCanopyTheme())
    const blocks = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n')
      .split('}')
    // What the provider writes for one scheme, its :root block first.
    const variablesIn = (scheme: 'light' | 'dark') => {
      const variables: Record<string, string> = {}
      const ordered = [
        ...blocks.filter((block) => /:root\s*\{/.test(block)),
        ...blocks.filter((block) => block.includes(`data-mantine-color-scheme="${scheme}"`)),
      ]
      for (const block of ordered) {
        for (const [, name, value] of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
          variables[name] = value.trim()
        }
      }
      return variables
    }
    const markIn = (scheme: 'light' | 'dark') => {
      const variables = variablesIn(scheme)
      let value = variables['--canopy-unsaved-mark']
      for (let hops = 0; hops < 5; hops++) {
        const reference = /^var\((--[\w-]+)\)$/.exec(value ?? '')
        if (!reference) break
        value = variables[reference[1]]
      }
      const colour = value ?? ''
      if (!/^#[0-9a-f]{6}$/i.test(colour)) {
        throw new Error(`--canopy-unsaved-mark did not resolve to a colour: ${colour}`)
      }
      return colour
    }
    expect(contrastRatio(markIn('light'), theme.white)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(markIn('dark'), theme.colors.dark[7])).toBeGreaterThanOrEqual(3)
  })
})
