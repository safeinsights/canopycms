/**
 * Sharing the open branch from the editor's top bar, and a new branch from the toast its create
 * raises once the Branches drawer has closed.
 */
import React from 'react'

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWRConfig } from 'swr'
import { notifications } from '@mantine/notifications'

import type { EditorEntry } from './Editor'
import { Editor } from './Editor'
import { ApiClientProvider } from './context'
import { CanopyCMSProvider } from './theme'
import { unsafeAsContentId, unsafeAsLogicalPath } from '../paths/test-utils'

vi.mock('@mantine/modals', () => ({
  ModalsProvider: ({ children }: { children: React.ReactNode }) => children,
  modals: { openConfirmModal: vi.fn() },
}))

vi.mock('@mantine/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/notifications')>()
  return { ...actual, notifications: { show: vi.fn(), hide: vi.fn(), update: vi.fn() } }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')
})

const SPRING = 'canopycms/local/spring'
const SUMMER = 'canopycms/local/summer'

const okJson = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, status: 200, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const hello: EditorEntry = {
  path: unsafeAsLogicalPath('content/posts/hello'),
  contentId: unsafeAsContentId('def456ABC123'),
  label: 'Hello',
  status: 'entry',
  schema: [{ name: 'title', type: 'string' }],
  collectionPath: unsafeAsLogicalPath('content/posts'),
  collectionName: 'posts',
  slug: 'hello',
  format: 'json',
  type: 'entry',
}

const ownerRights = {
  isOwner: true,
  canAdd: true,
  canManage: true,
  restricted: true,
  openToEveryone: false,
  addBy: 'members',
}

const listed = (name: string) => ({
  name,
  shortName: name.replace('canopycms/local/', ''),
  status: 'editing',
  access: { allowedUsers: ['author-1', 'bob'], restricted: true },
  createdBy: 'author-1',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  isProtected: false,
  readOnly: false,
  writeBlocked: false,
  submitBlocked: false,
  sharing: ownerRights,
})

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

const stubApi = (holdCreate?: Promise<void>, listingAfterCreate?: Promise<void>) => {
  let createdOnce = false
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/whoami')) return okJson({ userId: 'author-1', groups: [] })
    if (url.endsWith('/comments')) return okJson({ threads: [], users: [] })
    if (url.endsWith('/api/canopycms/branches') && method === 'POST') {
      await holdCreate
      createdOnce = true
      return okJson({ branch: listed(SUMMER) })
    }
    if (url.endsWith('/api/canopycms/branches')) {
      if (createdOnce) await listingAfterCreate
      return okJson({
        branches: [listed(SPRING)],
        defaultBranch: SPRING,
        users: [{ id: 'author-1', name: 'Ana Lee' }],
      })
    }
    if (url.endsWith('/access') && method === 'GET') {
      return okJson({
        entries: [{ kind: 'user', id: 'author-1', name: 'Ana Lee' }],
        restricted: true,
        openToEveryone: false,
        defaultAccess: 'deny',
        addBy: 'members',
        rights: { isOwner: true, canAdd: true, canManage: true },
        searchable: 'cms-users',
        addableByEmail: 'all-users',
      })
    }
    if (url.includes('/schema') && !url.includes('/schema/')) {
      return okJson({ schema: {}, flatSchema: [], entrySchemas: {} })
    }
    if (url.includes('/entries')) {
      return okJson({ collections: [], entries: [], pagination: { hasMore: false, limit: 50 } })
    }
    return okJson({})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderEditor = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 2000 }}>
      <ApiClientProvider>
        <Editor
          entries={[hello]}
          title="Test Editor"
          branchName="spring"
          operatingMode="dev"
          themeOptions={{}}
        />
      </ApiClientProvider>
    </SWRConfig>,
  )

describe('sharing from the editor', () => {
  it("opens the open branch's Share dialog from the top bar, returning focus to its control", async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    stubApi()
    renderEditor()

    const control = await screen.findByRole('button', { name: /^Share…, 2 people have access/ })
    control.focus()
    fireEvent.click(control)

    const dialog = await screen.findByRole('dialog', { name: 'Share “spring”' })
    expect(await within(dialog).findByText('Ana Lee (you)')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share “spring”' })).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(control))
  })

  it('offers Share… on the toast of a create whose drawer has closed', async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    let release = () => {}
    stubApi(new Promise<void>((resolve) => (release = resolve)))
    renderEditor()
    await screen.findByTestId('branch-share-control')
    fireEvent.click(screen.getByTestId('branch-dropdown-button'))
    fireEvent.click(await screen.findByTestId('manage-branches-menu-item'))
    fireEvent.click(await screen.findByTestId('create-branch-button'))
    fireEvent.change(await screen.findByTestId('branch-name-input'), {
      target: { value: 'summer' },
    })
    fireEvent.click(screen.getByTestId('create-branch-submit'))
    const drawer = screen.getByRole('dialog', { name: /Branches/ })
    fireEvent.click(within(drawer).getAllByRole('button', { name: /close/i })[0])
    await waitFor(() => expect(screen.queryByTestId('branch-manager')).toBeNull())

    release()

    await waitFor(() => expect(notifications.show).toHaveBeenCalled())
    const toast = vi.mocked(notifications.show).mock.calls[0][0]
    expect(toast.color).toBe('green')
    render(<CanopyCMSProvider>{toast.message}</CanopyCMSProvider>)
    expect(screen.getByText('Branch “summer” created')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Share…' }))

    expect(await screen.findByRole('dialog', { name: 'Share “summer”' })).toBeTruthy()
    expect(notifications.hide).toHaveBeenCalledWith(toast.id)
  })

  it("opens the toast's Share… from the create's own answer once listings no longer hold the branch", async () => {
    window.history.replaceState({}, '', '/?branch=spring')
    let release = () => {}
    let releaseListing = () => {}
    stubApi(
      new Promise<void>((resolve) => (release = resolve)),
      new Promise<void>((resolve) => (releaseListing = resolve)),
    )
    renderEditor()
    await screen.findByTestId('branch-share-control')
    fireEvent.click(screen.getByTestId('branch-dropdown-button'))
    fireEvent.click(await screen.findByTestId('manage-branches-menu-item'))
    fireEvent.click(await screen.findByTestId('create-branch-button'))
    fireEvent.change(await screen.findByTestId('branch-name-input'), {
      target: { value: 'summer' },
    })
    fireEvent.click(screen.getByTestId('create-branch-submit'))
    const drawer = screen.getByRole('dialog', { name: /Branches/ })
    fireEvent.click(within(drawer).getAllByRole('button', { name: /close/i })[0])
    await waitFor(() => expect(screen.queryByTestId('branch-manager')).toBeNull())
    release()
    await waitFor(() => expect(notifications.show).toHaveBeenCalled())
    // A listing that arrives past the created branch's grace, still without it, drops it.
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 60 * 60 * 1000)
    releaseListing()
    // With the open branch unlisted, the top bar has no sharing control for it.
    await waitFor(() => expect(screen.queryByTestId('branch-share-control')).toBeNull())

    const toast = vi.mocked(notifications.show).mock.calls[0][0]
    render(<CanopyCMSProvider>{toast.message}</CanopyCMSProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Share…' }))

    expect(await screen.findByRole('dialog', { name: 'Share “summer”' })).toBeTruthy()
    expect(notifications.hide).toHaveBeenCalledWith(toast.id)
  })
})
