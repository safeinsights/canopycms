'use client'

/**
 * The "Show changes" drawer's loading state, shared by the drawer and by the fallback that
 * LazyEntryChangesDrawer shows while the drawer's own chunk loads.
 */

import React from 'react'
import { Skeleton, Stack, VisuallyHidden } from '@mantine/core'

/** The summary line's placeholder, with the words a screen reader hears in its status region. */
export const LoadingSummary: React.FC = () => (
  <>
    <VisuallyHidden>Loading changes…</VisuallyHidden>
    <Skeleton height={22} width="45%" />
  </>
)

/** Cards' placeholders. */
export const LoadingCards: React.FC = () => (
  <Stack gap="sm" data-testid="entry-changes-loading" aria-busy="true">
    {[0, 1, 2].map((i) => (
      <Skeleton key={i} height={96} radius="sm" />
    ))}
  </Stack>
)
