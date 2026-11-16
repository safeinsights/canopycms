'use client'

import React, { forwardRef, useEffect, useState } from 'react'
import { Avatar, Button, Skeleton } from '@mantine/core'
import { IconWorld } from '@tabler/icons-react'

import type { UserSearchResult } from '../../auth/types'
import { personInitials, personName } from '../../auth/person-name'
import type { BranchSummary } from '../BranchManager'
import { EDITOR_ACTIONS } from '../copy'
import { removedFromBranch } from './share-copy'
import { joinNames } from './share-staging'

/**
 * One width for both labels and the skeleton, so the control's own width never changes as the
 * listing loads or with the viewer's role.
 * @internal Exported for tests.
 */
export const SHARE_CONTROL_WIDTH = 220
const CONTROL_HEIGHT = 36
const SHOWN_AVATARS = 3
const NAMED_IN_LABEL = 2
const NAME_UNAVAILABLE = 'Name unavailable'

/** @internal Exported for tests. */
export type SharedSummary = Pick<BranchSummary, 'access' | 'createdBy' | 'sharing'>

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** ", except the 1 person removed from this branch", for an open branch's owner and admins. */
const except = (b: SharedSummary): string => {
  const removed = b.access?.removed && removedFromBranch(b.access.removed)
  return removed ? `, except ${removed}` : ''
}

/**
 * Who `b`'s list admits, as the viewer's listing has it: an empty list that limits nothing beyond
 * its default leaves its owner alone, unless the branch is open to everyone.
 */
export function accessPeople(b: SharedSummary): { users: string[]; groups: string[] } {
  const users = b.access?.users ?? []
  const groups = b.access?.groups ?? []
  if (users.length + groups.length > 0 || b.sharing?.openToEveryone || !b.createdBy) {
    return { users, groups }
  }
  return { users: [b.createdBy], groups: [] }
}

/**
 * The control's accessible name, which starts with its visible label: "Share…, 4 people have
 * access", or "Who has access: Ana Lee, Ben Ortiz and 2 others". `named` are the people the lookup
 * could name, in list order; groups and anyone unnamed count among the others. The viewer, when
 * listed, is "you", first.
 * @internal Exported for tests.
 */
export function shareControlName(
  mode: 'share' | 'view',
  b: SharedSummary,
  named: ReadonlyArray<{ id: string; name: string }>,
  viewerId?: string,
): string {
  const { users, groups } = accessPeople(b)
  const open = !!b.sharing?.openToEveryone
  const total = users.length + groups.length
  const counted = [
    users.length > 0 && plural(users.length, 'person', 'people'),
    groups.length > 0 && plural(groups.length, 'group', 'groups'),
  ]
    .filter(Boolean)
    .join(' and ')
  if (mode === 'share') {
    const label = `${EDITOR_ACTIONS.share}…`
    if (open) return `${label}, anyone who can sign in has access${except(b)}`
    if (total === 0) return `${label}, no one is listed`
    return `${label}, ${counted} ${total === 1 ? 'has' : 'have'} access`
  }
  if (open) return `Who has access: anyone who can sign in${except(b)}`
  if (total === 0) return 'Who has access: no one is listed'
  const you = !!viewerId && users.includes(viewerId) ? ['you'] : []
  const shown = [...you, ...named.filter((p) => p.id !== viewerId).map((p) => p.name)].slice(
    0,
    NAMED_IN_LABEL,
  )
  const others = total - shown.length
  if (shown.length === 0) return `Who has access: ${counted}`
  if (others === 0) return `Who has access: ${joinNames(shown)}`
  return `Who has access: ${shown.join(', ')} and ${plural(others, 'other', 'others')}`
}

/**
 * The people behind `ids`, as the lookup answers, by id; null until it first has. While anyone is
 * unnamed, it asks again for each new `listing` (the summary, which each listing and any other
 * change to it renews), as a lookup that reads a cache the listing seeds can know more once it
 * arrives. A record with a name is never replaced by a later one without.
 */
