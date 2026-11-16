'use client'

import React, { useEffect, useId, useRef } from 'react'
import { Button, Popover, Skeleton, Stack, Text } from '@mantine/core'

import { accessRefusalMessage } from '../copy'
import { FOCUS_RETURN_ATTR, focusIfIdle } from '../utils/focus-return'
import { PersonLabel, type ShareTarget } from './ShareBranchDialog'
import { addByLabel, LISTED_ONLY_LINE, LOCKDOWN_LINE, OPEN_TO_EVERYONE_LINE } from './share-copy'
import { entryKey, type BranchAccess } from './share-staging'
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
  /** The person looking, marked "(you)" on the list. */
  viewerId?: string
}

/** Who may open a branch, read-only, for someone who may open it but not add people. */
export function WhoHasAccessPopover({
  branch,
  opened,
  onChange,
  children,
  withRoles = true,
  returnFocusTo,
  viewerId,
}: WhoHasAccessPopoverProps) {
  const headingId = useId()
  return (
    <Popover
      opened={opened}
      onChange={onChange}
      position="bottom-start"
      width={320}
      shadow="md"
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
            lockedDown={!!branch.access?.managerOrAdminAllowed}
            headingId={headingId}
            viewerId={viewerId}
          />
        )}
      </Popover.Dropdown>
    </Popover>
  )
}

function WhoHasAccessBody({
  branch,
  owner,
  lockedDown,
  headingId,
  viewerId,
}: {
  branch: string
  owner?: string
  lockedDown: boolean
  headingId: string
  viewerId?: string
}) {
  const { state, reload } = useBranchAccess(branch)
  const headingRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [])

  const data = state.data
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
          {data.entries.length > 0 && (
            <Stack
              component="ul"
              gap={6}
              m={0}
              p={0}
              aria-labelledby={headingId}
              style={{ listStyle: 'none' }}
            >
              {data.entries.map((entry) => (
                <li key={entryKey(entry)}>
                  <PersonLabel
                    kind={entry.kind}
                    name={entry.name}
                    avatarUrl={entry.avatarUrl}
                    suffix={entry.kind === 'user' && entry.id === viewerId ? ' (you)' : undefined}
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
            <WhoCanAddLine access={data} owner={owner} viewerId={viewerId} />
          )}
        </>
      )}
    </Stack>
  )
}

/**
 * Who may add people, for a viewer who may not. "Anyone on this list" is said only to someone not
 * on it: a member who still can't add (an archived branch) is told nothing they could act on.
 */
function WhoCanAddLine({
  access,
  owner,
  viewerId,
}: {
  access: BranchAccess
  owner?: string
  viewerId?: string
}) {
  const listed = access.entries.some((entry) => entry.kind === 'user' && entry.id === viewerId)
  if (access.addBy === 'members' && listed) return null
  const ownerName = access.entries.find(
    (entry) => entry.kind === 'user' && entry.id === owner,
  )?.name
  const line =
    access.addBy === 'owner'
      ? ownerName
        ? `Only the owner, ${ownerName}, can add people.`
        : 'Only the owner can add people.'
      : `${addByLabel(access.addBy, false)} can add people.`
  return (
    <Text size="sm" data-testid="who-can-add">
      {line}
    </Text>
  )
}
