'use client'

import React, { useMemo } from 'react'

import {
  Alert,
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  DEFAULT_THEME,
  Drawer,
  Input,
  MantineProvider,
  Modal,
  Notification,
  Radio,
  Switch,
  Tabs,
  Text,
  Tooltip,
  getDefaultZIndex,
  getPrimaryShade,
  mergeThemeOverrides,
  type CSSVariablesResolver,
  type MantineColorScheme,
  type MantineColorsTuple,
  type MantineTheme,
  type MantineThemeOverride,
  createTheme,
  darken,
} from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { ModalsProvider } from '@mantine/modals'
import { generateColors } from '@mantine/colors-generator'

import { composite, contrastRatio, isMeasurable, readableOnScale } from './contrast'

import '@mantine/core/styles.css'
import '@mantine/dates/styles.css'
import '@mantine/notifications/styles.css'
import '@mantine/dropzone/styles.css'
import '@mdxeditor/editor/style.css'

export type CanopyColorInput = MantineColorsTuple | string

export interface CanopyColorConfig {
  brand?: CanopyColorInput
  primary?: CanopyColorInput
  neutral?: CanopyColorInput
  accent?: CanopyColorInput
}

export interface CanopyThemeOptions {
  colors?: CanopyColorConfig
  colorScheme?: MantineColorScheme
  themeOverride?: MantineThemeOverride
  withNotifications?: boolean
}

const defaultCanopyColors: Required<CanopyColorConfig> = {
  brand: '#3b82f6',
  primary: '#2563eb',
  neutral: '#1f2937',
  accent: '#f59e0b',
}

export const CANOPY_DEFAULT_COLORS = defaultCanopyColors

const toScale = (
  input: CanopyColorInput | undefined,
  fallbackKey: keyof typeof DEFAULT_THEME.colors,
  fallback: CanopyColorInput,
) => {
  const fallbackScale =
    DEFAULT_THEME.colors[fallbackKey] ??
    (Array.isArray(fallback) && fallback.length === 10
      ? (fallback as MantineColorsTuple)
      : generateColors(String(fallback)))
  if (!input) return fallbackScale
  if (Array.isArray(input) && input.length === 10) return input as MantineColorsTuple

  if (typeof input === 'string') {
    const fromTheme = DEFAULT_THEME.colors[input as keyof typeof DEFAULT_THEME.colors]
    if (fromTheme) return fromTheme
    try {
      return generateColors(input)
    } catch {
      return fallbackScale
    }
  }

  return fallbackScale
}

// Icon-only close buttons are named "Close". Every Modal and Drawer one keeps it under a caller's
// `closeButtonProps` unless that sets `aria-label`; a toast's or Alert's is replaced whole.
const CLOSE_BUTTON_PROPS = { 'aria-label': 'Close' }
// Filled red is red.8 under white; filled orange is orange.6 under black, since no orange shade
// reaches 4.5:1 under white; a filled primary is `--canopy-primary-fill`. Callers pass a plain
// `color`.
const isPrimary = (theme: MantineTheme, color: string | undefined) =>
  color === undefined || color === theme.primaryColor
interface CheckedControlProps {
  color?: string
  variant?: string
  iconColor?: string
}
const checkboxOnRing = (theme: MantineTheme, props: CheckedControlProps) =>
  isPrimary(theme, props.color)
    ? {
        '--checkbox-color': props.variant === 'outline' ? undefined : 'var(--canopy-focus-ring)',
        '--checkbox-icon-color': props.iconColor ? undefined : 'var(--canopy-focus-ring-contrast)',
      }
    : {}
const radioOnRing = (theme: MantineTheme, props: CheckedControlProps) =>
  isPrimary(theme, props.color)
    ? {
        '--radio-color': props.variant === 'outline' ? undefined : 'var(--canopy-focus-ring)',
        '--radio-icon-color': props.iconColor ? undefined : 'var(--canopy-focus-ring-contrast)',
      }
    : {}
