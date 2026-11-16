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
const initials = () =>
  [...(control()?.querySelectorAll('.mantine-Avatar-root') ?? [])].map((a) => a.textContent)

/** The bar for viewer Ben on `b`, below md when `narrow`. */
const viewerBar = (b: BranchSummary) => (
  <CanopyCMSProvider>
    <ApiClientProvider client={createMockApiClient() as unknown as ApiClient}>
      <EditorHeader
        {...baseProps}
        branchName={b.name}
        sharing={{
          branch: b,
          loading: false,
          user: { userId: 'ben' },
          getUserMetadata: lookup,
          onShare: vi.fn(),
        }}
      />
    </ApiClientProvider>
  </CanopyCMSProvider>
)
const viewOnly = (name: string) =>
  branch({ name, sharing: rights({ isOwner: false, canAdd: false, canManage: false }) })

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

  it('offers someone who may not add people "Who has access", naming them first as you', async () => {
    renderBar({
      user: { userId: 'ben' },
      branch: branch({ sharing: rights({ isOwner: false, canAdd: false, canManage: false }) }),
    })

    expect(
      await screen.findByRole('button', {
        name: 'Who has access: you, Ana Lee and 2 others',
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

  it('says either control opens a dialog', async () => {
    renderBar({
      user: { userId: 'ben' },
      branch: branch({ sharing: rights({ isOwner: false, canAdd: false, canManage: false }) }),
    })

    expect(control()?.getAttribute('aria-haspopup')).toBe('dialog')
  })

  it('leaves avatars blank until the lookup answers, then shows two-letter initials', async () => {
    let answer: (person: UserSearchResult | null) => void = () => {}
    const slow = vi.fn(
      (id: string) =>
        new Promise<UserSearchResult | null>((resolve) => {
          answer = (person) => resolve(id === 'ana' ? person : null)
        }),
    )
    renderBar({ branch: branch({ access: { users: ['ana'], groups: [] } }), getUserMetadata: slow })
    expect(initials()).toEqual([' '])

    answer({ id: 'ana', name: 'Ana Lee', email: '' })

    await waitFor(() => expect(initials()).toEqual(['AL']))
  })

  it('asks again with each listing while anyone is unnamed, keeping names it had', async () => {
    let anaKnown = true
    const lookupAgain = vi.fn(
      async (id: string): Promise<UserSearchResult | null> =>
        id === 'ana' && anaKnown ? { id, name: 'Ana Lee', email: '' } : null,
    )
    const bar = (b: BranchSummary) => (
      <CanopyCMSProvider>
        <ApiClientProvider client={createMockApiClient() as unknown as ApiClient}>
          <EditorHeader
            {...baseProps}
            sharing={{
              branch: b,
              loading: false,
              user: { userId: 'ana' },
              getUserMetadata: lookupAgain,
              onShare: vi.fn(),
            }}
          />
        </ApiClientProvider>
      </CanopyCMSProvider>
    )
    const listing = () => branch({ access: { users: ['ana', 'zed'], groups: [] } })
    const { rerender } = render(bar(listing()))
    await waitFor(() => expect(initials()).toEqual(['AL', 'NU']))
    const asked = lookupAgain.mock.calls.length
    anaKnown = false

    rerender(bar(listing()))

    await waitFor(() => expect(lookupAgain.mock.calls.length).toBeGreaterThan(asked))
    expect(initials()).toEqual(['AL', 'NU'])
  })

  it('asks no more once everyone is named', async () => {
    const named = vi.fn(
      async (id: string): Promise<UserSearchResult | null> => ({ id, name: PEOPLE[id], email: '' }),
    )
    const bar = () => (
      <CanopyCMSProvider>
        <ApiClientProvider client={createMockApiClient() as unknown as ApiClient}>
          <EditorHeader
            {...baseProps}
            sharing={{
              branch: branch({ access: { users: ['ana', 'ben'], groups: [] } }),
              loading: false,
              user: { userId: 'ana' },
              getUserMetadata: named,
              onShare: vi.fn(),
            }}
          />
        </ApiClientProvider>
      </CanopyCMSProvider>
    )
    const { rerender } = render(bar())
    await waitFor(() => expect(initials()).toEqual(['AL', 'BO']))
    const asked = named.mock.calls.length

    rerender(bar())

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(named.mock.calls.length).toBe(asked)
  })

  it("doesn't reopen a branch's list on coming back to it", async () => {
    const { rerender } = render(viewerBar(viewOnly('canopycms/prod/spring')))
    fireEvent.click(control() as HTMLElement)
    await screen.findByRole('dialog', { name: 'Who has access' })

    rerender(viewerBar(viewOnly('canopycms/prod/summer')))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Who has access' })).toBeNull())
    rerender(viewerBar(viewOnly('canopycms/prod/spring')))

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('dialog', { name: 'Who has access' })).toBeNull()
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

    it('keeps the pill, its menu open, as the control changes between Share… and the list', async () => {
      stubNarrowWindow()
      const viewer = branch({
        sharing: rights({ isOwner: false, canAdd: false, canManage: false }),
      })
      const sharing = (b: BranchSummary): BranchBarSharing => ({
        branch: b,
        loading: false,
        user: { userId: 'ben' },
        getUserMetadata: lookup,
        onShare: vi.fn(),
      })
      const tree = (b: BranchSummary) => (
        <CanopyCMSProvider>
          <ApiClientProvider client={createMockApiClient() as unknown as ApiClient}>
            <EditorHeader {...baseProps} sharing={sharing(b)} />
          </ApiClientProvider>
        </CanopyCMSProvider>
      )
      const { rerender } = render(tree(branch()))
      const pill = screen.getByTestId('branch-dropdown-button')
      await userEvent.click(pill)
      await screen.findByRole('menuitem', { name: 'Share…' })

      rerender(tree(viewer))

      expect(screen.getByTestId('branch-dropdown-button')).toBe(pill)
      expect(await screen.findByRole('menuitem', { name: 'Who has access' })).toBeTruthy()
    })

    it("doesn't reopen the pill's list on coming back to its branch", async () => {
      stubNarrowWindow()
      const { rerender } = render(viewerBar(viewOnly('canopycms/prod/spring')))
      await userEvent.click(screen.getByTestId('branch-dropdown-button'))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Who has access' }))
      await screen.findByRole('dialog', { name: 'Who has access' })

      rerender(viewerBar(viewOnly('canopycms/prod/summer')))
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Who has access' })).toBeNull(),
      )
      rerender(viewerBar(viewOnly('canopycms/prod/spring')))

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(screen.queryByRole('dialog', { name: 'Who has access' })).toBeNull()
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
