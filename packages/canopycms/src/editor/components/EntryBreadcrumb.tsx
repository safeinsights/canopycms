'use client'

import React, { useRef, type Ref } from 'react'
import { Badge, Box, Button, Group, Menu, Text, Tooltip, VisuallyHidden } from '@mantine/core'
import { useMergedRef } from '@mantine/hooks'
import { IconChevronDown, IconChevronRight, IconLock } from '@tabler/icons-react'
import type { BreadcrumbSegment } from '../editor-utils'
import { EDITOR_ACTIONS } from '../copy'
import { ReasonedMenuItem } from './ReasonedMenuItem'
import { useMenuItemFocusReturn } from '../utils/focus-return'

export interface EntryBreadcrumbProps {
  /** The crumbs before the entry's own, from `buildBreadcrumbSegments`. */
  segments: BreadcrumbSegment[]
  /** The open entry's label; undefined when no entry is open. */
  entryLabel: string | undefined
  /** The open entry has unsaved changes. */
  entryDirty: boolean
  /** Why the open entry or its branch is read-only; set, the "Read-only" chip shows. */
  readOnlyReason?: string
  onAllContent: () => void
  onCollection: (collectionPath: string) => void
  onRefresh: () => void
  onDiscard: () => void
  refreshBlockedReason?: string
  discardBlockedReason?: string
  /** The entry menu's trigger, which stands in for a menu item that opened something. */
  entryMenuRef?: Ref<HTMLButtonElement>
}

const crumbText = (label: string) => (
  <Text span inherit truncate="end" display="block">
    {label}
  </Text>
)

const separator = (
  <IconChevronRight
    size={14}
    aria-hidden="true"
    style={{ flexShrink: 0, color: 'var(--mantine-color-dimmed)' }}
  />
)

/**
 * Where the open entry sits: "All content" opens the content panel, a collection crumb reveals
 * that collection in it, and the entry's own crumb is current and opens the entry menu. Crumbs
 * shrink and truncate before the entry's own does.
 */
export function EntryBreadcrumb({
  segments,
  entryLabel,
  entryDirty,
  readOnlyReason,
  onAllContent,
  onCollection,
  onRefresh,
  onDiscard,
  refreshBlockedReason,
  discardBlockedReason,
  entryMenuRef,
}: EntryBreadcrumbProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const triggerRef = useMergedRef(trigger, entryMenuRef)
  const menuFocus = useMenuItemFocusReturn(trigger)

  return (
    <Group gap="xs" wrap="nowrap" miw={0}>
      <Box
        component="nav"
        aria-label="Breadcrumb"
        miw={0}
        style={{ flex: '0 1 auto', overflow: 'hidden' }}
      >
        <Group
          component="ol"
          gap={2}
          wrap="nowrap"
          miw={0}
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
        >
          {segments.map((segment, index) => (
            <Group
              key={`${segment.label}-${index}`}
              component="li"
              gap={2}
              wrap="nowrap"
              miw={0}
              // Collections give up their width long before the entry's own crumb does.
              style={{ flex: '0 100 auto' }}
            >
              {index > 0 && separator}
              {segment.folder ? (
                <Text size="sm" c="dimmed" px={4} miw={0} truncate="end">
                  {segment.label}
                </Text>
              ) : (
                <Button
                  variant="subtle"
                  color="gray"
                  size="compact-sm"
                  fw={400}
                  miw={0}
                  maw={180}
                  onClick={() =>
                    segment.collectionPath ? onCollection(segment.collectionPath) : onAllContent()
                  }
                  data-testid="breadcrumb-segment"
                  styles={{ label: { minWidth: 0 } }}
                >
                  {crumbText(segment.label)}
                </Button>
              )}
            </Group>
          ))}
          <Group component="li" gap={2} wrap="nowrap" miw={64} style={{ flex: '0 1 auto' }}>
            {separator}
            {entryLabel === undefined ? (
              <Text size="sm" c="dimmed" px={4} data-testid="file-dropdown-button">
                No entry open
              </Text>
            ) : (
              <Menu withinPortal shadow="sm" position="bottom-start" {...menuFocus.menu}>
                <Menu.Target>
                  <Button
                    ref={triggerRef}
                    variant="subtle"
                    color="gray"
                    size="compact-sm"
                    fw={600}
                    miw={0}
                    maw="100%"
                    aria-current="page"
                    rightSection={<IconChevronDown size={14} aria-hidden="true" />}
                    data-testid="file-dropdown-button"
                    styles={{ label: { minWidth: 0, gap: 6 } }}
                  >
                    {crumbText(entryLabel)}
                    {entryDirty && (
                      <>
                        <Box
                          component="span"
                          aria-hidden="true"
                          w={8}
                          h={8}
                          style={{
                            borderRadius: '50%',
                            flexShrink: 0,
                            background: 'var(--mantine-color-text)',
                          }}
                          data-testid="entry-unsaved-dot"
                        />
                        <VisuallyHidden component="span">, unsaved changes</VisuallyHidden>
                      </>
                    )}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown {...menuFocus.dropdown}>
                  <ReasonedMenuItem
                    onClick={onRefresh}
                    blockedReason={refreshBlockedReason}
                    data-testid="refresh-entry-menu-item"
                  >
                    {EDITOR_ACTIONS.refreshFromServer}
                  </ReasonedMenuItem>
                  <ReasonedMenuItem
                    data-testid="discard-file-draft-menu-item"
                    onClick={onDiscard}
                    blockedReason={discardBlockedReason}
                  >
                    Discard changes
                  </ReasonedMenuItem>
                </Menu.Dropdown>
              </Menu>
            )}
          </Group>
        </Group>
      </Box>
      {readOnlyReason && (
        <Tooltip label={readOnlyReason} multiline maw={300}>
          <Badge
            variant="light"
            color="gray"
            radius="sm"
            leftSection={<IconLock size={12} aria-hidden="true" />}
            style={{ flexShrink: 0, textTransform: 'none' }}
            data-testid="read-only-chip"
          >
            Read-only
            <VisuallyHidden component="span">. {readOnlyReason}</VisuallyHidden>
          </Badge>
        </Tooltip>
      )}
    </Group>
  )
}
