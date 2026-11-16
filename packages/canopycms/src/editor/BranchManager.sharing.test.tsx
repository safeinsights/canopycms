import React, { useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { createMockApiClient } from '../api/__test__/mock-client'
import { RESERVED_GROUPS } from '../authorization/helpers'
import { SYSTEM_USER_ID } from '../system-users'
import {
  BranchManager,
  canShareBranch,
  type BranchSummary,
  type UserContext,
} from './BranchManager'
import { ApiClientProvider, type ApiClient } from './context'
import { CanopyCMSProvider } from './theme'
import { BranchesDrawer } from './components/BranchesDrawer'

type Sharing = NonNullable<BranchSummary['sharing']>
const rights = (over: Partial<Sharing> = {}): Sharing => ({
  isOwner: true,
  canAdd: true,
  canManage: true,
  restricted: true,
  openToEveryone: false,
  addBy: 'members',
  ...over,
})
const NONE = rights({ isOwner: false, canAdd: false, canManage: false })
const ANA: UserContext = { userId: 'ana', groups: [] }
const ADMIN: UserContext = { userId: 'root', groups: [RESERVED_GROUPS.ADMINS] }

const branch = (over: Partial<BranchSummary> = {}): BranchSummary => ({
  name: 'canopycms/prod/spring',
  shortName: 'spring',
  status: 'editing',
  createdBy: 'ana',
  access: { users: ['ana', 'ben'] },
  sharing: rights(),
  submitBlocked: false,
  isProtected: false,
  pullRequestUrl: 'https://github.com/o/r/pull/7',
  pullRequestNumber: 7,
  ...over,
})

const lookup = async (id: string) => ({
  id,
  name: id === 'ana' ? 'Ana Lee' : 'Ben Ortiz',
  email: '',
})

function renderManager(b: BranchSummary, user: UserContext = ANA) {
  const api = createMockApiClient()
  api.branches.getAccess.mockResolvedValue({
    ok: true,
    status: 200,
    data: {
      entries: [{ kind: 'user', id: 'ana', name: 'Ana Lee' }],
      restricted: true,
      openToEveryone: false,
      defaultAccess: 'deny',
      addBy: 'members',
      rights: b.sharing ?? NONE,
      searchable: 'cms-users',
      addableByEmail: 'all-users',
    },
  })
  const onOverlayChange = vi.fn()
  render(
    <CanopyCMSProvider>
      <ApiClientProvider client={api as unknown as ApiClient}>
        <BranchManager
          branches={[b]}
          mode="prod"
          user={user}
          onGetOwnerMetadata={lookup}
          onOverlayChange={onOverlayChange}
        />
      </ApiClientProvider>
    </CanopyCMSProvider>,
  )
  return { api, onOverlayChange }
}

const openMenu = async (b: BranchSummary) => {
  fireEvent.click(screen.getByTestId(`branch-actions-menu-${b.name}`))
  return screen.findByRole('menu')
}

describe('canShareBranch', () => {
  it('follows the server rights', () => {
    expect(canShareBranch(branch(), ANA)).toBe(true)
    expect(
      canShareBranch(branch({ sharing: rights({ canAdd: true, canManage: false }) }), ANA),
    ).toBe(true)
    expect(canShareBranch(branch({ sharing: NONE }), ANA)).toBe(false)
    expect(canShareBranch(branch({ sharing: undefined }), ANA)).toBe(false)
  })

  it('hides it on archived and system-owned branches from all but admins, and on the base branch', () => {
    expect(canShareBranch(branch({ status: 'archived' }), ANA)).toBe(false)
    expect(canShareBranch(branch({ status: 'archived' }), ADMIN)).toBe(true)
    expect(canShareBranch(branch({ createdBy: SYSTEM_USER_ID }), ANA)).toBe(false)
    expect(canShareBranch(branch({ createdBy: SYSTEM_USER_ID }), ADMIN)).toBe(true)
    expect(canShareBranch(branch({ isProtected: true }), ADMIN)).toBe(false)
  })
})

describe('BranchManager sharing', () => {
  it('offers Share… above "View pull request" to someone who may add people', async () => {
    const b = branch()
    renderManager(b)

    const items = within(await openMenu(b)).getAllByRole('menuitem')

    expect(items.map((item) => item.textContent)).toEqual([
      'Submit for review',
      'Share…',
      'View pull request #7',
      'Delete branch',
    ])
  })

  it('offers no Share… to someone who may not', async () => {
    const b = branch({ sharing: NONE, createdBy: 'zoe' })
    renderManager(b)

    const menu = await openMenu(b)

    expect(within(menu).queryByRole('menuitem', { name: 'Share…' })).toBeNull()
  })

  it('opens the dialog from Share…, holds the drawer off Escape, and returns focus to the menu', async () => {
    const b = branch()
    const { onOverlayChange } = renderManager(b)

    fireEvent.click(within(await openMenu(b)).getByRole('menuitem', { name: 'Share…' }))

    expect(await screen.findByRole('dialog', { name: 'Share spring' })).toBeTruthy()
    expect(onOverlayChange).toHaveBeenLastCalledWith(true)
    await screen.findByRole('button', { name: 'Cancel' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    await waitFor(() => expect(onOverlayChange).toHaveBeenLastCalledWith(false))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId(`branch-actions-menu-${b.name}`)),
    )
  })

  it('opens the dialog from the Access line for someone who may add, returning focus to it', async () => {
    const b = branch()
    renderManager(b)
    const line = await screen.findByRole('button', { name: 'Access: Ana Lee, Ben Ortiz' })

    fireEvent.click(line)

    expect(await screen.findByRole('dialog', { name: 'Share spring' })).toBeTruthy()
    await screen.findByRole('button', { name: 'Cancel' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    await waitFor(() => expect(document.activeElement).toBe(line))
  })

  it('opens "Who has access" from the Access line for someone who may not add', async () => {
    const b = branch({ sharing: NONE, createdBy: 'zoe' })
    const { onOverlayChange } = renderManager(b)
    const line = await screen.findByRole('button', { name: 'Access: Ana Lee, Ben Ortiz' })

    await userEvent.click(line)

    expect(await screen.findByRole('dialog', { name: 'Who has access' })).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: /^Share/ })).toBeNull()
    expect(onOverlayChange).toHaveBeenLastCalledWith(true)
  })

  it('reads "anyone who can sign in" for an open branch', async () => {
    renderManager(
      branch({ access: {}, sharing: rights({ restricted: false, openToEveryone: true }) }),
    )

    expect(
      await screen.findByRole('button', { name: 'Access: anyone who can sign in' }),
    ).toBeTruthy()
  })
})

