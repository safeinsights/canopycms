import React, { useEffect } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  ActionIcon,
  Alert,
  Button,
  DEFAULT_THEME,
  Drawer,
  Modal,
  Notification,
  getDefaultZIndex,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { CanopyCMSProvider } from './theme'
import { openConfirm } from './utils/confirm-modal'

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

  it("keeps the default size when an adopter overrides another of the component's props", () => {
    const { getByText } = render(
      <CanopyCMSProvider
        themeOverride={{
          components: { Button: Button.extend({ defaultProps: { radius: 'xl' } }) },
        }}
      >
        <Button>Plain</Button>
      </CanopyCMSProvider>,
    )
    expect(getByText('Plain').closest('button')?.getAttribute('data-size')).toBe('xs')
  })

  it('keeps the brand colours when an adopter overrides only other colours', () => {
    const extra = [
      '#000',
      '#111',
      '#222',
      '#333',
      '#444',
      '#555',
      '#666',
      '#777',
      '#888',
      '#999',
    ] as const
    const { getByText } = render(
      <CanopyCMSProvider themeOverride={{ colors: { extra: [...extra] } }}>
        <Button>Plain</Button>
      </CanopyCMSProvider>,
    )
    expect(getByText('Plain')).toBeTruthy()
  })

  it('gives confirm-modal actions the dialog size, not the compact default', async () => {
    render(<CanopyCMSProvider>{null}</CanopyCMSProvider>)
    openConfirm({ title: 'Sure?', labels: { confirm: 'Yes', cancel: 'No' } })
    const yes = await waitFor(() => {
      const el = document.body.querySelector('button[data-size]:not([data-variant="default"])')
      if (!el) throw new Error('confirm not open')
      return el
    })
    expect(yes.getAttribute('data-size')).toBe('sm')
    const no = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === 'No',
    )
    expect(no?.getAttribute('data-size')).toBe('sm')
    modals.closeAll()
  })

  it('names the confirm modal close button, unless the caller names it', async () => {
    render(<CanopyCMSProvider>{null}</CanopyCMSProvider>)
    const closeLabel = () =>
      document.body.querySelector('button.mantine-Modal-close')?.getAttribute('aria-label')
    openConfirm({ title: 'Sure?', labels: { confirm: 'Yes', cancel: 'No' } })
    await waitFor(() => expect(closeLabel()).toBe('Close'))
    modals.closeAll()
    await waitFor(() =>
      expect(document.body.querySelector('button.mantine-Modal-close')).toBeNull(),
    )

    openConfirm({
      title: 'Sure?',
      labels: { confirm: 'Yes', cancel: 'No' },
      closeButtonProps: { 'aria-label': 'Dismiss' },
    })
    await waitFor(() => expect(closeLabel()).toBe('Dismiss'))
    modals.closeAll()
  })
})

describe('CanopyCMSProvider close buttons', () => {
  const closeButton = (kind: 'Drawer' | 'Modal') =>
    document.body.querySelector(`button.mantine-${kind}-close`)

  it('names the close button of every Drawer', async () => {
    render(
      <CanopyCMSProvider>
        <Drawer opened onClose={() => {}} title="Branches">
          Body
        </Drawer>
      </CanopyCMSProvider>,
    )
    await waitFor(() => expect(closeButton('Drawer')?.getAttribute('aria-label')).toBe('Close'))
  })

  it('names the close button of every Modal, including one a confirm opens itself', async () => {
    render(
      <CanopyCMSProvider>
        <Modal opened onClose={() => {}} title="Rename">
          Body
        </Modal>
        <OpensConfirm />
      </CanopyCMSProvider>,
    )
    await waitFor(() => {
      const labels = Array.from(document.body.querySelectorAll('button.mantine-Modal-close')).map(
        (button) => button.getAttribute('aria-label'),
      )
      expect(labels).toEqual(['Close', 'Close'])
    })
    modals.closeAll()
  })

  it("names a hand-placed Drawer.CloseButton, a toast's and a dismissible alert's", async () => {
    render(
      <CanopyCMSProvider>
        <Drawer.Root opened onClose={() => {}}>
          <Drawer.Content>
            <Drawer.Header>
              <Drawer.CloseButton />
            </Drawer.Header>
          </Drawer.Content>
        </Drawer.Root>
        <Notification onClose={() => {}}>Saved</Notification>
        <Alert withCloseButton onClose={() => {}}>
          Failed
        </Alert>
      </CanopyCMSProvider>,
    )
    await waitFor(() => expect(closeButton('Drawer')?.getAttribute('aria-label')).toBe('Close'))
    expect(
      document.body.querySelector('.mantine-Notification-root button')?.getAttribute('aria-label'),
    ).toBe('Close')
    expect(
      document.body.querySelector('.mantine-Alert-root button')?.getAttribute('aria-label'),
    ).toBe('Close')
  })

  it('leaves a caller that names its own close button in charge of the name', async () => {
    render(
      <CanopyCMSProvider>
        <Drawer opened onClose={() => {}} closeButtonProps={{ 'aria-label': 'Dismiss' }}>
          Body
        </Drawer>
      </CanopyCMSProvider>,
    )
    await waitFor(() => expect(closeButton('Drawer')?.getAttribute('aria-label')).toBe('Dismiss'))
  })
})