const canopyComponents = {
  Button: Button.extend({
    // The editor's default control size; a per-call `size` is only for a deliberate exception.
    defaultProps: { size: 'xs' },
    vars: (theme, props) => {
      if ((props.variant ?? 'filled') !== 'filled') return { root: {} }
      if (props.color === 'red') {
        return {
          root: { '--button-bg': theme.colors.red[8], '--button-hover': theme.colors.red[9] },
        }
      }
      if (props.color === 'orange') {
        return {
          root: {
            '--button-bg': theme.colors.orange[6],
            '--button-hover': theme.colors.orange[7],
            '--button-color': theme.black,
          },
        }
      }
      if (isPrimary(theme, props.color)) {
        return {
          root: {
            '--button-bg': 'var(--canopy-primary-fill)',
            '--button-hover': 'var(--canopy-primary-fill-hover)',
            '--button-color': 'var(--mantine-color-white)',
          },
        }
      }
      return { root: {} }
    },
  }),
  Badge: Badge.extend({
    // Sentence case, as every other label; an xs badge's 9px is too small for lowercase.
    styles: { root: { textTransform: 'none', '--badge-fz-xs': 'var(--badge-fz-sm)' } },
    vars: (theme, props) =>
      (props.variant ?? 'filled') === 'filled' && isPrimary(theme, props.color)
        ? {
            root: {
              '--badge-bg': 'var(--canopy-primary-fill)',
              '--badge-color': 'var(--mantine-color-white)',
            },
          }
        : { root: {} },
  }),
  ActionIcon: ActionIcon.extend({
    defaultProps: { size: 'sm' },
    vars: (theme, props) =>
      (props.variant ?? 'filled') === 'filled' && isPrimary(theme, props.color)
        ? {
            root: {
              '--ai-bg': 'var(--canopy-primary-fill)',
              '--ai-hover': 'var(--canopy-primary-fill-hover)',
              '--ai-color': 'var(--mantine-color-white)',
            },
          }
        : { root: {} },
  }),
  // Tooltips open on focus and touch too, so an icon-only control's name reaches the keyboard.
  Tooltip: Tooltip.extend({ defaultProps: { events: { hover: true, focus: true, touch: true } } }),
  // A default input's border is `--canopy-input-border`; errored and focused ones keep Mantine's.
  Input: Input.extend({
    styles: (_theme, props) =>
      props.error || (props.variant ?? 'default') !== 'default'
        ? {}
        : { wrapper: { '--input-bd': 'var(--canopy-input-border)' } },
  }),
  // Checkbox, Radio and Tabs name their colour inline even when none is given, and a Switch when
  // one is, past the focus-ring alias; a primary one is pointed at the ring here, and its tick,
  // dot or thumb takes the colour that reads on it.
  Checkbox: Checkbox.extend({ vars: (theme, props) => ({ root: checkboxOnRing(theme, props) }) }),
  CheckboxIndicator: Checkbox.Indicator.extend({
    vars: (theme, props) => ({ indicator: checkboxOnRing(theme, props) }),
  }),
  Radio: Radio.extend({ vars: (theme, props) => ({ root: radioOnRing(theme, props) }) }),
  RadioIndicator: Radio.Indicator.extend({
    vars: (theme, props) => ({ indicator: radioOnRing(theme, props) }),
  }),
  // Pills put text on the colour, which the ring does not measure for.
  Tabs: Tabs.extend({
    vars: (theme, props) => ({
      root:
        isPrimary(theme, props.color) && props.variant !== 'pills'
          ? { '--tabs-color': 'var(--canopy-focus-ring)' }
          : {},
    }),
  }),
  Switch: Switch.extend({
    vars: (theme, props) => ({
      root: isPrimary(theme, props.color) ? { '--switch-color': 'var(--canopy-focus-ring)' } : {},
    }),
    styles: (theme, props) =>
      isPrimary(theme, props.color)
        ? { root: { '--canopy-switch-thumb-on': 'var(--canopy-focus-ring-contrast)' } }
        : {},
  }),
  // Dark dimmed text is nearly as bright as body text, so it also takes the dimmed font style.
  // Every input's description, Checkbox's, Radio's and Switch's included, is an InputWrapper's.
  InputWrapper: Input.Wrapper.extend({
    styles: { description: { fontStyle: 'var(--canopy-dimmed-font-style)' } },
  }),
  // Dimmed Text takes the same style.
  Text: Text.extend({
    styles: (_theme, props) =>
      props.c === 'dimmed' ? { root: { fontStyle: 'var(--canopy-dimmed-font-style)' } } : {},
  }),
  ModalCloseButton: Modal.CloseButton.extend({ defaultProps: CLOSE_BUTTON_PROPS }),
  DrawerCloseButton: Drawer.CloseButton.extend({ defaultProps: CLOSE_BUTTON_PROPS }),
  // Mantine dims a titled toast's text to gray.6 / dark.2, about 3.3:1.
  Notification: Notification.extend({
    defaultProps: { closeButtonProps: CLOSE_BUTTON_PROPS },
    styles: { description: { color: 'var(--mantine-color-text)' } },
  }),
  // A light yellow Alert's title, icon and close button are yellow on pale yellow, under 2:1, so
  // they take the text colour; the tint and the icon's shape still mark it a warning.
  Alert: Alert.extend({
    defaultProps: { closeButtonLabel: 'Close' },
    vars: (_theme, props) =>
      props.color === 'yellow' && (props.variant ?? 'light') === 'light'
        ? { root: { '--alert-color': 'var(--mantine-color-text)' } }
        : { root: {} },
  }),
}