function useLookedUp(
  ids: readonly string[],
  getUserMetadata: (userId: string) => Promise<UserSearchResult | null>,
  listing: unknown,
): Readonly<Record<string, UserSearchResult | null>> | null {
  const key = ids.join('\n')
  const [result, setResult] = useState<{
    key: string
    people: Record<string, UserSearchResult | null>
  }>()
  const known = result?.key === key ? result.people : null
  const named = (id: string, person: UserSearchResult | null | undefined) =>
    !!person && personName(id, person.name) !== undefined
  const complete = !!known && ids.every((id) => named(id, known[id]))
  useEffect(() => {
    if (complete) return
    let current = true
    const wanted = key.split('\n').filter(Boolean)
    void Promise.all(wanted.map((id) => getUserMetadata(id).catch(() => null))).then((found) => {
      if (!current) return
      setResult((prev) => {
        const earlier = prev?.key === key ? prev.people : {}
        const people = Object.fromEntries(
          wanted.map((id, i) => [
            id,
            named(id, found[i]) || !named(id, earlier[id])
              ? (found[i] ?? earlier[id] ?? null)
              : earlier[id],
          ]),
        )
        return { key, people }
      })
    })
    return () => {
      current = false
    }
  }, [key, getUserMetadata, listing, complete])
  return known
}

export interface BranchShareControlProps {
  mode: 'share' | 'view'
  branch: SharedSummary
  getUserMetadata: (userId: string) => Promise<UserSearchResult | null>
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  viewerId?: string
}

/**
 * The open branch's sharing control, first in the top bar's actions: an avatar stack of who has
 * access (a globe on a branch open to everyone) and "Share…", or "Who has access" for someone who
 * may open the branch but not add people. Its width is fixed, so names arriving move nothing.
 */
export const BranchShareControl = forwardRef<HTMLButtonElement, BranchShareControlProps>(
  function BranchShareControl(
    { mode, branch, getUserMetadata, onClick, viewerId, ...popoverTarget },
    ref,
  ) {
    const { users, groups } = accessPeople(branch)
    const open = !!branch.sharing?.openToEveryone
    const people = useLookedUp(users, getUserMetadata, branch)
    const named = users.flatMap((id) => {
      const person = people?.[id]
      const name = person && personName(id, person.name)
      return name ? [{ id, name }] : []
    })
    const total = users.length + groups.length
    const shownUsers = users.slice(0, SHOWN_AVATARS)
    const extra = total - shownUsers.length
    return (
      <Button
        ref={ref}
        {...popoverTarget}
        variant="default"
        size="sm"
        w={SHARE_CONTROL_WIDTH}
        px={10}
        justify="flex-start"
        style={{ flexShrink: 0 }}
        aria-label={shareControlName(mode, branch, named, viewerId)}
        aria-haspopup="dialog"
        onClick={onClick}
        data-testid="branch-share-control"
        data-mode={mode}
        leftSection={
          open ? (
            <IconWorld size={18} aria-hidden="true" />
          ) : (
            <Avatar.Group spacing={8} aria-hidden="true">
              {shownUsers.map((id) => {
                const person = people?.[id]
                // Blank until the lookup answers, then the name's initials or the fallback's.
                const name = people
                  ? ((person && personName(id, person.name)) ?? NAME_UNAVAILABLE)
                  : undefined
                return (
                  <Avatar key={id} src={person?.avatarUrl} alt="" size={24} radius="xl">
                    {name ? personInitials(name) : ' '}
                  </Avatar>
                )
              })}
              {extra > 0 && (
                <Avatar size={24} radius="xl">
                  {`+${extra}`}
                </Avatar>
              )}
            </Avatar.Group>
          )
        }
      >
        {mode === 'share' ? `${EDITOR_ACTIONS.share}…` : 'Who has access'}
      </Button>
    )
  },
)

/** The control's place while the open branch's listing loads. */
export function BranchShareControlSkeleton() {
  return (
    <Skeleton
      width={SHARE_CONTROL_WIDTH}
      height={CONTROL_HEIGHT}
      radius="sm"
      style={{ flexShrink: 0 }}
      data-testid="branch-share-skeleton"
    />
  )
}
