'use client'

import React, { useRef, type Ref } from 'react'
import { Box, Button, Menu, Text, Tooltip, VisuallyHidden } from '@mantine/core'
import { useMediaQuery, useMergedRef } from '@mantine/hooks'
import { IconChevronDown, IconGitBranch } from '@tabler/icons-react'
import type { LogicalPath } from '../../paths/types'
import { EDITOR_ACTIONS } from '../copy'
import { DestructiveMenuItem } from './DestructiveMenuItem'
import { ReasonedMenuItem } from './ReasonedMenuItem'
import { UnsavedMark } from './UnsavedMark'
import { useMenuItemFocusReturn } from '../utils/focus-return'

export interface BranchPillProps {
  branchName: string
  /** The editor is busy; with no branch name yet, that is the branch list loading. */
  loading: boolean
  /** The status label ("In review", "Protected"), set only for a status worth a place in the bar. */
  status?: { label: string; testId: string; value: string }
  /** How many entries on the branch have unsaved changes, counting any the list can't name yet. */
  unsavedCount: number
  /** The listed entries with unsaved changes. */
  unsavedEntries: Array<{ path: LogicalPath; label: string }>
  onSwitchBranch: () => void
  onRefreshBranch: () => void
  onDiscardAll: () => void
  onEntrySelect: (path: LogicalPath) => void
  /** The pill, which stands in for a menu item that opened something. */
  pillRef?: Ref<HTMLButtonElement>
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * The branch's name, status and unsaved count: the unsaved mark and a number. Its menu holds the
 * branch actions and lists the unsaved entries, each opening that entry. Below `sm` it is the
 * branch icon and the count, its name then in its Tooltip, accessible name and menu label: the
 * row's actions must not clip.
 */
export function BranchPill({
  branchName,
  loading,
  status,
  unsavedCount: unsaved,
  unsavedEntries,
  onSwitchBranch,
  onRefreshBranch,
  onDiscardAll,
  onEntrySelect,
  pillRef,
}: BranchPillProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const triggerRef = useMergedRef(trigger, pillRef)
  const menuFocus = useMenuItemFocusReturn(trigger)
  const noBranch = branchName ? undefined : 'Open a branch first.'
  const wide = useMediaQuery('(min-width: 48em)')
  const name = branchName || (loading ? 'Loading branches…' : 'No branch open')

  return (
    <Menu withinPortal shadow="sm" position="bottom-start" {...menuFocus.menu}>
      <Tooltip
        label={status ? `${name} · ${status.label}` : name}
        disabled={wide}
        events={{ hover: true, focus: true, touch: false }}
      >
        <Menu.Target>
          <Button
            ref={triggerRef}
            variant="default"
            size="sm"
            miw={0}
            px={{ base: 8, sm: 14 }}
            // The bar's row wraps before the pill's name or count clips.
            style={{ flexShrink: 0 }}
            leftSection={<IconGitBranch size={16} aria-hidden="true" />}
            rightSection={wide ? <IconChevronDown size={14} aria-hidden="true" /> : undefined}
            loading={!branchName && loading}
            data-testid="branch-dropdown-button"
            styles={{ label: { minWidth: 0, gap: 6 } }}
          >
            <Text span inherit truncate="end" maw={200} visibleFrom="sm">
              {name}
            </Text>
            <VisuallyHidden component="span" hiddenFrom="sm">
              {name}
            </VisuallyHidden>
            {branchName && status && (
              <Text span size="xs" c="dimmed" visibleFrom="md" style={{ flexShrink: 0 }}>
                <span aria-hidden="true">· </span>
                <span data-testid={status.testId} data-status={status.value}>
                  {status.label}
                </span>
              </Text>
            )}
            {unsaved > 0 && (
              <Box
                component="span"
                display="inline-flex"
                style={{ alignItems: 'center', gap: 4, flexShrink: 0 }}
                data-testid="branch-unsaved-count"
              >
                <UnsavedMark aria-hidden="true" />
                <Text span size="xs" fw={600} aria-hidden="true">
                  {unsaved}
                </Text>
                <VisuallyHidden component="span">
                  {`, ${plural(unsaved, 'entry', 'entries')} with unsaved changes`}
                </VisuallyHidden>
              </Box>
            )}
          </Button>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown data-testid="branch-menu" {...menuFocus.dropdown}>
        {branchName && status && (
          <Menu.Label hiddenFrom="md">{`${branchName} · ${status.label}`}</Menu.Label>
        )}
        <Menu.Item onClick={onSwitchBranch} data-testid="manage-branches-menu-item">
          {`${EDITOR_ACTIONS.switchBranch}…`}
        </Menu.Item>
        <ReasonedMenuItem
          onClick={onRefreshBranch}
          blockedReason={noBranch}
          data-testid="refresh-branch-menu-item"
        >
          Refresh branch
        </ReasonedMenuItem>
        <Menu.Divider />
        <Menu.Label>Unsaved changes</Menu.Label>
        {unsavedEntries.length === 0 ? (
          <Text size="sm" c="dimmed" px="sm" py={6} data-testid="edited-entries-empty">
            {unsaved === 0 ? 'No unsaved changes on this branch.' : 'Loading their names…'}
          </Text>
        ) : (
          unsavedEntries.map((entry) => (
            <Menu.Item key={entry.path} onClick={() => onEntrySelect(entry.path)}>
              {entry.label}
            </Menu.Item>
          ))
        )}
        <Menu.Divider />
        <DestructiveMenuItem
          data-testid="discard-all-drafts-menu-item"
          onClick={onDiscardAll}
          blockedReason={noBranch ?? (unsaved === 0 ? 'Nothing to discard.' : undefined)}
        >
          {unsaved > 0
            ? `Discard all changes (${plural(unsaved, 'entry', 'entries')})`
            : 'Discard all changes'}
        </DestructiveMenuItem>
      </Menu.Dropdown>
    </Menu>
  )
}
