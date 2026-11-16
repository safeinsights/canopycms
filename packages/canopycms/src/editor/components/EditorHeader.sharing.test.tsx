import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'

import { createMockApiClient } from '../../api/__test__/mock-client'
import type { UserSearchResult } from '../../auth/types'
import { RESERVED_GROUPS } from '../../authorization/helpers'
import { SYSTEM_USER_ID } from '../../system-users'
import type { BranchSummary } from '../BranchManager'
import { ApiClientProvider, type ApiClient } from '../context'
import { SHARE_CONTROL_WIDTH } from '../sharing/BranchShareControl'
import type { BranchAccess } from '../sharing/share-staging'
import { CanopyCMSProvider } from '../theme'
import { EditorHeader, type BranchBarSharing, type EditorHeaderProps } from './EditorHeader'

const PEOPLE: Record<string, string> = { ana: 'Ana Lee', ben: 'Ben Ortiz', cole: 'Cole Wu' }
const lookup = async (id: string): Promise<UserSearchResult | null> =>
  PEOPLE[id] ? { id, name: PEOPLE[id], email: `${id}@example.org` } : null

const rights = (over: Partial<NonNullable<BranchSummary['sharing']>> = {}) => ({
  isOwner: true,
  canAdd: true,
  canManage: true,
  restricted: true,
  openToEveryone: false,
  addBy: 'members' as const,
  ...over,
})

const branch = (over: Partial<BranchSummary> = {}): BranchSummary => ({
  name: 'canopycms/prod/spring',
  shortName: 'spring',
  status: 'submitted',
  createdBy: 'ana',
  access: { users: ['ana', 'ben', 'cole', 'dee'], groups: [] },
  sharing: rights(),
  ...over,
})

const access: BranchAccess = {
  entries: [{ kind: 'user', id: 'ana', name: 'Ana Lee' }],
  restricted: true,
  openToEveryone: false,
  defaultAccess: 'deny',
  addBy: 'members',
  rights: { isOwner: false, canAdd: false, canManage: false },
  searchable: 'cms-users',
  addableByEmail: 'all-users',
}

const baseProps: EditorHeaderProps = {
  branchName: 'canopycms/prod/spring',
  branchLabel: 'spring',
  busy: false,
  modifiedCount: 0,
  onShowUnsaved: vi.fn(),
  onBranchReloadData: vi.fn(),
  onBranchDiscardDrafts: vi.fn(),
  onBranchManagerOpen: vi.fn(),
  onSaveAll: vi.fn(),
  saveAllProgress: null,
  onSubmit: vi.fn(),
  onWithdraw: vi.fn(),
  branchStatus: 'submitted',
  branchWriteBlocked: true,
  branchHold: { kind: 'conflicts' },
  userContext: { userId: 'ana' },
  branchCreatedBy: 'ana',
  branchIsProtected: false,
}

function renderBar(
  sharing: Partial<BranchBarSharing> & { user?: BranchBarSharing['user'] },
  props: Partial<EditorHeaderProps> = {},
) {
  const api = createMockApiClient()
  api.branches.getAccess.mockResolvedValue({ ok: true, status: 200, data: access })
  const onShare = vi.fn()
  const full: BranchBarSharing = {
    branch: branch(),
    loading: false,
    user: { userId: 'ana' },
    getUserMetadata: lookup,
    onShare,
    ...sharing,
  }
  const view = render(
    <CanopyCMSProvider>
      <ApiClientProvider client={api as unknown as ApiClient}>
        <EditorHeader {...baseProps} {...props} sharing={full} />
      </ApiClientProvider>
    </CanopyCMSProvider>,
  )
  return { ...view, onShare, api }
}

const control = () => screen.queryByTestId('branch-share-control')