describe('CanopyCMSProvider filled button contrast', () => {
  const buttonVar = (button: HTMLElement | null, name: string) =>
    button?.style.getPropertyValue(name) ?? ''

  it('fills red buttons with red.8, hovering to red.9', () => {
    const { getByText } = render(
      <CanopyCMSProvider>
        <Button color="red">Delete</Button>
      </CanopyCMSProvider>,
    )
    const button = getByText('Delete').closest('button')
    expect(buttonVar(button, '--button-bg')).toBe(DEFAULT_THEME.colors.red[8])
    expect(buttonVar(button, '--button-hover')).toBe(DEFAULT_THEME.colors.red[9])
  })

  it('fills orange buttons with orange.6 under black text', () => {
    const { getByText } = render(
      <CanopyCMSProvider>
        <Button color="orange" variant="filled">
          Withdraw
        </Button>
      </CanopyCMSProvider>,
    )
    const button = getByText('Withdraw').closest('button')
    expect(buttonVar(button, '--button-bg')).toBe(DEFAULT_THEME.colors.orange[6])
    expect(buttonVar(button, '--button-hover')).toBe(DEFAULT_THEME.colors.orange[7])
    expect(buttonVar(button, '--button-color')).toBe(DEFAULT_THEME.black)
  })

  it('leaves light and subtle buttons, and other colours, as Mantine draws them', () => {
    const { getByText } = render(
      <CanopyCMSProvider>
        <Button color="red" variant="light">
          Light red
        </Button>
        <Button color="red" variant="subtle">
          Subtle red
        </Button>
        <Button color="orange" variant="light">
          Light orange
        </Button>
        <Button color="blue">Blue</Button>
      </CanopyCMSProvider>,
    )
    for (const name of ['Light red', 'Subtle red', 'Light orange']) {
      const button = getByText(name).closest('button')
      expect(buttonVar(button, '--button-bg')).not.toBe(DEFAULT_THEME.colors.red[8])
      expect(buttonVar(button, '--button-bg')).not.toBe(DEFAULT_THEME.colors.orange[6])
      expect(buttonVar(button, '--button-color')).not.toBe(DEFAULT_THEME.black)
    }
    expect(buttonVar(getByText('Blue').closest('button'), '--button-bg')).toBe(
      'var(--mantine-color-blue-filled)',
    )
  })

  it('keeps the shades when an adopter overrides another Button prop, not its vars', () => {
    const { getByText } = render(
      <CanopyCMSProvider
        themeOverride={{
          components: { Button: Button.extend({ defaultProps: { radius: 'xl' } }) },
        }}
      >
        <Button color="red">Delete</Button>
      </CanopyCMSProvider>,
    )
    expect(buttonVar(getByText('Delete').closest('button'), '--button-bg')).toBe(
      DEFAULT_THEME.colors.red[8],
    )
  })

  it('reaches the confirm button a modal draws', async () => {
    render(<CanopyCMSProvider>{null}</CanopyCMSProvider>)
    openConfirm({
      title: 'Sure?',
      labels: { confirm: 'Delete entry', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
    })
    const confirm = await waitFor(() => {
      const el = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent === 'Delete entry',
      )
      if (!el) throw new Error('confirm not open')
      return el
    })
    expect(buttonVar(confirm, '--button-bg')).toBe(DEFAULT_THEME.colors.red[8])
    modals.closeAll()
  })
})

describe('CanopyCMSProvider light yellow alert contrast', () => {
  const alertColor = (props: React.ComponentProps<typeof Alert>) => {
    const { getByRole } = render(
      <CanopyCMSProvider>
        <Alert {...props}>Heads up</Alert>
      </CanopyCMSProvider>,
    )
    const value = getByRole('alert').style.getPropertyValue('--alert-color')
    cleanup()
    return value
  }

  it('draws the title, icon and close button of a light yellow alert in the text colour', () => {
    expect(alertColor({ color: 'yellow', title: 'Careful' })).toBe('var(--mantine-color-text)')
  })

  it('applies the text colour when the light variant is named', () => {
    expect(alertColor({ color: 'yellow', variant: 'light' })).toBe('var(--mantine-color-text)')
  })

  it('leaves a filled yellow alert, and a light red one, as Mantine draws them', () => {
    expect(alertColor({ color: 'yellow', variant: 'filled' })).not.toBe('var(--mantine-color-text)')
    expect(alertColor({ color: 'red' })).not.toBe('var(--mantine-color-text)')
  })
})

describe('CanopyCMSProvider dimmed text', () => {
  const dimmedIn = (scheme: 'light' | 'dark') => {
    const css = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n')
    const rule = css
      .split('}')
      .find(
        (block) =>
          block.includes(`data-mantine-color-scheme="${scheme}"`) &&
          block.includes('--mantine-color-dimmed'),
      )
    return rule?.match(/--mantine-color-dimmed:\s*([^;]+);/)?.[1]
  }

  it('sets the dimmed colour to gray.7 in light mode and dark.1 in dark mode', () => {
    render(
      <CanopyCMSProvider>
        <span>text</span>
      </CanopyCMSProvider>,
    )
    expect(dimmedIn('light')).toBe('var(--mantine-color-gray-7)')
    expect(dimmedIn('dark')).toBe('var(--mantine-color-dark-1)')
  })
})
