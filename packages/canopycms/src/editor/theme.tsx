'use client'

import React, { useMemo } from 'react'

import {
  Alert,
  ActionIcon,
  Button,
  DEFAULT_THEME,
  Drawer,
  Input,
  MantineProvider,
  Modal,
  Notification,
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
} from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { ModalsProvider } from '@mantine/modals'
import { generateColors } from '@mantine/colors-generator'

import { composite, isMeasurable, readableOnScale } from './contrast'

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
// reaches 4.5:1 under white. Callers pass a plain `color`.
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
      return { root: {} }
    },
  }),
  ActionIcon: ActionIcon.extend({ defaultProps: { size: 'sm' } }),
  // Tooltips open on focus and touch too, so an icon-only control's name reaches the keyboard.
  Tooltip: Tooltip.extend({ defaultProps: { events: { hover: true, focus: true, touch: true } } }),
  // A default input's border is `--canopy-input-border`; errored and focused ones keep Mantine's.
  Input: Input.extend({
    styles: (_theme, props) =>
      props.error || (props.variant ?? 'default') !== 'default'
        ? {}
        : { wrapper: { '--input-bd': 'var(--canopy-input-border)' } },
  }),
  ModalCloseButton: Modal.CloseButton.extend({ defaultProps: CLOSE_BUTTON_PROPS }),
  DrawerCloseButton: Drawer.CloseButton.extend({ defaultProps: CLOSE_BUTTON_PROPS }),
  Notification: Notification.extend({ defaultProps: { closeButtonProps: CLOSE_BUTTON_PROPS } }),
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
    // White on a filled primary is 4.98:1 at indigo.7 and 5.67:1 at indigo.8, the default brand.
    primaryShade: { light: 7, dark: 8 },
    defaultRadius: 'md',
    colors: { ...DEFAULT_THEME.colors, brand, primary, neutral, accent },
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    components: canopyComponents,
  })
  // Deep merge, so an override that sets only some colours or one component's props keeps the rest.
  return mergeThemeOverrides(base, themeOverride ?? {})
}

/**
 * A colour's text, light and subtle variants and outline take the step nearest Mantine's default
 * that reaches 4.5:1 on its hovered light tint over the lightest light surface (gray.1) or dark
 * one (dark.4); past the scale's end, the end shade darkened or lightened until it does. A colour
 * in a notation it cannot measure, a virtual colour's `var()` steps included, keeps Mantine's.
 */
const readableColourVariables = (theme: MantineTheme, scheme: 'light' | 'dark') => {
  const variables: Record<string, string> = {}
  const shade = getPrimaryShade(theme, scheme)
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
            from: Math.max(shade - 5, 0),
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

/**
 * docs/ux-guidelines.md "Colour and contrast" says what each token is for; `theme.test.tsx` pins
 * every ratio for the default palette. Dark dimmed mixes dark.1 with dark.2, since dark.1 alone
 * reads as body text.
 */
const canopyCssVariablesResolver: CSSVariablesResolver = (theme) => ({
  variables: {
    '--canopy-count-bg':
      'color-mix(in srgb, var(--mantine-primary-color-filled) 20%, var(--mantine-color-body))',
  },
  light: {
    ...readableColourVariables(theme, 'light'),
    '--mantine-color-dimmed': 'var(--mantine-color-gray-7)',
    '--mantine-color-placeholder': 'var(--mantine-color-dimmed)',
    '--canopy-danger-text': 'var(--mantine-color-red-9)',
    '--canopy-input-border': 'var(--mantine-color-gray-6)',
    '--canopy-surface-subtle': 'var(--mantine-color-gray-0)',
    '--canopy-surface-muted': 'var(--mantine-color-gray-1)',
  },
  dark: {
    ...readableColourVariables(theme, 'dark'),
    '--mantine-color-dimmed':
      'color-mix(in srgb, var(--mantine-color-dark-1) 85%, var(--mantine-color-dark-2))',
    '--mantine-color-placeholder': 'var(--mantine-color-dimmed)',
    '--canopy-danger-text': 'var(--mantine-color-red-3)',
    '--canopy-input-border': 'var(--mantine-color-dark-2)',
    '--canopy-surface-subtle': 'var(--mantine-color-dark-6)',
    '--canopy-surface-muted': 'var(--mantine-color-dark-5)',
  },
})

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
      <ModalsProvider modalProps={{ zIndex: getDefaultZIndex('popover') }}>
        {withNotifications ? <Notifications position="bottom-left" /> : null}
        {children}
      </ModalsProvider>
    </MantineProvider>
  )
}