describe('EditorHeader - sharing control', () => {
  const originalMatchMedia = window.matchMedia
  /** A window below `md`: max-width queries match, min-width ones don't. */
  const stubNarrowWindow = () => {
    window.matchMedia = (query: string) =>
      ({
        matches: query.startsWith('(max-width:'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    cleanup()
  })

  it('leads the actions for the owner, named by how many have access', async () => {
    const { onShare } = renderBar({})

    const share = await screen.findByRole('button', { name: 'Share…, 4 people have access' })
    expect(share).toBe(control())
    expect(share.textContent).toContain('Share…')
    const trailing = screen.getByTestId('withdraw-button').parentElement
    expect(trailing?.firstElementChild).toBe(share)

    fireEvent.click(share)
    expect(onShare).toHaveBeenCalledTimes(1)
    expect(onShare.mock.calls[0][0]()).toBe(share)
  })

  it('counts groups apart from people', () => {
    renderBar({ branch: branch({ access: { users: ['ana'], groups: ['design', 'legal'] } }) })

    expect(control()?.getAttribute('aria-label')).toBe('Share…, 1 person and 2 groups have access')
  })

  it.each([
    [
      'a member who may add people',
      { userId: 'ben' },
      rights({ isOwner: false, canManage: false }),
    ],
    ['an admin', { userId: 'ada', groups: [RESERVED_GROUPS.ADMINS] }, rights({ isOwner: false })],
  ])('offers Share… to %s', (_who, user, sharing) => {
    renderBar({ user, branch: branch({ sharing }) })

    expect(control()?.getAttribute('data-mode')).toBe('share')
  })

  it('offers someone who may not add people "Who has access", naming two and counting the rest', async () => {
    renderBar({
      user: { userId: 'ben' },
      branch: branch({ sharing: rights({ isOwner: false, canAdd: false, canManage: false }) }),
    })

    expect(
      await screen.findByRole('button', {
        name: 'Who has access: Ana Lee, Ben Ortiz and 2 others',
      }),
    ).toBe(control())
    expect(control()?.textContent).toContain('Who has access')
  })

  it('opens the list read-only from "Who has access" and returns focus to it on Esc', async () => {
    const { onShare } = renderBar({
      user: { userId: 'ben' },
      branch: branch({ sharing: rights({ isOwner: false, canAdd: false, canManage: false }) }),
    })
    const opener = control() as HTMLElement
    opener.focus()

    fireEvent.click(opener)

    const list = await screen.findByRole('dialog', { name: 'Who has access' })
    expect(await within(list).findByText('Ana Lee')).toBeTruthy()
    expect(onShare).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Who has access' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })

  it('shows a globe for a branch open to everyone', () => {
    renderBar({
      branch: branch({
        status: 'editing',
        access: { users: [], groups: [] },
        sharing: rights({ restricted: false, openToEveryone: true }),
      }),
    })

    expect(control()?.getAttribute('aria-label')).toBe('Share…, anyone who can sign in has access')
    expect(control()?.querySelector('.tabler-icon-world')).toBeTruthy()
    expect(control()?.querySelector('.mantine-Avatar-root')).toBeNull()
  })

  it.each([
    [
      'the base branch',
      branch({ isProtected: true }),
      { userId: 'ada', groups: [RESERVED_GROUPS.ADMINS] },
    ],
    ['a system-owned branch', branch({ createdBy: SYSTEM_USER_ID }), { userId: 'ana' }],
    ['an archived branch', branch({ status: 'archived' }), { userId: 'ana' }],
    ['a branch with no rights listed', branch({ sharing: undefined }), { userId: 'ana' }],
  ])('is hidden on %s', (_what, b, user) => {
    renderBar({ branch: b, user })

    expect(control()).toBeNull()
    expect(screen.queryByTestId('branch-share-skeleton')).toBeNull()
  })

  it('stays for an admin on an archived or system-owned branch', () => {
    const admin = { userId: 'ada', groups: [RESERVED_GROUPS.ADMINS] }
    renderBar({ branch: branch({ status: 'archived', createdBy: SYSTEM_USER_ID }), user: admin })

    expect(control()?.getAttribute('data-mode')).toBe('share')
  })

  it('holds its place with a skeleton of its own width while the listing loads', () => {
    const { rerender } = renderBar({ branch: undefined, loading: true })
    const skeleton = screen.getByTestId('branch-share-skeleton')
    const width = `calc(${SHARE_CONTROL_WIDTH / 16}rem * var(--mantine-scale))`
    expect(skeleton.getAttribute('style')).toContain(`--skeleton-width: ${width}`)
    expect(control()).toBeNull()

    rerender(
      <CanopyCMSProvider>
        <ApiClientProvider client={createMockApiClient() as unknown as ApiClient}>
          <EditorHeader
            {...baseProps}
            sharing={{
              branch: branch(),
              loading: false,
              user: { userId: 'ana' },
              getUserMetadata: lookup,
              onShare: vi.fn(),
            }}
          />
        </ApiClientProvider>
      </CanopyCMSProvider>,
    )
    expect(screen.queryByTestId('branch-share-skeleton')).toBeNull()
    expect(control()?.getAttribute('style')).toContain(`width: ${width}`)
  })

  describe('below md', () => {
    it('moves into the pill menu as "Share…", returning focus to the pill', async () => {
      stubNarrowWindow()
      const { onShare } = renderBar({})
      expect(control()).toBeNull()

      await userEvent.click(screen.getByTestId('branch-dropdown-button'))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Share…' }))

      expect(onShare).toHaveBeenCalledTimes(1)
      expect(onShare.mock.calls[0][0]()).toBe(screen.getByTestId('branch-dropdown-button'))
    })

    it('offers "Who has access" there, opening the list from the pill and focusing it after', async () => {
      stubNarrowWindow()
      renderBar({
        user: { userId: 'ben' },
        branch: branch({ sharing: rights({ isOwner: false, canAdd: false, canManage: false }) }),
      })
      const pill = screen.getByTestId('branch-dropdown-button')

      await userEvent.click(pill)
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Who has access' }))

      const list = await screen.findByRole('dialog', { name: 'Who has access' })
      expect(await within(list).findByText('Ana Lee')).toBeTruthy()
      // As in a browser, the menu has finished closing, its own focus return spent, before Esc.
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
      await new Promise((resolve) => requestAnimationFrame(resolve))
      await userEvent.keyboard('{Escape}')
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Who has access' })).toBeNull(),
      )
      await waitFor(() => expect(document.activeElement).toBe(pill))
    })

    it('leaves the pill menu without it where sharing is hidden', async () => {
      stubNarrowWindow()
      renderBar({ branch: branch({ isProtected: true }) })

      await userEvent.click(screen.getByTestId('branch-dropdown-button'))
      await screen.findByRole('menuitem', { name: 'Switch branch…' })
      expect(screen.queryByTestId('share-branch-menu-item')).toBeNull()
    })
  })
})
