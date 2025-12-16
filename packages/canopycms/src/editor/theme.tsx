'use client'

import React, { useMemo } from 'react'

import {
  DEFAULT_THEME,
  MantineProvider,
  type MantineColorScheme,
  type MantineColorsTuple,
  type MantineThemeOverride,
  createTheme,
} from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { generateColors } from '@mantine/colors-generator'

import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

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
  fallback: CanopyColorInput
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

export const createCanopyTheme = (options?: Pick<CanopyThemeOptions, 'colors' | 'themeOverride'>) => {
  const { colors, themeOverride } = options ?? {}
  const brand = toScale(colors?.brand, 'indigo', defaultCanopyColors.brand)
  const primary = toScale(colors?.primary ?? colors?.brand, 'blue', defaultCanopyColors.primary)
  const neutral = toScale(colors?.neutral, 'gray', defaultCanopyColors.neutral)
  const accent = toScale(colors?.accent, 'teal', defaultCanopyColors.accent)

  return createTheme({
    primaryColor: 'brand',
    primaryShade: { light: 6, dark: 5 },
    defaultRadius: 'md',
    colors: {
      ...DEFAULT_THEME.colors,
      brand,
      primary,
      neutral,
      accent,
      ...(themeOverride?.colors ?? {}),
    },
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    ...themeOverride,
  })
}

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
    <MantineProvider theme={theme} defaultColorScheme={colorScheme}>
      {withNotifications ? <Notifications position="top-right" /> : null}
      {children}
    </MantineProvider>
  )
}
