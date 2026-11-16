import React, { forwardRef, useEffect, useState, type ComponentPropsWithoutRef } from 'react'
import { Anchor, Skeleton, Text } from '@mantine/core'
import type { UserSearchResult } from '../../auth/types'
import { personName } from '../../auth/person-name'

export interface BranchAccessListProps extends Omit<
  ComponentPropsWithoutRef<'button'>,
  'children'
> {
  users?: readonly string[]
  groups?: readonly string[]
  getUserMetadata: (userId: string) => Promise<UserSearchResult | null>
  /** No list limits the branch: anyone who can sign in may open it. */
  openToEveryone?: boolean
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The trailing count of people the lookup couldn't name, after the names shown or standing alone. */
const othersLabel = (people: number, afterNames: boolean): string =>
  afterNames ? `and ${count(people, 'other', 'others')}` : count(people, 'person', 'people')

/**
 * A branch's access list as one line of text: the people the viewer's lookup names, its groups,
 * then "and N others" for the people it couldn't name (docs/ux-guidelines.md, People). An unnamed
 * person is counted, not shown as "Name unavailable". With `onClick` the line is a button.
 */
export const BranchAccessList = forwardRef<HTMLButtonElement, BranchAccessListProps>(
  function BranchAccessList(
    { users = [], groups = [], getUserMetadata, openToEveryone = false, ...button },
    ref,
  ) {
    const usersKey = users.join('\n')
    // Tagged with what it answers, so a list or lookup that changed reads as still loading.
    const [result, setResult] = useState<{
      usersKey: string
      lookup: BranchAccessListProps['getUserMetadata']
      named: UserSearchResult[]
    }>()

    useEffect(() => {
      let current = true
      void Promise.all(
        usersKey
          .split('\n')
          .filter(Boolean)
          .map((id) => getUserMetadata(id).catch(() => null)),
      ).then((records) => {
        if (!current) return
        setResult({
          usersKey,
          lookup: getUserMetadata,
          named: records.filter(
            (record): record is UserSearchResult =>
              !!record && personName(record.id, record.name) !== undefined,
          ),
        })
      })
      return () => {
        current = false
      }
    }, [usersKey, getUserMetadata])
    const named =
      result?.usersKey === usersKey && result.lookup === getUserMetadata ? result.named : null

    if (!openToEveryone && users.length + groups.length === 0) return null

    const otherPeople = named ? users.length - named.length : 0
    const shown = [...(named ?? []).map((user) => personName(user.id, user.name) ?? ''), ...groups]
    const others = otherPeople > 0 ? othersLabel(otherPeople, shown.length > 0) : ''
    const line = (
      <>
        {'Access: '}
        {openToEveryone ? (
          'anyone who can sign in'
        ) : named === null ? (
          <Skeleton component="span" display="inline-block" height={10} width={120} />
        ) : (
          [shown.join(', '), others].filter(Boolean).join(' ')
        )}
      </>
    )
    const busy = (!openToEveryone && named === null) || undefined
    return button.onClick ? (
      <Anchor
        component="button"
        type="button"
        ref={ref}
        size="xs"
        c="dimmed"
        underline="always"
        ta="start"
        aria-busy={busy}
        {...button}
      >
        {line}
      </Anchor>
    ) : (
      <Text size="xs" c="dimmed" aria-busy={busy}>
        {line}
      </Text>
    )
  },
)
