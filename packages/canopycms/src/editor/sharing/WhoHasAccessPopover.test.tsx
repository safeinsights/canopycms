import React, { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { createMockApiClient } from '../../api/__test__/mock-client'
import { ApiClientProvider, type ApiClient } from '../context'
import { CanopyCMSProvider } from '../theme'
import { LISTED_ONLY_LINE, LOCKDOWN_LINE, OPEN_TO_EVERYONE_LINE } from './share-copy'
import type { UserContext } from '../BranchManager'
import type { BranchAccess } from './share-staging'
import { WhoHasAccessPopover } from './WhoHasAccessPopover'

const access = (over: Partial<BranchAccess> = {}): BranchAccess => ({
  entries: [
    { kind: 'user', id: 'ana', name: 'Ana Lee' },
    { kind: 'group', id: 'team', name: 'Marketing team' },
  ],
  restricted: true,
  openToEveryone: false,
  defaultAccess: 'deny',
  addBy: 'members',
  whoCanAdd: 'members',
  rights: { isOwner: false, canAdd: false, canManage: false },
  searchable: 'cms-users',
  addableByEmail: 'all-users',
  ...over,
})

function renderPopover(data: BranchAccess, lockedDown = false, viewer?: UserContext) {
  const api = createMockApiClient()
  api.branches.getAccess.mockResolvedValue({ ok: true, status: 200, data })
  function Harness() {
    const [opened, setOpened] = useState(false)
    return (
      <WhoHasAccessPopover
        branch={{
          name: 'spring',
          createdBy: 'ana',
          ownerName: 'Ana Lee',
          access: { managerOrAdminAllowed: lockedDown },
        }}
        opened={opened}
        onChange={setOpened}
        viewer={viewer}
      >
        <button onClick={() => setOpened((o) => !o)}>Access: Ana Lee, Marketing team</button>
      </WhoHasAccessPopover>
    )
  }
  render(
    <CanopyCMSProvider>
      <ApiClientProvider client={api as unknown as ApiClient}>
        <Harness />
      </ApiClientProvider>
    </CanopyCMSProvider>,
  )
  return { api, opener: screen.getByRole('button', { name: /^Access:/ }) }
}

describe('WhoHasAccessPopover', () => {
  it('lists names, groups and the general access line, focusing its heading', async () => {
    const { opener } = renderPopover(access())

    fireEvent.click(opener)

    const popover = await screen.findByRole('dialog', { name: 'Who has access' })
    const rows = await within(popover).findAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Ana Lee')).toBeTruthy()
    expect(within(rows[0]).getByText('Owner')).toBeTruthy()
    expect(within(rows[1]).getByText('Marketing team')).toBeTruthy()
    expect(within(rows[1]).getByText('Group')).toBeTruthy()
    expect(within(popover).getByText(LISTED_ONLY_LINE)).toBeTruthy()
    await waitFor(() =>
      expect(document.activeElement).toBe(within(popover).getByText('Who has access')),
    )
  })

  it('shows the owner of an unlisted branch on a closed site, as the Share dialog does', async () => {
    const { opener } = renderPopover(access({ entries: [], restricted: false }), false, {
      userId: 'zoe',
    })

    fireEvent.click(opener)

    const popover = await screen.findByRole('dialog', { name: 'Who has access' })
    const rows = await within(popover).findAllByRole('listitem')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Ana Lee')).toBeTruthy()
    expect(within(rows[0]).getByText('Owner')).toBeTruthy()
  })

  it('keeps focus, and so Esc, inside after a Tab', async () => {
    const { opener } = renderPopover(access())
    fireEvent.click(opener)
    const popover = await screen.findByRole('dialog', { name: 'Who has access' })
    await waitFor(() => expect(popover.contains(document.activeElement)).toBe(true))

    await userEvent.tab()

    expect(popover.contains(document.activeElement)).toBe(true)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Who has access' })).toBeNull())
  })

  it('says an open branch is open to everyone who can sign in', async () => {
    const { opener } = renderPopover(
      access({ entries: [], restricted: false, openToEveryone: true, defaultAccess: 'allow' }),
    )

    fireEvent.click(opener)

    expect(await screen.findByText(OPEN_TO_EVERYONE_LINE)).toBeTruthy()
  })

  it('says a locked branch is locked instead of who may open it', async () => {
    const { opener } = renderPopover(access(), true)

    fireEvent.click(opener)

    expect(await screen.findByText(LOCKDOWN_LINE)).toBeTruthy()
    expect(screen.queryByText(LISTED_ONLY_LINE)).toBeNull()
  })

  it('closes on Esc and returns focus to its opener', async () => {
    const { opener } = renderPopover(access())
    opener.focus()
    fireEvent.click(opener)
    const popover = await screen.findByRole('dialog', { name: 'Who has access' })
    await waitFor(() => expect(popover.contains(document.activeElement)).toBe(true))

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Who has access' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('marks the viewer "(you)"', async () => {
    const { opener } = renderPopover(access(), false, { userId: 'ana' })
    fireEvent.click(opener)

    const popover = await screen.findByRole('dialog', { name: 'Who has access' })
    expect(await within(popover).findByText('Ana Lee (you)')).toBeTruthy()
  })

  it.each([
    ['owner', 'Only the owner, Ana Lee, can add people.'],
    ['admins', 'Only admins can add people.'],
    ['members', 'Anyone on this list can add people.'],
  ] as const)('says who can add people when that is %s', async (addBy, line) => {
    const { opener } = renderPopover(access({ addBy, whoCanAdd: addBy }), false, { userId: 'zoe' })
    fireEvent.click(opener)

    expect((await screen.findByTestId('who-can-add')).textContent).toBe(line)
  })

  it('tells someone on the list who still may not add nothing about who can', async () => {
    const { opener } = renderPopover(access({ addBy: 'members' }), false, { userId: 'ana' })
    fireEvent.click(opener)

    await screen.findByText(LISTED_ONLY_LINE)
    expect(screen.queryByTestId('who-can-add')).toBeNull()
  })

  it('counts someone on the list through a group as listed', async () => {
    const { opener } = renderPopover(access({ addBy: 'members' }), false, {
      userId: 'zoe',
      groups: ['team'],
    })
    fireEvent.click(opener)

    await screen.findByText(LISTED_ONLY_LINE)
    expect(screen.queryByTestId('who-can-add')).toBeNull()
  })

  it('tells someone on the list through a group who else may add, when it is not the list', async () => {
    const { opener } = renderPopover(access({ addBy: 'owner', whoCanAdd: 'owner' }), false, {
      userId: 'zoe',
      groups: ['team'],
    })
    fireEvent.click(opener)

    expect((await screen.findByTestId('who-can-add')).textContent).toBe(
      'Only the owner, Ana Lee, can add people.',
    )
  })

  it.each([
    ['an archived branch', 'members'],
    ['a system-owned or unowned branch', 'members'],
    ['a branch whose owner is off its list', 'owner'],
  ] as const)(
    'says only admins can add on %s, as the server answers, whatever the setting',
    async (_what, addBy) => {
      const { opener } = renderPopover(access({ addBy, whoCanAdd: 'admins' }), false, {
        userId: 'zoe',
      })
      fireEvent.click(opener)

      expect((await screen.findByTestId('who-can-add')).textContent).toBe(
        'Only admins can add people.',
      )
    },
  )

  it('says nothing of who can add on a branch open to everyone', async () => {
    const { opener } = renderPopover(
      access({ entries: [], restricted: false, openToEveryone: true, defaultAccess: 'allow' }),
      false,
      { userId: 'zoe' },
    )
    fireEvent.click(opener)

    await screen.findByText(OPEN_TO_EVERYONE_LINE)
    expect(screen.queryByTestId('who-can-add')).toBeNull()
  })
})
