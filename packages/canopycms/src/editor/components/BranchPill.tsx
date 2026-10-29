'use client'

import React, { useRef, type Ref } from 'react'
import { Button, Menu, Text, Tooltip } from '@mantine/core'
import { useMediaQuery, useMergedRef } from '@mantine/hooks'
import { IconChevronDown, IconGitBranch } from '@tabler/icons-react'
import { EDITOR_ACTIONS } from '../copy'
import { DestructiveMenuItem } from './DestructiveMenuItem'
import { ReasonedMenuItem } from './ReasonedMenuItem'
import { useMenuItemFocusReturn } from '../utils/focus-return'

export interface BranchPillProps {
  branchName: string
  /** The editor is busy; with no branch name yet, that is the branch list loading. */
  loading: boolean
  /** How many entries on the branch have unsaved changes, counting any the list can't name yet. */
  unsavedCount: number
  onSwitchBranch: () => void
  onRefreshBranch: () => void
  onDiscardAll: () => void
  /** The pill, which stands in for a menu item that opened something. */
  pillRef?: Ref<HTMLButtonElement>
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * The branch's name. Its menu, headed by the name untruncated, holds the branch actions. Below `sm` the
 * name truncates shorter, so the actions don't clip.
 */
export function BranchPill({
  branchName,
  loading,
  unsavedCount: unsaved,
  onSwitchBranch,
  onRefreshBranch,
  onDiscardAll,
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
      <Tooltip label={name} disabled={wide} events={{ hover: true, focus: true, touch: true }}>
        <Menu.Target>
          <Button
            ref={triggerRef}
            variant="default"
            size="sm"
            miw={0}
            px={{ base: 8, sm: 14 }}
            // The bar's row wraps before the pill's name clips.
            style={{ flexShrink: 0 }}
            leftSection={<IconGitBranch size={16} aria-hidden="true" />}
            rightSection={wide ? <IconChevronDown size={14} aria-hidden="true" /> : undefined}
            loading={!branchName && loading}
            data-testid="branch-dropdown-button"
            styles={{ label: { minWidth: 0, gap: 6 } }}
          >
            <Text span inherit truncate="end" maw={{ base: 120, sm: 200 }}>
              {name}
            </Text>
          </Button>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown data-testid="branch-menu" {...menuFocus.dropdown}>
        {branchName && <Menu.Label>{branchName}</Menu.Label>}
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
