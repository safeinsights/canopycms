import React, { useEffect, useState } from 'react'
import { Skeleton, Text } from '@mantine/core'
import type { UserSearchResult } from '../../auth/types'
import { personName } from '../../auth/person-name'

export interface BranchAccessListProps {
  users?: readonly string[]
  groups?: readonly string[]
  getUserMetadata: (userId: string) => Promise<UserSearchResult | null>
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The trailing count of people the lookup couldn't name, after the names shown or standing alone. */
const othersLabel = (people: number, afterNames: boolean): string =>
  afterNames ? `and ${count(people, 'other', 'others')}` : count(people, 'person', 'people')

/**
 * A branch's access list as one line of text: the people the viewer's lookup names, its groups,
 * then "and N others" for the people it couldn't name (docs/ux-guidelines.md, People). An unnamed
 * person is counted, not shown as "Name unavailable".
 */
export function BranchAccessList({
  users = [],
  groups = [],
  getUserMetadata,
}: BranchAccessListProps) {
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

  if (users.length + groups.length === 0) return null

  const otherPeople = named ? users.length - named.length : 0
  const shown = [...(named ?? []).map((user) => personName(user.id, user.name) ?? ''), ...groups]
  const others = otherPeople > 0 ? othersLabel(otherPeople, shown.length > 0) : ''
  return (
    <Text size="xs" c="dimmed" aria-busy={named === null || undefined}>
      {'Access: '}
      {named === null ? (
        <Skeleton component="span" display="inline-block" height={10} width={120} />
      ) : (
        [shown.join(', '), others].filter(Boolean).join(' ')
      )}
    </Text>
  )
}