export const createCanopyTheme = (
  options?: Pick<CanopyThemeOptions, 'colors' | 'themeOverride'>,
) => {
  const { colors, themeOverride } = options ?? {}
  const brand = toScale(colors?.brand, 'indigo', defaultCanopyColors.brand)
  const primary = toScale(colors?.primary ?? colors?.brand, 'blue', defaultCanopyColors.primary)
  const neutral = toScale(colors?.neutral, 'gray', defaultCanopyColors.neutral)
  const accent = toScale(colors?.accent, 'teal', defaultCanopyColors.accent)

  const base = createTheme({
    primaryColor: 'brand',
    // Where `--canopy-focus-ring` and `--canopy-primary-fill` start on the primary scale.
    primaryShade: { light: 7, dark: 5 },
    defaultRadius: 'md',
    colors: { ...DEFAULT_THEME.colors, brand, primary, neutral, accent },
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    components: canopyComponents,
  })
  // Deep merge, so an override that sets only some colours or one component's props keeps the rest.
  return mergeThemeOverrides(base, themeOverride ?? {})
}

/**
 * A colour's text, light and subtle variants and outline take the first step, from the primary
 * shade in light mode or Mantine's dark text shade 4, reaching 4.5:1 on its hovered light tint
 * over the lowest-contrast surface (gray.1, dark.4); past the scale's end, the end shade darkened
 * or lightened. A colour, gray or dark scale it cannot measure (`var()`, oklch) keeps Mantine's.
 */
const readableColourVariables = (theme: MantineTheme, scheme: 'light' | 'dark') => {
  const variables: Record<string, string> = {}
  const shade = getPrimaryShade(theme, scheme)
  if (!theme.colors.gray.every(isMeasurable) || !theme.colors.dark.every(isMeasurable)) {
    return variables
  }
  for (const [name, scale] of Object.entries(theme.colors)) {
    if (scale.length !== 10 || !scale.every(isMeasurable)) continue
    const { shade: step, value } =
      scheme === 'light'
        ? readableOnScale(scale, {
            from: shade,
            toward: 'darker',
            background: composite(scale[shade], 0.12, theme.colors.gray[1]),
          })
        : readableOnScale(scale, {
            from: 4,
            toward: 'lighter',
            background: composite(scale[Math.max(shade - 2, 0)], 0.2, theme.colors.dark[4]),
          })
    const colour = step === undefined ? value : `var(--mantine-color-${name}-${step})`
    variables[`--mantine-color-${name}-text`] = colour
    variables[`--mantine-color-${name}-light-color`] = colour
    variables[`--mantine-color-${name}-outline`] = colour
  }
  return variables
}

