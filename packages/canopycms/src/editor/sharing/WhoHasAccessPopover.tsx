'use client'

import React, { useEffect, useId, useRef } from 'react'
import { Button, Popover, Skeleton, Stack, Text } from '@mantine/core'

import { accessRefusalMessage } from '../copy'
import { PersonLabel, type ShareTarget } from './ShareBranchDialog'
import { LISTED_ONLY_LINE, LOCKDOWN_LINE, OPEN_TO_EVERYONE_LINE } from './share-copy'
import { entryKey } from './share-staging'
import { useBranchAccess } from './useBranchAccess'

export interface WhoHasAccessPopoverProps {
  branch: ShareTarget
  opened: boolean
  onChange: (opened: boolean) => void
  /** The control the popover hangs from; it takes focus back on Esc. */
  children: React.ReactElement
}

/** Who may open a branch, read-only, for someone who may open it but not add people. */
export function WhoHasAccessPopover({
  branch,
  opened,
  onChange,
  children,
}: WhoHasAccessPopoverProps) {
  const headingId = useId()
  return (
    <Popover opened={opened} onChange={onChange} position="bottom-start" width={320} shadow="md">
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown aria-labelledby={headingId} data-testid="who-has-access">
        <WhoHasAccessBody
          branch={branch.name}
          owner={branch.createdBy}
          lockedDown={!!branch.access?.managerOrAdminAllowed}
          headingId={headingId}
        />
      </Popover.Dropdown>
    </Popover>
  )
}

function WhoHasAccessBody({
  branch,
  owner,
  lockedDown,
  headingId,
}: {
  branch: string
  owner?: string
  lockedDown: boolean
  headingId: string
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
        </>
      )}
    </Stack>
  )
}
