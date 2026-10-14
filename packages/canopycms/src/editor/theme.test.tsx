import React, { useEffect } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  DEFAULT_THEME,
  Drawer,
  Menu,
  Modal,
  Notification,
  Radio,
  Select,
  Switch,
  Tabs,
  Text,
  TextInput,
  Tooltip,
  getDefaultZIndex,
  defaultCssVariablesResolver,
  getPrimaryShade,
  mergeMantineTheme,
  virtualColor,
  type MantineColorsTuple,
} from '@mantine/core'
import { modals } from '@mantine/modals'
import { DestructiveMenuItem } from './components/DestructiveMenuItem'
import { composite, contrastRatio } from './contrast'
import { CanopyCMSProvider, createCanopyTheme } from './theme'
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

  it('keeps white text on the primary fill when autoContrast would pick black for a light brand', () => {
    const { getByText } = render(
      <CanopyCMSProvider colors={{ brand: '#facc15' }} themeOverride={{ autoContrast: true }}>
        <Button>Save</Button>
        <Badge color="brand">Current</Badge>
      </CanopyCMSProvider>,
    )
    expect(buttonVar(getByText('Save').closest('button'), '--button-color')).toBe(
      'var(--mantine-color-white)',
    )
    expect(
      (getByText('Current').closest('.mantine-Badge-root') as HTMLElement).style.getPropertyValue(
        '--badge-color',
      ),
    ).toBe('var(--mantine-color-white)')
  })

  it('fills a primary Button and Badge, named or by default, with the primary fill', () => {
    const { getByText } = render(
      <CanopyCMSProvider>
        <Button>Save</Button>
        <Button color="brand">Submit for review</Button>
        <Button color="brand" variant="light">
          Open
        </Button>
        <Badge>Current</Badge>
        <Badge variant="light">Editing</Badge>
        <Button color="brand.6">Shaded</Button>
      </CanopyCMSProvider>,
    )
    for (const name of ['Save', 'Submit for review']) {
      const button = getByText(name).closest('button')
      expect(buttonVar(button, '--button-bg')).toBe('var(--canopy-primary-fill)')
      expect(buttonVar(button, '--button-hover')).toBe('var(--canopy-primary-fill-hover)')
    }
    expect(buttonVar(getByText('Open').closest('button'), '--button-bg')).not.toBe(
      'var(--canopy-primary-fill)',
    )
    const badgeBg = (name: string) =>
      (getByText(name).closest('.mantine-Badge-root') as HTMLElement).style.getPropertyValue(
        '--badge-bg',
      )
    expect(badgeBg('Current')).toBe('var(--canopy-primary-fill)')
    expect(badgeBg('Editing')).not.toBe('var(--canopy-primary-fill)')
    // A named shade is the caller's choice.
    expect(buttonVar(getByText('Shaded').closest('button'), '--button-bg')).toBe(
      'var(--mantine-color-brand-6)',
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

/** The full theme the provider builds, for the colours its variables name. */
const canopyTheme = mergeMantineTheme(DEFAULT_THEME, createCanopyTheme())

/**
 * Every variable in force for one scheme: what the provider's style tag writes, over Mantine's
 * defaults, which the tag leaves out where the provider's value is the same.
 */
const variablesIn = (scheme: 'light' | 'dark'): Record<string, string> => {
  const defaults = defaultCssVariablesResolver(DEFAULT_THEME)
  const variables: Record<string, string> = { ...defaults.variables, ...defaults[scheme] }
  const css = Array.from(document.querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .join('\n')
  const blocks = css.split('}')
  const root = blocks.filter((block) => /:root\s*\{/.test(block))
  const schemed = blocks.filter((block) => block.includes(`data-mantine-color-scheme="${scheme}"`))
  for (const block of [...root, ...schemed]) {
    for (const [, name, value] of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      variables[name] = value.trim()
    }
  }
  return variables
}

/** A variable's value as an opaque colour, following `var()` and `color-mix()` through the theme. */
const resolveColour = (
  value: string,
  variables: Record<string, string>,
  theme = canopyTheme,
): string => {
  const palette = /^var\(--mantine-color-([a-z]+)-(\d)\)$/.exec(value)
  if (palette) return theme.colors[palette[1]][Number(palette[2])]
  const reference = /^var\((--[\w-]+)\)$/.exec(value)
  if (reference) return resolveColour(variables[reference[1]], variables, theme)
  const mix = /^color-mix\(in srgb, (var\([^)]+\)) (\d+)%, (var\([^)]+\))\)$/.exec(value)
  if (mix) {
    const a = resolveColour(mix[1], variables, theme)
    const b = resolveColour(mix[3], variables, theme)
    return composite(a, Number(mix[2]) / 100, b)
  }
  return value
}

describe('CanopyCMSProvider colour and contrast', () => {
  const { colors, white } = canopyTheme
  const { gray, dark, red } = colors
  let light: Record<string, string>
  let darkVars: Record<string, string>
  const inLight = (name: string) => resolveColour(light[name], light)
  const inDark = (name: string) => resolveColour(darkVars[name], darkVars)

  beforeAll(() => {
    render(
      <CanopyCMSProvider>
        <span>text</span>
      </CanopyCMSProvider>,
    )
    light = variablesIn('light')
    darkVars = variablesIn('dark')
    cleanup()
  })

  it('sets the dimmed colour to gray.7 in light mode and the dark.1/dark.2 mix in dark mode', () => {
    expect(light['--mantine-color-dimmed']).toBe('var(--mantine-color-gray-7)')
    expect(darkVars['--mantine-color-dimmed']).toBe(
      'color-mix(in srgb, var(--mantine-color-dark-1) 85%, var(--mantine-color-dark-2))',
    )
    expect(contrastRatio(inLight('--mantine-color-dimmed'), gray[1])).toBeCloseTo(7.35, 2)
    expect(contrastRatio(inDark('--mantine-color-dimmed'), dark[4])).toBeCloseTo(4.63, 2)
    expect(contrastRatio(inDark('--mantine-color-dimmed'), dark[7])).toBeCloseTo(7.16, 2)
    // Distinct from body text, which plain dark.1 is not.
    expect(inDark('--mantine-color-dimmed')).not.toBe(dark[1])
  })

  it('draws placeholders at 4.5:1 on the input background, apart from typed text', () => {
    const placeholder = {
      light: inLight('--mantine-color-placeholder'),
      dark: inDark('--mantine-color-placeholder'),
    }
    expect(contrastRatio(placeholder.light, white)).toBeCloseTo(4.66, 2)
    expect(contrastRatio(placeholder.dark, dark[6])).toBeCloseTo(4.71, 2)
    // Further from the text colour than the dimmed colour is, so it never passes for a value.
    expect(contrastRatio(placeholder.light, inLight('--mantine-color-text'))).toBeCloseTo(4.5, 2)
    expect(contrastRatio(placeholder.dark, inDark('--mantine-color-text'))).toBeCloseTo(1.74, 2)
    expect(contrastRatio(placeholder.dark, inDark('--mantine-color-text'))).toBeGreaterThan(
      contrastRatio(inDark('--mantine-color-dimmed'), inDark('--mantine-color-text')),
    )
  })

  it('draws focus rings, focused borders and checked controls at 3:1 in both schemes', () => {
    // Mantine draws rings and focused borders in its primary colour, which the theme makes the ring.
    expect(light['--mantine-primary-color-filled']).toBe('var(--canopy-focus-ring)')
    expect(darkVars['--mantine-primary-color-filled']).toBe('var(--canopy-focus-ring)')
    expect(light['--canopy-focus-ring']).toBe('var(--mantine-color-brand-7)')
    expect(darkVars['--canopy-focus-ring']).toBe('var(--mantine-color-brand-5)')
    const indicator = {
      light: inLight('--mantine-primary-color-filled'),
      dark: inDark('--mantine-primary-color-filled'),
    }
    expect(contrastRatio(indicator.light, gray[1])).toBeCloseTo(4.48, 2)
    expect(
      [dark[5], dark[6], dark[7]].map((bg) => Number(contrastRatio(indicator.dark, bg).toFixed(2))),
    ).toEqual([3.05, 3.7, 4.23])
    // A checked control's tick stays white, 3:1 or more on the ring.
    expect(light['--canopy-focus-ring-contrast']).toBe(white)
    expect(darkVars['--canopy-focus-ring-contrast']).toBe(white)
    expect(contrastRatio(white, indicator.light)).toBeCloseTo(4.98, 2)
    expect(contrastRatio(white, indicator.dark)).toBeCloseTo(3.67, 2)
  })

  it('borders an unchecked Checkbox, Radio and Switch at 3:1 on their own fill', () => {
    // A Checkbox and Radio are white or dark.6 inside; a Switch's track is gray.2 or dark.6.
    expect(contrastRatio(inLight('--canopy-input-border'), white)).toBeCloseTo(3.9, 2)
    expect(contrastRatio(inLight('--canopy-input-border'), gray[2])).toBeCloseTo(3.29, 2)
    expect(contrastRatio(inDark('--canopy-input-border'), dark[6])).toBeCloseTo(4.09, 2)
  })

  it('sets dimmed text in italics in dark mode only', () => {
    expect(light['--canopy-dimmed-font-style']).toBe('normal')
    expect(darkVars['--canopy-dimmed-font-style']).toBe('italic')
  })

  it('draws danger text at red.9 in light mode and red.3 in dark, 4.5:1 wherever it sits', () => {
    expect(light['--canopy-danger-text']).toBe('var(--mantine-color-red-9)')
    expect(darkVars['--canopy-danger-text']).toBe('var(--mantine-color-red-3)')
    const lightPs = getPrimaryShade(canopyTheme, 'light')
    const darkPs = getPrimaryShade(canopyTheme, 'dark')
    const lightRatios = [white, gray[0], gray[1], composite(red[lightPs], 0.12, white)].map((bg) =>
      contrastRatio(red[9], bg),
    )
    expect(lightRatios.map((r) => Number(r.toFixed(2)))).toEqual([5.46, 5.18, 4.91, 4.65])
    // A red menu item's hover is red's light hover tint over the dark dropdown (dark.6).
    const darkRatios = [
      dark[4],
      dark[5],
      dark[6],
      dark[7],
      composite(red[darkPs - 2], 0.2, dark[6]),
    ].map((bg) => contrastRatio(red[3], bg))
    expect(darkRatios.map((r) => Number(r.toFixed(2)))).toEqual([5.46, 6.09, 7.38, 8.44, 4.8])
  })

  it('draws input borders at 3:1 on the surfaces inputs sit on', () => {
    const border = {
      light: inLight('--canopy-input-border'),
      dark: inDark('--canopy-input-border'),
    }
    // The form pane is the muted surface, the lowest-contrast one an input sits on.
    expect(contrastRatio(border.light, white)).toBeCloseTo(3.9, 2)
    expect(contrastRatio(border.light, inLight('--canopy-surface-muted'))).toBeCloseTo(3.51, 2)
    expect(contrastRatio(border.dark, inDark('--canopy-surface-muted'))).toBeCloseTo(3.37, 2)
    expect(contrastRatio(border.dark, dark[6])).toBeCloseTo(4.09, 2)
    expect(contrastRatio(border.dark, dark[7])).toBeCloseTo(4.68, 2)
  })

  it('fills primary Buttons and Badges dark enough for white text in both schemes', () => {
    expect(light['--canopy-primary-fill']).toBe('var(--mantine-color-brand-7)')
    expect(darkVars['--canopy-primary-fill']).toBe('var(--mantine-color-brand-7)')
    expect(darkVars['--canopy-primary-fill-hover']).toBe('var(--mantine-color-brand-8)')
    expect(contrastRatio(white, inLight('--canopy-primary-fill'))).toBeCloseTo(4.98, 2)
    expect(contrastRatio(white, inDark('--canopy-primary-fill'))).toBeCloseTo(4.98, 2)
    expect(contrastRatio(white, inDark('--canopy-primary-fill-hover'))).toBeCloseTo(5.67, 2)
  })

  it('puts an orange count in the text colour on an opaque orange tint', () => {
    expect(light['--canopy-count-bg-orange']).toBe(
      'color-mix(in srgb, var(--mantine-color-orange-filled) 20%, var(--mantine-color-body))',
    )
    expect(
      contrastRatio(inLight('--mantine-color-text'), inLight('--canopy-count-bg-orange')),
    ).toBeCloseTo(16.83, 2)
    expect(
      contrastRatio(inDark('--mantine-color-text'), inDark('--canopy-count-bg-orange')),
    ).toBeCloseTo(6.43, 2)
  })

  it('puts a count in the text colour on a tint of the primary colour', () => {
    expect(light['--canopy-count-bg']).toBe(
      'color-mix(in srgb, var(--mantine-primary-color-filled) 20%, var(--mantine-color-body))',
    )
    const tint = (vars: Record<string, string>, scheme: 'light' | 'dark') =>
      composite(
        colors.brand[getPrimaryShade(canopyTheme, scheme)],
        0.2,
        resolveColour(vars['--mantine-color-body'], vars),
      )
    expect(contrastRatio(inLight('--mantine-color-text'), tint(light, 'light'))).toBeCloseTo(
      16.01,
      2,
    )
    expect(contrastRatio(inDark('--mantine-color-text'), tint(darkVars, 'dark'))).toBeCloseTo(
      7.2,
      2,
    )
  })

  describe('coloured text, light and subtle variants', () => {
    const lightPs = getPrimaryShade(canopyTheme, 'light')
    const darkPs = getPrimaryShade(canopyTheme, 'dark')
    // The controls the guidelines name, by the colour each is drawn in.
    const named = {
      'light orange buttons': 'orange',
      'light red buttons ("Purge", "Delete branch")': 'red',
      'light brand buttons ("Save", "Open")': 'brand',
      '"In review" badge': 'green',
      '"Approved" badge': 'teal',
      'warning text': 'yellow',
      'neutral badges': 'gray',
    } as const

    for (const [control, colour] of Object.entries(named)) {
      it(`reaches 4.5:1 for ${control}, at rest and hovered, in both schemes`, () => {
        const scale = colors[colour]
        for (const name of ['text', 'light-color', 'outline']) {
          expect(light[`--mantine-color-${colour}-${name}`]).toBe(
            light[`--mantine-color-${colour}-light-color`],
          )
        }
        const text = {
          light: inLight(`--mantine-color-${colour}-light-color`),
          dark: inDark(`--mantine-color-${colour}-light-color`),
        }
        for (const surface of [white, gray[1]]) {
          for (const opacity of [0.1, 0.12]) {
            const tint = composite(scale[lightPs], opacity, surface)
            expect(contrastRatio(text.light, tint)).toBeGreaterThanOrEqual(4.5)
          }
        }
        for (const surface of [dark[4], dark[6], dark[7]]) {
          for (const opacity of [0.15, 0.2]) {
            const tint = composite(scale[Math.max(darkPs - 2, 0)], opacity, surface)
            expect(contrastRatio(text.dark, tint)).toBeGreaterThanOrEqual(4.5)
          }
        }
        // Plain coloured text (`c="red"`) on the lightest dark surface, the menu hover.
        expect(
          contrastRatio(inDark(`--mantine-color-${colour}-text`), dark[4]),
        ).toBeGreaterThanOrEqual(4.5)
      })
    }

    it('names a step of the scale where one reaches 4.5:1, and darkens the end shade otherwise', () => {
      expect(light['--mantine-color-brand-light-color']).toBe('var(--mantine-color-brand-9)')
      expect(light['--mantine-color-gray-light-color']).toBe('var(--mantine-color-gray-7)')
      expect(light['--mantine-color-orange-light-color']).toMatch(/^rgba\(/)
      expect(darkVars['--mantine-color-red-text']).toBe('var(--mantine-color-red-2)')
    })

    it("draws a light orange button's label in the readable orange", () => {
      const { getByText } = render(
        <CanopyCMSProvider>
          <Button color="orange" variant="light">
            Withdraw
          </Button>
        </CanopyCMSProvider>,
      )
      expect(
        getByText('Withdraw').closest('button')?.style.getPropertyValue('--button-color'),
      ).toBe('var(--mantine-color-orange-light-color)')
    })
  })
})

describe('CanopyCMSProvider focus ring for adopter brands', () => {
  /** The ring and its contrast colour a provider with `brand` writes, resolved per scheme. */
  const ringFor = (brand: string) => {
    const theme = mergeMantineTheme(DEFAULT_THEME, createCanopyTheme({ colors: { brand } }))
    render(
      <CanopyCMSProvider colors={{ brand }}>
        <span>text</span>
      </CanopyCMSProvider>,
    )
    const read = (scheme: 'light' | 'dark') => {
      const vars = variablesIn(scheme)
      return {
        name: vars['--canopy-focus-ring'],
        ring: resolveColour(vars['--canopy-focus-ring'], vars, theme),
        contrast: vars['--canopy-focus-ring-contrast'],
      }
    }
    const result = { theme, light: read('light'), dark: read('dark') }
    cleanup()
    return result
  }

  it('lightens a dark brand in dark mode until the ring is 3:1 on dark.5', () => {
    const { theme, light, dark } = ringFor('#1e3a8a')
    const surfaces = theme.colors.dark
    // The primary shade, dark.5's 2.21:1, would vanish; shade 3 is the first step past 3:1.
    expect(contrastRatio(theme.colors.brand[5], surfaces[5])).toBeCloseTo(2.21, 2)
    expect(dark.name).toBe('var(--mantine-color-brand-3)')
    expect(contrastRatio(dark.ring, surfaces[5])).toBeCloseTo(4.08, 2)
    expect(light.name).toBe('var(--mantine-color-brand-7)')
    expect(contrastRatio(light.ring, theme.colors.gray[1])).toBeCloseTo(6.48, 2)
    // White is 2.75:1 on the lightened ring, so a tick on it turns black.
    expect(contrastRatio(theme.white, dark.ring)).toBeCloseTo(2.75, 2)
    expect(dark.contrast).toBe(theme.black)
    expect(contrastRatio(theme.black, dark.ring)).toBeCloseTo(7.64, 2)
    expect(light.contrast).toBe(theme.white)
  })

  it('darkens a light brand in light mode until the ring is 3:1 on gray.1', () => {
    const { theme, light, dark } = ringFor('#facc15')
    expect(light.name).toBe('var(--mantine-color-brand-9)')
    expect(contrastRatio(light.ring, theme.colors.gray[1])).toBeCloseTo(3.02, 2)
    expect(light.contrast).toBe(theme.white)
    expect(contrastRatio(theme.white, light.ring)).toBeCloseTo(3.36, 2)
    expect(dark.name).toBe('var(--mantine-color-brand-5)')
    expect(contrastRatio(dark.ring, theme.colors.dark[5])).toBeCloseTo(7.42, 2)
    expect(dark.contrast).toBe(theme.black)
  })
})

const rootVar = (el: Element | null, name: string) =>
  (el?.closest('[class*="-root"]') as HTMLElement | null)?.style.getPropertyValue(name) ?? ''

describe('CanopyCMSProvider checked controls', () => {
  it('fills a checked primary Checkbox and Radio, and marks the active Tab, with the ring', () => {
    const { getByLabelText, getByRole } = render(
      <CanopyCMSProvider colors={{ brand: '#facc15' }}>
        <Checkbox label="Primary box" defaultChecked />
        <Checkbox label="Red box" color="red" defaultChecked />
        <Checkbox label="Outline box" variant="outline" defaultChecked />
        <Radio label="Primary dot" defaultChecked />
        <Checkbox.Indicator checked data-testid="box-indicator" />
        <Radio.Indicator checked data-testid="dot-indicator" />
        <Tabs defaultValue="a">
          <Tabs.List>
            <Tabs.Tab value="a">Fields</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <Tabs defaultValue="b" variant="pills">
          <Tabs.List>
            <Tabs.Tab value="b">Pill</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <Switch label="Brand switch" color="brand" />
      </CanopyCMSProvider>,
    )
    const ring = 'var(--canopy-focus-ring)'
    const own = (el: Element, name: string) => (el as HTMLElement).style.getPropertyValue(name)
    expect(rootVar(getByLabelText('Primary box'), '--checkbox-color')).toBe(ring)
    expect(rootVar(getByLabelText('Red box'), '--checkbox-color')).not.toBe(ring)
    expect(rootVar(getByLabelText('Outline box'), '--checkbox-color')).not.toBe(ring)
    expect(rootVar(getByLabelText('Primary dot'), '--radio-color')).toBe(ring)
    expect(own(document.querySelector('[data-testid="box-indicator"]')!, '--checkbox-color')).toBe(
      ring,
    )
    expect(own(document.querySelector('[data-testid="dot-indicator"]')!, '--radio-color')).toBe(
      ring,
    )
    expect(
      own(getByRole('tab', { name: 'Fields' }).closest('.mantine-Tabs-root')!, '--tabs-color'),
    ).toBe(ring)
    // Pills put text on the colour, so they keep Mantine's.
    expect(
      own(getByRole('tab', { name: 'Pill' }).closest('.mantine-Tabs-root')!, '--tabs-color'),
    ).not.toBe(ring)
    expect(rootVar(getByLabelText('Brand switch'), '--switch-color')).toBe(ring)
  })

  it("draws a primary Checkbox's tick, Radio's dot and Switch's thumb in the ring's contrast", () => {
    const { getByLabelText } = render(
      <CanopyCMSProvider>
        <Checkbox label="Primary box" />
        <Checkbox label="Red box" color="red" />
        <Checkbox label="Own tick" iconColor="black" />
        <Radio label="Primary dot" />
        <Switch label="Primary switch" />
        <Switch label="Green switch" color="green" />
      </CanopyCMSProvider>,
    )
    const ring = 'var(--canopy-focus-ring-contrast)'
    expect(rootVar(getByLabelText('Primary box'), '--checkbox-icon-color')).toBe(ring)
    expect(rootVar(getByLabelText('Red box'), '--checkbox-icon-color')).not.toBe(ring)
    expect(rootVar(getByLabelText('Own tick'), '--checkbox-icon-color')).not.toBe(ring)
    expect(rootVar(getByLabelText('Primary dot'), '--radio-icon-color')).toBe(ring)
    expect(rootVar(getByLabelText('Primary switch'), '--canopy-switch-thumb-on')).toBe(ring)
    expect(rootVar(getByLabelText('Green switch'), '--canopy-switch-thumb-on')).toBe('')
  })
})

/** Whether the provider's stylesheet sets `property` on `element`, by matching its rules' selectors. */
const canopyRuleSets = (element: Element, property: string): boolean => {
  const sheet = document.querySelector<HTMLStyleElement>('style[data-canopy-styles]')?.sheet
  if (!sheet) throw new Error('no canopy stylesheet')
  return Array.from(sheet.cssRules).some(
    (rule) =>
      rule instanceof CSSStyleRule &&
      rule.style.getPropertyValue(property) !== '' &&
      rule.selectorText
        .split(/,(?![^(]*\))/)
        .some((selector) => !selector.includes('::') && element.matches(selector.trim())),
  )
}

describe('CanopyCMSProvider stylesheet', () => {
  it('borders unchecked, enabled Checkboxes, Radios and Switches with the input border', () => {
    const { getByLabelText } = render(
      <CanopyCMSProvider>
        <Checkbox label="Off" />
        <Checkbox label="On" defaultChecked />
        <Checkbox label="Disabled" disabled />
        <Radio label="Radio off" />
        <Radio label="Radio on" defaultChecked />
        <Switch label="Switch off" />
        <Switch label="Switch on" defaultChecked />
        <Switch label="Switch disabled" disabled />
        <Switch label="Switch on, disabled" defaultChecked disabled />
      </CanopyCMSProvider>,
    )
    expect(canopyRuleSets(getByLabelText('Off'), 'border-color')).toBe(true)
    expect(canopyRuleSets(getByLabelText('On'), 'border-color')).toBe(false)
    expect(canopyRuleSets(getByLabelText('Disabled'), 'border-color')).toBe(false)
    expect(canopyRuleSets(getByLabelText('Radio off'), 'border-color')).toBe(true)
    expect(canopyRuleSets(getByLabelText('Radio on'), 'border-color')).toBe(false)
    const track = (label: string) =>
      getByLabelText(label).parentElement?.querySelector('.mantine-Switch-track') as Element
    expect(canopyRuleSets(track('Switch off'), '--switch-bd')).toBe(true)
    expect(canopyRuleSets(track('Switch on'), '--switch-bd')).toBe(false)
    expect(canopyRuleSets(track('Switch disabled'), '--switch-bd')).toBe(false)
    const thumb = (label: string) => track(label).querySelector('.mantine-Switch-thumb') as Element
    expect(canopyRuleSets(thumb('Switch on'), '--switch-thumb-bg')).toBe(true)
    // An unchecked thumb's position is the state cue, so it is bordered too.
    expect(canopyRuleSets(thumb('Switch off'), '--switch-thumb-bd')).toBe(true)
    expect(canopyRuleSets(thumb('Switch disabled'), '--switch-thumb-bd')).toBe(false)
    expect(canopyRuleSets(thumb('Switch off'), '--switch-thumb-bg')).toBe(false)
    // A disabled thumb keeps Mantine's colour: the checked rule out-specifies Mantine's disabled one.
    expect(canopyRuleSets(thumb('Switch on, disabled'), '--switch-thumb-bg')).toBe(false)
  })

  it('puts the armed combobox option and the selected day on the primary fill', async () => {
    const { getByRole } = render(
      <CanopyCMSProvider>
        <Select
          label="Collection"
          data={['Posts', 'Pages']}
          dropdownOpened
          defaultValue="Posts"
          selectFirstOptionOnChange
        />
      </CanopyCMSProvider>,
    )
    const option = await waitFor(() => getByRole('option', { name: 'Posts' }))
    option.setAttribute('data-combobox-selected', 'true')
    expect(canopyRuleSets(option, '--mantine-primary-color-filled')).toBe(true)
    const day = document.createElement('button')
    day.className = 'mantine-DateTimePicker-day'
    day.setAttribute('data-selected', 'true')
    expect(canopyRuleSets(day, 'background-color')).toBe(true)
    day.removeAttribute('data-selected')
    expect(canopyRuleSets(day, 'background-color')).toBe(false)
  })

  it('sets blocked menu items, empty comboboxes and outside days in the dimmed font style', () => {
    render(<CanopyCMSProvider>{null}</CanopyCMSProvider>)
    const item = document.createElement('button')
    item.className = 'mantine-Menu-item'
    expect(canopyRuleSets(item, 'font-style')).toBe(false)
    item.setAttribute('aria-disabled', 'true')
    expect(canopyRuleSets(item, 'font-style')).toBe(true)
    const outside = document.createElement('button')
    outside.className = 'mantine-DateTimePicker-day'
    outside.setAttribute('data-outside', 'true')
    expect(canopyRuleSets(outside, 'font-style')).toBe(true)
    expect(canopyRuleSets(outside, 'opacity')).toBe(true)
    outside.setAttribute('data-disabled', 'true')
    expect(canopyRuleSets(outside, 'opacity')).toBe(false)
  })
})

describe('CanopyCMSProvider text', () => {
  it('sets dimmed Text in the dimmed font style unless the caller sets one', () => {
    const { getByText } = render(
      <CanopyCMSProvider>
        <Text c="dimmed">Quiet</Text>
        <Text c="dimmed" fs="normal">
          Upright
        </Text>
        <Text c="red">Loud</Text>
      </CanopyCMSProvider>,
    )
    expect(getByText('Quiet').style.fontStyle).toBe('var(--canopy-dimmed-font-style)')
    expect(getByText('Upright').style.fontStyle).toBe('normal')
    expect(getByText('Loud').style.fontStyle).toBe('')
  })

  it("sets an input's description in the dimmed font style", () => {
    const { getByText } = render(
      <CanopyCMSProvider>
        <TextInput label="Slug" description="The entry's file name" />
        <Select label="Type" description="What the entry holds" data={['Post']} />
        <Switch label="Default" description="New entries take this type" />
        <Checkbox label="Required" description="Saving needs a value" />
        <Radio label="Draft" description="Not yet published" />
      </CanopyCMSProvider>,
    )
    for (const text of [
      "The entry's file name",
      'What the entry holds',
      'New entries take this type',
      'Saving needs a value',
      'Not yet published',
    ]) {
      expect(getByText(text).style.fontStyle).toBe('var(--canopy-dimmed-font-style)')
    }
  })

  it('sets badges in sentence case, an xs badge at the sm size', () => {
    const { getByText } = render(
      <CanopyCMSProvider>
        <Badge color="green">In review</Badge>
      </CanopyCMSProvider>,
    )
    const root = getByText('In review').closest('.mantine-Badge-root') as HTMLElement
    expect(root.style.textTransform).toBe('none')
    expect(root.style.getPropertyValue('--badge-fz-xs')).toBe('var(--badge-fz-sm)')
  })
})

describe('CanopyCMSProvider adopter palettes it cannot measure', () => {
  it('leaves every colour to Mantine in dark mode when the dark scale is oklch', () => {
    const oklchDark = Array.from(
      { length: 10 },
      (_, i) => `oklch(${80 - i * 8}% 0.003 264)`,
    ) as unknown as MantineColorsTuple
    render(
      <CanopyCMSProvider themeOverride={{ colors: { dark: oklchDark } }}>
        <span>text</span>
      </CanopyCMSProvider>,
    )
    const css = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n')
    expect(css).not.toMatch(/--mantine-color-[a-z]+-light-color:\s*(rgba?\(|#)/)
    cleanup()
  })

  it('leaves every colour to Mantine when the gray scale it measures against is oklch', () => {
    const oklchGray = Array.from(
      { length: 10 },
      (_, i) => `oklch(${98 - i * 8}% 0.003 264)`,
    ) as unknown as MantineColorsTuple
    render(
      <CanopyCMSProvider themeOverride={{ colors: { gray: oklchGray } }}>
        <span>text</span>
      </CanopyCMSProvider>,
    )
    const css = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n')
    expect(css).not.toMatch(/--mantine-color-[a-z]+-light-color:\s*(rgba?\(|#)/)
    expect(css).toMatch(/--mantine-color-brand-light-color:\s*var\(--mantine-color-brand-7\)/)
    cleanup()
  })

  it("leaves a virtual colour's and an oklch palette's variables to Mantine", () => {
    const oklch = Array.from(
      { length: 10 },
      (_, i) => `oklch(${90 - i * 7}% 0.16 250)`,
    ) as unknown as MantineColorsTuple
    render(
      <CanopyCMSProvider
        themeOverride={{
          colors: { virt: virtualColor({ name: 'virt', light: 'blue', dark: 'orange' }), oklch },
        }}
      >
        <span>text</span>
      </CanopyCMSProvider>,
    )
    const css = Array.from(document.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n')
    for (const name of ['virt', 'oklch']) {
      for (const suffix of ['text', 'light-color', 'outline']) {
        const written = css.match(new RegExp(`--mantine-color-${name}-${suffix}:\\s*([^;]+);`, 'g'))
        // Only Mantine's own value, one of the colour's variables, never a computed black or grey.
        for (const declaration of written ?? []) {
          expect(declaration).toMatch(new RegExp(`:\\s*var\\(--mantine-color-${name}-[\\w]+\\);$`))
        }
      }
    }
    // The measurable default palette is still computed alongside them.
    expect(css).toMatch(/--mantine-color-orange-light-color:\s*rgba\(/)
  })
})

describe('CanopyCMSProvider tooltips', () => {
  it('opens a tooltip on keyboard focus without the caller asking', async () => {
    const { getByRole } = render(
      <CanopyCMSProvider>
        <Tooltip label="Expand">
          <button type="button">E</button>
        </Tooltip>
      </CanopyCMSProvider>,
    )
    act(() => getByRole('button').focus())
    await waitFor(() => expect(getByRole('tooltip').textContent).toBe('Expand'))
  })
})

describe('CanopyCMSProvider input borders', () => {
  const wrapperBorder = (input: HTMLElement) =>
    (input.closest('.mantine-Input-wrapper') as HTMLElement | null)?.style.getPropertyValue(
      '--input-bd',
    )

  it('borders a default input with the input border token', () => {
    const { getByLabelText } = render(
      <CanopyCMSProvider>
        <TextInput label="Title" />
      </CanopyCMSProvider>,
    )
    expect(wrapperBorder(getByLabelText('Title'))).toBe('var(--canopy-input-border)')
  })

  it("leaves an errored input's border, and a filled input's, to Mantine", () => {
    const { getByLabelText } = render(
      <CanopyCMSProvider>
        <TextInput label="Title" error="Required" />
        <TextInput label="Slug" variant="filled" />
      </CanopyCMSProvider>,
    )
    expect(wrapperBorder(getByLabelText('Title'))).toBe('')
    expect(wrapperBorder(getByLabelText('Slug'))).toBe('')
  })
})

describe('DestructiveMenuItem', () => {
  it('draws its label in the danger text colour over the red hover tint', async () => {
    const { getByRole } = render(
      <CanopyCMSProvider>
        <Menu opened>
          <Menu.Target>
            <button type="button">Actions</button>
          </Menu.Target>
          <Menu.Dropdown>
            <DestructiveMenuItem>Delete entry</DestructiveMenuItem>
          </Menu.Dropdown>
        </Menu>
      </CanopyCMSProvider>,
    )
    const item = await waitFor(() => getByRole('menuitem', { name: 'Delete entry' }))
    expect(item.style.color).toBe('var(--canopy-danger-text)')
    expect(item.style.getPropertyValue('--menu-item-hover')).toBe(
      'var(--mantine-color-red-light-hover)',
    )
  })

  it('is dimmed with its reason when blocked', async () => {
    const { getByRole } = render(
      <CanopyCMSProvider>
        <Menu opened>
          <Menu.Target>
            <button type="button">Actions</button>
          </Menu.Target>
          <Menu.Dropdown>
            <DestructiveMenuItem blockedReason="This branch is in review.">
              Delete entry
            </DestructiveMenuItem>
          </Menu.Dropdown>
        </Menu>
      </CanopyCMSProvider>,
    )
    const item = await waitFor(() => getByRole('menuitem', { name: /Delete entry/ }))
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.style.color).toBe('var(--mantine-color-dimmed)')
  })
})