/** `--canopy-primary-fill`: the first step from the primary shade with white at 4.5:1 on it. */
const primaryFill = (theme: MantineTheme, scheme: 'light' | 'dark') => {
  const scale = theme.colors[theme.primaryColor]
  if (!scale.every(isMeasurable)) {
    return {
      '--canopy-primary-fill': `var(--mantine-color-${theme.primaryColor}-filled)`,
      '--canopy-primary-fill-hover': `var(--mantine-color-${theme.primaryColor}-filled-hover)`,
    }
  }
  const { shade, value } = readableOnScale(scale, {
    from: getPrimaryShade(theme, scheme),
    toward: 'darker',
    background: theme.white,
  })
  const step = (n: number) => `var(--mantine-color-${theme.primaryColor}-${n})`
  return shade === undefined
    ? { '--canopy-primary-fill': value, '--canopy-primary-fill-hover': darken(value, 0.1) }
    : {
        '--canopy-primary-fill': step(shade),
        '--canopy-primary-fill-hover': step(shade === 9 ? 8 : shade + 1),
      }
}

/**
 * `--canopy-focus-ring`: the first step from the primary shade, darker in light mode and lighter in
 * dark, at 3:1 on gray.1 or dark.5. Mantine draws focus rings, focused borders and a checked
 * Switch in `--mantine-primary-color-filled`, so that becomes the ring; `canopyComponents` points
 * Checkbox, Radio and Tabs at it. A tick on it is white, or black where white is under 3:1.
 */
const focusRing = (theme: MantineTheme, scheme: 'light' | 'dark') => {
  const scale = theme.colors[theme.primaryColor]
  const surface = scheme === 'light' ? theme.colors.gray[1] : theme.colors.dark[5]
  const ring =
    scale.every(isMeasurable) && isMeasurable(surface)
      ? readableOnScale(scale, {
          from: getPrimaryShade(theme, scheme),
          toward: scheme === 'light' ? 'darker' : 'lighter',
          background: surface,
          minimum: 3,
        })
      : undefined
  const contrast = ring && contrastRatio(theme.white, ring.value) < 3 ? theme.black : theme.white
  return {
    '--canopy-focus-ring':
      ring === undefined
        ? `var(--mantine-color-${theme.primaryColor}-filled)`
        : ring.shade === undefined
          ? ring.value
          : `var(--mantine-color-${theme.primaryColor}-${ring.shade})`,
    '--canopy-focus-ring-contrast': contrast,
    '--mantine-primary-color-filled': 'var(--canopy-focus-ring)',
  }
}

/**
 * docs/ux-guidelines.md "Colour and contrast" says what each token is for; `theme.test.tsx` pins
 * every ratio for the default palette. Dark dimmed mixes dark.1 with dark.2, since dark.1 alone
 * reads as body text; placeholders sit further from it, so they never pass for a value.
 */
const canopyCssVariablesResolver: CSSVariablesResolver = (theme) => ({
  variables: {
    '--canopy-count-bg':
      'color-mix(in srgb, var(--mantine-primary-color-filled) 20%, var(--mantine-color-body))',
    '--canopy-count-bg-orange':
      'color-mix(in srgb, var(--mantine-color-orange-filled) 20%, var(--mantine-color-body))',
  },
  light: {
    ...readableColourVariables(theme, 'light'),
    '--mantine-color-dimmed': 'var(--mantine-color-gray-7)',
    '--mantine-color-placeholder':
      'color-mix(in srgb, var(--mantine-color-gray-6) 60%, var(--mantine-color-gray-7))',
    '--canopy-danger-text': 'var(--mantine-color-red-9)',
    '--canopy-input-border':
      'color-mix(in srgb, var(--mantine-color-gray-6) 80%, var(--mantine-color-gray-7))',
    '--canopy-surface-subtle': 'var(--mantine-color-gray-0)',
    '--canopy-surface-muted': 'var(--mantine-color-gray-1)',
    '--canopy-dimmed-font-style': 'normal',
    ...primaryFill(theme, 'light'),
    ...focusRing(theme, 'light'),
  },
  dark: {
    ...readableColourVariables(theme, 'dark'),
    '--mantine-color-dimmed':
      'color-mix(in srgb, var(--mantine-color-dark-1) 85%, var(--mantine-color-dark-2))',
    '--mantine-color-placeholder':
      'color-mix(in srgb, var(--mantine-color-dark-2) 60%, var(--mantine-color-dark-1))',
    '--canopy-danger-text': 'var(--mantine-color-red-3)',
    '--canopy-input-border':
      'color-mix(in srgb, var(--mantine-color-dark-2) 80%, var(--mantine-color-dark-1))',
    '--canopy-surface-subtle': 'var(--mantine-color-dark-6)',
    '--canopy-surface-muted': 'var(--mantine-color-dark-5)',
    '--canopy-dimmed-font-style': 'italic',
    ...primaryFill(theme, 'dark'),
    ...focusRing(theme, 'dark'),
  },
})