describe('BranchManager sharing inside the Branches drawer', () => {
  /** The drawer yields Escape to an open overlay, wired as Editor.tsx wires it. */
  function renderInDrawer(b: BranchSummary) {
    const api = createMockApiClient()
    api.branches.getAccess.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        entries: [{ kind: 'user', id: 'ana', name: 'Ana Lee' }],
        restricted: true,
        openToEveryone: false,
        defaultAccess: 'deny',
        addBy: 'members',
        rights: b.sharing ?? NONE,
        searchable: 'cms-users',
        addableByEmail: 'all-users',
      },
    })
    const onDrawerClose = vi.fn()
    function Harness() {
      const [overlayOpen, setOverlayOpen] = useState(false)
      return (
        <BranchesDrawer opened onClose={onDrawerClose} confirmOpen={overlayOpen}>
          <BranchManager
            branches={[b]}
            mode="prod"
            user={ANA}
            onGetOwnerMetadata={lookup}
            onOverlayChange={setOverlayOpen}
          />
        </BranchesDrawer>
      )
    }
    render(
      <CanopyCMSProvider>
        <ApiClientProvider client={api as unknown as ApiClient}>
          <Harness />
        </ApiClientProvider>
      </CanopyCMSProvider>,
    )
    return { onDrawerClose }
  }

  it('closes only the Share dialog on Esc, leaving the drawer open', async () => {
    const { onDrawerClose } = renderInDrawer(branch())
    fireEvent.click(await screen.findByRole('button', { name: 'Access: Ana Lee, Ben Ortiz' }))
    await screen.findByRole('button', { name: 'Cancel' })

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share spring' })).toBeNull())
    expect(onDrawerClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('branch-manager')).toBeTruthy()
  })

  it('closes only "Who has access" on Esc, leaving the drawer open', async () => {
    const { onDrawerClose } = renderInDrawer(branch({ sharing: NONE, createdBy: 'zoe' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Access: Ana Lee, Ben Ortiz' }))
    await screen.findByRole('dialog', { name: 'Who has access' })

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Who has access' })).toBeNull())
    expect(onDrawerClose).not.toHaveBeenCalled()
  })
})
