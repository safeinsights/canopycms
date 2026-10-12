'use client'

import React, { useMemo } from 'react'

import {
  ActionIcon,
  Button,
  DEFAULT_THEME,
  MantineProvider,
  getDefaultZIndex,
  mergeThemeOverrides,
  type CSSVariablesResolver,
  type MantineColorScheme,
  type MantineColorsTuple,
  type MantineThemeOverride,
  createTheme,
} from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { ModalsProvider } from '@mantine/modals'
import { generateColors } from '@mantine/colors-generator'

import '@mantine/core/styles.css'
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

// The editor's default control sizes; a per-call `size` is only for a deliberate exception.
// Filled red is red.8 under white; filled orange is orange.6 under black, since no orange shade
// reaches 4.5:1 under white. Callers pass a plain `color`.
const canopyComponents = {
  Button: Button.extend({
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
    primaryShade: { light: 6, dark: 5 },
    defaultRadius: 'md',
    colors: { ...DEFAULT_THEME.colors, brand, primary, neutral, accent },
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    components: canopyComponents,
  })
  // Deep merge, so an override that sets only some colours or one component's props keeps the rest.
  return mergeThemeOverrides(base, themeOverride ?? {})
}

// Mantine's dimmed gray.6 is 3.32:1 on white and dark.2 is 3.53:1 on dark.6 panels; gray.7 and
// dark.1 reach at least 6.85:1 on every editor background.
const canopyCssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: { '--mantine-color-dimmed': 'var(--mantine-color-gray-7)' },
  dark: { '--mantine-color-dimmed': 'var(--mantine-color-dark-1)' },
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
