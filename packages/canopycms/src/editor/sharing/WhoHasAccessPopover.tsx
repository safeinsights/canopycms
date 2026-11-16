'use client'

import React, { useEffect, useId, useRef } from 'react'
import { Button, Popover, Skeleton, Stack, Text } from '@mantine/core'

import { accessRefusalMessage } from '../copy'
import { FOCUS_RETURN_ATTR, focusIfIdle } from '../utils/focus-return'
import type { UserContext } from '../BranchManager'
import { PersonLabel, type ShareTarget } from './ShareBranchDialog'
import { addByLabel, LISTED_ONLY_LINE, LOCKDOWN_LINE, OPEN_TO_EVERYONE_LINE } from './share-copy'
import { entryKey, showsUnlistedOwner, type BranchAccess } from './share-staging'
import { useBranchAccess } from './useBranchAccess'

export interface WhoHasAccessPopoverProps {
  /** Absent, the popover is off and only its target renders. */
  branch?: ShareTarget
  opened: boolean
  onChange: (opened: boolean) => void
  /** The control the popover hangs from; it takes focus back on Esc. */
  children: React.ReactElement
  /** False for a target that is no control, such as a wrapper, which takes no popup attributes. */
  withRoles?: boolean
  /** Where focus goes once the list has closed, when its opener is gone, such as a menu item. */
  returnFocusTo?: () => HTMLElement | null
  /** The person looking: marked "(you)" on the list, and listed through any of their groups too. */
  viewer?: UserContext
}

/**
 * Who may open a branch, read-only, for someone who may open it but not add people. It holds focus
 * while open, so Esc, which only a key inside it reaches, always closes it.
 */
export function WhoHasAccessPopover({
  branch,
  opened,
  onChange,
  children,
  withRoles = true,
  returnFocusTo,
  viewer,
}: WhoHasAccessPopoverProps) {
  const headingId = useId()
  return (
    <Popover
      opened={opened}
      onChange={onChange}
      position="bottom-start"
      width={320}
      shadow="md"
      trapFocus
      withRoles={withRoles}
      disabled={!branch}
      onExitTransitionEnd={returnFocusTo && (() => focusIfIdle(returnFocusTo()))}
    >
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown
        role="dialog"
        aria-labelledby={headingId}
        tabIndex={-1}
        data-testid="who-has-access"
        {...(returnFocusTo && { [FOCUS_RETURN_ATTR]: true })}
      >
        {branch && (
          <WhoHasAccessBody
            branch={branch.name}
            owner={branch.createdBy}
            ownerName={branch.ownerName}
            lockedDown={!!branch.access?.managerOrAdminAllowed}
            headingId={headingId}
            viewer={viewer}
          />
        )}
      </Popover.Dropdown>
    </Popover>
  )
}

function WhoHasAccessBody({
  branch,
  owner,
  ownerName,
  lockedDown,
  headingId,
  viewer,
}: {
  branch: string
  owner?: string
  ownerName?: string
  lockedDown: boolean
  headingId: string
  viewer?: UserContext
}) {
  const { state, reload } = useBranchAccess(branch)
  const headingRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [])

  const data = state.data
  // As the Share dialog has it: an unlisted branch on a closed site still admits its owner.
  const ownerRow = !!data && showsUnlistedOwner(data, owner)
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600} id={headingId} ref={headingRef} tabIndex={-1}>
        Who has access
      </Text>
      {state.status === 'refused' ? (
        <Text size="sm">{accessRefusalMessage(state.code)}</Text>
      ) : !data && state.status === 'failed' ? (
        <Stack gap={4} align="flex-start">
          <Text size="sm">{"Who has access couldn't be loaded."}</Text>
          <Button variant="default" size="xs" onClick={() => void reload()}>
            Retry
          </Button>
        </Stack>
      ) : !data ? (
        <Stack gap="xs" aria-busy>
          <Skeleton height={10} width="60%" />
          <Skeleton height={10} width="45%" />
        </Stack>
      ) : (
        <>
          {(ownerRow || data.entries.length > 0) && (
            <Stack
              component="ul"
              gap={6}
              m={0}
              p={0}
              aria-labelledby={headingId}
              style={{ listStyle: 'none' }}
            >
              {ownerRow && owner && (
                <li>
                  <PersonLabel
                    kind="user"
                    name={ownerName || 'Name unavailable'}
                    suffix={owner === viewer?.userId ? ' (you)' : undefined}
                    detail="Owner"
                  />
                </li>
              )}
              {data.entries.map((entry) => (
                <li key={entryKey(entry)}>
                  <PersonLabel
                    kind={entry.kind}
                    name={entry.name}
                    avatarUrl={entry.avatarUrl}
                    suffix={
                      entry.kind === 'user' && entry.id === viewer?.userId ? ' (you)' : undefined
                    }
                    detail={
                      entry.kind === 'group' ? 'Group' : entry.id === owner ? 'Owner' : undefined
                    }
                  />
                </li>
              ))}
            </Stack>
          )}
          <Text size="sm">
            {lockedDown
              ? LOCKDOWN_LINE
              : data.openToEveryone
                ? OPEN_TO_EVERYONE_LINE
                : LISTED_ONLY_LINE}
          </Text>
          {!lockedDown && !data.openToEveryone && (
            <WhoCanAddLine access={data} owner={owner} viewer={viewer} />
          )}
        </>
      )}
    </Stack>
  )
}

/**
 * Who may add people, for a viewer who may not. "Anyone on this list" is said only to someone not
 * on it, by name or through a group: one on it who still can't add (an archived branch) is told
 * nothing they could act on.
 */
function WhoCanAddLine({
  access,
  owner,
  viewer,
}: {
  access: BranchAccess
  owner?: string
  viewer?: UserContext
}) {
  const listed = access.entries.some((entry) =>
    entry.kind === 'user' ? entry.id === viewer?.userId : !!viewer?.groups?.includes(entry.id),
  )
  // The server's rules as they stand, not the setting alone (`whoCanAdd`).
  const addBy = access.whoCanAdd
  if (addBy === 'members' && listed) return null
  const ownerName = access.entries.find(
    (entry) => entry.kind === 'user' && entry.id === owner,
  )?.name
  const line =
    addBy === 'owner'
      ? ownerName
        ? `Only the owner, ${ownerName}, can add people.`
        : 'Only the owner can add people.'
      : `${addByLabel(addBy, false)} can add people.`
  return (
    <Text size="sm" data-testid="who-can-add">
      {line}
    </Text>
  )
}
