import React, { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { createMockApiClient } from '../../api/__test__/mock-client'
import { ApiClientProvider, type ApiClient } from '../context'
import { CanopyCMSProvider } from '../theme'
import { OPEN_TO_EVERYONE_LINE, LISTED_ONLY_LINE } from './share-copy'
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
  rights: { isOwner: false, canAdd: false, canManage: false },
  searchable: 'cms-users',
  addableByEmail: 'all-users',
  ...over,
})

function renderPopover(data: BranchAccess) {
  const api = createMockApiClient()
  api.branches.getAccess.mockResolvedValue({ ok: true, status: 200, data })
  function Harness() {
    const [opened, setOpened] = useState(false)
    return (
      <WhoHasAccessPopover
        branch={{ name: 'spring', createdBy: 'ana' }}
        opened={opened}
        onChange={setOpened}
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
  it('lists names, groups and the general access line, focusing the first row', async () => {
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
    await waitFor(() => expect(document.activeElement).toBe(rows[0]))
  })

  it('says an open branch is open to everyone who can sign in', async () => {
    const { opener } = renderPopover(
      access({ entries: [], restricted: false, openToEveryone: true, defaultAccess: 'allow' }),
    )

    fireEvent.click(opener)

    expect(await screen.findByText(OPEN_TO_EVERYONE_LINE)).toBeTruthy()
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
})
