import React, { useEffect } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  ActionIcon,
  Alert,
  Button,
  DEFAULT_THEME,
  Drawer,
  Menu,
  Modal,
  Notification,
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
const resolveColour = (value: string, variables: Record<string, string>): string => {
  const palette = /^var\(--mantine-color-([a-z]+)-(\d)\)$/.exec(value)
  if (palette) return canopyTheme.colors[palette[1]][Number(palette[2])]
  const reference = /^var\((--[\w-]+)\)$/.exec(value)
  if (reference) return resolveColour(variables[reference[1]], variables)
  const mix = /^color-mix\(in srgb, (var\([^)]+\)) (\d+)%, (var\([^)]+\))\)$/.exec(value)
  if (mix) {
    const a = resolveColour(mix[1], variables)
    const b = resolveColour(mix[3], variables)
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

  it('draws placeholders at 4.5:1 on the input background in both schemes', () => {
    expect(light['--mantine-color-placeholder']).toBe('var(--mantine-color-dimmed)')
    expect(darkVars['--mantine-color-placeholder']).toBe('var(--mantine-color-dimmed)')
    expect(contrastRatio(inLight('--mantine-color-placeholder'), white)).toBeCloseTo(8.18, 2)
    expect(contrastRatio(inDark('--mantine-color-placeholder'), dark[6])).toBeCloseTo(6.26, 2)
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
    expect(darkRatios.map((r) => Number(r.toFixed(2)))).toEqual([5.46, 6.09, 7.38, 8.44, 5.81])
  })

  it('draws input borders at 3:1 on the surfaces inputs sit on', () => {
    const border = {
      light: inLight('--canopy-input-border'),
      dark: inDark('--canopy-input-border'),
    }
    expect(contrastRatio(border.light, white)).toBeCloseTo(3.32, 2)
    expect(contrastRatio(border.light, inLight('--canopy-surface-subtle'))).toBeCloseTo(3.15, 2)
    expect(contrastRatio(border.dark, dark[6])).toBeCloseTo(3.53, 2)
    expect(contrastRatio(border.dark, inDark('--canopy-surface-subtle'))).toBeCloseTo(3.53, 2)
    expect(contrastRatio(border.dark, dark[7])).toBeCloseTo(4.04, 2)
  })

  it('fills primary controls dark enough for white text: Submit for review in both schemes', () => {
    const filled = (scheme: 'light' | 'dark') => colors.brand[getPrimaryShade(canopyTheme, scheme)]
    expect(contrastRatio(white, filled('light'))).toBeCloseTo(4.98, 2)
    expect(contrastRatio(white, filled('dark'))).toBeCloseTo(5.67, 2)
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
      7.94,
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
      expect(darkVars['--mantine-color-red-light-color']).toBe('var(--mantine-color-red-3)')
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

describe('CanopyCMSProvider adopter palettes it cannot measure', () => {
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
            <DestructiveMenuItem>Delete…</DestructiveMenuItem>
          </Menu.Dropdown>
        </Menu>
      </CanopyCMSProvider>,
    )
    const item = await waitFor(() => getByRole('menuitem', { name: 'Delete…' }))
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
              Delete…
            </DestructiveMenuItem>
          </Menu.Dropdown>
        </Menu>
      </CanopyCMSProvider>,
    )
    const item = await waitFor(() => getByRole('menuitem', { name: /Delete…/ }))
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.style.color).toBe('var(--mantine-color-dimmed)')
  })
})
