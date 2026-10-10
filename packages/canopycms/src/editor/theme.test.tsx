import React, { useEffect } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ActionIcon, Button, Drawer, getDefaultZIndex } from '@mantine/core'
import { modals } from '@mantine/modals'
import { CanopyCMSProvider } from './theme'

const originalMatchMedia = window.matchMedia

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList) as typeof window.matchMedia
  }
  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    ;(window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
      ResizeObserver as typeof ResizeObserver
  }
})

afterAll(() => {
  if (originalMatchMedia) window.matchMedia = originalMatchMedia
})

afterEach(() => {
  cleanup()
})

const OpensConfirm: React.FC = () => {
  useEffect(() => {
    modals.openConfirmModal({ title: 'Confirm title', children: 'Confirm body' })
  }, [])
  return null
}

/** The z-index Mantine writes onto a modal/drawer root, as the `--mb-z-index` custom property. */
const zIndexOfRootContaining = (text: string): number => {
  const roots = Array.from(document.querySelectorAll<HTMLElement>('[style*="--mb-z-index"]'))
  const root = roots.find((el) => el.textContent?.includes(text))
  if (!root) throw new Error(`no modal/drawer root contains "${text}"`)
  return Number(root.style.getPropertyValue('--mb-z-index'))
}

describe('CanopyCMSProvider confirm-modal stacking', () => {
  it('stacks confirm modals above a default-z-index Drawer and its overlay', async () => {
    render(
      <CanopyCMSProvider>
        <Drawer opened onClose={() => {}} title="Drawer title">
          Drawer body
        </Drawer>
        <OpensConfirm />
      </CanopyCMSProvider>,
    )

    await waitFor(() => {
      expect(zIndexOfRootContaining('Confirm body')).toBeGreaterThan(0)
    })

    const confirmZ = zIndexOfRootContaining('Confirm body')
    const drawerZ = zIndexOfRootContaining('Drawer body')
    expect(drawerZ).toBe(getDefaultZIndex('modal'))
    // A margin of one level, not +1: anything an adopter or Mantine stacks just above a
    // default modal (a Drawer.Stack, a popover opened from a drawer) must stay below it.
    expect(confirmZ).toBeGreaterThanOrEqual(getDefaultZIndex('popover'))
    // Notifications render at the overlay level and must stay above a confirm modal.
    expect(confirmZ).toBeLessThan(getDefaultZIndex('overlay'))
  })
})

describe('CanopyCMSProvider default control sizes', () => {
  it('sizes Button xs and ActionIcon sm unless the call says otherwise', () => {
    const { getByText, getByLabelText } = render(
      <CanopyCMSProvider>
        <Button>Plain</Button>
        <Button size="sm">Explicit</Button>
        <ActionIcon aria-label="plain-icon" />
        <ActionIcon aria-label="large-icon" size="lg" />
      </CanopyCMSProvider>,
    )
    expect(getByText('Plain').closest('button')?.getAttribute('data-size')).toBe('xs')
    expect(getByText('Explicit').closest('button')?.getAttribute('data-size')).toBe('sm')
    expect(getByLabelText('plain-icon').getAttribute('data-size')).toBe('sm')
    expect(getByLabelText('large-icon').getAttribute('data-size')).toBe('lg')
  })

  it('lets an adopter override a component without losing the others', () => {
    const { getByText, getByLabelText } = render(
      <CanopyCMSProvider
        themeOverride={{ components: { Button: Button.extend({ defaultProps: { size: 'lg' } }) } }}
      >
        <Button>Plain</Button>
        <ActionIcon aria-label="plain-icon" />
      </CanopyCMSProvider>,
    )
    expect(getByText('Plain').closest('button')?.getAttribute('data-size')).toBe('lg')
    expect(getByLabelText('plain-icon').getAttribute('data-size')).toBe('sm')
  })
})
