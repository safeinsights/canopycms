'use client'

import React, { useMemo, useRef, useState } from 'react'
import { ActionIcon, Badge, Group, Stack, Text, Tooltip, VisuallyHidden } from '@mantine/core'
import { IconUsers, IconX } from '@tabler/icons-react'

import type { NewBranchSharing } from '../../api/branch-people'
import type { ApiErrorCode } from '../../api/types'
import { useFocusAfterRemove } from '../utils/focus-return'
import { PeoplePicker } from './PeoplePicker'
import { entryKey, withAddition, type Addition } from './share-staging'

/** @internal Exported for tests. */
export const NEW_BRANCH_PRIVATE_LINE =
  'Only you and the people you add will be able to open this branch.'

export interface ShareWithFieldProps {
  value: Addition[]
  onChange: (next: Addition[]) => void
  /** Why the create refused the people chosen. */
  error?: string
  disabled?: boolean
  /** A refusal of the user rather than of whom they chose, such as not being able to create branches. */
  onRefused: (code: ApiErrorCode) => void
}

/**
 * The New branch form's "Share with": the Share dialog's picker against the branchless finder,
 * which suggests recent shares only, as a branch not yet created has no editors. The people chosen
 * are removable chips. On a site whose branches are open to everyone, choosing anyone makes the
 * branch private, which a line under them says; the finder's answer says what the site is.
 */
export function ShareWithField({
  value,
  onChange,
  error,
  disabled,
  onRefused,
}: ShareWithFieldProps) {
  const [site, setSite] = useState<NewBranchSharing>()
  const [announcement, setAnnouncement] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const { listRef, focusAfterRemove } = useFocusAfterRemove()
  const chosen = useMemo(() => new Set(value.map(entryKey)), [value])

  const remove = (index: number) => {
    const removed = value[index]
    onChange(value.filter((_, i) => i !== index))
    setAnnouncement(`Removed ${removed.name}`)
    focusAfterRemove(index, inputRef)
  }

  return (
    <Stack gap={6}>
      <VisuallyHidden role="status" data-testid="share-with-status">
        {error ?? announcement}
      </VisuallyHidden>
      <PeoplePicker
        label="Share with"
        searchable={site?.searchable ?? 'cms-users'}
        addableByEmail={site?.addableByEmail ?? 'all-users'}
        staged={chosen}
        onAdd={(addition) => onChange(withAddition(value, addition))}
        onRefused={onRefused}
        announce={setAnnouncement}
        inputRef={inputRef}
        focusOnOpen={false}
        disabled={disabled}
        error={error}
        onAnswer={(data) => data.newBranch && setSite(data.newBranch)}
      />
      {value.length > 0 && (
        <Group gap="xs" ref={listRef} data-testid="share-with-chips">
          {value.map((addition, index) => {
            const label = `Remove ${addition.name}`
            return (
              <Badge
                key={entryKey(addition)}
                variant="light"
                color="gray"
                pr={3}
                leftSection={addition.kind === 'group' && <IconUsers size={12} aria-hidden />}
                rightSection={
                  <Tooltip label={label}>
                    <ActionIcon
                      size="xs"
                      color="gray"
                      radius="xl"
                      variant="transparent"
                      aria-label={label}
                      disabled={disabled}
                      onClick={() => remove(index)}
                    >
                      <IconX
                        size={12}
                        stroke={2.5}
                        style={{ color: 'var(--mantine-color-text)' }}
                        aria-hidden
                      />
                    </ActionIcon>
                  </Tooltip>
                }
              >
                {addition.name}
                {addition.kind === 'group' && <VisuallyHidden>, group</VisuallyHidden>}
              </Badge>
            )
          })}
        </Group>
      )}
      {value.length > 0 && site?.defaultAccess !== 'deny' && (
        <Text size="sm" data-testid="share-with-private-line">
          {NEW_BRANCH_PRIVATE_LINE}
        </Text>
      )}
    </Stack>
  )
}
