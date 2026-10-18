'use client'

import React, { useEffect, useRef, useState, type ReactElement, type Ref } from 'react'
import {
  Badge,
  Box,
  Button,
  Group,
  Menu,
  Skeleton,
  Text,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core'
import { useMergedRef } from '@mantine/hooks'
import { IconChevronDown, IconChevronRight, IconLock } from '@tabler/icons-react'
import type { BreadcrumbSegment } from '../editor-utils'
import { EDITOR_ACTIONS } from '../copy'
import { DestructiveMenuItem } from './DestructiveMenuItem'
import { ReasonedMenuItem } from './ReasonedMenuItem'
import { UnsavedMark } from './UnsavedMark'
import { useMenuItemFocusReturn } from '../utils/focus-return'

export interface EntryBreadcrumbProps {
  /** The crumbs before the entry's own, from `buildBreadcrumbSegments`. */
  segments: BreadcrumbSegment[]
  /** The open entry's label; undefined when no entry is open. */
  entryLabel: string | undefined
  /** No entry yet because the branch or its entries are still loading: a placeholder crumb shows. */
  entryLoading?: boolean
  /** The open entry has unsaved changes. */
  entryDirty: boolean
  /** Why the open entry is read-only; set, the "Read-only" chip shows. */
  readOnlyReason?: string
  onCollection: (collectionPath: string) => void
  /** Offers "Show in content panel", which brings the entry's row into view and focuses it. */
  onReveal?: () => void
  onRefresh: () => void
  onDiscard: () => void
  /** With `onDelete`, offers "Change URL…" and "Delete entry"; absent where a path rule refuses them. */
  onRename?: () => void
  /** The entry has no page on the site, so "Change URL…" reads "Change slug…". */
  entryNoPage?: boolean
  onDelete?: () => void
  refreshBlockedReason?: string
  discardBlockedReason?: string
  /** Why the entry's URL can't be changed, or the entry deleted, now. */
  changeBlockedReason?: string
  /** The entry menu's trigger, which stands in for a menu item that opened something. */
  entryMenuRef?: Ref<HTMLButtonElement>
}

/** Whether the element's text is cut short, kept current as it resizes. */
function useTruncated(label: string) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [truncated, setTruncated] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setTruncated(el.scrollWidth > el.clientWidth)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [label])
  return [ref, truncated] as const
}

const crumbText = (label: string, ref: Ref<HTMLParagraphElement>) => (
  <Text ref={ref} span inherit truncate="end" display="block">
    {label}
  </Text>
)

/** A cut-short crumb shows its full label in a Tooltip, on hover and on focus. */
function CrumbTooltip({
  label,
  truncated,
  children,
}: {
  label: string
  truncated: boolean
  children: ReactElement
}) {
  return (
    <Tooltip
      label={label}
      disabled={!truncated}
      events={{ hover: true, focus: true, touch: false }}
    >
      {children}
    </Tooltip>
  )
}

function CollectionCrumb({ label, onClick }: { label: string; onClick: () => void }) {
  const [ref, truncated] = useTruncated(label)
  return (
    <CrumbTooltip label={label} truncated={truncated}>
      <Button
        variant="subtle"
        color="gray"
        size="compact-sm"
        fw={400}
        miw={0}
        maw={180}
        onClick={onClick}
        data-testid="breadcrumb-segment"
        styles={{ label: { minWidth: 0 } }}
      >
        {crumbText(label, ref)}
      </Button>
    </CrumbTooltip>
  )
}

const separator = (
  <IconChevronRight
    size={14}
    aria-hidden="true"
    style={{ flexShrink: 0, color: 'var(--mantine-color-dimmed)' }}
  />
)

/**
 * Where the open entry sits: a collection crumb reveals that collection in the content panel, and
 * the entry's own crumb is current and opens the entry menu. Crumbs shrink and truncate before the
 * entry's own does.
 */
export function EntryBreadcrumb({
  segments,
  entryLabel,
  entryLoading = false,
  entryDirty,
  readOnlyReason,
  onCollection,
  onReveal,
  onRefresh,
  onDiscard,
  onRename,
  entryNoPage = false,
  onDelete,
  refreshBlockedReason,
  discardBlockedReason,
  changeBlockedReason,
  entryMenuRef,
}: EntryBreadcrumbProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const triggerRef = useMergedRef(trigger, entryMenuRef)
  const menuFocus = useMenuItemFocusReturn(trigger)
  const [entryLabelRef, entryTruncated] = useTruncated(entryLabel ?? '')

  return (
    <Group gap="xs" wrap="nowrap" miw={0}>
      <Box
        component="nav"
        aria-label="Breadcrumb"
        miw={0}
        // Clips crumbs that overflow, padded by the focus ring's reach so the ring is not clipped.
        style={{ flex: '0 1 auto', overflow: 'hidden', padding: 4, margin: -4 }}
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
                <CollectionCrumb
                  label={segment.label}
                  onClick={() => onCollection(segment.collectionPath)}
                />
              )}
            </Group>
          ))}
          <Group component="li" gap={2} wrap="nowrap" miw={64} style={{ flex: '0 1 auto' }}>
            {segments.length > 0 && separator}
            {entryLabel === undefined && entryLoading ? (
              <Skeleton height={16} width={120} mx={4} data-testid="entry-crumb-loading">
                <VisuallyHidden>Loading…</VisuallyHidden>
              </Skeleton>
            ) : entryLabel === undefined ? (
              <Text size="sm" c="dimmed" px={4} data-testid="file-dropdown-button">
                No entry open
              </Text>
            ) : (
              <Menu withinPortal shadow="sm" position="bottom-start" {...menuFocus.menu}>
                <CrumbTooltip label={entryLabel} truncated={entryTruncated}>
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
                      {crumbText(entryLabel, entryLabelRef)}
                      {entryDirty && (
                        <>
                          <UnsavedMark aria-hidden="true" data-testid="entry-unsaved-dot" />
                          <VisuallyHidden component="span">, unsaved changes</VisuallyHidden>
                        </>
                      )}
                    </Button>
                  </Menu.Target>
                </CrumbTooltip>
                <Menu.Dropdown {...menuFocus.dropdown}>
                  {onReveal && (
                    <>
                      <Menu.Item onClick={onReveal} data-testid="entry-menu-reveal">
                        Show in content panel
                      </Menu.Item>
                      <Menu.Divider />
                    </>
                  )}
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
                  {onRename && onDelete && (
                    <>
                      <Menu.Divider />
                      <ReasonedMenuItem
                        onClick={onRename}
                        blockedReason={changeBlockedReason}
                        data-testid="entry-menu-rename"
                      >
                        {entryNoPage ? EDITOR_ACTIONS.changeSlug : EDITOR_ACTIONS.changeUrl}…
                      </ReasonedMenuItem>
                      <DestructiveMenuItem
                        onClick={onDelete}
                        blockedReason={changeBlockedReason}
                        data-testid="entry-menu-delete"
                      >
                        Delete entry
                      </DestructiveMenuItem>
                    </>
                  )}
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
