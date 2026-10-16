'use client'

import React from 'react'
import { Drawer, Group, type DrawerRootProps } from '@mantine/core'

export interface OverlayHeaderProps {
  title: React.ReactNode
  /** Sits beside the title and is part of its accessible name, such as a status badge. */
  adornment?: React.ReactNode
  /** For a drawer that moves focus to its title. */
  titleRef?: React.Ref<HTMLHeadingElement>
  titleTabIndex?: number
}

/**
 * The header of every right-hand drawer, sized and ruled like the content panel's header in
 * `SidePanelHost`: a 16px semibold title, a default-size close button, `md` by `xs` padding and a
 * 1px bottom rule. It is the drawer's own `Drawer.Header`, so the title labels the dialog and the
 * header stays pinned while the body scrolls.
 */
export const OverlayHeader: React.FC<OverlayHeaderProps> = ({
  title,
  adornment,
  titleRef,
  titleTabIndex,
}) => (
  <Drawer.Header
    mih={0}
    px="md"
    py="xs"
    style={{ borderBlockEnd: '1px solid var(--canopy-input-border)' }}
  >
    <Drawer.Title ref={titleRef} tabIndex={titleTabIndex} fw={600} fz="md" miw={0}>
      {/* An adornment is part of the title, so it names the dialog too. */}
      <Group component="span" gap="xs" wrap="nowrap">
        {title}
        {adornment}
      </Group>
    </Drawer.Title>
    <Drawer.CloseButton aria-label="Close" />
  </Drawer.Header>
)

export interface OverlayDrawerProps
  extends Omit<DrawerRootProps, 'children' | 'title' | 'padding'>, OverlayHeaderProps {
  children: React.ReactNode
}

/** A Mantine `Drawer` with an `OverlayHeader`, a blurred backdrop and a body padded under the rule. */
export const OverlayDrawer: React.FC<OverlayDrawerProps> = ({
  title,
  adornment,
  titleRef,
  titleTabIndex,
  children,
  ...root
}) => (
  <Drawer.Root padding="md" {...root}>
    <Drawer.Overlay blur={2} />
    <Drawer.Content>
      <OverlayHeader
        title={title}
        adornment={adornment}
        titleRef={titleRef}
        titleTabIndex={titleTabIndex}
      />
      <Drawer.Body pt="md">{children}</Drawer.Body>
    </Drawer.Content>
  </Drawer.Root>
)