/**
 * What Mantine draws from class rules, out of the theme variables' reach: unchecked control borders,
 * Switch thumbs, white text on the primary colour (moved to the fill), and dimmed text Mantine
 * draws itself (a blocked menu item, a combobox's empty message, outside days). Outside days lose
 * Mantine's half opacity, under 4.5:1.
 */
const CANOPY_STYLES = `
.mantine-Checkbox-input:not(:checked, :disabled, [data-indeterminate], [data-error]),
.mantine-CheckboxIndicator-indicator:not([data-checked], [data-disabled], [data-indeterminate]),
.mantine-Radio-radio:not(:checked, :disabled, [data-error]),
.mantine-RadioIndicator-indicator:not([data-checked], [data-disabled]) {
  border-color: var(--canopy-input-border);
}
.mantine-Switch-input:not(:checked, :disabled, [data-disabled]) + .mantine-Switch-track:not([data-error]) {
  --switch-bd: var(--canopy-input-border);
}
.mantine-Switch-input:not(:checked, :disabled, [data-disabled]) + .mantine-Switch-track > .mantine-Switch-thumb {
  --switch-thumb-bd: var(--canopy-input-border);
}
.mantine-Switch-input:checked:not(:disabled, [data-disabled]) + .mantine-Switch-track > .mantine-Switch-thumb {
  --switch-thumb-bg: var(--canopy-switch-thumb-on, var(--mantine-color-white));
  --switch-thumb-bd: var(--canopy-switch-thumb-on, var(--mantine-color-white));
}
[data-combobox-selected] {
  --mantine-primary-color-filled: var(--canopy-primary-fill);
}
.mantine-DateTimePicker-day[data-selected],
.mantine-DateTimePicker-pickerControl[data-selected] {
  background-color: var(--canopy-primary-fill);
}
.mantine-DateTimePicker-day[data-selected]:hover,
.mantine-DateTimePicker-pickerControl[data-selected]:hover {
  background-color: var(--canopy-primary-fill-hover);
}
input.mantine-TimeInput-input::-webkit-datetime-edit-hour-field:focus,
input.mantine-TimeInput-input::-webkit-datetime-edit-minute-field:focus,
input.mantine-TimeInput-input::-webkit-datetime-edit-second-field:focus,
input.mantine-TimeInput-input::-webkit-datetime-edit-ampm-field:focus {
  background-color: var(--canopy-primary-fill);
}
.mantine-Menu-item[aria-disabled='true'],
.mantine-Combobox-empty,
.mantine-DateTimePicker-day[data-outside] {
  font-style: var(--canopy-dimmed-font-style);
}
.mantine-DateTimePicker-day[data-outside]:not([data-disabled]) {
  opacity: 1;
}
`

export interface CanopyCMSProviderProps extends CanopyThemeOptions {
  children: React.ReactNode
}

export const CanopyCMSProvider: React.FC<CanopyCMSProviderProps> = ({
  children,
  colors,
  colorScheme = 'light',
  themeOverride,
  withNotifications = true,
}) => {
  const theme = useMemo(() => createCanopyTheme({ colors, themeOverride }), [colors, themeOverride])

  return (
    <MantineProvider
      theme={theme}
      defaultColorScheme={colorScheme}
      cssVariablesResolver={canopyCssVariablesResolver}
    >
      {/* Confirms open from inside Drawers (level 'modal'), so sit a level above; notifications stay higher. */}
      <style data-canopy-styles dangerouslySetInnerHTML={{ __html: CANOPY_STYLES }} />
      <ModalsProvider modalProps={{ zIndex: getDefaultZIndex('popover') }}>
        {withNotifications ? <Notifications position="bottom-right" /> : null}
        {children}
      </ModalsProvider>
    </MantineProvider>
  )
}
